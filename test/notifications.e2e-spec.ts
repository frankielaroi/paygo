import { createHmac, randomInt, randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { getStorageToken, type ThrottlerStorage } from '@nestjs/throttler';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import type { BikeDetailDto } from '../src/assets/dto/bike-response.dto';
import type { LoginResponseDto } from '../src/auth/dto/login-response.dto';
import type { Env } from '../src/config/env.validation';
import type { CustomerDetailDto } from '../src/customers/dto/customer-response.dto';
import { EnforcementService } from '../src/enforcement/enforcement.service';
import type { Notification } from '../src/generated/prisma/client';
import type { LoanDetailDto } from '../src/loans/dto/loan.dto';
import {
  MESSAGE_CHANNEL,
  type MessageChannel,
  type OutgoingMessage,
  type SendResult,
} from '../src/notifications/channels/message-channel';
import type { StaffAlertPageDto } from '../src/notifications/dto/notification.dto';
import { toMsisdn } from '../src/notifications/messages';
import { NotificationSchedulerService } from '../src/notifications/notification-scheduler.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { DEVICE_COMMAND_RESPONSE } from '../src/tcp/tcp.events';

/**
 * A channel the test controls per recipient: accepted by default, or rejected or unavailable for
 * the numbers a test names. Keyed by number because the scheduler messages every loan in the
 * database, not only the one a test created.
 */
class ScriptedChannel implements MessageChannel {
  readonly name = 'scripted';
  readonly sent: OutgoingMessage[] = [];
  readonly outcomes = new Map<string, SendResult>();

  send(message: OutgoingMessage): Promise<SendResult> {
    this.sent.push(message);
    return Promise.resolve(
      this.outcomes.get(message.to) ?? {
        outcome: 'accepted',
        providerMessageId: `scripted-${randomUUID()}`,
      },
    );
  }

  to(phone: string): OutgoingMessage[] {
    const msisdn = toMsisdn(phone);
    return this.sent.filter((message) => message.to === msisdn);
  }
}

/**
 * Notifications against the real database and the real scheduler, enforcement and payments.
 * Covers each acceptance criterion: reminders with the right amount and date, a warning that
 * always precedes a lock, lock and unlock messages that say why, staff alerts for deferrals and
 * failed messages, and no duplicate message for a repeated event.
 */
describe('Notifications (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let enforcement: EnforcementService;
  let scheduler: NotificationSchedulerService;
  let events: EventEmitter2;
  let config: ConfigService<Env, true>;
  const channel = new ScriptedChannel();
  const auth = { Authorization: '' };

  const suffix = (): string => randomUUID().slice(0, 8).toUpperCase();
  const digits = (length: number): string =>
    Array.from({ length }, () => randomInt(10)).join('');
  const http = () => request(app.getHttpServer());
  const day = (offset: number): string =>
    new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

  interface Setup {
    loan: LoanDetailDto;
    bikeId: string;
    phone: string;
    imei: string;
  }

  /** A rider on a bike with a tracker and a loan, the way staff would set it up. */
  async function riderWithLoan(
    terms: Record<string, unknown> = {},
    phone = `+23355${digits(7)}`,
  ): Promise<Setup> {
    const bike = await http()
      .post('/bikes')
      .set(auth)
      .send({
        label: `Ntf ${suffix()}`,
        vin: `NT${suffix()}${suffix()}`,
        registrationNumber: `GN ${digits(4)}-${digits(2)}`,
        make: 'Bajaj',
        model: 'Boxer',
      })
      .expect(201);
    const bikeId = (bike.body as BikeDetailDto).id;
    const imei = `35${digits(13)}`;
    await http()
      .post(`/bikes/${bikeId}/tracker`)
      .set(auth)
      .send({ imei })
      .expect(200);

    const rider = await http()
      .post('/customers')
      .set(auth)
      .send({
        firstName: 'Ama',
        lastName: `Owusu${suffix()}`,
        phone,
        nationalId: `GHA-${digits(9)}-${digits(1)}`,
        photoUrl: 'https://files.example.test/p.jpg',
        idDocumentUrl: 'https://files.example.test/id.jpg',
      })
      .expect(201);
    const riderId = (rider.body as CustomerDetailDto).id;
    await http()
      .post(`/customers/${riderId}/kyc-verification`)
      .set(auth)
      .expect(200);
    await http()
      .post(`/bikes/${bikeId}/assignment`)
      .set(auth)
      .send({ customerId: riderId })
      .expect(200);

    const loan = await http()
      .post('/loans')
      .set(auth)
      .send({
        customerId: riderId,
        bikeId,
        currency: 'GHS',
        principalMinor: 300_00,
        installmentMinor: 100_00,
        frequency: 'DAILY',
        graceDays: 0,
        firstDueDate: day(1),
        ...terms,
      })
      .expect(201);
    return { loan: loan.body as LoanDetailDto, bikeId, phone, imei };
  }

  function notificationsFor(
    loanId: string,
    kind?: string,
  ): Promise<Notification[]> {
    return prisma.notification.findMany({
      where: {
        loanId,
        ...(kind ? { kind: kind as Notification['kind'] } : {}),
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async function ageWarnings(loanId: string): Promise<void> {
    const hours = config.get('LOCKOUT_WARNING_LEAD_HOURS', { infer: true });
    const past = new Date(Date.now() - (hours + 1) * 3_600_000);
    const warnings = { loanId, kind: 'LOCKOUT_WARNING' as const };
    // Only timestamps that exist are moved back: a pending warning must stay unattempted.
    await prisma.notification.updateMany({
      where: { ...warnings, sentAt: { not: null } },
      data: { sentAt: past },
    });
    await prisma.notification.updateMany({
      where: { ...warnings, failedAt: { not: null } },
      data: { failedAt: past },
    });
  }

  async function desiredState(bikeId: string): Promise<string | undefined> {
    const row = await prisma.bikeEnforcement.findUnique({
      where: { bikeId },
      select: { desiredState: true },
    });
    return row?.desiredState;
  }

  /** Listeners run after the emitting call returns; wait for their effect, briefly. */
  async function eventually<T>(
    read: () => Promise<T>,
    ok: (value: T) => boolean,
  ): Promise<T> {
    let value = await read();
    for (let attempt = 0; attempt < 40 && !ok(value); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      value = await read();
    }
    return value;
  }

  function deviceReplies(imei: string, text: string): Promise<unknown> {
    return events.emitAsync(DEVICE_COMMAND_RESPONSE, {
      imei,
      text,
      receivedAt: new Date(),
    });
  }

  function paystack(
    loanId: string,
    amount: number,
    reference = `T${suffix()}`,
  ) {
    const secret = config.get('PAYSTACK_SECRET_KEY', { infer: true }) ?? '';
    const body = JSON.stringify({
      event: 'charge.success',
      data: {
        id: randomInt(1_000_000_000),
        reference,
        status: 'success',
        amount,
        currency: 'GHS',
        paid_at: new Date().toISOString(),
        metadata: { loan_id: loanId },
      },
    });
    return http()
      .post('/webhooks/paystack')
      .set('Content-Type', 'application/json')
      .set(
        'x-paystack-signature',
        createHmac('sha512', secret).update(body).digest('hex'),
      )
      .send(body);
  }

  beforeAll(async () => {
    const neverCounts: ThrottlerStorage = {
      increment: () =>
        Promise.resolve({
          totalHits: 1,
          timeToExpire: 60,
          isBlocked: false,
          timeToBlockExpire: 0,
        }),
    };
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(getStorageToken())
      .useValue(neverCounts)
      .overrideProvider(MESSAGE_CHANNEL)
      .useValue(channel)
      .compile();

    app = moduleFixture.createNestApplication({ rawBody: true });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();

    prisma = app.get(PrismaService);
    enforcement = app.get(EnforcementService);
    scheduler = app.get(NotificationSchedulerService);
    events = app.get(EventEmitter2);
    config = app.get<ConfigService<Env, true>>(ConfigService);

    const login = await http()
      .post('/auth/login')
      .send({
        email: process.env.SEED_ADMIN_EMAIL ?? 'admin@paygo.local',
        password: process.env.SEED_ADMIN_PASSWORD ?? 'ChangeMe!2026',
      })
      .expect(200);
    auth.Authorization = `Bearer ${(login.body as LoginResponseDto).accessToken}`;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('reminders', () => {
    it('reminds the rider ahead of the due date with the right amount and date, once', async () => {
      const setup = await riderWithLoan({ firstDueDate: day(1) });

      await scheduler.sendReminders(new Date());
      await scheduler.sendReminders(new Date());

      const reminders = await notificationsFor(
        setup.loan.id,
        'PAYMENT_REMINDER',
      );
      expect(reminders).toHaveLength(1);
      expect(reminders[0]?.status).toBe('SENT');
      expect(reminders[0]?.body).toContain('GHS 100.00');
      const due = new Date(`${day(1)}T00:00:00Z`);
      const expectedDay = due.toUTCString().slice(0, 3);
      expect(reminders[0]?.body).toContain(
        `due on ${expectedDay} ${due.getUTCDate()}`,
      );
      expect(channel.to(setup.phone)).toHaveLength(1);
    });

    it('does not remind for an installment already paid', async () => {
      const setup = await riderWithLoan({ firstDueDate: day(1) });
      await paystack(setup.loan.id, 100_00).expect(200);

      await scheduler.sendReminders(new Date());

      expect(
        await notificationsFor(setup.loan.id, 'PAYMENT_REMINDER'),
      ).toHaveLength(0);
    });
  });

  describe('the pre-lockout warning comes before any lock', () => {
    it('warns inside the grace period, while the bike cannot yet be locked', async () => {
      const setup = await riderWithLoan({
        firstDueDate: day(-1),
        graceDays: 2,
      });

      await scheduler.sendLockoutWarnings(new Date());
      const [warning] = await notificationsFor(
        setup.loan.id,
        'LOCKOUT_WARNING',
      );
      expect(warning?.status).toBe('SENT');
      // Everything due so far: yesterday's installment and today's.
      expect(warning?.body).toContain('GHS 200.00');
      // The deadline is the last grace day of the installment warned about: yesterday + 2.
      const lastGraceDay = new Date(`${day(1)}T00:00:00Z`);
      expect(warning?.body).toContain(
        `Pay by end of ${lastGraceDay.toUTCString().slice(0, 3)}`,
      );
      expect(warning?.body).toContain('immobilized');

      await ageWarnings(setup.loan.id);
      await enforcement.sweep();
      expect(await desiredState(setup.bikeId)).toBeUndefined(); // still within grace
    });

    it('does not lock an overdue rider who has not been warned, nor one warned just now', async () => {
      const setup = await riderWithLoan({ firstDueDate: day(-3) });

      await enforcement.sweep();
      expect(await desiredState(setup.bikeId)).toBeUndefined();

      await scheduler.sendLockoutWarnings(new Date());
      await enforcement.sweep();
      expect(await desiredState(setup.bikeId)).toBeUndefined();

      await ageWarnings(setup.loan.id);
      await enforcement.sweep();
      expect(await desiredState(setup.bikeId)).toBe('IMMOBILIZED');
    });

    it('never counts a warning stuck behind a provider outage, and alerts staff', async () => {
      const phone = `+23324${digits(7)}`;
      const msisdn = toMsisdn(phone) ?? '';
      channel.outcomes.set(msisdn, {
        outcome: 'unavailable',
        error: 'Arkesel HTTP 503',
      });
      const setup = await riderWithLoan({ firstDueDate: day(-3) }, phone);

      await scheduler.sendLockoutWarnings(new Date());
      const max = config.get('NOTIFICATION_MAX_ATTEMPTS', { infer: true });
      for (let attempt = 1; attempt < max; attempt += 1) {
        await app.get(NotificationsService).retryPending(new Date());
      }
      // A long outage: the stuck warning was recorded well over the lead time ago. Being old
      // must not make it count; only a send attempt that reached the rider (or was refused for
      // their number) does.
      await prisma.notification.updateMany({
        where: { loanId: setup.loan.id, kind: 'LOCKOUT_WARNING' },
        data: { createdAt: new Date(Date.now() - 48 * 3_600_000) },
      });
      await ageWarnings(setup.loan.id);
      await enforcement.sweep();

      const [warning] = await notificationsFor(
        setup.loan.id,
        'LOCKOUT_WARNING',
      );
      expect(warning).toMatchObject({ status: 'PENDING', attempts: max });
      expect(await desiredState(setup.bikeId)).toBeUndefined();
      const alerts = await prisma.staffAlert.findMany({
        where: { notificationId: warning?.id },
      });
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.detail).toContain('cannot be locked automatically');

      // The provider recovers: the warning goes out and, once aged, the lock may follow.
      channel.outcomes.delete(msisdn);
      await app.get(NotificationsService).retryPending(new Date());
      expect(
        (await notificationsFor(setup.loan.id, 'LOCKOUT_WARNING'))[0]?.status,
      ).toBe('SENT');
      await ageWarnings(setup.loan.id);
      await enforcement.sweep();
      expect(await desiredState(setup.bikeId)).toBe('IMMOBILIZED');
    });

    it('treats a number the provider rejects as warned, so it cannot dodge enforcement, and alerts staff', async () => {
      const phone = `+23320${digits(7)}`;
      channel.outcomes.set(toMsisdn(phone) ?? '', {
        outcome: 'rejected',
        error: 'Arkesel rejected the message: Invalid phone number',
      });
      const setup = await riderWithLoan({ firstDueDate: day(-3) }, phone);

      await scheduler.sendLockoutWarnings(new Date());
      const [warning] = await notificationsFor(
        setup.loan.id,
        'LOCKOUT_WARNING',
      );
      expect(warning?.status).toBe('FAILED');

      const alerts = await http()
        .get('/staff-alerts')
        .query({ limit: 100 })
        .set(auth)
        .expect(200);
      const alert = (alerts.body as StaffAlertPageDto).data.find(
        (row) => row.notificationId === warning?.id,
      );
      expect(alert?.title).toContain('could not be delivered');

      await ageWarnings(setup.loan.id);
      await enforcement.sweep();
      expect(await desiredState(setup.bikeId)).toBe('IMMOBILIZED');
    });
  });

  describe('lock and unlock messages', () => {
    it('tells the rider why the bike was immobilized, and thanks them when payment unlocks it', async () => {
      const setup = await riderWithLoan({ firstDueDate: day(-3) });
      await scheduler.sendLockoutWarnings(new Date());
      await ageWarnings(setup.loan.id);
      await enforcement.sweep();

      await deviceReplies(setup.imei, 'Setdigout 1 OK');
      const [locked] = await eventually(
        () => notificationsFor(setup.loan.id, 'BIKE_IMMOBILIZED'),
        (rows) => rows.length > 0,
      );
      expect(locked?.body).toContain('immobilized');
      expect(locked?.body).toContain('GHS 300.00 is overdue');

      await paystack(setup.loan.id, 300_00).expect(200);
      expect(await desiredState(setup.bikeId)).toBe('MOBILE');
      await deviceReplies(setup.imei, 'Setdigout 0 OK');
      const [restored] = await eventually(
        () => notificationsFor(setup.loan.id, 'BIKE_RESTORED'),
        (rows) => rows.length > 0,
      );
      expect(restored?.body).toContain('thank you for your payment');
      expect(restored?.body).toContain('unlocked');
    });

    it('sends one message per confirmed change, however often the device repeats itself', async () => {
      const setup = await riderWithLoan({ firstDueDate: day(-3) });
      await scheduler.sendLockoutWarnings(new Date());
      await ageWarnings(setup.loan.id);
      await enforcement.sweep();

      await deviceReplies(setup.imei, 'Setdigout 1 OK');
      await deviceReplies(setup.imei, 'Setdigout 1 OK');
      await deviceReplies(setup.imei, 'Setdigout 1 OK');
      await eventually(
        () => notificationsFor(setup.loan.id, 'BIKE_IMMOBILIZED'),
        (rows) => rows.length > 0,
      );
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(
        await notificationsFor(setup.loan.id, 'BIKE_IMMOBILIZED'),
      ).toHaveLength(1);
    });

    it('sends no second unlock message when Paystack retries the payment webhook', async () => {
      const setup = await riderWithLoan({ firstDueDate: day(-3) });
      await scheduler.sendLockoutWarnings(new Date());
      await ageWarnings(setup.loan.id);
      await enforcement.sweep();
      await deviceReplies(setup.imei, 'Setdigout 1 OK');

      const reference = `T${suffix()}`;
      await paystack(setup.loan.id, 300_00, reference).expect(200);
      await paystack(setup.loan.id, 300_00, reference).expect(200);
      await deviceReplies(setup.imei, 'Setdigout 0 OK');
      await eventually(
        () => notificationsFor(setup.loan.id, 'BIKE_RESTORED'),
        (rows) => rows.length > 0,
      );

      expect(
        await notificationsFor(setup.loan.id, 'BIKE_RESTORED'),
      ).toHaveLength(1);
    });
  });

  describe('staff alerts', () => {
    it('raises an alert when enforcement defers a lock because the position cannot be trusted', async () => {
      const setup = await riderWithLoan({ firstDueDate: day(-3) });
      await scheduler.sendLockoutWarnings(new Date());
      await ageWarnings(setup.loan.id);

      await enforcement.sweep(); // no telemetry at all: deferred for review
      await enforcement.sweep();

      const alerts = await eventually(
        () =>
          prisma.staffAlert.findMany({
            where: { bikeId: setup.bikeId, kind: 'ENFORCEMENT_REVIEW' },
          }),
        (rows) => rows.length > 0,
      );
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.title).toContain('position cannot be trusted');

      await http()
        .post(`/staff-alerts/${alerts[0]?.id}/acknowledgement`)
        .set(auth)
        .expect(200);
      await http()
        .post(`/staff-alerts/${alerts[0]?.id}/acknowledgement`)
        .set(auth)
        .expect(409);
    });
  });

  describe('delivery reports', () => {
    const token = (): string =>
      config.get('ARKESEL_CALLBACK_TOKEN', { infer: true }) ?? '';

    it('marks a message delivered, or failed with a staff alert, from the provider report', async () => {
      const setup = await riderWithLoan({ firstDueDate: day(-3) });
      await scheduler.sendLockoutWarnings(new Date());
      const [warning] = await notificationsFor(
        setup.loan.id,
        'LOCKOUT_WARNING',
      );

      await http()
        .post(`/webhooks/arkesel/${token()}`)
        .send({ sms_id: warning?.providerMessageId, status: 'DELIVERED' })
        .expect(200);
      expect(
        (await notificationsFor(setup.loan.id, 'LOCKOUT_WARNING'))[0]?.status,
      ).toBe('DELIVERED');

      const other = await riderWithLoan({ firstDueDate: day(-3) });
      await scheduler.sendLockoutWarnings(new Date());
      const [second] = await notificationsFor(other.loan.id, 'LOCKOUT_WARNING');
      await http()
        .get(`/webhooks/arkesel/${token()}`)
        .query({ sms_id: second?.providerMessageId, status: 'UNDELIVERED' })
        .expect(200);
      const [failed] = await notificationsFor(other.loan.id, 'LOCKOUT_WARNING');
      expect(failed?.status).toBe('FAILED');
      expect(
        await prisma.staffAlert.count({
          where: { notificationId: failed?.id },
        }),
      ).toBe(1);
    });

    it('ignores a report without the secret token', async () => {
      await http()
        .post('/webhooks/arkesel/not-the-token')
        .send({ sms_id: 'x', status: 'DELIVERED' })
        .expect(404);
    });
  });
});
