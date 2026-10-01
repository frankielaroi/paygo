import { ConfigService } from '@nestjs/config';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import { Subject } from 'rxjs';
import type { AuthenticatedStaff } from '../common/types/authenticated-staff';
import type { Env } from '../config/env.validation';
import type {
  BikeEnforcement,
  EnforcementEvent,
} from '../generated/prisma/client';
import {
  DesiredStateSource,
  EnforcementEventType,
  MobilityState,
  StaffRole,
} from '../generated/prisma/enums';
import type { PrismaService } from '../prisma/prisma.service';
import type {
  CommandResult,
  TcpServerService,
} from '../tcp/tcp-server.service';
import type { DeviceCommand } from '../tcp/command-encoder';
import type { BikeStatusDto } from '../tracking/dto/bike-status.dto';
import type {
  SafetyReading,
  TrackingSafetySnapshot,
  TrackingService,
} from '../tracking/tracking.service';
import type { ArrearsSource, OverdueBike } from './arrears-source';
import {
  ENFORCEMENT_REVIEW_FLAGGED,
  ENFORCEMENT_STATE_CONFIRMED,
} from './enforcement.events';
import { EnforcementService } from './enforcement.service';

const BIKE_ID = '00000000-0000-4000-8000-000000000001';
const IMEI = '356307042441013';
const ADMIN_ID = '00000000-0000-4000-8000-0000000000aa';
const ADMIN: AuthenticatedStaff = {
  kind: 'staff',
  id: ADMIN_ID,
  email: 'admin@paygo.test',
  role: StaffRole.ADMIN,
  mustChangePassword: false,
};

type Where = Record<string, unknown>;

function matches(row: Record<string, unknown>, where: Where): boolean {
  return Object.entries(where).every(([key, expected]) => {
    const actual = row[key];
    if (
      expected !== null &&
      typeof expected === 'object' &&
      !(expected instanceof Date) &&
      'not' in expected
    ) {
      return actual !== expected.not;
    }
    if (expected instanceof Date || actual instanceof Date) {
      return (
        actual instanceof Date &&
        expected instanceof Date &&
        actual.getTime() === expected.getTime()
      );
    }
    return actual === expected;
  });
}

/**
 * Just enough of Prisma for the enforcement service, with real semantics where they matter:
 * conditional updateMany counts, and a $transaction that rolls back when its callback throws.
 * A double that commits on throw would let a rollback bug pass (see CLAUDE.md).
 */
class FakeDb {
  rows = new Map<string, BikeEnforcement>();
  events: EnforcementEvent[] = [];
  bikes = new Map([[BIKE_ID, { id: BIKE_ID, imei: IMEI }]]);

  readonly client = {
    bike: {
      findUnique: ({ where }: { where: { id?: string; imei?: string } }) =>
        Promise.resolve(
          [...this.bikes.values()].find(
            (bike) =>
              (where.id === undefined || bike.id === where.id) &&
              (where.imei === undefined || bike.imei === where.imei),
          ) ?? null,
        ),
    },
    bikeEnforcement: {
      findUnique: ({
        where,
        include,
      }: {
        where: { bikeId: string };
        include?: unknown;
      }) => {
        const row = this.rows.get(where.bikeId);
        if (!row) {
          return Promise.resolve(null);
        }
        const copy = { ...row };
        return Promise.resolve(
          include ? { ...copy, bike: this.bikes.get(row.bikeId) } : copy,
        );
      },
      findMany: ({ where = {} }: { where?: Where } = {}) =>
        Promise.resolve(
          [...this.rows.values()]
            .filter((row) => matches(row, where))
            .map((row) => ({ ...row })),
        ),
      upsert: ({
        where,
        create,
        update,
      }: {
        where: { bikeId: string };
        create: Partial<BikeEnforcement> & { bikeId: string };
        update: Partial<BikeEnforcement>;
      }) => {
        const existing = this.rows.get(where.bikeId);
        const next: BikeEnforcement = existing
          ? { ...existing, ...update, updatedAt: new Date() }
          : {
              desiredState: MobilityState.MOBILE,
              desiredSource: DesiredStateSource.ARREARS,
              confirmedState: null,
              confirmedAt: null,
              pendingCommand: null,
              pendingSentAt: null,
              blockedReason: null,
              reviewReason: null,
              reviewSince: null,
              updatedAt: new Date(),
              ...create,
            };
        this.rows.set(where.bikeId, next);
        return Promise.resolve({ ...next });
      },
      update: ({
        where,
        data,
      }: {
        where: { bikeId: string };
        data: Partial<BikeEnforcement>;
      }) => {
        const existing = this.rows.get(where.bikeId);
        if (!existing) {
          return Promise.reject(new Error('Record not found'));
        }
        const next = { ...existing, ...data };
        this.rows.set(where.bikeId, next);
        return Promise.resolve({ ...next });
      },
      updateMany: ({
        where,
        data,
      }: {
        where: Where;
        data: Partial<BikeEnforcement>;
      }) => {
        let count = 0;
        for (const [key, row] of this.rows) {
          if (matches(row, where)) {
            this.rows.set(key, { ...row, ...data });
            count += 1;
          }
        }
        return Promise.resolve({ count });
      },
    },
    enforcementEvent: {
      create: ({ data }: { data: Partial<EnforcementEvent> }) => {
        const event = {
          id: `event-${this.events.length + 1}`,
          actorUserId: null,
          fromState: null,
          toState: null,
          telemetry: null,
          detail: null,
          deviceResponse: null,
          createdAt: new Date(),
          ...data,
        } as EnforcementEvent;
        this.events.push(event);
        return Promise.resolve(event);
      },
      findMany: () => Promise.resolve([...this.events].reverse()),
    },
    $transaction: async <T>(
      callback: (tx: unknown) => Promise<T>,
    ): Promise<T> => {
      const rows = new Map(
        [...this.rows].map(([key, row]) => [key, { ...row }]),
      );
      const events = [...this.events];
      try {
        return await callback(this.client);
      } catch (error) {
        this.rows = rows;
        this.events = events;
        throw error;
      }
    },
  };

  row(): BikeEnforcement | undefined {
    return this.rows.get(BIKE_ID);
  }

  eventTypes(): EnforcementEventType[] {
    return this.events.map((event) => event.type);
  }
}

class FakeDevices {
  connected: Date | null = null;
  readonly sendCommand = jest.fn<CommandResult, [string, DeviceCommand]>(
    (_imei, command) =>
      this.connected
        ? {
            delivered: true,
            command,
            text: `setdigout ${command === 'immobilize' ? 1 : 0}`,
          }
        : { delivered: false, reason: 'not-connected' },
  );

  isConnected(): boolean {
    return this.connected !== null;
  }

  connectedSince(): Date | null {
    return this.connected;
  }

  commands(): DeviceCommand[] {
    return this.sendCommand.mock.calls.map(([, command]) => command);
  }
}

class FakeTracking {
  snapshot: TrackingSafetySnapshot | null = null;
  window: { anchor: SafetyReading | null; readings: SafetyReading[] } = {
    anchor: null,
    readings: [],
  };
  readonly updates = new Subject<BikeStatusDto>();

  getSafetySnapshot(): Promise<TrackingSafetySnapshot | null> {
    return Promise.resolve(this.snapshot);
  }

  getSafetyWindow(): Promise<{
    anchor: SafetyReading | null;
    readings: SafetyReading[];
  }> {
    return Promise.resolve(this.window);
  }

  watchPositionUpdates(): Subject<BikeStatusDto> {
    return this.updates;
  }

  /** A bike parked for ten minutes, reading received just now on the current connection. */
  parked(): void {
    const now = Date.now();
    const reading: SafetyReading = {
      recordedAt: new Date(now - 1000),
      speed: 0,
      ignition: false,
      movement: false,
      hasFix: true,
    };
    this.snapshot = {
      bikeId: BIKE_ID,
      ...reading,
      receivedAt: new Date(now),
      lastReportedAt: new Date(now),
      online: true,
    };
    this.window = {
      anchor: { ...reading, recordedAt: new Date(now - 600_000) },
      readings: [reading],
    };
  }

  riding(): void {
    this.parked();
    if (this.snapshot) {
      this.snapshot = { ...this.snapshot, speed: 35, ignition: true };
    }
  }
}

const settings: Partial<Env> = {
  IMMOBILIZE_STATIONARY_SECONDS: 120,
  ENFORCEMENT_MAX_TELEMETRY_AGE_SECONDS: 300,
  ENFORCEMENT_COMMAND_RETRY_SECONDS: 300,
  ENFORCEMENT_SWEEP_INTERVAL_SECONDS: 900,
};

function setup(overdue: OverdueBike[] = []) {
  const db = new FakeDb();
  const devices = new FakeDevices();
  const tracking = new FakeTracking();
  const arrears: ArrearsSource = {
    findOverdue: () => Promise.resolve(overdue),
  };
  const config = {
    get: (key: keyof Env) => settings[key],
  } as unknown as ConfigService<Env, true>;
  const emit = jest.fn<boolean, [string, unknown]>(() => true);
  const service = new EnforcementService(
    db.client as unknown as PrismaService,
    config,
    tracking as unknown as TrackingService,
    devices as unknown as TcpServerService,
    arrears,
    { emit } as unknown as EventEmitter2,
  );
  return { db, devices, tracking, service, emit };
}

function reply(service: EnforcementService, text: string): Promise<void> {
  return service.handleCommandResponse({
    imei: IMEI,
    text,
    receivedAt: new Date(),
  });
}

const overdueBike: OverdueBike = {
  bikeId: BIKE_ID,
  detail: { daysOverdue: 9, contract: 'C-1' },
  lockable: true,
};

describe('EnforcementService', () => {
  describe('the warning gate', () => {
    it('does not lock an overdue bike whose rider has not been warned long enough', async () => {
      const { db, devices, tracking, service } = setup([
        { ...overdueBike, lockable: false },
      ]);
      tracking.parked();
      devices.connected = new Date(Date.now() - 60_000);

      await service.sweep();

      expect(devices.sendCommand).not.toHaveBeenCalled();
      expect(db.row()).toBeUndefined();
    });

    it('does not restore a locked bike that is still overdue but awaiting a new warning', async () => {
      const findings: OverdueBike[] = [overdueBike];
      const { db, devices, tracking, service } = setup(findings);
      tracking.parked();
      devices.connected = new Date(Date.now() - 60_000);
      await service.sweep();
      await reply(service, 'Setdigout 1 OK');

      findings[0] = { ...overdueBike, lockable: false };
      await service.sweep();

      expect(db.row()?.desiredState).toBe(MobilityState.IMMOBILIZED);
      expect(devices.commands()).toEqual(['immobilize']);
    });
  });

  describe('announcements', () => {
    type Emitted = [string, { toState?: string; fromState?: string | null }];

    it('announces a confirmed change of state, once, after it is recorded', async () => {
      const { devices, tracking, service, emit } = setup([overdueBike]);
      tracking.parked();
      devices.connected = new Date(Date.now() - 60_000);
      await service.sweep();

      await reply(service, 'Setdigout 1 OK');
      await reply(service, 'Setdigout 1 OK'); // same state again: not news

      const confirmed = (emit.mock.calls as Emitted[]).filter(
        ([name]) => name === ENFORCEMENT_STATE_CONFIRMED,
      );
      expect(confirmed).toHaveLength(1);
      expect(confirmed[0]?.[1]).toMatchObject({
        fromState: null,
        toState: MobilityState.IMMOBILIZED,
      });
    });

    it('announces a bike flagged for review, once', async () => {
      const { tracking, service, emit } = setup([overdueBike]);
      tracking.parked();
      if (tracking.snapshot) {
        tracking.snapshot = { ...tracking.snapshot, online: false };
      }

      await service.sweep();
      await service.sweep();

      expect(
        emit.mock.calls.filter(([name]) => name === ENFORCEMENT_REVIEW_FLAGGED),
      ).toHaveLength(1);
    });
  });

  describe('the scheduled sweep', () => {
    it('immobilizes an overdue bike that is parked', async () => {
      const { db, devices, tracking, service } = setup([overdueBike]);
      tracking.parked();
      devices.connected = new Date(Date.now() - 60_000);

      await service.sweep();

      expect(devices.commands()).toEqual(['immobilize']);
      expect(db.row()?.pendingCommand).toBe(MobilityState.IMMOBILIZED);
      expect(db.eventTypes()).toEqual([
        EnforcementEventType.DESIRED_STATE_CHANGED,
        EnforcementEventType.COMMAND_SENT,
      ]);
      expect(db.events[0]?.detail).toEqual(overdueBike.detail);
      expect(db.events[1]?.telemetry).toMatchObject({
        speed: 0,
        ignition: false,
      });
    });

    it('does not immobilize a bike being ridden, and defers it once, not every sweep', async () => {
      const { db, devices, tracking, service } = setup([overdueBike]);
      tracking.riding();
      devices.connected = new Date(Date.now() - 60_000);

      await service.sweep();
      await service.sweep();
      await service.sweep();

      expect(devices.sendCommand).not.toHaveBeenCalled();
      expect(db.eventTypes()).toEqual([
        EnforcementEventType.DESIRED_STATE_CHANGED,
        EnforcementEventType.COMMAND_DEFERRED,
      ]);
      expect(db.row()?.blockedReason).toBe('interlock:moving');
      expect(db.row()?.reviewReason).toBeNull();
    });

    it('flags a bike with stale telemetry for review instead of acting on it', async () => {
      const { db, devices, tracking, service } = setup([overdueBike]);
      tracking.parked();
      if (tracking.snapshot) {
        tracking.snapshot = { ...tracking.snapshot, online: false };
      }

      await service.sweep();
      await service.sweep();

      expect(devices.sendCommand).not.toHaveBeenCalled();
      expect(db.row()?.reviewReason).toBe('interlock:offline');
      expect(db.eventTypes()).toEqual([
        EnforcementEventType.DESIRED_STATE_CHANGED,
        EnforcementEventType.COMMAND_DEFERRED,
        EnforcementEventType.REVIEW_FLAGGED,
      ]);
      await expect(service.listForReview()).resolves.toHaveLength(1);
    });

    it('sends no second command and writes no second entry when run twice', async () => {
      const { db, devices, tracking, service } = setup([overdueBike]);
      tracking.parked();
      devices.connected = new Date(Date.now() - 60_000);

      await service.sweep();
      const eventsAfterFirst = db.events.length;
      await service.sweep();

      expect(devices.commands()).toEqual(['immobilize']);
      expect(db.events).toHaveLength(eventsAfterFirst);
    });

    it('restores a bike that is no longer overdue', async () => {
      const overdue: OverdueBike[] = [overdueBike];
      const { db, devices, tracking, service } = setup(overdue);
      tracking.parked();
      devices.connected = new Date(Date.now() - 60_000);
      await service.sweep();
      await reply(service, 'Setdigout 1 OK');

      overdue.length = 0;
      tracking.riding(); // restore is ungated: the bike's state does not matter
      await service.sweep();

      expect(devices.commands()).toEqual(['immobilize', 'restore']);
      expect(db.row()?.desiredState).toBe(MobilityState.MOBILE);
    });
  });

  describe('confirmation', () => {
    it('does not treat a successful write as confirmation', async () => {
      const { db, devices, tracking, service } = setup([overdueBike]);
      tracking.parked();
      devices.connected = new Date(Date.now() - 60_000);

      await service.sweep();

      expect(db.row()?.confirmedState).toBeNull();
      expect(db.row()?.pendingCommand).toBe(MobilityState.IMMOBILIZED);
    });

    it('confirms from the device reply and clears the pending command', async () => {
      const { db, devices, tracking, service } = setup([overdueBike]);
      tracking.parked();
      devices.connected = new Date(Date.now() - 60_000);
      await service.sweep();

      await reply(service, 'Setdigout 1 OK (Relay OFF / Immobilized)');

      expect(db.row()?.confirmedState).toBe(MobilityState.IMMOBILIZED);
      expect(db.row()?.pendingCommand).toBeNull();
      expect(db.events.at(-1)?.deviceResponse).toContain('Setdigout 1');
    });

    it('records an unreadable reply without confirming anything', async () => {
      const { db, devices, tracking, service } = setup([overdueBike]);
      tracking.parked();
      devices.connected = new Date(Date.now() - 60_000);
      await service.sweep();

      await reply(service, 'Command executed');

      expect(db.row()?.confirmedState).toBeNull();
      expect(db.eventTypes()).toContain(
        EnforcementEventType.RESPONSE_UNRECOGNIZED,
      );
    });

    it('logs a command to a disconnected device as failed, not sent', async () => {
      const { db, devices, service } = setup();
      devices.connected = null;

      await service.setDesiredStateByStaff(
        BIKE_ID,
        MobilityState.MOBILE,
        ADMIN,
        'Unlock requested by branch',
      );

      expect(devices.sendCommand).not.toHaveBeenCalled();
      expect(db.row()?.blockedReason).toBe('device-not-connected');
      expect(db.row()?.pendingCommand).toBeNull();
      expect(db.eventTypes()).toContain(EnforcementEventType.COMMAND_FAILED);
      expect(db.eventTypes()).not.toContain(EnforcementEventType.COMMAND_SENT);
    });
  });

  describe('over time', () => {
    it('does not immobilize on reconnect while ridden, then does once stopped', async () => {
      const { devices, tracking, service } = setup([overdueBike]);
      service.onApplicationBootstrap();
      tracking.riding();
      await service.sweep(); // desired IMMOBILIZED while the device is away

      devices.connected = new Date();
      await service.handleDeviceConnected({
        imei: IMEI,
        remoteAddress: '10.0.0.1',
        connectedAt: devices.connected,
      });
      expect(devices.sendCommand).not.toHaveBeenCalled();

      tracking.parked();
      await service.reconcile(BIKE_ID, 'telemetry');
      expect(devices.commands()).toEqual(['immobilize']);
      service.onModuleDestroy();
    });

    it('never immobilizes at reconnect on a reading taken before the connection', async () => {
      const { devices, tracking, service } = setup([overdueBike]);
      tracking.parked(); // looks perfectly parked, but was received before this connection
      await service.sweep();

      devices.connected = new Date(Date.now() + 1000);
      await service.handleDeviceConnected({
        imei: IMEI,
        remoteAddress: '10.0.0.1',
        connectedAt: devices.connected,
      });

      expect(devices.sendCommand).not.toHaveBeenCalled();
    });

    it('restores immediately at reconnect, even while the bike is moving', async () => {
      const { db, devices, tracking, service } = setup();
      tracking.riding();
      await service.applyArrears(BIKE_ID, true, 'Overdue', null);
      await service.applyArrears(
        BIKE_ID,
        false,
        'Payment cleared arrears',
        null,
      );
      expect(db.row()?.confirmedState).toBeNull(); // nothing reached the device

      devices.connected = new Date();
      await service.handleDeviceConnected({
        imei: IMEI,
        remoteAddress: '10.0.0.1',
        connectedAt: devices.connected,
      });

      expect(devices.commands()).toEqual(['restore']);
    });

    it('a payment clearing arrears while offline flips desired state only, and restores on reconnect', async () => {
      const { db, devices, tracking, service } = setup([overdueBike]);
      tracking.parked();
      devices.connected = new Date(Date.now() - 60_000);
      await service.sweep();
      await reply(service, 'Setdigout 1 OK');

      devices.connected = null;
      await service.applyArrears(
        BIKE_ID,
        false,
        'Payment brought contract current',
        {
          paymentRef: 'MP-123',
        },
      );
      expect(db.row()?.desiredState).toBe(MobilityState.MOBILE);
      expect(db.row()?.confirmedState).toBe(MobilityState.IMMOBILIZED);

      devices.connected = new Date();
      await service.handleDeviceConnected({
        imei: IMEI,
        remoteAddress: '10.0.0.1',
        connectedAt: devices.connected,
      });
      expect(devices.commands()).toEqual(['immobilize', 'restore']);
    });
  });

  describe('staff actions', () => {
    it('records the staff member and still waits for the interlock', async () => {
      const { db, devices, tracking, service } = setup();
      tracking.riding();
      devices.connected = new Date(Date.now() - 60_000);

      await service.setDesiredStateByStaff(
        BIKE_ID,
        MobilityState.IMMOBILIZED,
        ADMIN,
        'Reported stolen',
      );

      expect(devices.sendCommand).not.toHaveBeenCalled();
      expect(db.events[0]).toMatchObject({
        type: EnforcementEventType.DESIRED_STATE_CHANGED,
        actorUserId: ADMIN_ID,
        trigger: 'staff',
        reason: 'Reported stolen',
      });
      expect(db.row()?.blockedReason).toBe('interlock:moving');
    });

    it('distinguishes an automatic action from a staff one', async () => {
      const { db, service } = setup([overdueBike]);

      await service.sweep();

      expect(db.events[0]).toMatchObject({
        actorUserId: null,
        trigger: 'arrears',
      });
    });

    it('never lets arrears lift a staff lock', async () => {
      const { db, service } = setup();
      await service.setDesiredStateByStaff(
        BIKE_ID,
        MobilityState.IMMOBILIZED,
        ADMIN,
        'Reported stolen',
      );

      await service.applyArrears(BIKE_ID, false, 'Paid up', null);
      await service.sweep();

      expect(db.row()?.desiredState).toBe(MobilityState.IMMOBILIZED);
      expect(db.row()?.desiredSource).toBe(DesiredStateSource.STAFF);
    });

    it('audits a staff request even when it changes nothing', async () => {
      const { db, service } = setup();
      await service.setDesiredStateByStaff(
        BIKE_ID,
        MobilityState.MOBILE,
        ADMIN,
        'Checking',
      );
      await service.setDesiredStateByStaff(
        BIKE_ID,
        MobilityState.MOBILE,
        ADMIN,
        'Checking again',
      );

      expect(
        db.events.filter(
          (event) => event.type === EnforcementEventType.DESIRED_STATE_CHANGED,
        ),
      ).toHaveLength(2);
    });
  });
});
