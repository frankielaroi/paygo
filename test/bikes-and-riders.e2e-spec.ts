import { randomInt, randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { getStorageToken, type ThrottlerStorage } from '@nestjs/throttler';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import type {
  BikeDetailDto,
  BikePageDto,
} from '../src/assets/dto/bike-response.dto';
import type { LoginResponseDto } from '../src/auth/dto/login-response.dto';
import { PasswordService } from '../src/auth/password.service';
import type {
  CustomerDetailDto,
  CustomerPageDto,
} from '../src/customers/dto/customer-response.dto';
import type { EnforcementViewDto } from '../src/enforcement/dto/enforcement-view.dto';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  DEVICE_COMMAND_RESPONSE,
  DEVICE_POSITIONS,
  type DeviceCommandResponseEvent,
  type DevicePositionsEvent,
} from '../src/tcp/tcp.events';
import type { BikeStatusDto } from '../src/tracking/dto/bike-status.dto';

/**
 * Runs against the real database, like the auth suite: it needs the seeded admin
 * (npm run db:seed). Every record uses random identifiers so runs do not collide, and nothing is
 * deleted afterwards, which is the point: these records are never deletable through the API.
 *
 * The database matters here. The rule against assigning one bike twice is a partial unique
 * index, and the IMEI link is what tracking resolves positions through; neither can be proven
 * against a mock.
 */
describe('Bikes and riders (e2e)', () => {
  let app: INestApplication<App>;
  let adminToken: string;
  let agentToken: string;
  let agentId: string;

  const suffix = (): string => randomUUID().slice(0, 8).toUpperCase();
  const digits = (length: number): string =>
    Array.from({ length }, () => randomInt(10)).join('');

  const http = () => request(app.getHttpServer());

  async function login(email: string, password: string): Promise<string> {
    const response = await http()
      .post('/auth/login')
      .send({ email, password })
      .expect(200);
    return (response.body as LoginResponseDto).accessToken;
  }

  async function createBike(
    overrides: Record<string, unknown> = {},
  ): Promise<BikeDetailDto> {
    const response = await http()
      .post('/bikes')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        label: `E2E ${suffix()}`,
        vin: `E2E${suffix()}${suffix()}`,
        registrationNumber: `GE ${digits(4)}-${digits(2)}`,
        make: 'Bajaj',
        model: 'Boxer 150',
        ...overrides,
      })
      .expect(201);
    return response.body as BikeDetailDto;
  }

  async function createRider(
    token: string,
    overrides: Record<string, unknown> = {},
  ): Promise<CustomerDetailDto> {
    const response = await http()
      .post('/customers')
      .set('Authorization', `Bearer ${token}`)
      .send({
        firstName: 'Kofi',
        lastName: `Mensah${suffix()}`,
        phone: `+23320${digits(7)}`,
        nationalId: `GHA-${digits(9)}-${digits(1)}`,
        photoUrl: 'https://files.example.test/photo.jpg',
        idDocumentUrl: 'https://files.example.test/id.jpg',
        ...overrides,
      })
      .expect(201);
    return response.body as CustomerDetailDto;
  }

  async function verifiedRider(): Promise<CustomerDetailDto> {
    const rider = await createRider(adminToken);
    const response = await http()
      .post(`/customers/${rider.id}/kyc-verification`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    return response.body as CustomerDetailDto;
  }

  function assign(bikeId: string, customerId: string) {
    return http()
      .post(`/bikes/${bikeId}/assignment`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ customerId });
  }

  beforeAll(async () => {
    // This suite makes far more than the per-IP limit of requests from one address in under a
    // minute. The limit stays on in the app; only this suite's storage never counts. The auth
    // suite is where rate limiting itself is exercised.
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

    adminToken = await login(
      process.env.SEED_ADMIN_EMAIL ?? 'admin@paygo.local',
      process.env.SEED_ADMIN_PASSWORD ?? 'ChangeMe!2026',
    );

    // A throwaway field agent, to test that ownership is enforced and not just role.
    const password = `Agent-${randomUUID()}`;
    const email = `agent-${suffix().toLowerCase()}@e2e.paygo.local`;
    const agent = await app.get(PrismaService).user.create({
      data: {
        email,
        passwordHash: await app.get(PasswordService).hash(password),
        firstName: 'Field',
        lastName: 'Agent',
        role: 'FIELD_AGENT',
      },
      select: { id: true },
    });
    agentId = agent.id;
    agentToken = await login(email, password);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('bike inventory', () => {
    it('adds a bike and finds it by plate, VIN and label', async () => {
      const bike = await createBike();
      expect(bike.status).toBe('IN_INVENTORY');
      expect(bike.statusHistory[0]).toMatchObject({
        fromStatus: null,
        toStatus: 'IN_INVENTORY',
      });

      for (const search of [
        bike.registrationNumber,
        bike.vin.toLowerCase(),
        bike.label,
      ]) {
        const page = await http()
          .get('/bikes')
          .query({ search })
          .set('Authorization', `Bearer ${adminToken}`)
          .expect(200);
        expect((page.body as BikePageDto).data.map((row) => row.id)).toContain(
          bike.id,
        );
      }
    });

    it('refuses a duplicate VIN', async () => {
      const bike = await createBike();
      await http()
        .post('/bikes')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ label: 'Dup', vin: bike.vin, make: 'Bajaj', model: 'Boxer' })
        .expect(409);
    });

    it('refuses a price without a currency', async () => {
      await http()
        .post('/bikes')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          label: 'Priced',
          vin: `E2E${suffix()}${suffix()}`,
          make: 'Bajaj',
          model: 'Boxer',
          purchasePriceMinor: 1850000,
        })
        .expect(400);
    });
  });

  describe('trackers', () => {
    it('links an IMEI so a position event for it resolves to the right bike', async () => {
      const bike = await createBike();
      const imei = `35${digits(13)}`;

      await http()
        .post(`/bikes/${bike.id}/tracker`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ imei })
        .expect(200);

      const event: DevicePositionsEvent = {
        imei,
        receivedAt: new Date(),
        records: [
          {
            timestamp: new Date(),
            priority: 0,
            latitude: 5.6037,
            longitude: -0.187,
            altitude: 60,
            angle: 90,
            satellites: 9,
            speed: 0,
            eventIoId: 0,
            io: {},
            ignition: false,
            movement: false,
            hasFix: true,
          },
        ],
      };
      await app.get(EventEmitter2).emitAsync(DEVICE_POSITIONS, event);

      const status = await http()
        .get(`/tracking/bikes/${bike.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      const body = status.body as BikeStatusDto;
      expect(body.imei).toBe(imei);
      expect(body.current?.latitude).toBeCloseTo(5.6037);
      expect(body.online).toBe(true);
    });

    it('refuses to fit one tracker to two bikes', async () => {
      const first = await createBike();
      const second = await createBike();
      const imei = `35${digits(13)}`;

      await http()
        .post(`/bikes/${first.id}/tracker`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ imei })
        .expect(200);
      await http()
        .post(`/bikes/${second.id}/tracker`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ imei })
        .expect(409);
    });

    it('keeps the old unit in history on a swap, and resets the confirmed state', async () => {
      const bike = await createBike();
      const oldImei = `35${digits(13)}`;
      const newImei = `35${digits(13)}`;

      await http()
        .post(`/bikes/${bike.id}/tracker`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ imei: oldImei })
        .expect(200);

      // Enforcement knows the old unit's relay state.
      await http()
        .post(`/enforcement/bikes/${bike.id}/desired-state`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ state: 'MOBILE', reason: 'Initial state' })
        .expect(200);
      const reply: DeviceCommandResponseEvent = {
        imei: oldImei,
        text: 'Setdigout 0 OK',
        receivedAt: new Date(),
      };
      await app.get(EventEmitter2).emitAsync(DEVICE_COMMAND_RESPONSE, reply);

      const swapped = await http()
        .post(`/bikes/${bike.id}/tracker`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ imei: newImei, reason: 'Unit failed' })
        .expect(200);
      const detail = swapped.body as BikeDetailDto;

      expect(detail.imei).toBe(newImei);
      expect(detail.trackerHistory).toHaveLength(2);
      expect(detail.trackerHistory[1]).toMatchObject({
        imei: oldImei,
        removedReason: 'Unit failed',
      });
      expect(detail.trackerHistory[1]?.removedAt).not.toBeNull();

      const enforcement = await http()
        .get(`/enforcement/bikes/${bike.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      const view = enforcement.body as EnforcementViewDto;
      expect(view.state?.confirmedState).toBeNull();
      expect(view.events.map((event) => event.type)).toContain(
        'TRACKER_CHANGED',
      );
    });
  });

  describe('assignment and transfer', () => {
    it('logs each status change with a timestamp and actor', async () => {
      const bike = await createBike();
      const rider = await verifiedRider();

      const assigned = await assign(bike.id, rider.id).expect(200);
      const detail = assigned.body as BikeDetailDto;

      expect(detail.status).toBe('ASSIGNED');
      expect(detail.currentRider?.customerId).toBe(rider.id);
      expect(detail.statusHistory[0]).toMatchObject({
        fromStatus: 'IN_INVENTORY',
        toStatus: 'ASSIGNED',
      });
      expect(detail.statusHistory[0]?.createdAt).toBeDefined();
      expect(detail.statusHistory[0]?.actorUserId).toBeDefined();
    });

    it('blocks assigning a bike that is already assigned', async () => {
      const bike = await createBike();
      const first = await verifiedRider();
      const second = await verifiedRider();

      await assign(bike.id, first.id).expect(200);
      const refused = await assign(bike.id, second.id).expect(409);
      expect(JSON.stringify(refused.body)).toContain('already assigned');
    });

    it('lets exactly one of two simultaneous assignments win', async () => {
      const bike = await createBike();
      const riders = await Promise.all([verifiedRider(), verifiedRider()]);

      const results = await Promise.all(
        riders.map((rider) => assign(bike.id, rider.id)),
      );
      const statuses = results.map((result) => result.status).sort();

      expect(statuses).toEqual([200, 409]);
      const detail = await http()
        .get(`/bikes/${bike.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(
        (detail.body as BikeDetailDto).assignmentHistory.filter(
          (row) => row.endedAt === null,
        ),
      ).toHaveLength(1);
    });

    it('refuses a rider whose KYC is not verified', async () => {
      const bike = await createBike();
      const rider = await createRider(adminToken);
      await assign(bike.id, rider.id).expect(409);
    });

    it('transfers to a new rider and keeps the previous one on record', async () => {
      const bike = await createBike();
      const first = await verifiedRider();
      const second = await verifiedRider();
      await assign(bike.id, first.id).expect(200);

      const transferred = await http()
        .post(`/bikes/${bike.id}/transfer`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ customerId: second.id, reason: 'Original rider defaulted' })
        .expect(200);
      const detail = transferred.body as BikeDetailDto;

      expect(detail.currentRider?.customerId).toBe(second.id);
      expect(detail.assignmentHistory).toHaveLength(2);
      const previous = detail.assignmentHistory.find(
        (row) => row.rider.customerId === first.id,
      );
      expect(previous?.endReason).toBe('TRANSFERRED');
      expect(previous?.endedAt).toBe(detail.assignmentHistory[0]?.startedAt);
    });

    it('finds a bike by its current rider name', async () => {
      const bike = await createBike();
      const rider = await verifiedRider();
      await assign(bike.id, rider.id).expect(200);

      const page = await http()
        .get('/bikes')
        .query({ search: `kofi ${rider.lastName}` })
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect((page.body as BikePageDto).data.map((row) => row.id)).toEqual([
        bike.id,
      ]);
    });
  });

  describe('riders', () => {
    it('finds a rider by full name and by phone written with spaces', async () => {
      const rider = await createRider(adminToken);
      const spaced = rider.phone.replace(/^(\+\d{3})(\d{2})(\d+)$/, '$1 $2 $3');

      for (const search of [`kofi ${rider.lastName}`, spaced]) {
        const page = await http()
          .get('/customers')
          .query({ search })
          .set('Authorization', `Bearer ${adminToken}`)
          .expect(200);
        expect(
          (page.body as CustomerPageDto).data.map((row) => row.id),
        ).toContain(rider.id);
      }
    });

    it('shows every bike a rider has held, past and present', async () => {
      const rider = await verifiedRider();
      const firstBike = await createBike();
      const secondBike = await createBike();

      await assign(firstBike.id, rider.id).expect(200);
      await http()
        .post(`/bikes/${firstBike.id}/assignment/end`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'REPOSSESSED' })
        .expect(200);
      await assign(secondBike.id, rider.id).expect(200);

      const response = await http()
        .get(`/customers/${rider.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      const detail = response.body as CustomerDetailDto;

      expect(detail.bikeHistory.map((row) => row.bike.bikeId).sort()).toEqual(
        [firstBike.id, secondBike.id].sort(),
      );
      expect(detail.currentBikes.map((row) => row.bikeId)).toEqual([
        secondBike.id,
      ]);
      expect(detail.risk).toMatchObject({
        bikesHeld: 2,
        currentlyHolding: 1,
        repossessions: 1,
      });
    });

    it('clears KYC when an identity field changes', async () => {
      const rider = await verifiedRider();
      expect(rider.status).toBe('ACTIVE');

      const response = await http()
        .patch(`/customers/${rider.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ nationalId: `GHA-${digits(9)}-${digits(1)}` })
        .expect(200);
      const detail = response.body as CustomerDetailDto;

      expect(detail.status).toBe('PENDING_KYC');
      expect(detail.kycVerifiedAt).toBeNull();
    });

    it('refuses to deactivate a rider who holds a bike', async () => {
      const bike = await createBike();
      const rider = await verifiedRider();
      await assign(bike.id, rider.id).expect(200);

      await http()
        .post(`/customers/${rider.id}/deactivation`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'Moving away' })
        .expect(409);
    });
  });

  describe('history survives deactivation and retirement', () => {
    it('keeps the rider readable from the bike, and the bike from the rider', async () => {
      const bike = await createBike();
      const rider = await verifiedRider();
      await assign(bike.id, rider.id).expect(200);
      await http()
        .post(`/bikes/${bike.id}/assignment/end`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'RETURNED' })
        .expect(200);

      await http()
        .post(`/customers/${rider.id}/deactivation`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'Relocated' })
        .expect(200);
      await http()
        .post(`/bikes/${bike.id}/retirement`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'Written off after accident' })
        .expect(200);

      const bikeView = await http()
        .get(`/bikes/${bike.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      const bikeDetail = bikeView.body as BikeDetailDto;
      expect(bikeDetail.status).toBe('RETIRED');
      expect(bikeDetail.assignmentHistory[0]?.rider.customerId).toBe(rider.id);

      const riderView = await http()
        .get(`/customers/${rider.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      const riderDetail = riderView.body as CustomerDetailDto;
      expect(riderDetail.status).toBe('CLOSED');
      expect(riderDetail.bikeHistory[0]?.bike.bikeId).toBe(bike.id);
    });

    it('refuses to retire a bike that a rider holds', async () => {
      const bike = await createBike();
      const rider = await verifiedRider();
      await assign(bike.id, rider.id).expect(200);

      await http()
        .post(`/bikes/${bike.id}/retirement`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'Old' })
        .expect(409);
    });
  });

  describe('field agent boundaries', () => {
    it('owns the riders they register and cannot see anyone else', async () => {
      const own = await createRider(agentToken);
      expect(own.assignedAgentId).toBe(agentId);

      const someoneElses = await createRider(adminToken);
      await http()
        .get(`/customers/${someoneElses.id}`)
        .set('Authorization', `Bearer ${agentToken}`)
        .expect(404);
      await http()
        .patch(`/customers/${someoneElses.id}`)
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ district: 'Somewhere' })
        .expect(404);

      const page = await http()
        .get('/customers')
        .query({ limit: 100 })
        .set('Authorization', `Bearer ${agentToken}`)
        .expect(200);
      const ids = (page.body as CustomerPageDto).data.map((row) => row.id);
      expect(ids).toContain(own.id);
      expect(ids).not.toContain(someoneElses.id);
    });

    it('cannot verify KYC, manage bikes, or read the bike inventory', async () => {
      const own = await createRider(agentToken);
      await http()
        .post(`/customers/${own.id}/kyc-verification`)
        .set('Authorization', `Bearer ${agentToken}`)
        .expect(403);
      await http()
        .get('/bikes')
        .set('Authorization', `Bearer ${agentToken}`)
        .expect(403);
      await http()
        .post('/bikes')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ label: 'X', vin: `E2E${suffix()}`, make: 'X', model: 'X' })
        .expect(403);
    });

    it('cannot register a rider to another agent', async () => {
      await http()
        .post('/customers')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          firstName: 'Ama',
          lastName: 'Owusu',
          phone: `+23324${digits(7)}`,
          nationalId: `GHA-${digits(9)}-${digits(1)}`,
          assignedAgentId: randomUUID(),
        })
        .expect(403);
    });
  });
});
