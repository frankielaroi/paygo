import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  ENFORCEMENT_REVIEW_FLAGGED,
  ENFORCEMENT_STATE_CONFIRMED,
  type EnforcementReviewFlaggedEvent,
  type EnforcementStateConfirmedEvent,
} from '../enforcement/enforcement.events';
import {
  DesiredStateSource,
  LoanStatus,
  MobilityState,
  NotificationKind,
  StaffAlertKind,
} from '../generated/prisma/enums';
import { LoanArrearsService } from '../loans/loan-arrears.service';
import { PrismaService } from '../prisma/prisma.service';
import { immobilizedText, restoredText } from './messages';
import { NotificationsService } from './notifications.service';
import { StaffAlertsService } from './staff-alerts.service';

/**
 * Turns what enforcement announces into messages. Enforcement never sends anything itself and does
 * not know this listener exists.
 *
 * Messages key on the enforcement audit row, so a repeated announcement is a no-op. A listener
 * failure is logged and never reaches enforcement.
 */
@Injectable()
export class EnforcementNotifierService {
  private readonly logger = new Logger(EnforcementNotifierService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly alerts: StaffAlertsService,
    private readonly arrears: LoanArrearsService,
  ) {}

  /** The rider hears as soon as the device confirms the lock or unlock, and why. */
  @OnEvent(ENFORCEMENT_STATE_CONFIRMED)
  async onStateConfirmed(event: EnforcementStateConfirmedEvent): Promise<void> {
    try {
      const immobilized = event.toState === MobilityState.IMMOBILIZED;
      const restored =
        event.toState === MobilityState.MOBILE &&
        event.fromState === MobilityState.IMMOBILIZED;
      if (!immobilized && !restored) {
        // A first confirmation of MOBILE (a new tracker, for instance) is not news to the rider.
        return;
      }

      const holder = await this.currentHolder(event.bikeId);
      if (!holder) {
        this.logger.warn(
          `Bike ${event.bikeId} ${immobilized ? 'immobilized' : 'restored'} with no rider to tell`,
        );
        return;
      }
      const loan = await this.prisma.loan.findFirst({
        where: { bikeId: event.bikeId },
        orderBy: { createdAt: 'desc' },
        select: { id: true, status: true, currency: true, graceDays: true },
      });
      const position = loan
        ? await this.arrears.positionOf(this.prisma, loan, new Date())
        : null;

      let body: string;
      if (immobilized) {
        body =
          event.desiredSource === DesiredStateSource.ARREARS &&
          loan &&
          position &&
          position.overdueMinor > 0
            ? immobilizedText(holder.rider, {
                kind: 'arrears',
                overdueMinor: position.overdueMinor,
                currency: loan.currency,
              })
            : immobilizedText(holder.rider, { kind: 'staff' });
      } else {
        const paidUp =
          loan !== null &&
          (loan.status === LoanStatus.COMPLETED ||
            position?.overdueMinor === 0);
        body = restoredText(holder.rider, paidUp);
      }

      await this.notifications.notify({
        kind: immobilized
          ? NotificationKind.BIKE_IMMOBILIZED
          : NotificationKind.BIKE_RESTORED,
        dedupeKey: `${immobilized ? 'immobilized' : 'restored'}:${event.enforcementEventId}`,
        customerId: holder.customerId,
        loanId: loan?.id ?? null,
        bikeId: event.bikeId,
        phone: holder.phone,
        body,
      });
    } catch (error) {
      this.logger.error(
        `Could not notify for bike ${event.bikeId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** A deferral enforcement cannot resolve by itself becomes a staff alert, never silence. */
  @OnEvent(ENFORCEMENT_REVIEW_FLAGGED)
  async onReviewFlagged(event: EnforcementReviewFlaggedEvent): Promise<void> {
    try {
      const bike = await this.prisma.bike.findUnique({
        where: { id: event.bikeId },
        select: { label: true, registrationNumber: true },
      });
      const holder = await this.currentHolder(event.bikeId);
      const name = bike?.registrationNumber ?? bike?.label ?? event.bikeId;

      await this.alerts.raise({
        kind: StaffAlertKind.ENFORCEMENT_REVIEW,
        dedupeKey: `enforcement-review:${event.enforcementEventId}`,
        title: `Bike ${name} should be immobilized, but its position cannot be trusted`,
        detail:
          `Enforcement deferred the lock (${event.reason}): the tracker is offline or its ` +
          'last reading is too old to prove the bike is stopped. Nothing will be sent until it ' +
          'reports again. Check on the bike and the rider.',
        bikeId: event.bikeId,
        customerId: holder?.customerId ?? null,
      });
    } catch (error) {
      this.logger.error(
        `Could not raise review alert for bike ${event.bikeId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async currentHolder(bikeId: string) {
    const assignment = await this.prisma.bikeAssignment.findFirst({
      where: { bikeId, endedAt: null },
      select: {
        customer: { select: { id: true, phone: true, firstName: true } },
        bike: { select: { label: true, registrationNumber: true } },
      },
    });
    if (!assignment) {
      return null;
    }
    return {
      customerId: assignment.customer.id,
      phone: assignment.customer.phone,
      rider: {
        firstName: assignment.customer.firstName,
        bikeName: assignment.bike.registrationNumber ?? assignment.bike.label,
      },
    };
  }
}
