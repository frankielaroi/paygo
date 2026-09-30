import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isUniqueViolation } from '../common/prisma-errors';
import type { Env } from '../config/env.validation';
import type { Notification } from '../generated/prisma/client';
import {
  NotificationKind,
  NotificationStatus,
  StaffAlertKind,
} from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import {
  MESSAGE_CHANNEL,
  type MessageChannel,
} from './channels/message-channel';
import { toMsisdn } from './messages';
import { StaffAlertsService } from './staff-alerts.service';

export interface NewNotification {
  kind: NotificationKind;
  /**
   * Names the event the message is about (an installment, an enforcement audit row). The same
   * key can only ever be recorded once, which is what stops a retried webhook, a repeated device
   * reply or an overlapping scheduler run from messaging a rider twice.
   */
  dedupeKey: string;
  customerId: string;
  loanId?: string | null;
  installmentId?: string | null;
  bikeId?: string | null;
  phone: string;
  body: string;
}

/** How long a sender holds a message before another may try it. */
const CLAIM_MS = 60_000;

/** A reminder that could not go out in time is no longer worth sending. */
const REMINDER_STALE_MS = 24 * 3_600_000;

const KIND_LABEL: Record<NotificationKind, string> = {
  PAYMENT_REMINDER: 'payment reminder',
  LOCKOUT_WARNING: 'pre-lockout warning',
  BIKE_IMMOBILIZED: 'immobilization notice',
  BIKE_RESTORED: 'unlock confirmation',
};

/**
 * Records rider messages, sends them through the configured channel, and tracks what happened.
 *
 * A message is recorded before it is sent, so nothing goes out that is not on record, and every
 * outcome is kept: SENT when the provider accepted it, DELIVERED when the provider says it
 * arrived, FAILED when it never will (staff are alerted), and PENDING while the provider cannot
 * be reached (retried by the scheduler; staff are alerted if it stays stuck).
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly alerts: StaffAlertsService,
    @Inject(MESSAGE_CHANNEL) private readonly channel: MessageChannel,
  ) {}

  /**
   * Records and sends a message, once per dedupeKey. Returns false when the event was already
   * notified, which is the normal outcome of a repeat and not an error.
   */
  async notify(input: NewNotification): Promise<boolean> {
    let created: { id: string };
    try {
      created = await this.prisma.notification.create({
        data: {
          kind: input.kind,
          dedupeKey: input.dedupeKey,
          customerId: input.customerId,
          loanId: input.loanId ?? null,
          installmentId: input.installmentId ?? null,
          bikeId: input.bikeId ?? null,
          channel: this.channel.name,
          recipient: input.phone,
          body: input.body,
        },
        select: { id: true },
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return false;
      }
      throw error;
    }

    await this.dispatch(created.id);
    return true;
  }

  /** Tries every pending message once. Called by the scheduler. */
  async retryPending(now: Date): Promise<void> {
    const pending = await this.prisma.notification.findMany({
      where: {
        status: NotificationStatus.PENDING,
        OR: [{ claimedUntil: null }, { claimedUntil: { lt: now } }],
      },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
    for (const { id } of pending) {
      await this.dispatch(id);
    }
  }

  /**
   * One attempt at one message. The claim (a conditional update on PENDING and an expired
   * claim) means two senders racing on the same row cannot both send it.
   */
  async dispatch(id: string): Promise<void> {
    const now = new Date();
    const claimed = await this.prisma.notification.updateMany({
      where: {
        id,
        status: NotificationStatus.PENDING,
        OR: [{ claimedUntil: null }, { claimedUntil: { lt: now } }],
      },
      data: {
        claimedUntil: new Date(now.getTime() + CLAIM_MS),
        attempts: { increment: 1 },
      },
    });
    if (claimed.count !== 1) {
      return;
    }
    const message = await this.prisma.notification.findUniqueOrThrow({
      where: { id },
    });

    if (
      message.kind === NotificationKind.PAYMENT_REMINDER &&
      now.getTime() - message.createdAt.getTime() > REMINDER_STALE_MS
    ) {
      // A late "due tomorrow" is wrong, not helpful. Given up quietly: no alert for a reminder.
      await this.markFailed(
        message,
        'Not sent in time; reminder no longer relevant',
        false,
      );
      return;
    }

    const to = toMsisdn(message.recipient);
    if (!to) {
      await this.markFailed(
        message,
        `Not a valid phone number: ${message.recipient}`,
        true,
      );
      return;
    }

    let result;
    try {
      result = await this.channel.send({ to, body: message.body });
    } catch (error) {
      result = {
        outcome: 'unavailable' as const,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    if (result.outcome === 'accepted') {
      await this.prisma.notification.update({
        where: { id },
        data: {
          status: NotificationStatus.SENT,
          sentAt: new Date(),
          providerMessageId: result.providerMessageId,
          claimedUntil: null,
          lastError: null,
        },
      });
      return;
    }
    if (result.outcome === 'rejected') {
      await this.markFailed(message, result.error, true);
      return;
    }

    // Unavailable: stays PENDING for the next run. Staff hear about it once it looks stuck,
    // because a rider may be waiting on a warning that has not gone out.
    await this.prisma.notification.update({
      where: { id },
      data: { claimedUntil: null, lastError: result.error },
    });
    const attempts = message.attempts;
    if (
      attempts === this.config.get('NOTIFICATION_MAX_ATTEMPTS', { infer: true })
    ) {
      await this.alerts.raise({
        kind: StaffAlertKind.NOTIFICATION_FAILED,
        dedupeKey: `notification-stuck:${id}`,
        title: `A ${KIND_LABEL[message.kind]} has not gone out`,
        detail:
          `${attempts} attempts failed (${result.error}). It is still being retried. ` +
          (message.kind === NotificationKind.LOCKOUT_WARNING
            ? 'Until it goes out, this rider cannot be locked automatically.'
            : 'The rider may not know yet.'),
        customerId: message.customerId,
        bikeId: message.bikeId,
        notificationId: id,
      });
    }
  }

  /**
   * A delivery report from the provider. Idempotent: a repeat, or a report for a message already
   * in a final state, changes nothing.
   */
  async recordDelivery(
    providerMessageId: string,
    delivered: boolean,
    providerStatus: string,
  ): Promise<void> {
    const message = await this.prisma.notification.findFirst({
      where: { providerMessageId },
    });
    if (!message || message.status !== NotificationStatus.SENT) {
      return;
    }
    if (delivered) {
      await this.prisma.notification.updateMany({
        where: { id: message.id, status: NotificationStatus.SENT },
        data: { status: NotificationStatus.DELIVERED, deliveredAt: new Date() },
      });
      return;
    }
    await this.markFailed(
      message,
      `Provider reported the message undelivered (${providerStatus})`,
      true,
    );
  }

  private async markFailed(
    message: Notification,
    error: string,
    alertStaff: boolean,
  ): Promise<void> {
    await this.prisma.notification.update({
      where: { id: message.id },
      data: {
        status: NotificationStatus.FAILED,
        failedAt: new Date(),
        lastError: error,
        claimedUntil: null,
      },
    });
    this.logger.warn(`Notification ${message.id} failed: ${error}`);
    if (!alertStaff) {
      return;
    }
    await this.alerts.raise({
      kind: StaffAlertKind.NOTIFICATION_FAILED,
      dedupeKey: `notification-failed:${message.id}`,
      title: `A ${KIND_LABEL[message.kind]} could not be delivered`,
      detail:
        `${error}. ` +
        (message.kind === NotificationKind.LOCKOUT_WARNING
          ? 'The rider may not know their bike can be immobilized. Contact them another way.'
          : 'Check the phone number on the rider record.'),
      customerId: message.customerId,
      bikeId: message.bikeId,
      notificationId: message.id,
    });
  }
}
