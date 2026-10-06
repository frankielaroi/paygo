import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../src/generated/prisma/client';
import { BikeStatus } from '../../src/generated/prisma/enums';
import type { FleetRow } from './fleet';

/**
 * Reads the fleet the simulator should impersonate out of the application's database.
 *
 * This is the only file in `tools/` that touches Postgres, and it is deliberately the only one
 * that imports from `src/`. The dependency runs one way: `src/` must never import from `tools/`
 * (see CLAUDE.md), and nothing here is reachable from a production build, which excludes `tools`
 * entirely. What it borrows is the generated client, not the protocol code, so the simulator's
 * encoder is still independent of the parser it is testing.
 */

/**
 * "Active" is a bike that has a tracker fitted and is still in the fleet. A sold or retired bike
 * keeps its installation history but its unit is not reporting, so simulating it would invent
 * traffic the server should never see.
 */
export const ACTIVE_BIKE_STATUSES: BikeStatus[] = [
  BikeStatus.IN_INVENTORY,
  BikeStatus.ASSIGNED,
  BikeStatus.REPOSSESSED,
];

export interface LoadFleetOptions {
  /** 0 means every active bike. */
  limit?: number;
  statuses?: BikeStatus[];
}

export async function loadActiveFleet(
  options: LoadFleetOptions = {},
): Promise<FleetRow[]> {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is required to simulate the fleet from the database. ' +
        'Set it in .env, or drop --from-db and pass --imei instead.',
    );
  }

  const limit = options.limit ?? 0;
  const adapter = new PrismaPg({ connectionString });
  const prisma = new PrismaClient({ adapter });

  try {
    return await prisma.bike.findMany({
      where: {
        imei: { not: null },
        status: { in: options.statuses ?? ACTIVE_BIKE_STATUSES },
      },
      select: {
        imei: true,
        label: true,
        currentPosition: {
          select: {
            latitude: true,
            longitude: true,
            hasFix: true,
            speed: true,
            ignition: true,
            movement: true,
          },
        },
      },
      orderBy: { label: 'asc' },
      ...(limit > 0 ? { take: limit } : {}),
    });
  } finally {
    await prisma.$disconnect();
  }
}
