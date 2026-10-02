import { Injectable, NotFoundException } from '@nestjs/common';
import {
  EnforcementEventType,
  LoanStatus,
  MobilityState,
} from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import type { ActivityItemDto } from './dto/staff.dto';

type Item = ActivityItemDto;

const blank = {
  bikeId: null,
  customerId: null,
  loanId: null,
  paymentId: null,
  staffId: null,
};

/**
 * A staff member's recent actions, read from the audit trails the other modules already write:
 * enforcement events, loans, payments, bike status changes, tracker installations, rider
 * registrations and KYC, staff alerts, and the staff account log. Nothing is copied into a
 * separate activity table, so this can never disagree with the records it summarises.
 *
 * Each source is read newest first up to the limit, then merged, so the result is the true
 * newest `limit` across all of them.
 */
@Injectable()
export class StaffActivityService {
  constructor(private readonly prisma: PrismaService) {}

  async forStaff(
    userId: string,
    limit: number,
    before?: Date,
  ): Promise<Item[]> {
    const exists = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (!exists) {
      throw new NotFoundException('Staff member not found');
    }

    const at = (field: string) => (before ? { [field]: { lt: before } } : {});
    const page = { take: limit };

    const [
      enforcement,
      loansCreated,
      loansClosed,
      paymentsRecorded,
      paymentsAllocated,
      statusChanges,
      trackersFitted,
      trackersRemoved,
      ridersRegistered,
      kycVerified,
      alerts,
      staffChanges,
    ] = await Promise.all([
      this.prisma.enforcementEvent.findMany({
        where: {
          actorUserId: userId,
          type: EnforcementEventType.DESIRED_STATE_CHANGED,
          ...at('createdAt'),
        },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true, toState: true, reason: true, bikeId: true },
        ...page,
      }),
      this.prisma.loan.findMany({
        where: { createdById: userId, ...at('createdAt') },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          createdAt: true,
          principalMinor: true,
          currency: true,
          bikeId: true,
          customerId: true,
        },
        ...page,
      }),
      this.prisma.loan.findMany({
        where: {
          closedById: userId,
          status: {
            in: [
              LoanStatus.DEFAULTED,
              LoanStatus.REPOSSESSED,
              LoanStatus.WRITTEN_OFF,
            ],
          },
          ...at('updatedAt'),
        },
        orderBy: { updatedAt: 'desc' },
        select: {
          id: true,
          status: true,
          closedAt: true,
          updatedAt: true,
          closedReason: true,
          bikeId: true,
          customerId: true,
        },
        ...page,
      }),
      this.prisma.payment.findMany({
        where: { recordedById: userId, ...at('receivedAt') },
        orderBy: { receivedAt: 'desc' },
        select: {
          id: true,
          receivedAt: true,
          amountMinor: true,
          currency: true,
          providerReference: true,
          loanId: true,
        },
        ...page,
      }),
      this.prisma.payment.findMany({
        where: { allocatedById: userId, ...at('allocatedAt') },
        orderBy: { allocatedAt: 'desc' },
        select: {
          id: true,
          allocatedAt: true,
          amountMinor: true,
          currency: true,
          providerReference: true,
          loanId: true,
        },
        ...page,
      }),
      this.prisma.bikeStatusChange.findMany({
        where: { actorUserId: userId, ...at('createdAt') },
        orderBy: { createdAt: 'desc' },
        select: {
          createdAt: true,
          fromStatus: true,
          toStatus: true,
          reason: true,
          bikeId: true,
        },
        ...page,
      }),
      this.prisma.bikeTrackerInstallation.findMany({
        where: { installedById: userId, ...at('installedAt') },
        orderBy: { installedAt: 'desc' },
        select: { installedAt: true, imei: true, bikeId: true },
        ...page,
      }),
      this.prisma.bikeTrackerInstallation.findMany({
        where: { removedById: userId, ...at('removedAt') },
        orderBy: { removedAt: 'desc' },
        select: {
          removedAt: true,
          imei: true,
          bikeId: true,
          removedReason: true,
        },
        ...page,
      }),
      this.prisma.customer.findMany({
        where: { registeredById: userId, ...at('createdAt') },
        orderBy: { createdAt: 'desc' },
        select: { id: true, createdAt: true, firstName: true, lastName: true },
        ...page,
      }),
      this.prisma.customer.findMany({
        where: { kycVerifiedById: userId, ...at('kycVerifiedAt') },
        orderBy: { kycVerifiedAt: 'desc' },
        select: {
          id: true,
          kycVerifiedAt: true,
          firstName: true,
          lastName: true,
        },
        ...page,
      }),
      this.prisma.staffAlert.findMany({
        where: { acknowledgedById: userId, ...at('acknowledgedAt') },
        orderBy: { acknowledgedAt: 'desc' },
        select: {
          acknowledgedAt: true,
          title: true,
          bikeId: true,
          customerId: true,
        },
        ...page,
      }),
      this.prisma.staffAuditEvent.findMany({
        where: { actorUserId: userId, ...at('createdAt') },
        orderBy: { createdAt: 'desc' },
        select: {
          createdAt: true,
          type: true,
          targetUserId: true,
          target: { select: { firstName: true, lastName: true } },
        },
        ...page,
      }),
    ]);

    const items: Item[] = [
      ...enforcement.map((row) => ({
        ...blank,
        at: row.createdAt,
        action:
          row.toState === MobilityState.IMMOBILIZED
            ? 'MANUAL_LOCK'
            : 'MANUAL_UNLOCK',
        summary: `${row.toState === MobilityState.IMMOBILIZED ? 'Locked' : 'Unlocked'} a bike: ${row.reason}`,
        bikeId: row.bikeId,
      })),
      ...loansCreated.map((row) => ({
        ...blank,
        at: row.createdAt,
        action: 'LOAN_CREATED',
        summary: `Started a loan of ${money(row.principalMinor, row.currency)}`,
        loanId: row.id,
        bikeId: row.bikeId,
        customerId: row.customerId,
      })),
      ...loansClosed.map((row) => ({
        ...blank,
        at: row.closedAt ?? row.updatedAt,
        action: LOAN_CLOSURE[row.status]?.action ?? 'LOAN_DEFAULTED',
        summary:
          `${LOAN_CLOSURE[row.status]?.verb ?? 'Closed'} a loan: ${row.closedReason ?? ''}`.trim(),
        loanId: row.id,
        bikeId: row.bikeId,
        customerId: row.customerId,
      })),
      ...paymentsRecorded.map((row) => ({
        ...blank,
        at: row.receivedAt,
        action: 'PAYMENT_RECORDED',
        summary: `Recorded ${money(row.amountMinor, row.currency)} by hand (${row.providerReference})`,
        paymentId: row.id,
        loanId: row.loanId,
      })),
      ...paymentsAllocated.flatMap((row) =>
        row.allocatedAt
          ? [
              {
                ...blank,
                at: row.allocatedAt,
                action: 'PAYMENT_ALLOCATED',
                summary: `Allocated ${money(row.amountMinor, row.currency)} (${row.providerReference}) to a loan`,
                paymentId: row.id,
                loanId: row.loanId,
              },
            ]
          : [],
      ),
      ...statusChanges.map((row) => ({
        ...blank,
        at: row.createdAt,
        action: 'BIKE_STATUS_CHANGED',
        summary: `Bike ${row.fromStatus ?? 'new'} to ${row.toStatus}: ${row.reason}`,
        bikeId: row.bikeId,
      })),
      ...trackersFitted.map((row) => ({
        ...blank,
        at: row.installedAt,
        action: 'TRACKER_FITTED',
        summary: `Fitted tracker ${row.imei}`,
        bikeId: row.bikeId,
      })),
      ...trackersRemoved.flatMap((row) =>
        row.removedAt
          ? [
              {
                ...blank,
                at: row.removedAt,
                action: 'TRACKER_REMOVED',
                summary:
                  `Removed tracker ${row.imei}: ${row.removedReason ?? ''}`.trim(),
                bikeId: row.bikeId,
              },
            ]
          : [],
      ),
      ...ridersRegistered.map((row) => ({
        ...blank,
        at: row.createdAt,
        action: 'RIDER_REGISTERED',
        summary: `Registered rider ${row.firstName} ${row.lastName}`,
        customerId: row.id,
      })),
      ...kycVerified.flatMap((row) =>
        row.kycVerifiedAt
          ? [
              {
                ...blank,
                at: row.kycVerifiedAt,
                action: 'KYC_VERIFIED',
                summary: `Verified KYC for ${row.firstName} ${row.lastName}`,
                customerId: row.id,
              },
            ]
          : [],
      ),
      ...alerts.flatMap((row) =>
        row.acknowledgedAt
          ? [
              {
                ...blank,
                at: row.acknowledgedAt,
                action: 'ALERT_ACKNOWLEDGED',
                summary: `Acknowledged: ${row.title}`,
                bikeId: row.bikeId,
                customerId: row.customerId,
              },
            ]
          : [],
      ),
      ...staffChanges.map((row) => ({
        ...blank,
        at: row.createdAt,
        action: row.type,
        summary: `${STAFF_ACTION[row.type]} ${row.targetUserId === userId ? 'their own account' : `${row.target.firstName} ${row.target.lastName}`}`,
        staffId: row.targetUserId,
      })),
    ];

    return items
      .sort((a, b) => b.at.getTime() - a.at.getTime())
      .slice(0, limit);
  }
}

const STAFF_ACTION: Record<string, string> = {
  ACCOUNT_CREATED: 'Created the account of',
  PROFILE_UPDATED: 'Updated the profile of',
  ROLE_CHANGED: 'Changed the role of',
  DEACTIVATED: 'Deactivated',
  REACTIVATED: 'Reactivated',
  PASSWORD_RESET: 'Reset the password of',
  PASSWORD_CHANGED: 'Changed the password of',
};

function money(minor: number, currency: string): string {
  const whole = Math.floor(minor / 100);
  return `${currency} ${whole}.${String(minor % 100).padStart(2, '0')}`;
}

/** How a loan closed by staff reads in their activity. */
const LOAN_CLOSURE: Partial<
  Record<LoanStatus, { action: string; verb: string }>
> = {
  [LoanStatus.DEFAULTED]: {
    action: 'LOAN_DEFAULTED',
    verb: 'Declared in default',
  },
  [LoanStatus.REPOSSESSED]: {
    action: 'LOAN_REPOSSESSED',
    verb: 'Repossessed under',
  },
  [LoanStatus.WRITTEN_OFF]: { action: 'LOAN_WRITTEN_OFF', verb: 'Wrote off' },
};
