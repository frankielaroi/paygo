import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { Observable, Subject } from 'rxjs';
import type { Env } from '../config/env.validation';
import { PrismaService } from '../prisma/prisma.service';
import type { DevicePosition } from '../tcp/codec8-parser';
import { DEVICE_POSITIONS, type DevicePositionsEvent } from '../tcp/tcp.events';
import { BikePositionDto } from './dto/bike-position.dto';
import { BikeStatusDto } from './dto/bike-status.dto';

/**
 * How far ahead of the server clock a device timestamp may be and still become the current
 * position. The current row only ever moves forward in time, so a single record from a
 * glitched future clock would otherwise pin it: every genuine record after it looks older and
 * is discarded, while lastReportedAt stays fresh and the bike reads as online and stationary.
 */
const MAX_DEVICE_CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * The facts Enforcement reads before deciding anything. Two clocks are deliberately separate:
 *
 * - `recordedAt` is the device timestamp of the telemetry below. A device replaying a stored
 *   backlog after reconnecting can be online while this is hours old.
 * - `lastReportedAt` / `online` say when the server last heard from the device at all.
 *
 * A stationary reading is only as good as `recordedAt` is recent. `ignition` and `movement`
 * are null when the device did not report them, which means unknown, not off.
 */
/** One historical reading, reduced to what a stationary check needs. */
export interface SafetyReading {
  recordedAt: Date;
  speed: number;
  ignition: boolean | null;
  movement: boolean | null;
  hasFix: boolean;
}

export interface TrackingSafetySnapshot {
  bikeId: string;
  speed: number;
  ignition: boolean | null;
  movement: boolean | null;
  hasFix: boolean;
  recordedAt: Date;
  /** Server time at which the reading above arrived. */
  receivedAt: Date;
  lastReportedAt: Date;
  online: boolean;
}

@Injectable()
export class TrackingService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(TrackingService.name);
  private readonly positionUpdates = new Subject<BikeStatusDto>();
  private readonly offlineTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      const bikes = await this.prisma.bike.findMany({
        where: { lastReportedAt: { not: null } },
        select: { id: true, lastReportedAt: true },
      });

      for (const bike of bikes) {
        if (bike.lastReportedAt) {
          this.scheduleOfflineNotification(bike.id, bike.lastReportedAt);
        }
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(`Could not restore bike offline timers: ${detail}`);
    }
  }

  @OnEvent(DEVICE_POSITIONS)
  async handleDevicePositions(event: DevicePositionsEvent): Promise<void> {
    try {
      const bike = await this.prisma.bike.findUnique({
        where: { imei: event.imei },
        select: { id: true },
      });

      if (!bike) {
        this.logger.warn(`Position event from unregistered IMEI ${event.imei}`);
        return;
      }

      const currentChanged = await this.prisma.$transaction(
        async (transaction) => {
          await transaction.$executeRaw`
          UPDATE "bikes"
          SET "lastReportedAt" = GREATEST(
            COALESCE("lastReportedAt", ${event.receivedAt}),
            ${event.receivedAt}
          )
          WHERE "id" = ${bike.id}::uuid
        `;

          await transaction.bikePosition.createMany({
            data: event.records.map((record) =>
              this.historyData(bike.id, event.receivedAt, record),
            ),
            skipDuplicates: true,
          });

          const latestAcceptable =
            event.receivedAt.getTime() + MAX_DEVICE_CLOCK_SKEW_MS;
          const latestRecord = event.records.reduce<DevicePosition | null>(
            (latest, record) => {
              if (record.timestamp.getTime() > latestAcceptable) {
                this.logger.warn(
                  `IMEI ${event.imei} sent a record dated ${record.timestamp.toISOString()}, ` +
                    'ahead of the server clock; kept in history, not used as current',
                );
                return latest;
              }
              return !latest || record.timestamp > latest.timestamp
                ? record
                : latest;
            },
            null,
          );

          if (!latestRecord) {
            return false;
          }

          const affected = await transaction.$executeRaw`
            INSERT INTO "bike_current_positions" (
              "bikeId", "recordedAt", "receivedAt", "latitude", "longitude",
              "altitude", "angle", "satellites", "speed", "ignition", "movement", "hasFix"
            ) VALUES (
              ${bike.id}::uuid, ${latestRecord.timestamp}, ${event.receivedAt},
              ${latestRecord.latitude}, ${latestRecord.longitude}, ${latestRecord.altitude},
              ${latestRecord.angle}, ${latestRecord.satellites}, ${latestRecord.speed},
              ${latestRecord.ignition}, ${latestRecord.movement}, ${latestRecord.hasFix}
            )
            ON CONFLICT ("bikeId") DO UPDATE SET
              "recordedAt" = EXCLUDED."recordedAt",
              "receivedAt" = EXCLUDED."receivedAt",
              "latitude" = EXCLUDED."latitude",
              "longitude" = EXCLUDED."longitude",
              "altitude" = EXCLUDED."altitude",
              "angle" = EXCLUDED."angle",
              "satellites" = EXCLUDED."satellites",
              "speed" = EXCLUDED."speed",
              "ignition" = EXCLUDED."ignition",
              "movement" = EXCLUDED."movement",
              "hasFix" = EXCLUDED."hasFix"
            WHERE "bike_current_positions"."recordedAt" < EXCLUDED."recordedAt"
          `;

          return affected > 0;
        },
      );

      this.scheduleOfflineNotification(bike.id, event.receivedAt);

      if (currentChanged) {
        this.positionUpdates.next(await this.getBikeStatus(bike.id));
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Could not process positions from IMEI ${event.imei}: ${detail}`,
      );
    }
  }

  async listBikeStatuses(): Promise<BikeStatusDto[]> {
    const bikes = await this.prisma.bike.findMany({
      select: {
        id: true,
        imei: true,
        label: true,
        registrationNumber: true,
        lastReportedAt: true,
        currentPosition: true,
      },
      orderBy: { label: 'asc' },
    });

    return bikes.map((bike) => this.toBikeStatus(bike));
  }

  async getBikeStatus(bikeId: string): Promise<BikeStatusDto> {
    const bike = await this.prisma.bike.findUnique({
      where: { id: bikeId },
      select: {
        id: true,
        imei: true,
        label: true,
        registrationNumber: true,
        lastReportedAt: true,
        currentPosition: true,
      },
    });

    if (!bike) {
      throw new NotFoundException('Bike not found');
    }

    return this.toBikeStatus(bike);
  }

  async getPositionHistory(
    bikeId: string,
    from: Date,
    to: Date,
    limit: number,
  ): Promise<BikePositionDto[]> {
    if (from > to) {
      throw new BadRequestException('from must be earlier than or equal to to');
    }

    const bike = await this.prisma.bike.findUnique({
      where: { id: bikeId },
      select: { id: true },
    });

    if (!bike) {
      throw new NotFoundException('Bike not found');
    }

    return this.prisma.bikePosition.findMany({
      where: { bikeId, recordedAt: { gte: from, lte: to } },
      orderBy: { recordedAt: 'asc' },
      take: limit,
      select: {
        id: true,
        recordedAt: true,
        receivedAt: true,
        latitude: true,
        longitude: true,
        altitude: true,
        angle: true,
        satellites: true,
        speed: true,
        ignition: true,
        movement: true,
        hasFix: true,
      },
    });
  }

  async getSafetySnapshot(
    bikeId: string,
  ): Promise<TrackingSafetySnapshot | null> {
    const bike = await this.prisma.bike.findUnique({
      where: { id: bikeId },
      select: {
        lastReportedAt: true,
        currentPosition: {
          select: {
            recordedAt: true,
            receivedAt: true,
            speed: true,
            ignition: true,
            movement: true,
            hasFix: true,
          },
        },
      },
    });

    if (!bike?.currentPosition || !bike.lastReportedAt) {
      return null;
    }

    return {
      bikeId,
      ...bike.currentPosition,
      lastReportedAt: bike.lastReportedAt,
      online: this.isOnline(bike.lastReportedAt),
    };
  }

  /**
   * The readings Enforcement needs to judge whether a bike has been stopped since `from`: the
   * last reading at or before `from` (the anchor, proving the state at the start of the window)
   * and every reading after it up to `to`, oldest first. Judging them is Enforcement's job.
   */
  async getSafetyWindow(
    bikeId: string,
    from: Date,
    to: Date,
  ): Promise<{ anchor: SafetyReading | null; readings: SafetyReading[] }> {
    const select = {
      recordedAt: true,
      speed: true,
      ignition: true,
      movement: true,
      hasFix: true,
    } as const;

    const [anchor, readings] = await Promise.all([
      this.prisma.bikePosition.findFirst({
        where: { bikeId, recordedAt: { lte: from } },
        orderBy: { recordedAt: 'desc' },
        select,
      }),
      this.prisma.bikePosition.findMany({
        where: { bikeId, recordedAt: { gt: from, lte: to } },
        orderBy: { recordedAt: 'asc' },
        select,
      }),
    ]);

    return { anchor, readings };
  }

  watchPositionUpdates(): Observable<BikeStatusDto> {
    return this.positionUpdates.asObservable();
  }

  onModuleDestroy(): void {
    for (const timer of this.offlineTimers.values()) {
      clearTimeout(timer);
    }
    this.offlineTimers.clear();
    this.positionUpdates.complete();
  }

  private scheduleOfflineNotification(
    bikeId: string,
    lastReportedAt: Date,
  ): void {
    const existing = this.offlineTimers.get(bikeId);

    if (existing) {
      clearTimeout(existing);
    }

    const timeoutMs =
      this.config.get('TRACKING_OFFLINE_AFTER_SECONDS', { infer: true }) * 1000;
    const delay = Math.max(
      0,
      lastReportedAt.getTime() + timeoutMs - Date.now() + 1,
    );
    const timer = setTimeout(() => {
      this.offlineTimers.delete(bikeId);
      void this.publishOfflineStatus(bikeId);
    }, delay);

    timer.unref();
    this.offlineTimers.set(bikeId, timer);
  }

  private async publishOfflineStatus(bikeId: string): Promise<void> {
    try {
      const status = await this.getBikeStatus(bikeId);

      if (status.online && status.lastReportedAt) {
        this.scheduleOfflineNotification(bikeId, status.lastReportedAt);
        return;
      }

      this.positionUpdates.next(status);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Could not publish offline status for bike ${bikeId}: ${detail}`,
      );
    }
  }

  private isOnline(lastReportedAt: Date | null): boolean {
    if (!lastReportedAt) {
      return false;
    }

    const timeoutMs =
      this.config.get('TRACKING_OFFLINE_AFTER_SECONDS', { infer: true }) * 1000;

    return Date.now() - lastReportedAt.getTime() <= timeoutMs;
  }

  private toBikeStatus(bike: {
    id: string;
    imei: string | null;
    label: string;
    registrationNumber: string | null;
    lastReportedAt: Date | null;
    currentPosition: {
      recordedAt: Date;
      receivedAt: Date;
      latitude: number;
      longitude: number;
      altitude: number;
      angle: number;
      satellites: number;
      speed: number;
      ignition: boolean | null;
      movement: boolean | null;
      hasFix: boolean;
    } | null;
  }): BikeStatusDto {
    return {
      bikeId: bike.id,
      label: bike.label,
      imei: bike.imei,
      registrationNumber: bike.registrationNumber,
      lastReportedAt: bike.lastReportedAt,
      online: this.isOnline(bike.lastReportedAt),
      current: bike.currentPosition,
    };
  }

  private historyData(
    bikeId: string,
    receivedAt: Date,
    record: DevicePosition,
  ) {
    return {
      bikeId,
      recordedAt: record.timestamp,
      receivedAt,
      latitude: record.latitude,
      longitude: record.longitude,
      altitude: record.altitude,
      angle: record.angle,
      satellites: record.satellites,
      speed: record.speed,
      ignition: record.ignition,
      movement: record.movement,
      hasFix: record.hasFix,
    };
  }
}
