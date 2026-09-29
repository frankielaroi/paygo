import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import type { Subscription } from 'rxjs';
import type { Env } from '../config/env.validation';
import {
  DesiredStateSource,
  EnforcementEventType,
  MobilityState,
} from '../generated/prisma/enums';
import type {
  BikeEnforcement,
  EnforcementEvent,
  Prisma,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  commandFromResponse,
  type DeviceCommand,
} from '../tcp/command-encoder';
import { TcpServerService } from '../tcp/tcp-server.service';
import {
  DEVICE_COMMAND_RESPONSE,
  DEVICE_CONNECTED,
  type DeviceCommandResponseEvent,
  type DeviceConnectedEvent,
} from '../tcp/tcp.events';
import {
  TrackingService,
  type TrackingSafetySnapshot,
} from '../tracking/tracking.service';
import {
  ARREARS_SOURCE,
  type ArrearsDetail,
  type ArrearsSource,
} from './arrears-source';
import {
  checkLatest,
  checkSustained,
  type InterlockSettings,
  windowStart,
} from './interlock';

/** Who asked for a change of desired state. */
export type EnforcementActor =
  { kind: 'staff'; userId: string } | { kind: 'arrears' };

export type ReconcileTrigger =
  | 'staff'
  | 'sweep'
  | 'arrears'
  | 'device-connected'
  | 'telemetry'
  | 'command-response';

export interface EnforcementView {
  state: BikeEnforcement | null;
  events: EnforcementEvent[];
}

type BlockReason = string;

const COMMAND_FOR_STATE: Record<MobilityState, DeviceCommand> = {
  [MobilityState.IMMOBILIZED]: 'immobilize',
  [MobilityState.MOBILE]: 'restore',
};

const STATE_FOR_COMMAND: Record<DeviceCommand, MobilityState> = {
  immobilize: MobilityState.IMMOBILIZED,
  restore: MobilityState.MOBILE,
};

/**
 * Enforcement is a reconciler, not a command sender (see CLAUDE.md).
 *
 * Arrears, staff and (later) payments only ever write a desired state. reconcile() compares it
 * with what the device last confirmed and sends a command when they differ and it is safe now:
 *
 * - Immobilize passes the stationary interlock every time, whoever asked for it. Missing,
 *   stale, offline or ambiguous telemetry defers; it never counts as stopped.
 * - Restore is ungated and fires as soon as the device is reachable, including at reconnect.
 *   It cannot hurt anyone, and a rider who has paid must not be left stranded.
 * - Confirmed state advances only on the device's reply, never on a successful write.
 *
 * Nothing else in the application calls TcpServerService.sendCommand.
 */
@Injectable()
export class EnforcementService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(EnforcementService.name);
  /** Per-bike chains, so two triggers for one bike never reconcile concurrently. */
  private readonly queues = new Map<string, Promise<void>>();
  private sweepTimer: NodeJS.Timeout | null = null;
  private sweepRunning = false;
  private positionSubscription: Subscription | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly tracking: TrackingService,
    private readonly devices: TcpServerService,
    @Inject(ARREARS_SOURCE) private readonly arrears: ArrearsSource,
  ) {}

  onApplicationBootstrap(): void {
    // Tracking publishes only after its transaction commits, so the reconciler reads the
    // telemetry that triggered it rather than racing the write.
    this.positionSubscription = this.tracking
      .watchPositionUpdates()
      .subscribe((status) => {
        void this.reconcile(status.bikeId, 'telemetry');
      });

    const intervalMs =
      this.config.get('ENFORCEMENT_SWEEP_INTERVAL_SECONDS', { infer: true }) *
      1000;
    this.sweepTimer = setInterval(() => {
      void this.sweep();
    }, intervalMs);
    this.sweepTimer.unref();
  }

  onModuleDestroy(): void {
    this.positionSubscription?.unsubscribe();
    this.positionSubscription = null;
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /**
   * A staff decision. A staff lock is sticky: the arrears sweep and payments never lift it, only
   * another staff action does. A staff unlock hands the bike back to automatic control, so the
   * next sweep re-locks it if the contract is still overdue.
   */
  async setDesiredStateByStaff(
    bikeId: string,
    state: MobilityState,
    userId: string,
    reason: string,
  ): Promise<EnforcementView> {
    await this.requireBike(bikeId);
    await this.writeDesiredState(
      bikeId,
      state,
      { kind: 'staff', userId },
      reason,
      null,
    );
    await this.reconcile(bikeId, 'staff');
    return this.getEnforcement(bikeId);
  }

  /**
   * The arrears entry point, for the sweep now and for payments later. Payments must call this
   * with overdue: false once the ledger shows the contract current, inside or right after the
   * transaction that posted the payment, so restore does not wait for the next sweep.
   *
   * Does nothing to a bike under a staff lock.
   */
  async applyArrears(
    bikeId: string,
    overdue: boolean,
    reason: string,
    detail: ArrearsDetail | null,
    trigger: ReconcileTrigger = 'arrears',
  ): Promise<void> {
    const changed = await this.writeDesiredState(
      bikeId,
      overdue ? MobilityState.IMMOBILIZED : MobilityState.MOBILE,
      { kind: 'arrears' },
      reason,
      detail,
    );
    if (changed) {
      await this.reconcile(bikeId, trigger);
    }
  }

  /**
   * The scheduled pass: apply arrears to every bike, then retry everything still diverged, which
   * covers devices that were offline and commands that were never confirmed.
   */
  async sweep(): Promise<void> {
    if (this.sweepRunning) {
      return;
    }
    this.sweepRunning = true;

    try {
      const now = new Date();
      const overdue = await this.arrears.findOverdue(now);
      const overdueIds = new Set(overdue.map((finding) => finding.bikeId));

      for (const finding of overdue) {
        await this.applyArrears(
          finding.bikeId,
          true,
          'Overdue past grace period',
          finding.detail,
          'sweep',
        );
      }

      const lockedForArrears = await this.prisma.bikeEnforcement.findMany({
        where: {
          desiredState: MobilityState.IMMOBILIZED,
          desiredSource: DesiredStateSource.ARREARS,
        },
        select: { bikeId: true },
      });
      for (const { bikeId } of lockedForArrears) {
        if (!overdueIds.has(bikeId)) {
          await this.applyArrears(
            bikeId,
            false,
            'No longer overdue',
            null,
            'sweep',
          );
        }
      }

      // Prisma cannot compare two columns, and one row per bike is small, so filter here.
      const rows = await this.prisma.bikeEnforcement.findMany({
        select: {
          bikeId: true,
          desiredState: true,
          confirmedState: true,
          pendingCommand: true,
        },
      });
      for (const row of rows) {
        if (
          row.desiredState !== row.confirmedState ||
          row.pendingCommand !== null
        ) {
          await this.reconcile(row.bikeId, 'sweep');
        }
      }
    } catch (error) {
      this.logger.error(`Enforcement sweep failed: ${describe(error)}`);
    } finally {
      this.sweepRunning = false;
    }
  }

  reconcile(bikeId: string, trigger: ReconcileTrigger): Promise<void> {
    return this.serialize(bikeId, async () => {
      try {
        await this.reconcileNow(bikeId, trigger);
      } catch (error) {
        this.logger.error(
          `Reconcile of bike ${bikeId} (${trigger}) failed: ${describe(error)}`,
        );
      }
    });
  }

  @OnEvent(DEVICE_CONNECTED)
  async handleDeviceConnected(event: DeviceConnectedEvent): Promise<void> {
    const bike = await this.bikeByImei(event.imei);
    if (bike) {
      await this.reconcile(bike.id, 'device-connected');
    }
  }

  @OnEvent(DEVICE_COMMAND_RESPONSE)
  async handleCommandResponse(
    event: DeviceCommandResponseEvent,
  ): Promise<void> {
    const bike = await this.bikeByImei(event.imei);
    if (!bike) {
      return;
    }

    await this.serialize(bike.id, async () => {
      try {
        await this.recordResponse(bike.id, event);
      } catch (error) {
        this.logger.error(
          `Could not record response from ${event.imei}: ${describe(error)}`,
        );
      }
    });
    await this.reconcile(bike.id, 'command-response');
  }

  async getEnforcement(bikeId: string): Promise<EnforcementView> {
    await this.requireBike(bikeId);
    const [state, events] = await Promise.all([
      this.prisma.bikeEnforcement.findUnique({ where: { bikeId } }),
      this.prisma.enforcementEvent.findMany({
        where: { bikeId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    ]);
    return { state, events };
  }

  listForReview(): Promise<BikeEnforcement[]> {
    return this.prisma.bikeEnforcement.findMany({
      where: { reviewReason: { not: null } },
      orderBy: { reviewSince: 'asc' },
    });
  }

  /** Returns whether the desired state actually changed. */
  private async writeDesiredState(
    bikeId: string,
    state: MobilityState,
    actor: EnforcementActor,
    reason: string,
    detail: ArrearsDetail | null,
  ): Promise<boolean> {
    const source =
      actor.kind === 'staff' && state === MobilityState.IMMOBILIZED
        ? DesiredStateSource.STAFF
        : DesiredStateSource.ARREARS;

    return this.prisma.$transaction(async (tx) => {
      const current = await tx.bikeEnforcement.findUnique({
        where: { bikeId },
      });

      if (
        actor.kind === 'arrears' &&
        current?.desiredSource === DesiredStateSource.STAFF
      ) {
        return false;
      }

      const fromState = current?.desiredState ?? MobilityState.MOBILE;
      const unchanged =
        current !== null &&
        fromState === state &&
        current.desiredSource === source;

      if (actor.kind === 'arrears') {
        // Repeating an arrears decision is not a new decision, and arrears saying "current"
        // about a bike nobody ever enforced changes nothing.
        if (unchanged || (!current && state === MobilityState.MOBILE)) {
          return false;
        }
      }
      // A staff request is always audited, even when it changes nothing: a person asked.

      const clearReview =
        state === MobilityState.MOBILE
          ? { reviewReason: null, reviewSince: null }
          : {};

      await tx.bikeEnforcement.upsert({
        where: { bikeId },
        create: { bikeId, desiredState: state, desiredSource: source },
        update: {
          desiredState: state,
          desiredSource: source,
          blockedReason: null,
          ...clearReview,
        },
      });

      await tx.enforcementEvent.create({
        data: {
          bikeId,
          type: EnforcementEventType.DESIRED_STATE_CHANGED,
          actorUserId: actor.kind === 'staff' ? actor.userId : null,
          trigger: actor.kind === 'staff' ? 'staff' : 'arrears',
          fromState,
          toState: state,
          reason,
          detail: detail ?? undefined,
        },
      });

      return !unchanged;
    });
  }

  private async reconcileNow(
    bikeId: string,
    trigger: ReconcileTrigger,
  ): Promise<void> {
    const row = await this.prisma.bikeEnforcement.findUnique({
      where: { bikeId },
      include: { bike: { select: { imei: true } } },
    });
    if (!row) {
      return;
    }

    const wanted = row.desiredState;
    const now = new Date();

    if (row.confirmedState === wanted && row.pendingCommand === null) {
      if (row.blockedReason !== null || row.reviewReason !== null) {
        await this.prisma.bikeEnforcement.update({
          where: { bikeId },
          data: { blockedReason: null, reviewReason: null, reviewSince: null },
        });
      }
      return;
    }

    // Already sent and still waiting: give the device time to answer before sending again.
    if (
      row.pendingCommand === wanted &&
      row.pendingSentAt &&
      now.getTime() - row.pendingSentAt.getTime() <
        this.config.get('ENFORCEMENT_COMMAND_RETRY_SECONDS', { infer: true }) *
          1000
    ) {
      return;
    }

    let telemetry: TrackingSafetySnapshot | null = null;

    if (wanted === MobilityState.IMMOBILIZED) {
      const settings = this.interlockSettings();
      telemetry = await this.tracking.getSafetySnapshot(bikeId);

      let verdict = checkLatest(
        telemetry,
        now,
        settings,
        this.devices.connectedSince(row.bike.imei),
      );
      if (verdict.safe && telemetry) {
        verdict = checkSustained(
          await this.tracking.getSafetyWindow(
            bikeId,
            windowStart(telemetry, settings),
            telemetry.recordedAt,
          ),
        );
      }

      if (!verdict.safe) {
        await this.recordBlock(
          row,
          EnforcementEventType.COMMAND_DEFERRED,
          `interlock:${verdict.reason}`,
          trigger,
          telemetry,
          verdict.needsReview,
        );
        return;
      }
    }

    if (!this.devices.isConnected(row.bike.imei)) {
      await this.recordBlock(
        row,
        EnforcementEventType.COMMAND_FAILED,
        'device-not-connected',
        trigger,
        telemetry,
        false,
      );
      return;
    }

    // Claim the send. The conditions fail if the desired state or a previous send changed since
    // this row was read, so two reconciles can never both send.
    const claimed = await this.prisma.bikeEnforcement.updateMany({
      where: {
        bikeId,
        desiredState: wanted,
        pendingCommand: row.pendingCommand,
        pendingSentAt: row.pendingSentAt,
      },
      data: {
        pendingCommand: wanted,
        pendingSentAt: now,
        blockedReason: null,
        reviewReason: null,
        reviewSince: null,
      },
    });
    if (claimed.count !== 1) {
      return;
    }

    const result = this.devices.sendCommand(
      row.bike.imei,
      COMMAND_FOR_STATE[wanted],
    );

    if (result.delivered) {
      await this.prisma.enforcementEvent.create({
        data: {
          bikeId,
          type: EnforcementEventType.COMMAND_SENT,
          trigger,
          fromState: row.confirmedState,
          toState: wanted,
          reason:
            row.pendingCommand === wanted
              ? 'Resent: no confirmation within the retry period'
              : 'Desired state differs from confirmed state',
          telemetry: telemetry ? snapshotJson(telemetry) : undefined,
          detail: { command: result.text },
        },
      });
      return;
    }

    // Written nowhere: the claim is released so the next trigger tries again.
    await this.prisma.bikeEnforcement.update({
      where: { bikeId },
      data: {
        pendingCommand: row.pendingCommand,
        pendingSentAt: row.pendingSentAt,
      },
    });
    await this.recordBlock(
      { ...row, blockedReason: null },
      EnforcementEventType.COMMAND_FAILED,
      `send-failed:${result.reason}`,
      trigger,
      telemetry,
      false,
    );
  }

  /**
   * Records why nothing was sent, once per distinct reason, so a sweep repeating the same
   * deferral every few minutes does not write a new audit row each time.
   */
  private async recordBlock(
    row: BikeEnforcement,
    type: EnforcementEventType,
    reason: BlockReason,
    trigger: ReconcileTrigger,
    telemetry: TrackingSafetySnapshot | null,
    needsReview: boolean,
  ): Promise<void> {
    const flagReview = needsReview && row.reviewReason === null;
    if (row.blockedReason === reason && !flagReview) {
      return;
    }

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.bikeEnforcement.update({
        where: { bikeId: row.bikeId },
        data: {
          blockedReason: reason,
          ...(flagReview ? { reviewReason: reason, reviewSince: now } : {}),
        },
      });

      if (row.blockedReason !== reason) {
        await tx.enforcementEvent.create({
          data: {
            bikeId: row.bikeId,
            type,
            trigger,
            fromState: row.confirmedState,
            toState: row.desiredState,
            reason,
            telemetry: telemetry ? snapshotJson(telemetry) : undefined,
          },
        });
      }

      if (flagReview) {
        await tx.enforcementEvent.create({
          data: {
            bikeId: row.bikeId,
            type: EnforcementEventType.REVIEW_FLAGGED,
            trigger,
            fromState: row.confirmedState,
            toState: row.desiredState,
            reason: `Immobilize wanted but telemetry cannot be trusted: ${reason}`,
            telemetry: telemetry ? snapshotJson(telemetry) : undefined,
          },
        });
      }
    });
  }

  private async recordResponse(
    bikeId: string,
    event: DeviceCommandResponseEvent,
  ): Promise<void> {
    const row = await this.prisma.bikeEnforcement.findUnique({
      where: { bikeId },
    });
    if (!row) {
      return;
    }

    const command = commandFromResponse(event.text);

    if (!command) {
      await this.prisma.enforcementEvent.create({
        data: {
          bikeId,
          type: EnforcementEventType.RESPONSE_UNRECOGNIZED,
          trigger: 'command-response',
          fromState: row.confirmedState,
          toState: row.pendingCommand,
          reason:
            'Device reply does not state the output; not treated as confirmation',
          deviceResponse: event.text,
        },
      });
      return;
    }

    const state = STATE_FOR_COMMAND[command];
    await this.prisma.$transaction(async (tx) => {
      await tx.bikeEnforcement.update({
        where: { bikeId },
        data: {
          confirmedState: state,
          confirmedAt: event.receivedAt,
          ...(row.pendingCommand === state
            ? { pendingCommand: null, pendingSentAt: null }
            : {}),
        },
      });
      await tx.enforcementEvent.create({
        data: {
          bikeId,
          type: EnforcementEventType.STATE_CONFIRMED,
          trigger: 'command-response',
          fromState: row.confirmedState,
          toState: state,
          reason: 'Device reported its output state',
          deviceResponse: event.text,
        },
      });
    });
  }

  private serialize(bikeId: string, task: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(bikeId) ?? Promise.resolve();
    const run = previous.then(task, task);
    this.queues.set(bikeId, run);

    const cleanup = (): void => {
      if (this.queues.get(bikeId) === run) {
        this.queues.delete(bikeId);
      }
    };
    void run.then(cleanup, cleanup);

    return run;
  }

  private interlockSettings(): InterlockSettings {
    return {
      stationarySeconds: this.config.get('IMMOBILIZE_STATIONARY_SECONDS', {
        infer: true,
      }),
      maxTelemetryAgeSeconds: this.config.get(
        'ENFORCEMENT_MAX_TELEMETRY_AGE_SECONDS',
        { infer: true },
      ),
    };
  }

  private async bikeByImei(imei: string): Promise<{ id: string } | null> {
    try {
      return await this.prisma.bike.findUnique({
        where: { imei },
        select: { id: true },
      });
    } catch (error) {
      this.logger.error(`Could not resolve IMEI ${imei}: ${describe(error)}`);
      return null;
    }
  }

  private async requireBike(bikeId: string): Promise<void> {
    const bike = await this.prisma.bike.findUnique({
      where: { id: bikeId },
      select: { id: true },
    });
    if (!bike) {
      throw new NotFoundException('Bike not found');
    }
  }
}

function snapshotJson(
  snapshot: TrackingSafetySnapshot,
): Prisma.InputJsonObject {
  return {
    speed: snapshot.speed,
    ignition: snapshot.ignition,
    movement: snapshot.movement,
    hasFix: snapshot.hasFix,
    online: snapshot.online,
    recordedAt: snapshot.recordedAt.toISOString(),
    lastReportedAt: snapshot.lastReportedAt.toISOString(),
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
