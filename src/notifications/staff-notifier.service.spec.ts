import { Prisma } from '../generated/prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { MessageChannel } from './channels/message-channel';
import { HOURLY_CAP, StaffNotifierService } from './staff-notifier.service';

interface User {
  id: string;
  phone: string | null;
  role: 'ADMIN' | 'FIELD_AGENT' | 'FINANCE';
}

const admin: User = { id: 'admin-1', phone: '0241234567', role: 'ADMIN' };
const otherAdmin: User = { id: 'admin-2', phone: '0209998888', role: 'ADMIN' };
const agent: User = { id: 'agent-1', phone: '0501112222', role: 'FIELD_AGENT' };

const assignedBike = (agentId: string | null) => ({
  label: 'ACC-001',
  registrationNumber: 'GR-4471-24',
  status: 'ASSIGNED',
  assignments: [
    {
      customer: {
        firstName: 'Kwame',
        lastName: 'Boateng',
        assignedAgentId: agentId,
      },
    },
  ],
});

/**
 * `subscribers` are the users the database would return for the topic: active, with a phone,
 * and with that topic turned on. Who that is, is the query's job; what this service does with
 * them is tested here.
 */
function setup(subscribers: User[], bike: unknown = assignedBike(null)) {
  const send = jest.fn().mockResolvedValue({
    outcome: 'accepted',
    providerMessageId: 'sms-1',
  });
  const create = jest.fn().mockResolvedValue({ id: 'message-1' });
  const update = jest.fn().mockResolvedValue({});
  const findUsers = jest.fn().mockResolvedValue(subscribers);
  const prisma = {
    user: { findMany: findUsers },
    bike: { findUnique: jest.fn().mockResolvedValue(bike) },
    staffMessage: {
      create,
      update,
      count: jest.fn().mockResolvedValue(0),
    },
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
  const channel: MessageChannel = { name: 'test', send };
  return {
    service: new StaffNotifierService(
      prisma as unknown as PrismaService,
      channel,
    ),
    prisma,
    send,
    create,
    update,
    findUsers,
  };
}

const offline = {
  bikeId: 'bike-1',
  lastReportedAt: new Date('2026-10-02T09:05:00Z'),
};

describe('StaffNotifierService', () => {
  it('texts only the staff who turned the topic on', async () => {
    const { service, send, findUsers } = setup([admin]);

    await service.onBikeWentOffline(offline);

    // Acceptance: one person's preference never decides what another receives. The recipients
    // are exactly those with this topic on, an active account and a phone.
    expect(findUsers).toHaveBeenCalledWith({
      where: {
        isActive: true,
        phone: { not: null },
        notificationPreferences: { some: { topic: 'BIKE_OFFLINE', sms: true } },
      },
      select: { id: true, phone: true, role: true },
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      to: '233241234567',
      body: 'Bike GR-4471-24 (Kwame Boateng) stopped reporting. Last heard from at 09:05.',
    });
  });

  it('texts nobody when nobody has the topic on', async () => {
    const { service, send, create } = setup([]);

    await service.onBikeWentOffline(offline);

    expect(create).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('records the message before sending, once per person, bike and day', async () => {
    const { service, create, update } = setup([admin, otherAdmin]);

    await service.onBikeWentOffline(offline);

    expect(create).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'admin-1',
          topic: 'BIKE_OFFLINE',
          dedupeKey: 'bike-offline:bike-1:2026-10-02',
        }) as unknown,
      }),
    );
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'SENT' }) as unknown,
      }),
    );
  });

  it('does not text again for an event already sent to that person', async () => {
    const { service, create, send } = setup([admin]);
    create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('duplicate', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );

    await service.onBikeWentOffline(offline);

    expect(send).not.toHaveBeenCalled();
  });

  it('tells a field agent only about their own riders', async () => {
    const mine = setup([agent], assignedBike('agent-1'));
    await mine.service.onBikeWentOffline(offline);
    expect(mine.send).toHaveBeenCalledTimes(1);

    const someoneElses = setup([agent], assignedBike('agent-9'));
    await someoneElses.service.onBikeWentOffline(offline);
    expect(someoneElses.send).not.toHaveBeenCalled();
  });

  it('ignores a bike without a rider going quiet', async () => {
    const { service, send } = setup([admin], {
      ...assignedBike(null),
      status: 'IN_INVENTORY',
      assignments: [],
    });

    await service.onBikeWentOffline(offline);

    expect(send).not.toHaveBeenCalled();
  });

  it('stops texting someone who has reached the hourly cap', async () => {
    const { service, prisma, send } = setup([admin]);
    prisma.staffMessage.count.mockResolvedValue(HOURLY_CAP);

    await service.onGeofenceExited({
      crossingId: 'crossing-1',
      bikeId: 'bike-1',
      geofenceName: 'Accra zone',
    });

    expect(send).not.toHaveBeenCalled();
  });

  it('records a failed send and does not throw', async () => {
    const { service, send, update } = setup([admin]);
    send.mockResolvedValue({ outcome: 'unavailable', error: 'outage' });

    await expect(
      service.onGeofenceExited({
        crossingId: 'crossing-1',
        bikeId: 'bike-1',
        geofenceName: 'Accra zone',
      }),
    ).resolves.toBeUndefined();

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: 'FAILED', error: 'outage' },
      }),
    );
  });

  it('sends one overdue digest a day, each person seeing only their loans', async () => {
    const { service, prisma, send, create } = setup([admin, agent]);
    prisma.$queryRaw.mockResolvedValue([
      { bikeName: 'GR-1', agentId: 'agent-1' },
      { bikeName: 'GR-2', agentId: 'agent-9' },
    ]);

    await service.sendOverdueDigest(new Date('2026-10-02T08:00:00Z'));

    expect(send).toHaveBeenCalledWith({
      to: '233241234567',
      body: '2 loans became overdue today: GR-1, GR-2.',
    });
    expect(send).toHaveBeenCalledWith({
      to: '233501112222',
      body: '1 loan became overdue today: GR-1.',
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          dedupeKey: 'loan-overdue:2026-10-02',
        }) as unknown,
      }),
    );
  });

  it('sends no digest on a day nothing became overdue', async () => {
    const { service, send, findUsers } = setup([admin]);

    await service.sendOverdueDigest(new Date('2026-10-02T08:00:00Z'));

    expect(findUsers).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
