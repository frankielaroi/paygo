import { parseArgs } from 'node:util';
import { Client } from 'pg';
import { FakeDevice } from '../fake-device/fake-device';
import { activityOf, BikeMotion, type Activity, type FleetBike } from './plan';

/**
 * One run of the demo fleet: every demo bike with a tracker connects to the device listener as
 * its own IMEI, reports for `--duration` seconds, and disconnects. Run it on a schedule slightly
 * longer than the duration and the fleet looks alive: some bikes riding, most parked, a few
 * offline, and locked bikes standing still and answering lock and unlock commands.
 *
 * It only ever speaks for IMEIs starting with `--imei-prefix`, the range the demo seed issues,
 * so it cannot impersonate a real tracker.
 */

const HELP = `
PayGo demo fleet simulator: one bounded run, meant for a scheduler.

  DATABASE_URL=... npx tsx tools/fleet-sim/cli.ts [OPTIONS]

  --host <string>          Device listener host (default 127.0.0.1)
  --port <number>          Device listener port (default 5027)
  --duration <seconds>     How long to report before disconnecting (default 285)
  --ride-interval <s>      Report period while riding (default 20)
  --park-interval <s>      Report period while parked (default 60)
  --imei-prefix <digits>   Only bikes whose IMEI starts with this (default 3520940)
  --dry-run                Print what each bike would do and exit
  --help
`;

interface BikeRow {
  id: string;
  imei: string;
  status: string;
  latitude: number | null;
  longitude: number | null;
  externalVoltageMv: number | null;
  odometerMeters: number | null;
  confirmedState: string | null;
}

async function loadFleet(
  databaseUrl: string,
  imeiPrefix: string,
): Promise<FleetBike[]> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const result = await client.query<BikeRow>(
      `SELECT b."id", b."imei", b."status"::text AS "status",
              p."latitude", p."longitude", p."externalVoltageMv", p."odometerMeters",
              e."confirmedState"::text AS "confirmedState"
         FROM "bikes" b
         LEFT JOIN "bike_current_positions" p ON p."bikeId" = b."id"
         LEFT JOIN "bike_enforcement" e ON e."bikeId" = b."id"
        WHERE b."imei" LIKE $1
          AND b."status" IN ('ASSIGNED', 'REPOSSESSED')`,
      [`${imeiPrefix}%`],
    );

    return result.rows.map((row) => ({
      bikeId: row.id,
      imei: row.imei,
      latitude: row.latitude,
      longitude: row.longitude,
      externalVoltageMv: row.externalVoltageMv,
      odometerMeters: row.odometerMeters,
      heldStill:
        row.status === 'REPOSSESSED' || row.confirmedState === 'IMMOBILIZED',
    }));
  } finally {
    await client.end();
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      host: { type: 'string', default: '127.0.0.1' },
      port: { type: 'string', default: '5027' },
      duration: { type: 'string', default: '285' },
      'ride-interval': { type: 'string', default: '20' },
      'park-interval': { type: 'string', default: '60' },
      'imei-prefix': { type: 'string', default: '3520940' },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });

  if (values.help) {
    console.log(HELP);
    return;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set');
  }

  const imeiPrefix = values['imei-prefix'];
  if (!/^\d{4,15}$/.test(imeiPrefix)) {
    throw new Error('--imei-prefix must be 4 to 15 digits');
  }

  const durationMs = Number(values.duration) * 1000;
  const rideInterval = Number(values['ride-interval']);
  const parkInterval = Number(values['park-interval']);
  const port = Number(values.port);
  if (
    ![durationMs, rideInterval, parkInterval, port].every(
      (n) => Number.isFinite(n) && n > 0,
    )
  ) {
    throw new Error('duration, intervals and port must be positive numbers');
  }

  const startedAt = new Date();
  const fleet = await loadFleet(databaseUrl, imeiPrefix);
  const counts: Record<Activity, number> = { offline: 0, parked: 0, riding: 0 };
  const planned = fleet.map((bike) => {
    const activity = activityOf(bike, startedAt);
    counts[activity] += 1;
    return { bike, activity };
  });

  if (values['dry-run']) {
    for (const { bike, activity } of planned) {
      console.log(`${bike.imei} ${activity}`);
    }
    console.log(JSON.stringify({ bikes: fleet.length, ...counts }));
    return;
  }

  let errors = 0;
  const devices: FakeDevice[] = [];
  const runs: Promise<unknown>[] = [];

  for (const { bike, activity } of planned) {
    if (activity === 'offline') {
      continue;
    }

    const motion = new BikeMotion(bike, activity, startedAt.getTime());
    const device = new FakeDevice({
      host: values.host,
      port,
      imei: bike.imei,
      scenario: 'stationary',
      intervalSeconds: activity === 'riding' ? rideInterval : parkInterval,
      reconnect: true,
      recordSource: () => motion.next(Date.now()),
      logger: (_message, level) => {
        if (level === 'error') {
          errors += 1;
        }
      },
    });

    devices.push(device);
    runs.push(device.start());
    // A fleet does not connect in the same millisecond.
    await wait(40);
  }

  await wait(durationMs);

  let recordsAcknowledged = 0;
  let commandsReceived = 0;
  let neverAccepted = 0;
  for (const device of devices) {
    const stats = device.getStats();
    recordsAcknowledged += stats.recordsAcknowledged;
    commandsReceived += stats.commandsReceived;
    if (stats.recordsAcknowledged === 0) {
      neverAccepted += 1;
    }
    device.stop();
  }

  await Promise.race([Promise.all(runs), wait(5000)]);

  console.log(
    JSON.stringify({
      at: startedAt.toISOString(),
      bikes: fleet.length,
      ...counts,
      recordsAcknowledged,
      commandsReceived,
      neverAccepted,
      socketErrors: errors,
    }),
  );

  // Nothing got through at all: the listener is down or refusing, and a scheduler should see it.
  if (devices.length > 0 && recordsAcknowledged === 0) {
    process.exitCode = 1;
  }
}

main().then(
  () => process.exit(),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
