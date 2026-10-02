import { BadRequestException } from '@nestjs/common';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { PrismaService } from '../prisma/prisma.service';
import {
  GeofencesService,
  MIN_CROSSING_INTERVAL_MS,
} from './geofences.service';

const ZONE = {
  id: 'zone-1',
  name: 'Accra service zone',
  polygon: [
    [5.52, -0.3],
    [5.72, -0.3],
    [5.72, -0.05],
    [5.52, -0.05],
  ],
};
const INSIDE = [5.6037, -0.187] as const;
const OUTSIDE = [5.6698, 0.0166] as const;
const EARLIER = new Date('2026-10-02T08:00:00Z');
const NOW = new Date('2026-10-02T09:00:00Z');

interface State {
  geofenceId: string;
  inside: boolean;
  since: Date;
}

function setup(states: State[], zones = [ZONE]) {
  const createCrossing = jest.fn().mockResolvedValue({ id: 'crossing-1' });
  const emit = jest.fn();
  const createStates = jest.fn().mockResolvedValue({ count: 1 });
  const updateStates = jest.fn().mockResolvedValue({ count: 1 });
  const tx = {
    bikeGeofenceState: { updateMany: updateStates },
    geofenceCrossing: { create: createCrossing },
  };
  const prisma = {
    geofence: { findMany: jest.fn().mockResolvedValue(zones) },
    bikeGeofenceState: {
      findMany: jest.fn().mockResolvedValue(states),
      createMany: createStates,
    },
    $transaction: jest.fn((run: (client: typeof tx) => Promise<void>) =>
      run(tx),
    ),
  };
  return {
    service: new GeofencesService(
      prisma as unknown as PrismaService,
      { emit } as unknown as EventEmitter2,
    ),
    emit,
    prisma,
    createCrossing,
    createStates,
    updateStates,
  };
}

describe('GeofencesService.observe', () => {
  it('records a bike leaving its zone', async () => {
    const { service, createCrossing, updateStates } = setup([
      { geofenceId: 'zone-1', inside: true, since: EARLIER },
    ]);

    await service.observe('bike-1', ...OUTSIDE, NOW);

    expect(updateStates).toHaveBeenCalledWith({
      where: { bikeId: 'bike-1', geofenceId: 'zone-1', inside: true },
      data: { inside: false, since: NOW },
    });
    expect(createCrossing).toHaveBeenCalledWith({
      data: {
        bikeId: 'bike-1',
        geofenceId: 'zone-1',
        direction: 'EXITED',
        latitude: OUTSIDE[0],
        longitude: OUTSIDE[1],
        recordedAt: NOW,
      },
      select: { id: true },
    });
  });

  it('announces a bike leaving, so staff who asked can be told', async () => {
    const { service, emit } = setup([
      { geofenceId: 'zone-1', inside: true, since: EARLIER },
    ]);

    await service.observe('bike-1', ...OUTSIDE, NOW);

    expect(emit).toHaveBeenCalledWith('geofence.exited', {
      crossingId: 'crossing-1',
      bikeId: 'bike-1',
      geofenceName: 'Accra service zone',
    });
  });

  it('records a bike coming back in', async () => {
    const { service, createCrossing, emit } = setup([
      { geofenceId: 'zone-1', inside: false, since: EARLIER },
    ]);

    await service.observe('bike-1', ...INSIDE, NOW);

    expect(createCrossing).toHaveBeenCalledTimes(1);
    expect(createCrossing).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ direction: 'ENTERED' }) as unknown,
      }),
    );
    // Coming back is recorded, but it is not an alert.
    expect(emit).not.toHaveBeenCalled();
  });

  it('records nothing while a bike stays on the same side', async () => {
    const { service, createCrossing, updateStates } = setup([
      { geofenceId: 'zone-1', inside: false, since: EARLIER },
    ]);

    await service.observe('bike-1', ...OUTSIDE, NOW);

    expect(updateStates).not.toHaveBeenCalled();
    expect(createCrossing).not.toHaveBeenCalled();
  });

  it('only sets the baseline the first time a bike is seen, even outside', async () => {
    const { service, createCrossing, createStates } = setup([]);

    await service.observe('bike-1', ...OUTSIDE, NOW);

    expect(createStates).toHaveBeenCalledWith({
      data: [
        { bikeId: 'bike-1', geofenceId: 'zone-1', inside: false, since: NOW },
      ],
      skipDuplicates: true,
    });
    expect(createCrossing).not.toHaveBeenCalled();
  });

  it('ignores a second crossing moments after the first, so GPS drift on the boundary is not a stream of alerts', async () => {
    const justNow = new Date(NOW.getTime() - MIN_CROSSING_INTERVAL_MS + 1000);
    const { service, createCrossing, updateStates } = setup([
      { geofenceId: 'zone-1', inside: false, since: justNow },
    ]);

    await service.observe('bike-1', ...INSIDE, NOW);

    expect(updateStates).not.toHaveBeenCalled();
    expect(createCrossing).not.toHaveBeenCalled();
  });

  it('records one crossing when two positions are handled at once', async () => {
    const { service, createCrossing, updateStates } = setup([
      { geofenceId: 'zone-1', inside: true, since: EARLIER },
    ]);
    // The other handler moved the state first.
    updateStates.mockResolvedValue({ count: 0 });

    await service.observe('bike-1', ...OUTSIDE, NOW);

    expect(createCrossing).not.toHaveBeenCalled();
  });

  it('does nothing, and reads no state, when no zone is drawn', async () => {
    const { service, prisma } = setup([], []);

    await service.observe('bike-1', ...OUTSIDE, NOW);

    expect(prisma.bikeGeofenceState.findMany).not.toHaveBeenCalled();
  });

  it('never throws into position handling', async () => {
    const { service, prisma } = setup([]);
    prisma.geofence.findMany.mockRejectedValue(new Error('database away'));

    await expect(
      service.observe('bike-1', ...OUTSIDE, NOW),
    ).resolves.toBeUndefined();
  });
});

describe('GeofencesService.create', () => {
  it('refuses an outline that encloses nothing, before writing', async () => {
    const { service, prisma } = setup([]);
    const create = jest.fn();
    Object.assign(prisma.geofence, { create });

    await expect(
      service.create(
        {
          name: 'A line',
          polygon: [
            [5.5, -0.2],
            [5.6, -0.2],
            [5.7, -0.2],
          ],
        },
        'user-1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(create).not.toHaveBeenCalled();
  });
});
