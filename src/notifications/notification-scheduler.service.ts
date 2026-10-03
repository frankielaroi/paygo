import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.validation';
import { NotificationKind } from '../generated/prisma/enums';
import { addDays, utcDay } from '../loans/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { lockoutWarningText, reminderText } from './messages';
import { NotificationsService } from './notifications.service';
import { StaffNotifierService } from './staff-notifier.service';

interface DueRow {
  installmentId: string;
  loanId: string;
  customerId: string;
  bikeId: string;
  currency: string;
  graceDays: number;
  dueDate: Date;
  amountMinor: bigint | number | string;
  phone: string;
  firstName: string;
  bikeName: string;
}

/**
 * Sends the messages that are due by the calendar rather than by an event: reminders ahead of a
 * due date, and the warning before a lock. Also retries messages the provider could not take.
 *
 * Both queries skip installments already messaged, and notify() refuses a repeat anyway, so a
 * run that overlaps another, or runs twice, sends nothing twice.
 */
@Injectable()
export class NotificationSchedulerService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(NotificationSchedulerService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly notifications: NotificationsService,
    private readonly staffNotifier: StaffNotifierService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.get('NOTIFICATIONS_ENABLED', { infer: true })) {
      this.logger.warn(
        'Notification scheduler disabled by NOTIFICATIONS_ENABLED',
      );
      return;
    }
    const intervalMs =
      this.config.get('NOTIFICATIONS_INTERVAL_SECONDS', { infer: true }) * 1000;
    this.timer = setInterval(() => {
      void this.runOnce(new Date());
    }, intervalMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async runOnce(now: Date): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      if (this.withinMessagingHours(now)) {
        await this.sendReminders(now);
        await this.sendLockoutWarnings(now);
        // Staff are not texted a digest at night either.
        await this.staffNotifier.sendOverdueDigest(now);
      }
      await this.notifications.retryPending(now);
    } catch (error) {
      this.logger.error(
        `Notification run failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
  }

  /** Reminders and warnings are not sent at night. */
  withinMessagingHours(now: Date): boolean {
    const hour = now.getUTCHours();
    return (
      hour >= this.config.get('RIDER_MESSAGE_START_HOUR', { infer: true }) &&
      hour < this.config.get('RIDER_MESSAGE_END_HOUR', { infer: true })
    );
  }

  /** Unpaid installments falling due within the lead days, each reminded once. */
  async sendReminders(now: Date): Promise<number> {
    const lead = this.config.get('PAYMENT_REMINDER_LEAD_DAYS', { infer: true });
    if (lead === 0) {
      return 0;
    }
    const today = isoDay(now);
    const rows = await this.prisma.$queryRaw<DueRow[]>`
      SELECT i."id" AS "installmentId", l."id" AS "loanId", l."customerId", l."bikeId",
             l."currency", l."graceDays", i."dueDate",
             i."amountMinor" - i."paidMinor" AS "amountMinor",
             c."phone", c."firstName",
             COALESCE(b."registrationNumber", b."label") AS "bikeName"
      FROM "loan_installments" i
      JOIN "loans" l ON l."id" = i."loanId"
      JOIN "customers" c ON c."id" = l."customerId"
      JOIN "bikes" b ON b."id" = l."bikeId"
      WHERE l."status" IN ('ACTIVE', 'DEFAULTED')
        AND i."paidMinor" < i."amountMinor"
        AND i."dueDate" > ${today}::date
        AND i."dueDate" <= ${today}::date + ${lead}::int
        AND NOT EXISTS (
          SELECT 1 FROM "notifications" n WHERE n."dedupeKey" = 'reminder:' || i."id"::text
        )
    `;

    let sent = 0;
    for (const row of rows) {
      const created = await this.notifications.notify({
        kind: NotificationKind.PAYMENT_REMINDER,
        dedupeKey: `reminder:${row.installmentId}`,
        customerId: row.customerId,
        loanId: row.loanId,
        installmentId: row.installmentId,
        bikeId: row.bikeId,
        phone: row.phone,
        body: reminderText(
          { firstName: row.firstName, bikeName: row.bikeName },
          Number(row.amountMinor),
          row.currency,
          row.dueDate,
        ),
      });
      sent += created ? 1 : 0;
    }
    return sent;
  }

  /**
   * The pre-lockout warning, one per loan per arrears episode: about the oldest unpaid installment
   * that has fallen due, sent from the day after its due date (or on the due date itself when
   * there is no grace), so it always comes before the bike can be locked. The arrears sweep will
   * not lock until this has gone out and LOCKOUT_WARNING_LEAD_HOURS have passed.
   *
   * The amount is everything due so far, and the deadline is the last day of grace, or today if
   * that has already passed (a loan that fell behind before warnings existed).
   */
  async sendLockoutWarnings(now: Date): Promise<number> {
    const today = isoDay(now);
    const rows = await this.prisma.$queryRaw<DueRow[]>`
      SELECT oldest.* FROM (
        SELECT DISTINCT ON (l."id")
               i."id" AS "installmentId", l."id" AS "loanId", l."customerId", l."bikeId",
               l."currency", l."graceDays", i."dueDate",
               (
                 SELECT SUM(d."amountMinor" - d."paidMinor")
                 FROM "loan_installments" d
                 WHERE d."loanId" = l."id" AND d."dueDate" <= ${today}::date
               ) AS "amountMinor",
               c."phone", c."firstName",
               COALESCE(b."registrationNumber", b."label") AS "bikeName"
        FROM "loans" l
        JOIN "loan_installments" i ON i."loanId" = l."id"
        JOIN "customers" c ON c."id" = l."customerId"
        JOIN "bikes" b ON b."id" = l."bikeId"
        WHERE l."status" IN ('ACTIVE', 'DEFAULTED')
          AND i."paidMinor" < i."amountMinor"
          AND i."dueDate" + LEAST(l."graceDays", 1) <= ${today}::date
        ORDER BY l."id", i."sequence"
      ) oldest
      WHERE NOT EXISTS (
        SELECT 1 FROM "notifications" n
        WHERE n."dedupeKey" = 'lockout-warning:' || oldest."installmentId"::text
      )
    `;

    let sent = 0;
    const todayDate = utcDay(now);
    for (const row of rows) {
      const lastGraceDay = addDays(row.dueDate, row.graceDays);
      const created = await this.notifications.notify({
        kind: NotificationKind.LOCKOUT_WARNING,
        dedupeKey: `lockout-warning:${row.installmentId}`,
        customerId: row.customerId,
        loanId: row.loanId,
        installmentId: row.installmentId,
        bikeId: row.bikeId,
        phone: row.phone,
        body: lockoutWarningText(
          { firstName: row.firstName, bikeName: row.bikeName },
          Number(row.amountMinor),
          row.currency,
          lastGraceDay < todayDate ? todayDate : lastGraceDay,
        ),
      });
      sent += created ? 1 : 0;
    }
    return sent;
  }
}

function isoDay(date: Date): string {
  return utcDay(date).toISOString().slice(0, 10);
}
