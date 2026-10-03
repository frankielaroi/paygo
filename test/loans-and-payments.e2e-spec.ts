import { createHmac, randomInt, randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
import { NotificationSchedulerService } from '../src/notifications/notification-scheduler.service';
import type { LoanDetailDto, LoanPageDto } from '../src/loans/dto/loan.dto';
import { LoanArrearsService } from '../src/loans/loan-arrears.service';
import type {
  PaymentDto,
  PaymentPageDto,
} from '../src/payments/dto/payment.dto';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Loans and payments against the real database, where the rules that protect money live: the
 * unique (provider, reference) constraint, the balanced-ledger trigger, the append-only triggers
 * and the one-open-loan-per-bike index. Webhooks are signed with the key the app itself loaded,
 * exactly as Paystack would sign them.
 *
 * Amounts are in pesewas throughout.
 */
describe('Loans and payments (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let enforcement: EnforcementService;
  let token: string;
  let secret: string;

  const suffix = (): string => randomUUID().slice(0, 8).toUpperCase();
  const digits = (length: number): string =>
    Array.from({ length }, () => randomInt(10)).join('');
  const http = () => request(app.getHttpServer());
  const auth = { Authorization: '' };

  /** YYYY-MM-DD, `offset` days from today (UTC). */
  const day = (offset: number): string =>
    new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

  /** A bike in stock, assigned to nobody. */
  async function stockBike(plate?: string): Promise<string> {
    const bike = await http()
      .post('/bikes')
      .set(auth)
      .send({
        label: `Loan ${suffix()}`,
        vin: `LN${suffix()}${suffix()}`,
        make: 'Bajaj',
        model: 'Boxer 150',
        ...(plate ? { registrationNumber: plate } : {}),
      })
      .expect(201);
    return (bike.body as BikeDetailDto).id;
  }

  /** A KYC-verified rider holding nothing. */
  async function verifiedRider(
    lastName = `Boateng${suffix()}`,
  ): Promise<string> {
    const rider = await http()
      .post('/customers')
      .set(auth)
      .send({
        firstName: 'Esi',
        lastName,
        phone: `+23350${digits(7)}`,
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
    return riderId;
  }

  const terms = (customerId: string, bikeId: string) => ({
    customerId,
    bikeId,
    currency: 'GHS',
    principalMinor: 300_00,
    installmentMinor: 100_00,
    frequency: 'DAILY',
    graceDays: 0,
    firstDueDate: day(1),
  });

  async function bike(id: string): Promise<BikeDetailDto> {
    const response = await http().get(`/bikes/${id}`).set(auth).expect(200);
    return response.body as BikeDetailDto;
  }

  async function loans(query: Record<string, string>): Promise<LoanPageDto> {
    const response = await http()
      .get('/loans')
      .query(query)
      .set(auth)
      .expect(200);
    return response.body as LoanPageDto;
  }

  async function bikeWithRider(): Promise<{ bikeId: string; riderId: string }> {
    const bikeId = await stockBike();
    const riderId = await verifiedRider();
    await http()
      .post(`/bikes/${bikeId}/assignment`)
      .set(auth)
      .send({ customerId: riderId })
      .expect(200);
    return { bikeId, riderId };
  }

  async function createLoan(
    terms: Partial<{
      principalMinor: number;
      installmentMinor: number;
      frequency: 'DAILY' | 'WEEKLY';
      graceDays: number;
      firstDueDate: string;
    }> = {},
  ): Promise<LoanDetailDto & { riderId: string }> {
    const { bikeId, riderId } = await bikeWithRider();
    const response = await http()
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
    return { ...(response.body as LoanDetailDto), riderId };
  }

  async function loan(id: string): Promise<LoanDetailDto> {
    const response = await http().get(`/loans/${id}`).set(auth).expect(200);
    return response.body as LoanDetailDto;
  }

  /** Posts a Paystack charge.success, signed over the exact bytes sent. */
  function webhook(
    data: Record<string, unknown>,
    options: { signature?: string } = {},
  ) {
    const body = JSON.stringify({
      event: 'charge.success',
      data: {
        id: randomInt(1_000_000_000),
        status: 'success',
        currency: 'GHS',
        channel: 'mobile_money',
        paid_at: new Date().toISOString(),
        ...data,
      },
    });
    return http()
      .post('/webhooks/paystack')
      .set('Content-Type', 'application/json')
      .set(
        'x-paystack-signature',
        options.signature ??
          createHmac('sha512', secret).update(body).digest('hex'),
      )
      .send(body);
  }

  const pay = (loanId: string, amount: number, reference = `T${suffix()}`) =>
    webhook({ reference, amount, metadata: { loan_id: loanId } });

  /**
   * An automatic lock needs a warning sent long enough ago. Sends it the way production does,
   * then ages it past LOCKOUT_WARNING_LEAD_HOURS.
   */
  async function warnedLongAgo(loanId: string): Promise<void> {
    await app.get(NotificationSchedulerService).sendLockoutWarnings(new Date());
    const hours = app
      .get<ConfigService<Env, true>>(ConfigService)
      .get('LOCKOUT_WARNING_LEAD_HOURS', { infer: true });
    await prisma.notification.updateMany({
      where: { loanId, kind: 'LOCKOUT_WARNING' },
      data: { sentAt: new Date(Date.now() - (hours + 1) * 3_600_000) },
    });
  }

  async function desiredState(bikeId: string): Promise<string | undefined> {
    const row = await prisma.bikeEnforcement.findUnique({
      where: { bikeId },
      select: { desiredState: true },
    });
    return row?.desiredState;
  }

  async function paymentsWithReference(
    reference: string,
  ): Promise<PaymentDto[]> {
    const page = await http()
      .get('/payments')
      .query({ reference })
      .set(auth)
      .expect(200);
    return (page.body as PaymentPageDto).data;
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
    const key = app
      .get<ConfigService<Env, true>>(ConfigService)
      .get('PAYSTACK_SECRET_KEY', { infer: true });
    if (!key) {
      throw new Error('PAYSTACK_SECRET_KEY must be set for this suite');
    }
    secret = key;

    const login = await http()
      .post('/auth/login')
      .send({
        email: process.env.SEED_ADMIN_EMAIL ?? 'admin@paygo.local',
        password: process.env.SEED_ADMIN_PASSWORD ?? 'ChangeMe!2026',
      })
      .expect(200);
    token = (login.body as LoginResponseDto).accessToken;
    auth.Authorization = `Bearer ${token}`;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('loan creation and schedule', () => {
    it('generates the full weekly schedule, ending on the loan end date', async () => {
      const created = await createLoan({
        principalMinor: 1150_00,
        installmentMinor: 100_00,
        frequency: 'WEEKLY',
        firstDueDate: '2026-11-02',
      });

      expect(created.installmentCount).toBe(12);
      expect(created.schedule).toHaveLength(12);
      expect(created.schedule[1]?.dueDate).toBe('2026-11-09');
      expect(created.schedule.at(-1)).toMatchObject({
        sequence: 12,
        dueDate: '2027-01-18',
        amountMinor: 50_00,
      });
      expect(created.endDate).toBe(created.schedule.at(-1)?.dueDate);
      expect(created.balance).toMatchObject({
        lentMinor: 1150_00,
        paidMinor: 0,
        owedMinor: 1150_00,
      });
    });

    it('opens a loan on a bike in stock, handing it to the rider in the same step', async () => {
      const bikeId = await stockBike();
      const riderId = await verifiedRider();

      const response = await http()
        .post('/loans')
        .set(auth)
        .send(terms(riderId, bikeId))
        .expect(201);
      const created = response.body as LoanDetailDto;

      const after = await bike(bikeId);
      expect(after.status).toBe('ASSIGNED');
      const open = await prisma.bikeAssignment.findFirst({
        where: { bikeId, endedAt: null },
        select: { id: true, customerId: true },
      });
      expect(open?.customerId).toBe(riderId);
      expect(created.assignmentId).toBe(open?.id);
    });

    it('refuses a loan on a bike another rider holds, saying so', async () => {
      const { bikeId } = await bikeWithRider();
      const riderId = await verifiedRider();
      const refused = await http()
        .post('/loans')
        .set(auth)
        .send(terms(riderId, bikeId))
        .expect(409);
      expect(JSON.stringify(refused.body)).toContain(
        'assigned to another rider',
      );
    });

    it('refuses a second open loan for the same rider and leaves the bike in stock', async () => {
      const first = await createLoan();
      const secondBike = await stockBike();

      const refused = await http()
        .post('/loans')
        .set(auth)
        .send(terms(first.customerId, secondBike))
        .expect(409);
      expect(JSON.stringify(refused.body)).toContain(
        'already has an open loan',
      );
      // The refusal undoes everything, including the assignment the loan would have made.
      expect((await bike(secondBike)).status).toBe('IN_INVENTORY');
    });

    it('lets only one of two loans for the same rider through when both arrive at once', async () => {
      const riderId = await verifiedRider();
      const [bikeA, bikeB] = [await stockBike(), await stockBike()];

      const results = await Promise.all(
        [bikeA, bikeB].map((bikeId) =>
          http().post('/loans').set(auth).send(terms(riderId, bikeId)),
        ),
      );

      expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
      expect(await prisma.loan.count({ where: { customerId: riderId } })).toBe(
        1,
      );
    });

    it('refuses a second open loan on the same bike', async () => {
      const first = await createLoan();
      await http()
        .post('/loans')
        .set(auth)
        .send(terms(first.customerId, first.bikeId))
        .expect(409);
      expect(await prisma.loan.count({ where: { bikeId: first.bikeId } })).toBe(
        1,
      );
    });
  });

  describe('the loan list', () => {
    it('finds a loan by part of the rider name or part of the plate', async () => {
      const tag = suffix();
      const plate = `LN-${tag}`;
      const bikeId = await stockBike(plate);
      const riderId = await verifiedRider(`Quartey${tag}`);
      const created = await http()
        .post('/loans')
        .set(auth)
        .send(terms(riderId, bikeId))
        .expect(201);
      const id = (created.body as LoanDetailDto).id;

      const byName = await loans({ search: `quartey${tag.slice(0, 5)}` });
      expect(byName.data.map((row) => row.id)).toEqual([id]);
      expect(byName.data[0]?.rider.lastName).toBe(`Quartey${tag}`);
      expect(byName.data[0]?.bike.registrationNumber).toBe(plate);

      const byPlate = await loans({ search: tag.slice(1, 7).toLowerCase() });
      expect(byPlate.data.map((row) => row.id)).toEqual([id]);
    });

    it('counts loans by standing for the search, whichever chip is selected', async () => {
      const tag = suffix();
      // Built before the request: supertest opens its server when the request is created.
      const first = terms(
        await verifiedRider(`Lamptey${tag}`),
        await stockBike(),
      );
      const second = terms(
        await verifiedRider(`Lamptey${tag}`),
        await stockBike(),
      );
      const onTrack = await http()
        .post('/loans')
        .set(auth)
        .send(first)
        .expect(201);
      const behind = await http()
        .post('/loans')
        .set(auth)
        .send({
          ...second,
          firstDueDate: day(-3),
        })
        .expect(201);

      const page = await loans({
        search: `Lamptey${tag}`,
        standing: 'overdue',
      });
      expect(page.data.map((row) => row.id)).toEqual([
        (behind.body as LoanDetailDto).id,
      ]);
      expect(page.data[0]?.standing).toBe('overdue');
      expect(page.meta.totalItems).toBe(1);
      expect(page.counts).toMatchObject({
        all: 2,
        onTrack: 1,
        overdue: 1,
        completed: 0,
        writtenOff: 0,
      });

      // Catching up moves it between chips with nothing else done.
      await pay((behind.body as LoanDetailDto).id, 300_00).expect(200);
      const after = await loans({ search: `Lamptey${tag}` });
      expect(after.counts).toMatchObject({
        onTrack: 1,
        overdue: 0,
        completed: 1,
      });
      expect(after.data.map((row) => row.id)).toContain(
        (onTrack.body as LoanDetailDto).id,
      );
    });

    it('marks each installment paid, overdue, in grace, due today or upcoming', async () => {
      const created = await createLoan({
        principalMinor: 500_00,
        firstDueDate: day(-3),
        graceDays: 1,
      });
      await pay(created.id, 100_00).expect(200);

      const states = (await loan(created.id)).schedule.map((row) => row.state);
      // Due 3 days ago (paid), 2 days ago (past grace), yesterday (in grace), today, tomorrow.
      expect(states).toEqual([
        'paid',
        'overdue',
        'in-grace',
        'due-today',
        'upcoming',
      ]);
    });

    it('shows the same overdue standing on the loan and on the rider', async () => {
      const created = await createLoan({ firstDueDate: day(-3) });
      expect((await loan(created.id)).standing).toBe('overdue');
      const rider = await http()
        .get(`/customers/${created.riderId}`)
        .set(auth)
        .expect(200);
      expect((rider.body as CustomerDetailDto).standing).toBe('overdue');
    });
  });

  describe('applying payments', () => {
    it('marks the next installment paid on an exact payment and advances next due', async () => {
      const created = await createLoan();
      expect(created.nextDue).toMatchObject({
        sequence: 1,
        owingMinor: 100_00,
      });

      await pay(created.id, 100_00).expect(200);
      const after = await loan(created.id);

      expect(after.schedule[0]).toMatchObject({ paidMinor: 100_00 });
      expect(after.schedule[0]?.paidAt).not.toBeNull();
      expect(after.nextDue).toMatchObject({ sequence: 2, owingMinor: 100_00 });
      expect(after.balance).toMatchObject({
        paidMinor: 100_00,
        owedMinor: 200_00,
      });
    });

    it('applies the same webhook only once when Paystack sends it twice', async () => {
      const created = await createLoan();
      const reference = `T${suffix()}`;

      await pay(created.id, 100_00, reference).expect(200);
      await pay(created.id, 100_00, reference).expect(200);

      expect(await paymentsWithReference(reference)).toHaveLength(1);
      const after = await loan(created.id);
      expect(after.balance.paidMinor).toBe(100_00);
      expect(after.payments).toHaveLength(1);
      expect(
        await prisma.ledgerTransaction.count({
          where: { payment: { providerReference: reference } },
        }),
      ).toBe(1);
    });

    it('applies the same webhook only once when both copies arrive at the same moment', async () => {
      const created = await createLoan();
      const reference = `T${suffix()}`;

      const responses = await Promise.all(
        Array.from({ length: 4 }, () => pay(created.id, 100_00, reference)),
      );

      expect(responses.map((response) => response.status)).toEqual([
        200, 200, 200, 200,
      ]);
      expect(await paymentsWithReference(reference)).toHaveLength(1);
      expect((await loan(created.id)).balance.paidMinor).toBe(100_00);
    });

    it('rejects a webhook with a bad signature and records nothing', async () => {
      const created = await createLoan();
      const reference = `T${suffix()}`;

      await webhook(
        { reference, amount: 100_00, metadata: { loan_id: created.id } },
        { signature: 'ab'.repeat(64) },
      ).expect(401);

      expect(await paymentsWithReference(reference)).toHaveLength(0);
      expect((await loan(created.id)).balance.paidMinor).toBe(0);
    });

    it('spreads an overpayment forward and credits anything beyond the loan to the rider', async () => {
      const created = await createLoan();
      const reference = `T${suffix()}`;

      await pay(created.id, 350_00, reference).expect(200);
      const after = await loan(created.id);

      expect(after.schedule.map((row) => row.paidMinor)).toEqual([
        100_00, 100_00, 100_00,
      ]);
      expect(after.status).toBe('COMPLETED');
      const [payment] = await paymentsWithReference(reference);
      expect(payment?.overpaidMinor).toBe(50_00);
    });
  });

  describe('overdue and the catch-up rule', () => {
    it('is overdue only once the due date plus grace has fully passed', async () => {
      const onLastGraceDay = await createLoan({
        graceDays: 2,
        firstDueDate: day(-2),
      });
      const pastGrace = await createLoan({
        graceDays: 2,
        firstDueDate: day(-3),
      });

      expect((await loan(onLastGraceDay.id)).balance.overdueMinor).toBe(0);
      expect((await loan(pastGrace.id)).balance.overdueMinor).toBe(100_00);

      // The sweep's SQL must agree with the per-loan rule. Both riders are warned, so only
      // the overdue rule separates them.
      await warnedLongAgo(onLastGraceDay.id);
      await warnedLongAgo(pastGrace.id);
      await enforcement.sweep();
      expect(await desiredState(onLastGraceDay.bikeId)).toBeUndefined();
      expect(await desiredState(pastGrace.bikeId)).toBe('IMMOBILIZED');
    });

    it('does not count a partial payment as caught up, and restores only once fully covered', async () => {
      const created = await createLoan({ firstDueDate: day(-2) }); // two installments overdue
      await warnedLongAgo(created.id);
      await enforcement.sweep();
      expect(await desiredState(created.bikeId)).toBe('IMMOBILIZED');

      await pay(created.id, 150_00).expect(200);
      let after = await loan(created.id);
      expect(after.balance.overdueMinor).toBe(50_00);
      expect(after.schedule[1]).toMatchObject({
        paidMinor: 50_00,
        paidAt: null,
      });
      expect(await desiredState(created.bikeId)).toBe('IMMOBILIZED');

      // Still not current by one pesewa.
      await pay(created.id, 49_99).expect(200);
      after = await loan(created.id);
      expect(after.balance.overdueMinor).toBe(1);
      expect(await desiredState(created.bikeId)).toBe('IMMOBILIZED');

      // The payment that clears it restores the bike immediately, without a sweep.
      await pay(created.id, 1).expect(200);
      expect((await loan(created.id)).balance.overdueMinor).toBe(0);
      expect(await desiredState(created.bikeId)).toBe('MOBILE');
    });

    it('completes a fully settled loan and leaves it out of the sweep', async () => {
      const created = await createLoan({ firstDueDate: day(-10) });
      await warnedLongAgo(created.id);
      await enforcement.sweep();
      expect(await desiredState(created.bikeId)).toBe('IMMOBILIZED');

      await pay(created.id, 300_00).expect(200);
      const after = await loan(created.id);
      expect(after.status).toBe('COMPLETED');
      expect(after.completedAt).not.toBeNull();
      expect(after.nextDue).toBeNull();
      expect(await desiredState(created.bikeId)).toBe('MOBILE');

      await enforcement.sweep();
      expect(await desiredState(created.bikeId)).toBe('MOBILE');
    });
  });

  describe('money that cannot be applied', () => {
    it('holds a webhook for a completed loan as unallocated, with the reason', async () => {
      const created = await createLoan();
      await pay(created.id, 300_00).expect(200);
      const reference = `T${suffix()}`;

      await pay(created.id, 100_00, reference).expect(200);

      const [payment] = await paymentsWithReference(reference);
      expect(payment).toMatchObject({
        status: 'UNALLOCATED',
        loanId: null,
        statusReason: 'The named loan is already fully paid',
      });
      expect((await loan(created.id)).balance.paidMinor).toBe(300_00);
    });

    it('holds a payment that names no loan, and lets staff allocate it later', async () => {
      const created = await createLoan();
      const reference = `T${suffix()}`;

      await webhook({ reference, amount: 100_00 }).expect(200);
      const [held] = await paymentsWithReference(reference);
      expect(held?.status).toBe('UNALLOCATED');

      const allocated = await http()
        .post(`/payments/${held?.id}/allocation`)
        .set(auth)
        .send({ loanId: created.id })
        .expect(200);
      expect((allocated.body as PaymentDto).status).toBe('APPLIED');
      expect((await loan(created.id)).balance.paidMinor).toBe(100_00);

      await http()
        .post(`/payments/${held?.id}/allocation`)
        .set(auth)
        .send({ loanId: created.id })
        .expect(409);
    });

    it('refuses a manual payment against a missing or completed loan, recording nothing', async () => {
      const reference = `CASH-${suffix()}`;
      await http()
        .post(`/loans/${randomUUID()}/payments`)
        .set(auth)
        .send({ amountMinor: 100_00, currency: 'GHS', reference })
        .expect(404);

      const created = await createLoan();
      await pay(created.id, 300_00).expect(200);
      const refused = await http()
        .post(`/loans/${created.id}/payments`)
        .set(auth)
        .send({ amountMinor: 100_00, currency: 'GHS', reference })
        .expect(409);
      expect(JSON.stringify(refused.body)).toContain('already fully paid');
      expect(await paymentsWithReference(reference)).toHaveLength(0);
    });
  });

  describe('reconciliation and the ledger', () => {
    it('traces every payment to its provider reference', async () => {
      const created = await createLoan();
      const reference = `T${suffix()}`;
      await pay(created.id, 100_00, reference).expect(200);

      const [payment] = await paymentsWithReference(reference);
      expect(payment).toMatchObject({
        provider: 'paystack',
        providerReference: reference,
        amountMinor: 100_00,
        loanId: created.id,
        status: 'APPLIED',
      });
      expect(payment?.providerTransactionId).toBeTruthy();
    });

    it('keeps the installment cache equal to the ledger, and every ledger transaction balanced', async () => {
      const created = await createLoan();
      await pay(created.id, 130_00).expect(200);
      await pay(created.id, 45_00).expect(200);

      const cached = await prisma.loanInstallment.aggregate({
        where: { loanId: created.id },
        _sum: { paidMinor: true },
      });
      const ledger = await prisma.ledgerEntry.aggregate({
        where: { loanId: created.id, account: 'LOAN_RECEIVABLE' },
        _sum: { creditMinor: true },
      });
      expect(cached._sum.paidMinor).toBe(175_00);
      expect(ledger._sum.creditMinor).toBe(175_00);

      const unbalanced = await prisma.$queryRaw<{ transactionId: string }[]>`
        SELECT "transactionId" FROM "ledger_entries"
        GROUP BY "transactionId", "currency"
        HAVING SUM("debitMinor") <> SUM("creditMinor")
      `;
      expect(unbalanced).toEqual([]);
    });

    it('refuses to update or delete ledger history', async () => {
      const created = await createLoan();
      const entry = await prisma.ledgerEntry.findFirstOrThrow({
        where: { loanId: created.id },
      });

      await expect(
        prisma.ledgerEntry.update({
          where: { id: entry.id },
          data: { debitMinor: entry.debitMinor + 1 },
        }),
      ).rejects.toThrow(/append-only/);
      await expect(
        prisma.ledgerEntry.delete({ where: { id: entry.id } }),
      ).rejects.toThrow(/append-only/);
    });
  });

  describe('the bike under a loan', () => {
    it('cannot be transferred or returned while the loan is open', async () => {
      const created = await createLoan();
      const { riderId: other } = await bikeWithRider();

      await http()
        .post(`/bikes/${created.bikeId}/transfer`)
        .set(auth)
        .send({ customerId: other, reason: 'Swap riders' })
        .expect(409);
      await http()
        .post(`/bikes/${created.bikeId}/assignment/end`)
        .set(auth)
        .send({ reason: 'RETURNED' })
        .expect(409);
    });

    it('is repossessed through the loan, closing both together', async () => {
      const created = await createLoan({ firstDueDate: day(-5) });

      const response = await http()
        .post(`/loans/${created.id}/repossession`)
        .set(auth)
        .send({ reason: 'Five installments unpaid' })
        .expect(200);
      const after = response.body as LoanDetailDto;
      expect(after.status).toBe('REPOSSESSED');
      expect(after.balance.owedMinor).toBe(300_00);

      const bike = await http()
        .get(`/bikes/${created.bikeId}`)
        .set(auth)
        .expect(200);
      const detail = bike.body as BikeDetailDto;
      expect(detail.status).toBe('REPOSSESSED');
      expect(detail.assignmentHistory[0]?.endReason).toBe('REPOSSESSED');
    });

    it('is freed by a write-off, which records the loss without calling it paid', async () => {
      const created = await createLoan({ firstDueDate: day(-10) });
      await pay(created.id, 100_00).expect(200);

      const response = await http()
        .post(`/loans/${created.id}/write-off`)
        .set(auth)
        .send({ reason: 'Bike destroyed in a fire' })
        .expect(200);
      const after = response.body as LoanDetailDto;
      expect(after.status).toBe('WRITTEN_OFF');
      expect(after.standing).toBe('written-off');
      expect(after.closedReason).toBe('Bike destroyed in a fire');
      expect(after.nextDue).toBeNull();
      expect(after.balance).toEqual({
        lentMinor: 300_00,
        paidMinor: 100_00,
        writtenOffMinor: 200_00,
        owedMinor: 0,
        overdueMinor: 0,
      });

      // The loss is its own balanced transaction; the receivable was not credited.
      const entries = await prisma.ledgerEntry.findMany({
        where: { transaction: { loanId: created.id, type: 'LOAN_WRITE_OFF' } },
        select: { account: true, debitMinor: true, creditMinor: true },
        orderBy: { account: 'asc' },
      });
      expect(entries).toEqual([
        { account: 'LOAN_WRITTEN_OFF', debitMinor: 0, creditMinor: 200_00 },
        { account: 'WRITE_OFF_LOSS', debitMinor: 200_00, creditMinor: 0 },
      ]);

      // Closed for good: no second write-off, no more money, nothing for the sweep.
      await http()
        .post(`/loans/${created.id}/write-off`)
        .set(auth)
        .send({ reason: 'Again' })
        .expect(409);
      const refused = await http()
        .post(`/loans/${created.id}/payments`)
        .set(auth)
        .send({
          amountMinor: 50_00,
          currency: 'GHS',
          reference: `W${suffix()}`,
        })
        .expect(409);
      expect(JSON.stringify(refused.body)).toContain('written off');
      const overdue = await app.get(LoanArrearsService).findOverdue(new Date());
      expect(overdue.map((row) => row.detail.loanId)).not.toContain(created.id);

      // The bike goes back to stock and is financed again for someone else.
      await http()
        .post(`/bikes/${created.bikeId}/assignment/end`)
        .set(auth)
        .send({ reason: 'RETURNED' })
        .expect(200);
      const next = terms(await verifiedRider(), created.bikeId);
      await http().post('/loans').set(auth).send(next).expect(201);
    });

    it('lifts an arrears lock at the next sweep after a write-off', async () => {
      const created = await createLoan({ firstDueDate: day(-10) });
      await warnedLongAgo(created.id);
      await enforcement.sweep();
      expect(await desiredState(created.bikeId)).toBe('IMMOBILIZED');

      await http()
        .post(`/loans/${created.id}/write-off`)
        .set(auth)
        .send({ reason: 'Settled out of court' })
        .expect(200);
      await enforcement.sweep();
      expect(await desiredState(created.bikeId)).toBe('MOBILE');
    });

    it('can be sold to the rider once the loan is completed', async () => {
      const created = await createLoan();
      await http()
        .post(`/bikes/${created.bikeId}/assignment/end`)
        .set(auth)
        .send({ reason: 'SOLD' })
        .expect(409);

      await pay(created.id, 300_00).expect(200);
      await http()
        .post(`/bikes/${created.bikeId}/assignment/end`)
        .set(auth)
        .send({ reason: 'SOLD' })
        .expect(200);
    });
  });
});
