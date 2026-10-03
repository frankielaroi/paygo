import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaginatedResponseDto } from '../common/dto/paginated-response.dto';
import type { AuthenticatedStaff } from '../common/types/authenticated-staff';
import type { Env } from '../config/env.validation';
import type { Prisma } from '../generated/prisma/client';
import {
  EnforcementEventType,
  GeofenceCrossingDirection,
  LoanStatus,
  MobilityState,
  NotificationKind,
} from '../generated/prisma/enums';
import { LoanArrearsService } from '../loans/loan-arrears.service';
import { addDays, utcDay } from '../loans/schedule';
import { formatMoney, overdueReminderText } from '../notifications/messages';
import { NotificationSchedulerService } from '../notifications/notification-scheduler.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { Permission, roleHasPermission } from '../users/enums/role.enum';
import type {
  ActivityDto,
  DashboardSummaryDto,
  FleetPageDto,
  FleetQueryDto,
  FleetRowDto,
  MoneyDto,
  OverdueItemDto,
  SummaryQueryDto,
} from './dto/dashboard.dto';
import {
  deferralText,
  FLEET_STATUSES,
  type FleetStatus,
  fleetStatusOf,
  mobilityControlsOf,
} from './fleet-status';

const DAY_MS = 86_400_000;

/** Attention first: immobilized, then overdue, then offline, then everything else. */
const SORT_ORDER: Record<FleetStatus, number> = {
  immobilized: 0,
  overdue: 1,
  offline: 2,
  active: 3,
};

/** A fleet row plus what the service needs internally but the response does not carry. */
interface FleetBike extends FleetRowDto {
  graceDays: number | null;
  /** Tracker fitted and reporting within the offline threshold. */
  online: boolean;
}

function toRow(bike: FleetBike): FleetRowDto {
  return {
    bikeId: bike.bikeId,
    plate: bike.plate,
    label: bike.label,
    customerId: bike.customerId,
    rider: bike.rider,
    loanId: bike.loanId,
    status: bike.status,
    speedKmh: bike.speedKmh,
    lastSeenAt: bike.lastSeenAt,
    overdue: bike.overdue,
    canLock: bike.canLock,
    canUnlock: bike.canUnlock,
    lockPending: bike.lockPending,
  };
}

/**
 * The operations dashboard: one read of the fleet, shaped for the FleetView screens.
 *
 * Nothing here is cached or stored. Overdue comes from LoanArrearsService, the same answer the
 * enforcement sweep acts on, so the dashboard can never show a bike as current that the sweep
 * is about to lock, or the reverse. Locking and unlocking stay on the enforcement endpoints; this
 * module only says which of them the viewer may use.
 *
 * Scope follows the viewer: with ASSET_READ (admin, finance) the whole fleet; without it (field
 * agents) only bikes held by riders assigned to them.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly arrears: LoanArrearsService,
    private readonly notifications: NotificationsService,
    private readonly scheduler: NotificationSchedulerService,
  ) {}

  async summary(
    viewer: AuthenticatedStaff,
    query: SummaryQueryDto,
  ): Promise<DashboardSummaryDto> {
    const now = new Date();
    const fleet = await this.fleetOf(viewer, now);
    const bikeIds = fleet.map((bike) => bike.bikeId);

    const statusCounts = {
      all: fleet.length,
      ...(Object.fromEntries(FLEET_STATUSES.map((s) => [s, 0])) as Record<
        FleetStatus,
        number
      >),
    };
    for (const bike of fleet) {
      statusCounts[bike.status] += 1;
    }

    const overdueBikes = fleet.filter((bike) => bike.overdue !== null);
    const [collected, overdueQueue, recentActivity] = await Promise.all([
      this.collectedToday(viewer, now),
      this.overdueQueue(overdueBikes, now, query.overdueLimit),
      this.recentActivity(viewer, bikeIds, query.activityLimit),
    ]);

    return {
      viewer: this.viewerOf(viewer),
      kpis: {
        bikesOnline: fleet.filter((bike) => bike.online).length,
        bikesTotal: fleet.length,
        overdueLoans: overdueBikes.length,
        overdueTotal: sumByCurrency(overdueBikes.map((bike) => bike.overdue!)),
        collectedToday: collected.money,
        loansPaidToday: collected.loans,
        flaggedForReview: await this.prisma.bikeEnforcement.count({
          where: { bikeId: { in: bikeIds }, reviewReason: { not: null } },
        }),
      },
      statusCounts,
      overdueQueue,
      recentActivity,
      generatedAt: now,
    };
  }

  async fleet(
    viewer: AuthenticatedStaff,
    query: FleetQueryDto,
  ): Promise<FleetPageDto> {
    const words = (query.search ?? '')
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    const rows = (await this.fleetOf(viewer, new Date()))
      .filter((bike) => !query.status || bike.status === query.status)
      .filter((bike) => {
        const text = `${bike.plate} ${bike.label} ${bike.rider}`.toLowerCase();
        return words.every((word) => text.includes(word));
      })
      .sort(
        (a, b) =>
          SORT_ORDER[a.status] - SORT_ORDER[b.status] ||
          a.plate.localeCompare(b.plate),
      );

    const page = rows
      .slice((query.page - 1) * query.limit, query.page * query.limit)
      .map(toRow);
    return new PaginatedResponseDto(page, rows.length, query.page, query.limit);
  }

  /**
   * Sends the rider of an overdue loan a reminder by hand, at most once per loan per day: a
   * second press the same day sends nothing and reports the first one. Refused for a loan that
   * is not overdue, outside messaging hours, and (field agents) for someone else's rider.
   */
  async sendReminder(
    viewer: AuthenticatedStaff,
    loanId: string,
  ): Promise<{ sent: boolean; sentAt: Date }> {
    const now = new Date();
    const loan = await this.prisma.loan.findFirst({
      where: {
        id: loanId,
        status: { in: [LoanStatus.ACTIVE, LoanStatus.DEFAULTED] },
        ...(this.ownRidersOnly(viewer)
          ? { customer: { assignedAgentId: viewer.id } }
          : {}),
      },
      select: {
        id: true,
        graceDays: true,
        currency: true,
        bikeId: true,
        customer: { select: { id: true, firstName: true, phone: true } },
        bike: { select: { label: true, registrationNumber: true } },
      },
    });
    if (!loan) {
      throw new NotFoundException('Open loan not found');
    }

    const position = await this.arrears.positionOf(this.prisma, loan, now);
    if (position.overdueMinor === 0) {
      throw new ConflictException('This loan is not overdue');
    }
    if (!this.scheduler.withinMessagingHours(now)) {
      throw new ConflictException(
        'Riders are not messaged outside messaging hours',
      );
    }

    const dedupeKey = reminderKey(loan.id, now);
    const sent = await this.notifications.notify({
      kind: NotificationKind.PAYMENT_REMINDER,
      dedupeKey,
      customerId: loan.customer.id,
      loanId: loan.id,
      bikeId: loan.bikeId,
      phone: loan.customer.phone,
      body: overdueReminderText(
        {
          firstName: loan.customer.firstName,
          bikeName: loan.bike.registrationNumber ?? loan.bike.label,
        },
        position.overdueMinor,
        loan.currency,
      ),
    });
    const record = await this.prisma.notification.findUniqueOrThrow({
      where: { dedupeKey },
      select: { createdAt: true },
    });
    return { sent, sentAt: record.createdAt };
  }

  /** Every bike on the road that the viewer may see, with its status. */
  private async fleetOf(
    viewer: AuthenticatedStaff,
    now: Date,
  ): Promise<FleetBike[]> {
    const [assignments, overdue] = await Promise.all([
      this.prisma.bikeAssignment.findMany({
        where: {
          endedAt: null,
          ...(this.ownRidersOnly(viewer)
            ? { customer: { assignedAgentId: viewer.id } }
            : {}),
        },
        select: {
          customer: { select: { id: true, firstName: true, lastName: true } },
          bike: {
            select: {
              id: true,
              label: true,
              registrationNumber: true,
              imei: true,
              lastReportedAt: true,
              currentPosition: { select: { speed: true, hasFix: true } },
              enforcement: {
                select: { desiredState: true, confirmedState: true },
              },
              loans: {
                where: {
                  status: { in: [LoanStatus.ACTIVE, LoanStatus.DEFAULTED] },
                },
                select: { id: true, graceDays: true },
                take: 1,
              },
            },
          },
        },
      }),
      this.arrears.findOverdue(now),
    ]);

    const overdueByBike = new Map(
      overdue.map((row) => [
        row.bikeId,
        {
          amountMinor: Number(row.detail.overdueMinor),
          currency: String(row.detail.currency),
        },
      ]),
    );
    const canImmobilize = roleHasPermission(
      viewer.role,
      Permission.ASSET_IMMOBILIZE,
    );

    return assignments.map(({ bike, customer }) => {
      const online =
        bike.imei !== null &&
        bike.lastReportedAt !== null &&
        this.isOnline(bike.lastReportedAt, now);
      const owed = overdueByBike.get(bike.id) ?? null;
      const confirmed = bike.enforcement?.confirmedState ?? null;
      const desired = bike.enforcement?.desiredState ?? MobilityState.MOBILE;
      const status = fleetStatusOf({
        confirmedState: confirmed,
        online,
        overdueMinor: owed?.amountMinor ?? 0,
      });
      const loan = bike.loans[0] ?? null;
      return {
        bikeId: bike.id,
        plate: bike.registrationNumber ?? bike.label,
        label: bike.label,
        customerId: customer.id,
        rider: `${customer.firstName} ${customer.lastName}`,
        loanId: loan?.id ?? null,
        graceDays: loan?.graceDays ?? null,
        online,
        status,
        speedKmh: online ? (bike.currentPosition?.speed ?? null) : null,
        lastSeenAt: bike.lastReportedAt,
        overdue: owed,
        ...mobilityControlsOf({
          canImmobilize,
          online,
          desiredState: desired,
          confirmedState: confirmed,
        }),
      };
    });
  }

  private async overdueQueue(
    bikes: FleetBike[],
    now: Date,
    limit: number,
  ): Promise<OverdueItemDto[]> {
    const loanIds = bikes.flatMap((bike) => (bike.loanId ? [bike.loanId] : []));
    if (loanIds.length === 0) {
      return [];
    }
    // The oldest unpaid installment says how long the loan has been behind.
    const oldest = await this.prisma.$queryRaw<
      { loanId: string; dueDate: Date }[]
    >`
      SELECT i."loanId" AS "loanId", MIN(i."dueDate") AS "dueDate"
      FROM "loan_installments" i
      WHERE i."loanId" = ANY(${loanIds}::uuid[]) AND i."paidMinor" < i."amountMinor"
      GROUP BY i."loanId"
    `;
    const oldestByLoan = new Map(
      oldest.map((row) => [row.loanId, row.dueDate]),
    );
    const reminded = new Set(
      (
        await this.prisma.notification.findMany({
          where: {
            dedupeKey: { in: loanIds.map((id) => reminderKey(id, now)) },
          },
          select: { loanId: true },
        })
      ).map((row) => row.loanId),
    );
    const today = utcDay(now);

    return bikes
      .flatMap((bike) => {
        const due = bike.loanId ? oldestByLoan.get(bike.loanId) : undefined;
        if (!bike.loanId || !due || !bike.overdue) {
          return [];
        }
        const overdueSince = addDays(due, (bike.graceDays ?? 0) + 1);
        return [
          {
            loanId: bike.loanId,
            bikeId: bike.bikeId,
            customerId: bike.customerId,
            rider: bike.rider,
            plate: bike.plate,
            overdue: bike.overdue,
            daysOverdue: Math.max(
              1,
              Math.floor((today.getTime() - overdueSince.getTime()) / DAY_MS) +
                1,
            ),
            immobilized: bike.status === 'immobilized',
            reminderSentToday: reminded.has(bike.loanId),
          },
        ];
      })
      .sort(
        (a, b) =>
          b.daysOverdue - a.daysOverdue ||
          b.overdue.amountMinor - a.overdue.amountMinor,
      )
      .slice(0, limit);
  }

  private async collectedToday(
    viewer: AuthenticatedStaff,
    now: Date,
  ): Promise<{ money: MoneyDto[]; loans: number }> {
    const where: Prisma.PaymentWhereInput = {
      paidAt: { gte: utcDay(now) },
      ...(this.ownRidersOnly(viewer)
        ? { loan: { customer: { assignedAgentId: viewer.id } } }
        : {}),
    };
    const [byCurrency, loans] = await Promise.all([
      this.prisma.payment.groupBy({
        by: ['currency'],
        where,
        _sum: { amountMinor: true },
      }),
      this.prisma.payment.findMany({
        where: { ...where, loanId: { not: null } },
        distinct: ['loanId'],
        select: { loanId: true },
      }),
    ]);
    return {
      money: byCurrency.map((row) => ({
        currency: row.currency,
        amountMinor: row._sum.amountMinor ?? 0,
      })),
      loans: loans.length,
    };
  }

  /**
   * The feed from the audit trails the other modules already keep: lock and unlock decisions,
   * what devices confirmed, locks deferred, reminders and warnings sent, and money recorded by
   * hand. Read newest first from each, then merged.
   */
  private async recentActivity(
    viewer: AuthenticatedStaff,
    bikeIds: string[],
    limit: number,
  ): Promise<ActivityDto[]> {
    const scoped = this.ownRidersOnly(viewer);
    const bikeFilter = scoped ? { bikeId: { in: bikeIds } } : {};
    const bikeName = {
      select: { label: true, registrationNumber: true },
    } as const;

    const [events, messages, payments, crossings] = await Promise.all([
      this.prisma.enforcementEvent.findMany({
        where: {
          ...bikeFilter,
          OR: [
            { type: EnforcementEventType.STATE_CONFIRMED },
            { type: EnforcementEventType.COMMAND_DEFERRED },
            {
              type: EnforcementEventType.DESIRED_STATE_CHANGED,
              actorUserId: { not: null },
            },
          ],
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: {
          id: true,
          type: true,
          toState: true,
          fromState: true,
          reason: true,
          createdAt: true,
          bikeId: true,
          bike: bikeName,
          actor: { select: { firstName: true, lastName: true } },
        },
      }),
      this.prisma.notification.findMany({
        where: {
          ...bikeFilter,
          kind: {
            in: [
              NotificationKind.PAYMENT_REMINDER,
              NotificationKind.LOCKOUT_WARNING,
            ],
          },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: {
          id: true,
          kind: true,
          dedupeKey: true,
          status: true,
          createdAt: true,
          bikeId: true,
          customer: { select: { firstName: true, lastName: true } },
        },
      }),
      this.prisma.payment.findMany({
        where: {
          OR: [
            { recordedById: { not: null } },
            { allocatedById: { not: null } },
          ],
          ...(scoped ? { loan: { bikeId: { in: bikeIds } } } : {}),
        },
        orderBy: { receivedAt: 'desc' },
        take: limit,
        select: {
          id: true,
          amountMinor: true,
          currency: true,
          receivedAt: true,
          allocatedAt: true,
          providerReference: true,
          loan: { select: { bikeId: true } },
          recordedBy: { select: { firstName: true, lastName: true } },
          allocatedBy: { select: { firstName: true, lastName: true } },
        },
      }),
      // Bikes crossing an operating zone, recorded as positions arrive (GeofencesService).
      this.prisma.geofenceCrossing.findMany({
        where: bikeFilter,
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: {
          id: true,
          direction: true,
          createdAt: true,
          bikeId: true,
          bike: bikeName,
          geofence: { select: { name: true } },
        },
      }),
    ]);

    const name = (bike: { label: string; registrationNumber: string | null }) =>
      bike.registrationNumber ?? bike.label;
    const person = (p: { firstName: string; lastName: string } | null) =>
      p ? `${p.firstName} ${p.lastName}` : 'System';

    const items: ActivityDto[] = [
      ...events.map((event) => {
        const plate = name(event.bike);
        if (event.type === EnforcementEventType.COMMAND_DEFERRED) {
          return {
            id: event.id,
            actor: 'System',
            action: `deferred lock on ${plate}`,
            detail: deferralText(event.reason),
            at: event.createdAt,
            bikeId: event.bikeId,
          };
        }
        if (event.type === EnforcementEventType.STATE_CONFIRMED) {
          const locked = event.toState === MobilityState.IMMOBILIZED;
          return {
            id: event.id,
            actor: 'System',
            action: `${locked ? 'immobilized' : 'unlocked'} ${plate}`,
            detail: 'Confirmed by the tracker',
            at: event.createdAt,
            bikeId: event.bikeId,
          };
        }
        const lock = event.toState === MobilityState.IMMOBILIZED;
        return {
          id: event.id,
          actor: person(event.actor),
          action: `${lock ? 'requested a lock on' : 'unlocked'} ${plate}`,
          detail: event.reason,
          at: event.createdAt,
          bikeId: event.bikeId,
        };
      }),
      ...messages.map((message) => ({
        id: message.id,
        actor: 'System',
        action: `${message.kind === NotificationKind.LOCKOUT_WARNING ? 'warned' : 'sent a reminder to'} ${person(message.customer)}`,
        detail:
          message.status === 'FAILED'
            ? 'Not delivered'
            : message.dedupeKey.startsWith('overdue-reminder:')
              ? 'Sent by staff'
              : message.kind === NotificationKind.LOCKOUT_WARNING
                ? 'Pay by the deadline or the bike is immobilized'
                : 'Due tomorrow',
        at: message.createdAt,
        bikeId: message.bikeId,
      })),
      ...payments.map((payment) => {
        const allocated =
          payment.allocatedBy !== null && payment.allocatedAt !== null;
        return {
          id: payment.id,
          actor: person(allocated ? payment.allocatedBy : payment.recordedBy),
          action: `${allocated ? 'allocated' : 'recorded'} a ${formatMoney(payment.amountMinor, payment.currency)} payment`,
          detail: payment.providerReference,
          at:
            (allocated ? payment.allocatedAt : payment.receivedAt) ??
            payment.receivedAt,
          bikeId: payment.loan?.bikeId ?? null,
        };
      }),
      ...crossings.map((crossing) => {
        const left = crossing.direction === GeofenceCrossingDirection.EXITED;
        return {
          id: crossing.id,
          actor: 'System',
          action: `flagged ${name(crossing.bike)} ${left ? 'leaving' : 'back in'} ${crossing.geofence.name}`,
          detail: left ? 'Outside its operating zone' : 'Inside its zone again',
          at: crossing.createdAt,
          bikeId: crossing.bikeId,
        };
      }),
    ];

    return items
      .sort((a, b) => b.at.getTime() - a.at.getTime())
      .slice(0, limit);
  }

  private viewerOf(viewer: AuthenticatedStaff) {
    return {
      canImmobilize: roleHasPermission(
        viewer.role,
        Permission.ASSET_IMMOBILIZE,
      ),
      canSendReminders: roleHasPermission(
        viewer.role,
        Permission.REMINDER_SEND,
      ),
      ownRidersOnly: this.ownRidersOnly(viewer),
    };
  }

  private ownRidersOnly(viewer: AuthenticatedStaff): boolean {
    return !roleHasPermission(viewer.role, Permission.ASSET_READ);
  }

  private isOnline(lastReportedAt: Date, now: Date): boolean {
    return (
      now.getTime() - lastReportedAt.getTime() <=
      this.config.get('TRACKING_OFFLINE_AFTER_SECONDS', { infer: true }) * 1000
    );
  }
}

function reminderKey(loanId: string, now: Date): string {
  return `overdue-reminder:${loanId}:${utcDay(now).toISOString().slice(0, 10)}`;
}

function sumByCurrency(amounts: MoneyDto[]): MoneyDto[] {
  const totals = new Map<string, number>();
  for (const { currency, amountMinor } of amounts) {
    totals.set(currency, (totals.get(currency) ?? 0) + amountMinor);
  }
  return [...totals].map(([currency, amountMinor]) => ({
    currency,
    amountMinor,
  }));
}
