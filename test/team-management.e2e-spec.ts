import { randomInt, randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getStorageToken, type ThrottlerStorage } from '@nestjs/throttler';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import type { BikeDetailDto } from '../src/assets/dto/bike-response.dto';
import type { LoginResponseDto } from '../src/auth/dto/login-response.dto';
import type { CustomerDetailDto } from '../src/customers/dto/customer-response.dto';
import type { EnforcementViewDto } from '../src/enforcement/dto/enforcement-view.dto';
import type {
  ActivityItemDto,
  StaffDto,
  StaffWithPasswordDto,
} from '../src/users/dto/staff.dto';

interface ErrorBody {
  message: string | string[];
}

interface Account {
  id: string;
  email: string;
  password: string;
  token: string;
  refreshToken: string;
}

/**
 * Staff accounts and what their roles allow, against the real app and database: real logins,
 * the real guard chain, and the other modules' own audit trails.
 */
describe('Team management (e2e)', () => {
  let app: INestApplication<App>;
  let admin: Account;

  const suffix = (): string => randomUUID().slice(0, 8).toLowerCase();
  const digits = (length: number): string =>
    Array.from({ length }, () => randomInt(10)).join('');
  const http = () => request(app.getHttpServer());
  const bearer = (account: { token: string }) => ({
    Authorization: `Bearer ${account.token}`,
  });

  /** Not async: callers chain .expect() on the request itself. */
  function login(email: string, password: string) {
    return http().post('/auth/login').send({ email, password });
  }

  /** Creates an account as an admin and returns it with the temporary password, unchanged. */
  async function createStaff(
    role: 'ADMIN' | 'FIELD_AGENT' | 'FINANCE',
  ): Promise<StaffWithPasswordDto & { email: string }> {
    const email = `staff-${suffix()}@e2e.paygo.local`;
    const response = await http()
      .post('/staff')
      .set(bearer(admin))
      .send({ email, firstName: 'Kwame', lastName: `Asante${suffix()}`, role })
      .expect(201);
    return { ...(response.body as StaffWithPasswordDto), email };
  }

  /** A ready-to-use account: created, signed in, temporary password changed, signed in again. */
  async function activeStaff(
    role: 'ADMIN' | 'FIELD_AGENT' | 'FINANCE',
  ): Promise<Account> {
    const created = await createStaff(role);
    const first = await login(created.email, created.temporaryPassword).expect(
      200,
    );
    const password = `Pass-${randomUUID()}`;
    await http()
      .post('/me/password')
      .set(bearer({ token: (first.body as LoginResponseDto).accessToken }))
      .send({
        currentPassword: created.temporaryPassword,
        newPassword: password,
      })
      .expect(204);
    const second = await login(created.email, password).expect(200);
    const body = second.body as LoginResponseDto;
    return {
      id: created.staff.id,
      email: created.email,
      password,
      token: body.accessToken,
      refreshToken: body.refreshToken,
    };
  }

  /** A bike assigned to a KYC-verified rider registered by (and so assigned to) `agent`. */
  async function bikeForRiderOf(
    agent: Account,
  ): Promise<{ bikeId: string; riderId: string }> {
    const rider = await http()
      .post('/customers')
      .set(bearer(agent))
      .send({
        firstName: 'Yaw',
        lastName: `Boateng${suffix()}`,
        phone: `+23357${digits(7)}`,
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
    const bike = await http()
      .post('/bikes')
      .set(bearer(admin))
      .send({
        label: `Team ${suffix()}`,
        vin: `TM${suffix()}${suffix()}`.toUpperCase(),
        make: 'Bajaj',
        model: 'Boxer',
      })
      .expect(201);
    const bikeId = (bike.body as BikeDetailDto).id;
    await http()
      .post(`/bikes/${bikeId}/assignment`)
      .set(bearer(admin))
      .send({ customerId: riderId })
      .expect(200);
    return { bikeId, riderId };
  }

  const lock = (account: Account, bikeId: string, state = 'IMMOBILIZED') =>
    http()
      .post(`/enforcement/bikes/${bikeId}/desired-state`)
      .set(bearer(account))
      .send({ state, reason: 'Rider stopped answering' });

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

    const email = process.env.SEED_ADMIN_EMAIL ?? 'admin@paygo.local';
    const password = process.env.SEED_ADMIN_PASSWORD ?? 'ChangeMe!2026';
    const response = await login(email, password).expect(200);
    const body = response.body as LoginResponseDto;
    admin = {
      id: body.user.id,
      email,
      password,
      token: body.accessToken,
      refreshToken: body.refreshToken,
    };
  });

  afterAll(async () => {
    await app.close();
  });

  describe('creating accounts', () => {
    it('creates an account with a role and a temporary password shown once', async () => {
      const created = await createStaff('FINANCE');

      expect(created.staff).toMatchObject({
        role: 'FINANCE',
        mustChangePassword: true,
      });
      expect(created.temporaryPassword).toHaveLength(24);
      expect(JSON.stringify(created.staff)).not.toContain(
        created.temporaryPassword,
      );
    });

    it('lets a temporary password do nothing but change itself', async () => {
      const created = await createStaff('ADMIN');
      const first = await login(
        created.email,
        created.temporaryPassword,
      ).expect(200);
      const temporary = { token: (first.body as LoginResponseDto).accessToken };
      expect((first.body as LoginResponseDto).user.mustChangePassword).toBe(
        true,
      );

      const refused = await http()
        .get('/staff')
        .set(bearer(temporary))
        .expect(403);
      expect((refused.body as ErrorBody).message).toContain(
        'temporary password',
      );
      await http().get('/auth/me').set(bearer(temporary)).expect(200);
      await http().get('/me').set(bearer(temporary)).expect(200);
    });
  });

  describe('roles decide access, and only roles', () => {
    it('blocks a field agent from creating a loan with a clear permission error', async () => {
      const agent = await activeStaff('FIELD_AGENT');

      const refused = await http()
        .post('/loans')
        .set(bearer(agent))
        .send({})
        .expect(403);
      expect((refused.body as ErrorBody).message).toBe(
        'Insufficient permissions',
      );
    });

    it('lets finance read loans and record payments, but not lend, lock or manage staff', async () => {
      const finance = await activeStaff('FINANCE');

      await http().get('/loans').set(bearer(finance)).expect(200);
      await http().get('/payments').set(bearer(finance)).expect(200);
      await http().get('/bikes').set(bearer(finance)).expect(200);
      await http().get('/customers').set(bearer(finance)).expect(200);
      await http().get('/staff-alerts').set(bearer(finance)).expect(200);

      await http().post('/loans').set(bearer(finance)).send({}).expect(403);
      await http().get('/enforcement/review').set(bearer(finance)).expect(403);
      await http().get('/staff').set(bearer(finance)).expect(403);
      await http().post('/customers').set(bearer(finance)).send({}).expect(403);
    });

    it('gives two people with the same role exactly the same permissions', async () => {
      const first = await activeStaff('FIELD_AGENT');
      const second = await activeStaff('FIELD_AGENT');

      const [a, b] = await Promise.all(
        [first, second].map(async (account) => {
          const response = await http()
            .get(`/staff/${account.id}`)
            .set(bearer(admin))
            .expect(200);
          return (response.body as StaffDto).permissions;
        }),
      );
      expect(a).toEqual(b);

      for (const account of [first, second]) {
        await http().post('/loans').set(bearer(account)).send({}).expect(403);
        await http().get('/customers').set(bearer(account)).expect(200);
      }
    });

    it('applies a role change on the very next request, without signing in again', async () => {
      const person = await activeStaff('FIELD_AGENT');
      await http().get('/payments').set(bearer(person)).expect(403);

      await http()
        .patch(`/staff/${person.id}`)
        .set(bearer(admin))
        .send({ role: 'FINANCE' })
        .expect(200);

      await http().get('/payments').set(bearer(person)).expect(200);
    });
  });

  describe('field agents and manual locks', () => {
    it('lets an agent lock and unlock bikes of their own riders only', async () => {
      const agent = await activeStaff('FIELD_AGENT');
      const otherAgent = await activeStaff('FIELD_AGENT');
      const own = await bikeForRiderOf(agent);
      const someoneElses = await bikeForRiderOf(otherAgent);

      await lock(agent, own.bikeId).expect(200);
      await lock(agent, own.bikeId, 'MOBILE').expect(200);
      await lock(agent, someoneElses.bikeId).expect(404);
      await http()
        .get(`/enforcement/bikes/${someoneElses.bikeId}`)
        .set(bearer(agent))
        .expect(404);
      await http().get('/enforcement/review').set(bearer(agent)).expect(403);
    });
  });

  describe('self-service', () => {
    it('lets anyone update their own profile, but not their role', async () => {
      const agent = await activeStaff('FIELD_AGENT');

      const updated = await http()
        .patch('/me')
        .set(bearer(agent))
        .send({ firstName: 'Kofi' })
        .expect(200);
      expect((updated.body as StaffDto).firstName).toBe('Kofi');

      await http()
        .patch('/me')
        .set(bearer(agent))
        .send({ role: 'ADMIN' })
        .expect(400);
    });

    it('changes a password only with the current one, and ends every session', async () => {
      const agent = await activeStaff('FIELD_AGENT');

      await http()
        .post('/me/password')
        .set(bearer(agent))
        .send({
          currentPassword: 'wrong-password-123',
          newPassword: `New-${randomUUID()}`,
        })
        .expect(401);

      const newPassword = `New-${randomUUID()}`;
      await http()
        .post('/me/password')
        .set(bearer(agent))
        .send({ currentPassword: agent.password, newPassword })
        .expect(204);

      await http()
        .post('/auth/refresh')
        .send({ refreshToken: agent.refreshToken })
        .expect(401);
      await login(agent.email, agent.password).expect(401);
      await login(agent.email, newPassword).expect(200);
    });
  });

  describe('deactivation', () => {
    it('stops sign-in at once but keeps the name on what they did', async () => {
      const agent = await activeStaff('FIELD_AGENT');
      const { bikeId } = await bikeForRiderOf(agent);
      await lock(agent, bikeId).expect(200);

      await http()
        .post(`/staff/${agent.id}/deactivation`)
        .set(bearer(admin))
        .send({ reason: 'Left the company' })
        .expect(200);

      await login(agent.email, agent.password).expect(401);
      await http().get('/auth/me').set(bearer(agent)).expect(401);
      await http()
        .post('/auth/refresh')
        .send({ refreshToken: agent.refreshToken })
        .expect(401);

      const history = await http()
        .get(`/enforcement/bikes/${bikeId}`)
        .set(bearer(admin))
        .expect(200);
      const event = (history.body as EnforcementViewDto).events.find(
        (row) => row.actorUserId === agent.id,
      );
      expect(event?.actorName).toMatch(/^Kwame Asante\w+ \(deactivated\)$/);

      const staff = await http()
        .get(`/staff/${agent.id}`)
        .set(bearer(admin))
        .expect(200);
      expect(staff.body as StaffDto).toMatchObject({
        isActive: false,
        deactivationReason: 'Left the company',
      });
    });

    it('never lets an admin deactivate themselves or change their own role', async () => {
      // A throwaway admin acts on itself. Never the seeded admin: if this guard ever
      // regressed, the test would lock everyone out of the development database.
      const self = await activeStaff('ADMIN');

      await http()
        .post(`/staff/${self.id}/deactivation`)
        .set(bearer(self))
        .send({ reason: 'Testing' })
        .expect(409);
      await http()
        .patch(`/staff/${self.id}`)
        .set(bearer(self))
        .send({ role: 'FINANCE' })
        .expect(409);

      const after = await http()
        .get(`/staff/${self.id}`)
        .set(bearer(admin))
        .expect(200);
      expect(after.body as StaffDto).toMatchObject({
        isActive: true,
        role: 'ADMIN',
      });
    });
  });

  describe('activity', () => {
    it("shows an admin a staff member's locks and unlocks, and their own loans", async () => {
      const agent = await activeStaff('FIELD_AGENT');
      const { bikeId, riderId } = await bikeForRiderOf(agent);
      await lock(agent, bikeId).expect(200);
      await lock(agent, bikeId, 'MOBILE').expect(200);

      const agentActivity = await http()
        .get(`/staff/${agent.id}/activity`)
        .set(bearer(admin))
        .expect(200);
      const actions = (agentActivity.body as ActivityItemDto[]).map(
        (row) => row.action,
      );
      expect(actions.slice(0, 3)).toEqual([
        'MANUAL_UNLOCK',
        'MANUAL_LOCK',
        'RIDER_REGISTERED',
      ]);
      expect(actions).toContain('PASSWORD_CHANGED');

      const loan = await http()
        .post('/loans')
        .set(bearer(admin))
        .send({
          customerId: riderId,
          bikeId,
          currency: 'GHS',
          principalMinor: 300_00,
          installmentMinor: 100_00,
          frequency: 'WEEKLY',
          graceDays: 2,
          firstDueDate: new Date(Date.now() + 86_400_000)
            .toISOString()
            .slice(0, 10),
        })
        .expect(201);
      const adminActivity = await http()
        .get(`/staff/${admin.id}/activity`)
        .set(bearer(admin))
        .query({ limit: 200 })
        .expect(200);
      // The seeded admin is shared with other suites, so look for this loan rather than
      // assuming it is the admin's very latest action.
      const created = (adminActivity.body as ActivityItemDto[]).find(
        (row) => row.loanId === (loan.body as { id: string }).id,
      );
      expect(created).toMatchObject({
        action: 'LOAN_CREATED',
        summary: 'Started a loan of GHS 300.00',
      });
    });
  });
});
