import { randomInt, randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { getStorageToken, type ThrottlerStorage } from '@nestjs/throttler';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import type { BikeDetailDto } from '../src/assets/dto/bike-response.dto';
import type { LoginResponseDto } from '../src/auth/dto/login-response.dto';
import type { CustomerDetailDto } from '../src/customers/dto/customer-response.dto';
import type {
  DashboardSummaryDto,
  FleetPageDto,
  FleetRowDto,
  ReminderResultDto,
} from '../src/dashboard/dto/dashboard.dto';
import type { LoanDetailDto } from '../src/loans/dto/loan.dto';
import {
  DEVICE_COMMAND_RESPONSE,
  DEVICE_POSITIONS,
} from '../src/tcp/tcp.events';
import type { StaffWithPasswordDto } from '../src/users/dto/staff.dto';

interface Token {
  token: string;
}

/**
 * The dashboard against the real app and database, which also holds whatever else other suites
 * and the demo seed created: assertions look up this suite's own bikes rather than assuming
 * totals.
 */
describe('Dashboard (e2e)', () => {
  let app: INestApplication<App>;
  let admin: Token;
  let events: EventEmitter2;

  const suffix = (): string => randomUUID().slice(0, 8).toLowerCase();
  const digits = (length: number): string =>
    Array.from({ length }, () => randomInt(10)).join('');
  const http = () => request(app.getHttpServer());
  const bearer = (who: Token) => ({ Authorization: `Bearer ${who.token}` });
  const day = (offset: number): string =>
    new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

  async function staff(role: 'FIELD_AGENT' | 'FINANCE'): Promise<Token> {
    const email = `dash-${suffix()}@e2e.paygo.local`;
    const created = await http()
      .post('/staff')
      .set(bearer(admin))
      .send({ email, firstName: 'Dash', lastName: 'Board', role })
      .expect(201);
    const temporary = (created.body as StaffWithPasswordDto).temporaryPassword;
    const first = await http()
      .post('/auth/login')
      .send({ email, password: temporary })
      .expect(200);
    const password = `Pass-${randomUUID()}`;
    await http()
      .post('/me/password')
      .set(bearer({ token: (first.body as LoginResponseDto).accessToken }))
      .send({ currentPassword: temporary, newPassword: password })
      .expect(204);
    const login = await http()
      .post('/auth/login')
      .send({ email, password })
      .expect(200);
    return { token: (login.body as LoginResponseDto).accessToken };
  }

  interface Setup {
    bikeId: string;
    plate: string;
    imei: string;
    loanId: string;
    rider: string;
  }

  /**
   * A bike on the road with a tracker and a daily loan of GHS 100 a day. `registeredBy` makes
   * the rider that agent's; `reporting` sends a fresh stationary reading so it counts as online.
   */
  async function bikeOnLoan(options: {
    firstDueDate: string;
    registeredBy?: Token;
    reporting?: boolean;
  }): Promise<Setup> {
    const lastName = `Dash${suffix()}`;
    const rider = await http()
      .post('/customers')
      .set(bearer(options.registeredBy ?? admin))
      .send({
        firstName: 'Kojo',
        lastName,
        phone: `+23324${digits(7)}`,
        nationalId: `GHA-${digits(9)}-${digits(1)}`,
        photoUrl: 'https://files.example.test/p.jpg',
        idDocumentUrl: 'https://files.example.test/id.jpg',
      })
      .expect(201);
    const riderId = (rider.body as CustomerDetailDto).id;
    await http()
      .post(`/customers/${riderId}/kyc-verification`)
      .set(bearer(admin))
      .expect(200);

    const plate = `E2E-${suffix().toUpperCase()}`;
    const bike = await http()
      .post('/bikes')
      .set(bearer(admin))
      .send({
        label: `DSH-${suffix()}`,
        vin: `DS${suffix()}${suffix()}`.toUpperCase(),
        registrationNumber: plate,
        make: 'Bajaj',
        model: 'Boxer',
      })
      .expect(201);
    const bikeId = (bike.body as BikeDetailDto).id;
    const imei = `35${digits(13)}`;
    await http()
      .post(`/bikes/${bikeId}/tracker`)
      .set(bearer(admin))
      .send({ imei })
      .expect(200);
    await http()
      .post(`/bikes/${bikeId}/assignment`)
      .set(bearer(admin))
      .send({ customerId: riderId })
      .expect(200);
    const loan = await http()
      .post('/loans')
      .set(bearer(admin))
      .send({
        customerId: riderId,
        bikeId,
        currency: 'GHS',
        principalMinor: 3000_00,
        installmentMinor: 100_00,
        frequency: 'DAILY',
        graceDays: 0,
        firstDueDate: options.firstDueDate,
      })
      .expect(201);

    if (options.reporting !== false) {
      await events.emitAsync(DEVICE_POSITIONS, {
        imei,
        receivedAt: new Date(),
        records: [
          {
            timestamp: new Date(),
            priority: 0,
            latitude: 5.6,
            longitude: -0.19,
            altitude: 50,
            angle: 0,
            satellites: 10,
            speed: 23,
            eventIoId: 0,
            io: {},
            ignition: true,
            movement: true,
            hasFix: true,
          },
        ],
      });
    }
    return {
      bikeId,
      plate,
      imei,
      loanId: (loan.body as LoanDetailDto).id,
      rider: `Kojo ${lastName}`,
    };
  }

  async function row(
    who: Token,
    setup: Setup,
  ): Promise<FleetRowDto | undefined> {
    const page = await http()
      .get('/dashboard/fleet')
      .query({ search: setup.plate })
      .set(bearer(who))
      .expect(200);
    return (page.body as FleetPageDto).data.find(
      (r) => r.bikeId === setup.bikeId,
    );
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
      .compile();
    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
    events = app.get(EventEmitter2);

    const login = await http()
      .post('/auth/login')
      .send({
        email: process.env.SEED_ADMIN_EMAIL ?? 'admin@paygo.local',
        password: process.env.SEED_ADMIN_PASSWORD ?? 'ChangeMe!2026',
      })
      .expect(200);
    admin = { token: (login.body as LoginResponseDto).accessToken };
  });

  afterAll(async () => {
    await app.close();
  });

  describe('summary', () => {
    it('gives KPIs whose status chips add up to the whole fleet', async () => {
      await bikeOnLoan({ firstDueDate: day(1) });

      const response = await http()
        .get('/dashboard')
        .set(bearer(admin))
        .expect(200);
      const summary = response.body as DashboardSummaryDto;
      const counts = summary.statusCounts;

      expect(
        counts.active + counts.overdue + counts.immobilized + counts.offline,
      ).toBe(counts.all);
      expect(summary.kpis.bikesTotal).toBe(counts.all);
      expect(summary.kpis.bikesOnline).toBeLessThanOrEqual(
        summary.kpis.bikesTotal,
      );
      expect(summary.viewer).toEqual({
        canImmobilize: true,
        canSendReminders: true,
        ownRidersOnly: false,
      });
    });

    it('counts money received today, per currency', async () => {
      const before =
        (
          (await http().get('/dashboard').set(bearer(admin)).expect(200))
            .body as DashboardSummaryDto
        ).kpis.collectedToday.find((m) => m.currency === 'GHS')?.amountMinor ??
        0;

      const setup = await bikeOnLoan({ firstDueDate: day(1) });
      await http()
        .post(`/loans/${setup.loanId}/payments`)
        .set(bearer(admin))
        .send({
          amountMinor: 250_00,
          currency: 'GHS',
          reference: `CASH-DSH-${suffix()}`,
        })
        .expect(201);

      const after =
        (
          (await http().get('/dashboard').set(bearer(admin)).expect(200))
            .body as DashboardSummaryDto
        ).kpis.collectedToday.find((m) => m.currency === 'GHS')?.amountMinor ??
        0;
      expect(after - before).toBe(250_00);
    });
  });

  describe('fleet', () => {
    it('shows an overdue bike as overdue, with what it owes and a lock it may request', async () => {
      const setup = await bikeOnLoan({ firstDueDate: day(-3) });

      expect(await row(admin, setup)).toMatchObject({
        status: 'overdue',
        rider: setup.rider,
        overdue: { currency: 'GHS', amountMinor: 300_00 },
        speedKmh: 23,
        canLock: true,
        canUnlock: false,
      });
    });

    it('shows a bike whose tracker is silent as offline, with no lock on offer', async () => {
      const setup = await bikeOnLoan({
        firstDueDate: day(-3),
        reporting: false,
      });

      expect(await row(admin, setup)).toMatchObject({
        status: 'offline',
        speedKmh: null,
        canLock: false,
      });
    });

    it('follows a lock from requested to confirmed', async () => {
      const setup = await bikeOnLoan({ firstDueDate: day(-3) });
      await http()
        .post(`/enforcement/bikes/${setup.bikeId}/desired-state`)
        .set(bearer(admin))
        .send({
          state: 'IMMOBILIZED',
          reason: 'Collections call went unanswered',
        })
        .expect(200);

      expect(await row(admin, setup)).toMatchObject({
        status: 'overdue',
        lockPending: true,
        canLock: false,
        canUnlock: true,
      });

      await events.emitAsync(DEVICE_COMMAND_RESPONSE, {
        imei: setup.imei,
        text: 'Setdigout 1 OK',
        receivedAt: new Date(),
      });
      expect(await row(admin, setup)).toMatchObject({
        status: 'immobilized',
        lockPending: false,
        canUnlock: true,
      });

      const summary = (
        await http()
          .get('/dashboard')
          .query({ activityLimit: 50 })
          .set(bearer(admin))
          .expect(200)
      ).body as DashboardSummaryDto;
      const actions = summary.recentActivity
        .filter((a) => a.bikeId === setup.bikeId)
        .map((a) => a.action);
      expect(actions).toContain(`immobilized ${setup.plate}`);
      expect(actions).toContain(`requested a lock on ${setup.plate}`);
    });

    it('finds a bike by rider name or plate, and filters by status', async () => {
      const setup = await bikeOnLoan({ firstDueDate: day(-3) });

      const byName = await http()
        .get('/dashboard/fleet')
        .query({ search: setup.rider.toLowerCase() })
        .set(bearer(admin))
        .expect(200);
      expect((byName.body as FleetPageDto).data.map((r) => r.bikeId)).toContain(
        setup.bikeId,
      );

      const active = await http()
        .get('/dashboard/fleet')
        .query({ search: setup.plate, status: 'active' })
        .set(bearer(admin))
        .expect(200);
      expect((active.body as FleetPageDto).data).toHaveLength(0);
    });
  });

  describe('who sees what', () => {
    it("shows a field agent only their own riders' bikes", async () => {
      const agent = await staff('FIELD_AGENT');
      const own = await bikeOnLoan({
        firstDueDate: day(1),
        registeredBy: agent,
      });
      const someoneElses = await bikeOnLoan({ firstDueDate: day(1) });

      const page = await http()
        .get('/dashboard/fleet')
        .query({ limit: 100 })
        .set(bearer(agent))
        .expect(200);
      const ids = (page.body as FleetPageDto).data.map((r) => r.bikeId);
      expect(ids).toEqual([own.bikeId]);
      expect(ids).not.toContain(someoneElses.bikeId);

      const summary = (
        await http().get('/dashboard').set(bearer(agent)).expect(200)
      ).body as DashboardSummaryDto;
      expect(summary.viewer.ownRidersOnly).toBe(true);
      expect(summary.kpis.bikesTotal).toBe(1);
    });

    it('shows finance everything, but offers no lock or unlock', async () => {
      const finance = await staff('FINANCE');
      const setup = await bikeOnLoan({ firstDueDate: day(-3) });

      expect(await row(finance, setup)).toMatchObject({
        status: 'overdue',
        canLock: false,
        canUnlock: false,
      });
      const summary = (
        await http().get('/dashboard').set(bearer(finance)).expect(200)
      ).body as DashboardSummaryDto;
      expect(summary.viewer.canImmobilize).toBe(false);
    });
  });

  describe('overdue reminders', () => {
    it('sends one reminder per loan per day, however often the button is pressed', async () => {
      const setup = await bikeOnLoan({ firstDueDate: day(-3) });

      const first = await http()
        .post(`/dashboard/overdue/${setup.loanId}/reminder`)
        .set(bearer(admin))
        .expect(200);
      const second = await http()
        .post(`/dashboard/overdue/${setup.loanId}/reminder`)
        .set(bearer(admin))
        .expect(200);

      const a = first.body as ReminderResultDto;
      const b = second.body as ReminderResultDto;
      expect(a.sent).toBe(true);
      expect(b.sent).toBe(false);
      expect(b.sentAt).toBe(a.sentAt);
    });

    it('refuses a reminder for a loan that is not overdue', async () => {
      const setup = await bikeOnLoan({ firstDueDate: day(1) });
      await http()
        .post(`/dashboard/overdue/${setup.loanId}/reminder`)
        .set(bearer(admin))
        .expect(409);
    });

    it("does not let a field agent message someone else's rider", async () => {
      const agent = await staff('FIELD_AGENT');
      const someoneElses = await bikeOnLoan({ firstDueDate: day(-3) });
      await http()
        .post(`/dashboard/overdue/${someoneElses.loanId}/reminder`)
        .set(bearer(agent))
        .expect(404);
    });
  });
});
