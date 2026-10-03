import { Inject, Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  BIKE_WENT_OFFLINE,
  GEOFENCE_EXITED,
  type BikeWentOfflineEvent,
  type GeofenceExitedEvent,
} from '../common/events';
import { isUniqueViolation } from '../common/prisma-errors';
import {
  BikeStatus,
  StaffMessageStatus,
  StaffNotificationTopic,
  type StaffRole,
} from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { Permission, roleHasPermission } from '../users/enums/role.enum';
import {
  MESSAGE_CHANNEL,
  type MessageChannel,
} from './channels/message-channel';
import type {
  NotificationPreferencesDto,
  TopicPreferenceDto,
} from './dto/staff-notification.dto';
import { toMsisdn } from './messages';
import {
  bikeOfflineText,
  overdueDigestText,
  zoneExitText,
} from './staff-messages';

export const STAFF_TOPICS: readonly StaffNotificationTopic[] = [
  StaffNotificationTopic.LOAN_OVERDUE,
  StaffNotificationTopic.BIKE_OFFLINE,
  StaffNotificationTopic.GEOFENCE_EXIT,
];

/**
 * The most event alerts (offline, zone exit) one person is texted in an hour. A tracker that
 * flaps, or a zone redrawn through a busy street, must not become hundreds of paid messages.
 */
export const HOURLY_CAP = 10;

interface Recipient {
  id: string;
  phone: string;
  role: StaffRole;
}

interface BikeContext {
  name: string;
  rider: string | null;
  /** The field agent who owns the rider holding the bike, if any. */
  agentId: string | null;
  status: BikeStatus;
}

interface OverdueRow {
  bikeName: string;
  agentId: string | null;
}

/**
 * SMS alerts to staff, each person choosing their own topics. Nothing is sent to anyone who
 * has not turned a topic on, so one person's choice never changes what another receives.
 *
 * Who hears about what follows what they can see in the app: staff who see the whole fleet
 * (asset:read) hear about every bike, and a field agent only about their own riders'.
 *
 * Every message is written to staff_messages before it is sent, unique per person and event,
 * so an event handled twice texts nobody twice. A failed send is recorded and not retried: an
 * alert about something happening now is not worth delivering an hour late.
 */
@Injectable()
export class StaffNotifierService {
  private readonly logger = new Logger(StaffNotifierService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(MESSAGE_CHANNEL) private readonly channel: MessageChannel,
  ) {}

  async preferencesOf(userId: string): Promise<NotificationPreferencesDto> {
    const [user, rows] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { phone: true },
      }),
      this.prisma.staffNotificationPreference.findMany({
        where: { userId },
        select: { topic: true, sms: true },
      }),
    ]);
    return {
      phone: user.phone,
      topics: STAFF_TOPICS.map((topic) => ({
        topic,
        sms: rows.find((row) => row.topic === topic)?.sms ?? false,
      })),
    };
  }

  /** Only ever the caller's own preferences: `userId` comes from the session, never the body. */
  async setPreferences(
    userId: string,
    topics: TopicPreferenceDto[],
  ): Promise<NotificationPreferencesDto> {
    await this.prisma.$transaction(
      topics.map(({ topic, sms }) =>
        this.prisma.staffNotificationPreference.upsert({
          where: { userId_topic: { userId, topic } },
          update: { sms },
          create: { userId, topic, sms },
        }),
      ),
    );
    return this.preferencesOf(userId);
  }

  @OnEvent(BIKE_WENT_OFFLINE)
  async onBikeWentOffline(event: BikeWentOfflineEvent): Promise<void> {
    await this.guarded('bike offline', async () => {
      const bike = await this.bikeContext(event.bikeId);
      // A bike in stock or repossessed going quiet is not an emergency; one with a rider is.
      if (!bike || bike.status !== BikeStatus.ASSIGNED) {
        return;
      }
      const day = event.lastReportedAt.toISOString().slice(0, 10);
      await this.sendToSubscribers(
        StaffNotificationTopic.BIKE_OFFLINE,
        // Once per bike per day, however often its tracker drops out.
        `bike-offline:${event.bikeId}:${day}`,
        bikeOfflineText(bike.name, bike.rider, event.lastReportedAt),
        { bikeId: event.bikeId, agentId: bike.agentId },
      );
    });
  }

  @OnEvent(GEOFENCE_EXITED)
  async onGeofenceExited(event: GeofenceExitedEvent): Promise<void> {
    await this.guarded('zone exit', async () => {
      const bike = await this.bikeContext(event.bikeId);
      if (!bike) {
        return;
      }
      await this.sendToSubscribers(
        StaffNotificationTopic.GEOFENCE_EXIT,
        `zone-exit:${event.crossingId}`,
        zoneExitText(bike.name, bike.rider, event.geofenceName),
        { bikeId: event.bikeId, agentId: bike.agentId },
      );
    });
  }

  /**
   * One message per person per day listing the loans that became overdue that day: those whose
   * oldest unpaid installment passed its grace period today. Called by the scheduler inside
   * messaging hours; safe to call on every run, since the day is the dedupe key.
   */
  async sendOverdueDigest(now: Date): Promise<void> {
    await this.guarded('overdue digest', async () => {
      const today = now.toISOString().slice(0, 10);
      const rows = await this.prisma.$queryRaw<OverdueRow[]>`
        SELECT COALESCE(b."registrationNumber", b."label") AS "bikeName",
               c."assignedAgentId" AS "agentId"
        FROM "loans" l
        JOIN "bikes" b ON b."id" = l."bikeId"
        JOIN "customers" c ON c."id" = l."customerId"
        JOIN LATERAL (
          SELECT MIN(i."dueDate") AS "oldest"
          FROM "loan_installments" i
          WHERE i."loanId" = l."id" AND i."paidMinor" < i."amountMinor"
        ) unpaid ON true
        WHERE l."status" = 'ACTIVE'
          AND unpaid."oldest" + l."graceDays" + 1 = ${today}::date
        ORDER BY 1
      `;
      if (rows.length === 0) {
        return;
      }
      const recipients = await this.subscribers(
        StaffNotificationTopic.LOAN_OVERDUE,
      );
      for (const recipient of recipients) {
        const seesAll = roleHasPermission(
          recipient.role,
          Permission.LOAN_READ_ALL,
        );
        const own = rows.filter(
          (row) => seesAll || row.agentId === recipient.id,
        );
        if (own.length > 0) {
          await this.send(
            recipient,
            StaffNotificationTopic.LOAN_OVERDUE,
            `loan-overdue:${today}`,
            overdueDigestText(own.map((row) => row.bikeName)),
            null,
          );
        }
      }
    });
  }

  private async sendToSubscribers(
    topic: StaffNotificationTopic,
    dedupeKey: string,
    body: string,
    bike: { bikeId: string; agentId: string | null },
  ): Promise<void> {
    for (const recipient of await this.subscribers(topic)) {
      const seesAll = roleHasPermission(recipient.role, Permission.ASSET_READ);
      if (!seesAll && bike.agentId !== recipient.id) {
        continue;
      }
      if (await this.overCap(recipient.id)) {
        this.logger.warn(
          `Staff ${recipient.id} reached ${HOURLY_CAP} alerts this hour; ${topic} not sent`,
        );
        continue;
      }
      await this.send(recipient, topic, dedupeKey, body, bike.bikeId);
    }
  }

  /** Active staff with a phone who turned this topic on. */
  private async subscribers(
    topic: StaffNotificationTopic,
  ): Promise<Recipient[]> {
    const users = await this.prisma.user.findMany({
      where: {
        isActive: true,
        phone: { not: null },
        notificationPreferences: { some: { topic, sms: true } },
      },
      select: { id: true, phone: true, role: true },
    });
    return users.flatMap((user) =>
      user.phone ? [{ id: user.id, phone: user.phone, role: user.role }] : [],
    );
  }

  private async overCap(userId: string): Promise<boolean> {
    const recent = await this.prisma.staffMessage.count({
      where: {
        userId,
        topic: { not: StaffNotificationTopic.LOAN_OVERDUE },
        createdAt: { gt: new Date(Date.now() - 3_600_000) },
      },
    });
    return recent >= HOURLY_CAP;
  }

  private async send(
    recipient: Recipient,
    topic: StaffNotificationTopic,
    dedupeKey: string,
    body: string,
    bikeId: string | null,
  ): Promise<void> {
    let id: string;
    try {
      ({ id } = await this.prisma.staffMessage.create({
        data: {
          userId: recipient.id,
          topic,
          dedupeKey,
          recipient: recipient.phone,
          body,
          channel: this.channel.name,
          bikeId,
        },
        select: { id: true },
      }));
    } catch (error) {
      if (isUniqueViolation(error)) {
        return; // Already sent to this person for this event.
      }
      throw error;
    }

    const to = toMsisdn(recipient.phone);
    const result = to
      ? await this.channel.send({ to, body }).catch((error: unknown) => ({
          outcome: 'unavailable' as const,
          error: error instanceof Error ? error.message : String(error),
        }))
      : { outcome: 'rejected' as const, error: 'Not a valid phone number' };

    await this.prisma.staffMessage.update({
      where: { id },
      data:
        result.outcome === 'accepted'
          ? {
              status: StaffMessageStatus.SENT,
              sentAt: new Date(),
              providerMessageId: result.providerMessageId,
            }
          : { status: StaffMessageStatus.FAILED, error: result.error },
    });
  }

  private async bikeContext(bikeId: string): Promise<BikeContext | null> {
    const bike = await this.prisma.bike.findUnique({
      where: { id: bikeId },
      select: {
        label: true,
        registrationNumber: true,
        status: true,
        assignments: {
          where: { endedAt: null },
          take: 1,
          select: {
            customer: {
              select: {
                firstName: true,
                lastName: true,
                assignedAgentId: true,
              },
            },
          },
        },
      },
    });
    if (!bike) {
      return null;
    }
    const rider = bike.assignments[0]?.customer ?? null;
    return {
      name: bike.registrationNumber ?? bike.label,
      rider: rider ? `${rider.firstName} ${rider.lastName}` : null,
      agentId: rider?.assignedAgentId ?? null,
      status: bike.status,
    };
  }

  /** An alert that cannot be sent must never break what raised it. */
  private async guarded(what: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(`Could not send the ${what} alert: ${detail}`);
    }
  }
}
