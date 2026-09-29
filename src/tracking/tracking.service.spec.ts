import { ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.validation';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { DevicePosition } from '../tcp/codec8-parser';
import type { DevicePositionsEvent } from '../tcp/tcp.events';
import type { BikeStatusDto } from './dto/bike-status.dto';
import { TrackingService } from './tracking.service';

const position: DevicePosition = {
  timestamp: new Date('2026-09-29T12:00:00.000Z'),
  priority: 0,
  latitude: -1.2921,
  longitude: 36.8219,
  altitude: 1600,
  angle: 270,
  satellites: 11,
  speed: 0,
  eventIoId: 0,
  io: {},
  ignition: false,
  movement: false,
  hasFix: true,
};

const event: DevicePositionsEvent = {
  imei: '356307042441013',
  records: [position],
  receivedAt: new Date(),
};

const bikeRow = {
  id: 'bike-1',
  imei: event.imei,
  label: 'Bike 7',
  registrationNumber: null,
  lastReportedAt: event.receivedAt,
  currentPosition: {
    recordedAt: position.timestamp,
    receivedAt: event.receivedAt,
    latitude: position.latitude,
    longitude: position.longitude,
    altitude: position.altitude,
    angle: position.angle,
    satellites: position.satellites,
    speed: position.speed,
    ignition: position.ignition,
    movement: position.movement,
    hasFix: position.hasFix,
  },
};

function configWithTimeout(seconds = 300): ConfigService<Env, true> {
  return {
    get: jest.fn(() => seconds),
  } as unknown as ConfigService<Env, true>;
}

describe('TrackingService', () => {
  it('restores offline timers for previously reported bikes at startup', async () => {
    const prisma = {
      bike: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'bike-1', lastReportedAt: new Date() },
          { id: 'bike-2', lastReportedAt: null },
        ]),
      },
    } as unknown as PrismaService;
    const service = new TrackingService(prisma, configWithTimeout());

    await service.onApplicationBootstrap();

    expect(prisma.bike.findMany).toHaveBeenCalledWith({
      where: { lastReportedAt: { not: null } },
      select: { id: true, lastReportedAt: true },
    });
    service.onModuleDestroy();
  });

  it('logs an unregistered IMEI and does not persist anything', async () => {
    const prisma = {
      bike: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn(),
    } as unknown as PrismaService;
    const service = new TrackingService(prisma, configWithTimeout());

    await expect(service.handleDevicePositions(event)).resolves.toBeUndefined();

    expect(prisma.bike.findUnique).toHaveBeenCalledWith({
      where: { imei: event.imei },
      select: { id: true },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('persists history idempotently and publishes a newer current position', async () => {
    type CreateManyArgs = {
      data: Array<{
        bikeId: string;
        recordedAt: Date;
        speed: number;
        ignition: boolean | null;
      }>;
      skipDuplicates: boolean;
    };
    const createMany = jest.fn<unknown, [CreateManyArgs]>();
    const transaction = {
      $executeRaw: jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(1),
      bikePosition: { createMany },
    };
    const prisma = {
      bike: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce({ id: 'bike-1' })
          .mockResolvedValueOnce(bikeRow),
      },
      $transaction: jest.fn(
        async (callback: (client: typeof transaction) => Promise<boolean>) =>
          callback(transaction),
      ),
    } as unknown as PrismaService;
    const service = new TrackingService(prisma, configWithTimeout());
    const received: BikeStatusDto[] = [];
    service.watchPositionUpdates().subscribe((update) => received.push(update));

    await service.handleDevicePositions(event);

    const createManyCall = createMany.mock.calls[0]?.[0];
    expect(createManyCall?.data[0]).toEqual({
      ...createManyCall?.data[0],
      bikeId: 'bike-1',
      recordedAt: position.timestamp,
      speed: 0,
      ignition: false,
    });
    expect(createManyCall?.skipDuplicates).toBe(true);
    expect(transaction.$executeRaw).toHaveBeenCalledTimes(2);
    expect(received).toHaveLength(1);
    expect(received[0]?.bikeId).toBe('bike-1');
    expect(received[0]?.current?.speed).toBe(0);
    expect(received[0]?.current?.ignition).toBe(false);
    service.onModuleDestroy();
  });

  it('does not publish a stale record when the current-position upsert changes no row', async () => {
    const transaction = {
      $executeRaw: jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(0),
      bikePosition: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    const prisma = {
      bike: { findUnique: jest.fn().mockResolvedValue({ id: 'bike-1' }) },
      $transaction: jest.fn(
        async (callback: (client: typeof transaction) => Promise<boolean>) =>
          callback(transaction),
      ),
    } as unknown as PrismaService;
    const service = new TrackingService(prisma, configWithTimeout());
    const received: BikeStatusDto[] = [];
    service.watchPositionUpdates().subscribe((update) => received.push(update));

    await service.handleDevicePositions(event);

    expect(received).toHaveLength(0);
    service.onModuleDestroy();
  });

  describe('choosing the record that becomes current', () => {
    type ExecuteRaw = jest.Mock<
      Promise<number>,
      [TemplateStringsArray, ...unknown[]]
    >;

    function serviceCapturingUpsert(): {
      service: TrackingService;
      executeRaw: ExecuteRaw;
    } {
      const executeRaw: ExecuteRaw = jest.fn<
        Promise<number>,
        [TemplateStringsArray, ...unknown[]]
      >(() => Promise.resolve(1));
      const transaction = {
        $executeRaw: executeRaw,
        bikePosition: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
      };
      const prisma = {
        bike: {
          findUnique: jest
            .fn()
            .mockResolvedValue(bikeRow)
            .mockResolvedValueOnce({ id: 'bike-1' }),
        },
        $transaction: jest.fn(
          async (callback: (client: typeof transaction) => Promise<boolean>) =>
            callback(transaction),
        ),
      } as unknown as PrismaService;
      return {
        service: new TrackingService(prisma, configWithTimeout()),
        executeRaw,
      };
    }

    /** The upsert is the second raw statement; its second value is recordedAt. */
    function upsertedRecordedAt(executeRaw: ExecuteRaw): unknown {
      return executeRaw.mock.calls[1]?.[2];
    }

    it('uses the newest record by device time, not the last one in the packet', async () => {
      const { service, executeRaw } = serviceCapturingUpsert();
      const receivedAt = new Date('2026-09-29T12:10:00.000Z');
      const newest = new Date('2026-09-29T12:05:00.000Z');

      await service.handleDevicePositions({
        imei: event.imei,
        receivedAt,
        records: [
          { ...position, timestamp: newest, speed: 40 },
          { ...position, timestamp: new Date('2026-09-29T12:01:00.000Z') },
        ],
      });

      expect(upsertedRecordedAt(executeRaw)).toEqual(newest);
      service.onModuleDestroy();
    });

    it('never lets a future-dated record become current', async () => {
      const { service, executeRaw } = serviceCapturingUpsert();
      const receivedAt = new Date('2026-09-29T12:10:00.000Z');
      const genuine = new Date('2026-09-29T12:09:59.000Z');

      await service.handleDevicePositions({
        imei: event.imei,
        receivedAt,
        records: [
          { ...position, timestamp: genuine, speed: 35, ignition: true },
          { ...position, timestamp: new Date('2080-01-01T00:00:00.000Z') },
        ],
      });

      expect(upsertedRecordedAt(executeRaw)).toEqual(genuine);
      service.onModuleDestroy();
    });
  });

  it('keeps simultaneous bikes independent', async () => {
    type CreateManyArgs = { data: Array<{ bikeId: string }> };
    const createMany = jest.fn<unknown, [CreateManyArgs]>();
    const transaction = {
      $executeRaw: jest.fn().mockResolvedValue(0),
      bikePosition: { createMany },
    };
    const bikesByImei: Record<string, { id: string }> = {
      '356307042441013': { id: 'bike-1' },
      '356307042441014': { id: 'bike-2' },
    };
    const findUnique = jest.fn(
      (args: { where: { imei: string } }) => bikesByImei[args.where.imei],
    );
    const prisma = {
      bike: { findUnique },
      $transaction: jest.fn(
        async (callback: (client: typeof transaction) => Promise<boolean>) =>
          callback(transaction),
      ),
    } as unknown as PrismaService;
    const service = new TrackingService(prisma, configWithTimeout());

    await Promise.all([
      service.handleDevicePositions({ ...event, imei: '356307042441013' }),
      service.handleDevicePositions({ ...event, imei: '356307042441014' }),
    ]);

    const bikeIds = createMany.mock.calls
      .flatMap(([args]) => args.data.map((row) => row.bikeId))
      .sort();
    expect(bikeIds).toEqual(['bike-1', 'bike-2']);
    service.onModuleDestroy();
  });

  it('rejects a second bike with an already registered IMEI as a conflict', async () => {
    const prisma = {
      bike: {
        create: jest.fn().mockRejectedValue(
          new Prisma.PrismaClientKnownRequestError('Unique constraint', {
            code: 'P2002',
            clientVersion: 'test',
          }),
        ),
      },
    } as unknown as PrismaService;
    const service = new TrackingService(prisma, configWithTimeout());

    await expect(
      service.registerBike({ label: 'Bike 8', imei: event.imei }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('returns an explicit empty and offline status before the first report', async () => {
    const prisma = {
      bike: {
        findUnique: jest.fn().mockResolvedValue({
          ...bikeRow,
          lastReportedAt: null,
          currentPosition: null,
        }),
      },
    } as unknown as PrismaService;
    const service = new TrackingService(prisma, configWithTimeout());

    await expect(service.getBikeStatus('bike-1')).resolves.toMatchObject({
      bikeId: 'bike-1',
      current: null,
      lastReportedAt: null,
      online: false,
    });
  });

  it('pushes an offline status when a bike exceeds the quiet period', async () => {
    jest.useFakeTimers();
    const receivedAt = new Date();
    const reportedBike = {
      ...bikeRow,
      lastReportedAt: receivedAt,
    };
    const transaction = {
      $executeRaw: jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(1),
      bikePosition: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const prisma = {
      bike: {
        findUnique: jest
          .fn()
          .mockResolvedValue(reportedBike)
          .mockResolvedValueOnce({ id: 'bike-1' }),
      },
      $transaction: jest.fn(
        async (callback: (client: typeof transaction) => Promise<boolean>) =>
          callback(transaction),
      ),
    } as unknown as PrismaService;
    const service = new TrackingService(prisma, configWithTimeout(1));
    const received: BikeStatusDto[] = [];
    service.watchPositionUpdates().subscribe((update) => received.push(update));

    await service.handleDevicePositions({ ...event, receivedAt });
    expect(received[0]?.online).toBe(true);

    await jest.advanceTimersByTimeAsync(1002);

    expect(received.map((status) => status.online)).toEqual([true, false]);
    service.onModuleDestroy();
    jest.useRealTimers();
  });

  it('returns history in timestamp order with the requested inclusive window', async () => {
    const positions = [{ id: 'position-1', ...position, bikeId: 'bike-1' }];
    const prisma = {
      bike: { findUnique: jest.fn().mockResolvedValue({ id: 'bike-1' }) },
      bikePosition: { findMany: jest.fn().mockResolvedValue(positions) },
    } as unknown as PrismaService;
    const service = new TrackingService(prisma, configWithTimeout());
    const from = new Date('2026-09-29T11:00:00.000Z');
    const to = new Date('2026-09-29T13:00:00.000Z');

    await expect(
      service.getPositionHistory('bike-1', from, to, 100),
    ).resolves.toEqual(positions);
    const findMany = prisma.bikePosition.findMany as unknown as jest.Mock<
      unknown,
      [
        {
          where: unknown;
          orderBy: unknown;
          take: number;
          select: Record<string, boolean>;
        },
      ]
    >;
    const query = findMany.mock.calls[0]?.[0];
    expect(query?.where).toEqual({
      bikeId: 'bike-1',
      recordedAt: { gte: from, lte: to },
    });
    expect(query?.orderBy).toEqual({ recordedAt: 'asc' });
    expect(query?.take).toBe(100);
    expect(query?.select.bikeId).toBeUndefined();
  });

  it('gives Enforcement a nullable, freshness-aware safety snapshot', async () => {
    const prisma = {
      bike: {
        findUnique: jest.fn().mockResolvedValue({
          lastReportedAt: new Date(),
          currentPosition: {
            recordedAt: position.timestamp,
            speed: position.speed,
            ignition: null,
            movement: position.movement,
            hasFix: position.hasFix,
          },
        }),
      },
    } as unknown as PrismaService;
    const service = new TrackingService(prisma, configWithTimeout());

    await expect(service.getSafetySnapshot('bike-1')).resolves.toMatchObject({
      bikeId: 'bike-1',
      speed: 0,
      ignition: null,
      hasFix: true,
      online: true,
    });
  });

  it('returns null to Enforcement when there is no current telemetry', async () => {
    const prisma = {
      bike: {
        findUnique: jest.fn().mockResolvedValue({
          lastReportedAt: null,
          currentPosition: null,
        }),
      },
    } as unknown as PrismaService;
    const service = new TrackingService(prisma, configWithTimeout());

    await expect(service.getSafetySnapshot('bike-1')).resolves.toBeNull();
  });
});
