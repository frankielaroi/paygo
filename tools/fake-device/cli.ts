import { parseArgs } from 'node:util';
import {
  FakeDevice,
  type FakeDeviceStats,
  type SimulationScenario,
} from './fake-device';
import { toFleetDevices, type FleetDevice } from './fleet';
import { ACTIVE_BIKE_STATUSES, loadActiveFleet } from './fleet-db';

const SCENARIOS: SimulationScenario[] = [
  'stationary',
  'moving',
  'idle',
  'abrupt-disconnect',
  'corrupt-crc',
  'corrupt-data',
  'reconnect',
  'split-writes',
];

function printHelp(): void {
  console.log(`
\x1b[1m\x1b[36m===============================================================
 PayGo Teltonika Codec 8 Fake Device Simulator
===============================================================\x1b[0m

Simulates a real Teltonika GPS tracker (e.g. FMB920) connecting over TCP.

\x1b[1mUSAGE:\x1b[0m
  npx tsx tools/fake-device/cli.ts [OPTIONS]
  npm run simulator -- [OPTIONS]

\x1b[1mOPTIONS:\x1b[0m
  --host, -h <string>        TCP server host (default: "127.0.0.1")
  --port, -p <number>        TCP server port (default: 5027)
  --imei, -i <string>        15-digit device IMEI (default: "356892080000001")
  --scenario, -s <string>    One of: ${SCENARIOS.join(' | ')}
                             (default: "stationary")
  --interval, -t <number>    Report interval in seconds (default: 10)
  --lat=<number>             Initial latitude (default: -1.2921)
  --lng=<number>             Initial longitude (default: 36.8219)
  --count, -c <number>       Max packets per device (default: 0 = unlimited)
  --devices, -d <number>     Concurrent devices to simulate (default: 1)
  --batch, -b <number>       Max records per packet (default: 1)
  --reconnect                Reconnect after the connection drops
  --reconnect-delay <number> Seconds before reconnecting (default: 3)
  --store <number>           Records the device can hold offline (default: 500)
  --from-db                  Simulate every active bike in the database instead of
                             generating IMEIs. Needs DATABASE_URL.
  --db-limit <number>        With --from-db, simulate at most N bikes (default: 0 = all)
  --help                     Show this message

\x1b[1mNOTE:\x1b[0m negative numbers need the equals form, because a leading dash reads as a flag:
  \x1b[32mnpm run simulator -- --lat=-1.30 --lng=36.85\x1b[0m

\x1b[1mFROM THE DATABASE:\x1b[0m
  --from-db reads every bike that has a tracker fitted and is still in the fleet
  (status ${ACTIVE_BIKE_STATUSES.join(', ')}) and runs one device per bike, using
  that bike's own IMEI, so the server resolves each one to a real record.

  Each bike starts at its last known position when that fix was valid, and falls back
  to --lat/--lng otherwise. Without --scenario, each bike also gets the scenario
  matching its last telemetry: "moving" if it was last seen rolling or with its
  ignition on, "stationary" otherwise. Passing --scenario overrides that for every
  bike. --imei and --devices are ignored.

\x1b[1mSCENARIOS:\x1b[0m
  stationary         speed 0, ignition off. The only state in which immobilizing is safe.
  moving             speed 35km/h, ignition on, position advancing.
  idle               one report, then silence on an open socket.
  abrupt-disconnect  reports once, then a reset with no FIN (battery pull).
  corrupt-crc        valid frame with a broken checksum. The server must not acknowledge it.
  corrupt-data       mismatched record counts. The server must reject the packet.
  reconnect          reports, drops, comes back, and sends what it stored while away.
  split-writes       each packet written in two chunks, to test stream reassembly.

\x1b[1mEXAMPLES:\x1b[0m
  \x1b[32m# Stationary bike: the state an immobilize interlock should allow\x1b[0m
  npm run simulator -- --scenario stationary

  \x1b[32m# Moving bike: the state an interlock must refuse\x1b[0m
  npm run simulator -- --scenario moving --interval 5

  \x1b[32m# Offline buffering: watch stored records arrive in one batch on reconnect\x1b[0m
  npm run simulator -- --scenario reconnect --interval 2 --batch 10

  \x1b[32m# Corrupt checksum: the server should log a discard and send no ACK\x1b[0m
  npm run simulator -- --scenario corrupt-crc --count 2

  \x1b[32m# A small fleet\x1b[0m
  npm run simulator -- --devices 5 --scenario moving

  \x1b[32m# The real fleet, each bike resuming where it was last seen\x1b[0m
  npm run simulator -- --from-db

  \x1b[32m# The real fleet, all of it stationary: the state immobilizing is allowed in\x1b[0m
  npm run simulator -- --from-db --scenario stationary
`);
}

function positiveInt(
  raw: string | undefined,
  fallback: number,
  name: string,
): number {
  if (raw === undefined) {
    return fallback;
  }

  const value = Number.parseInt(raw, 10);

  if (!Number.isFinite(value) || value < 0) {
    console.error(`Invalid --${name}: "${raw}"`);
    process.exit(1);
  }

  return value;
}

function finiteFloat(
  raw: string | undefined,
  fallback: number,
  name: string,
): number {
  if (raw === undefined) {
    return fallback;
  }

  const value = Number.parseFloat(raw);

  if (!Number.isFinite(value)) {
    console.error(`Invalid --${name}: "${raw}"`);
    process.exit(1);
  }

  return value;
}

/** The IMEIs the simulator invents when it is not reading the real fleet. */
function generatedFleet(options: {
  baseImei: string;
  deviceCount: number;
  scenario: SimulationScenario;
  latitude: number;
  longitude: number;
}): FleetDevice[] {
  return Array.from({ length: options.deviceCount }, (_unused, i) => ({
    imei: (BigInt(options.baseImei) + BigInt(i)).toString().padStart(15, '0'),
    label: `device ${i + 1}`,
    latitude: options.latitude + i * 0.005,
    longitude: options.longitude + i * 0.005,
    scenario: options.scenario,
    derivedScenario: false,
    derivedPosition: false,
  }));
}

async function fleetFromDatabase(options: {
  limit: number;
  forcedScenario: SimulationScenario | undefined;
  latitude: number;
  longitude: number;
}): Promise<FleetDevice[]> {
  const rows = await loadActiveFleet({ limit: options.limit });
  const { devices, skipped } = toFleetDevices(rows, {
    forcedScenario: options.forcedScenario,
    fallbackLatitude: options.latitude,
    fallbackLongitude: options.longitude,
  });

  for (const entry of skipped) {
    console.warn(`\x1b[33mSkipped ${entry.label}: ${entry.reason}\x1b[0m`);
  }

  if (devices.length === 0) {
    console.error(
      'No active bike in the database has a tracker fitted, so there is nothing to simulate. ' +
        'Add a bike with an IMEI, or run without --from-db.',
    );
    process.exit(1);
  }

  const resumed = devices.filter((device) => device.derivedPosition).length;
  console.log(
    `Loaded ${devices.length} bike(s) from the database; ` +
      `${resumed} resuming from their last known fix.`,
  );

  return devices;
}

/** "scenario: moving" for a uniform run, or the mix when each bike derived its own. */
function describeScenarios(fleet: readonly FleetDevice[]): string {
  const counts = new Map<SimulationScenario, number>();

  for (const member of fleet) {
    counts.set(member.scenario, (counts.get(member.scenario) ?? 0) + 1);
  }

  if (counts.size === 1) {
    const [only] = [...counts.keys()];
    return `scenario: ${only}`;
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name}: ${count}`)
    .join(', ');
}

function printSummary(
  stats: FakeDeviceStats[],
  labels: ReadonlyMap<string, string>,
): void {
  console.log('\n\x1b[1m\x1b[36mSummary\x1b[0m');

  for (const s of stats) {
    const label = labels.get(s.imei);
    console.log(
      `  ${s.imei}${label === undefined ? '' : ` (${label})`} [${s.scenario}] connections=${s.connections} ` +
        `packets=${s.packetsSent} records=${s.recordsSent} ` +
        `acked=${s.recordsAcknowledged} stillStored=${s.recordsStored} ` +
        `dropped=${s.recordsDropped} commands=${s.commandsReceived}`,
    );

    // Unacknowledged records are the interesting case: either the server refused them, which is
    // correct for a corrupt packet, or they never got a chance to go out.
    if (s.recordsStored > 0) {
      console.log(
        `    \x1b[33m${s.recordsStored} record(s) were never acknowledged\x1b[0m`,
      );
    }
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      host: { type: 'string' as const, short: 'h', default: '127.0.0.1' },
      port: { type: 'string' as const, short: 'p', default: '5027' },
      imei: { type: 'string' as const, short: 'i', default: '356892080000001' },
      scenario: { type: 'string' as const, short: 's' },
      interval: { type: 'string' as const, short: 't', default: '10' },
      lat: { type: 'string' as const, default: '-1.2921' },
      lng: { type: 'string' as const, default: '36.8219' },
      count: { type: 'string' as const, short: 'c', default: '0' },
      devices: { type: 'string' as const, short: 'd', default: '1' },
      batch: { type: 'string' as const, short: 'b', default: '1' },
      reconnect: { type: 'boolean' as const, default: false },
      'reconnect-delay': { type: 'string' as const, default: '3' },
      store: { type: 'string' as const, default: '500' },
      'from-db': { type: 'boolean' as const, default: false },
      'db-limit': { type: 'string' as const, default: '0' },
      help: { type: 'boolean' as const, default: false },
    },
    allowPositionals: true,
  });

  if (values.help) {
    printHelp();
    return;
  }

  // Left undefined, --from-db gives each bike the scenario matching its own last telemetry.
  // Everything else keeps the historical default.
  const explicitScenario = values.scenario as SimulationScenario | undefined;

  if (explicitScenario !== undefined && !SCENARIOS.includes(explicitScenario)) {
    console.error(
      `Invalid scenario: "${explicitScenario}". Valid choices: ${SCENARIOS.join(', ')}`,
    );
    process.exit(1);
  }

  const scenario = explicitScenario ?? 'stationary';

  const host = values.host ?? '127.0.0.1';
  const port = positiveInt(values.port, 5027, 'port');
  const baseImei = values.imei ?? '356892080000001';
  const intervalSeconds = Math.max(
    1,
    positiveInt(values.interval, 10, 'interval'),
  );
  const latitude = finiteFloat(values.lat, -1.2921, 'lat');
  const longitude = finiteFloat(values.lng, 36.8219, 'lng');
  const maxPackets = positiveInt(values.count, 0, 'count');
  const deviceCount = Math.max(1, positiveInt(values.devices, 1, 'devices'));
  const batchSize = Math.max(1, positiveInt(values.batch, 1, 'batch'));
  const reconnectDelaySeconds = positiveInt(
    values['reconnect-delay'],
    3,
    'reconnect-delay',
  );
  const maxStoredRecords = Math.max(1, positiveInt(values.store, 500, 'store'));

  const fromDb = values['from-db'] === true;
  const dbLimit = positiveInt(values['db-limit'], 0, 'db-limit');

  if (!fromDb && !/^\d{8,17}$/.test(baseImei)) {
    console.error(`Invalid --imei: "${baseImei}". Expected 8 to 17 digits.`);
    process.exit(1);
  }

  const fleet = fromDb
    ? await fleetFromDatabase({
        limit: dbLimit,
        forcedScenario: explicitScenario,
        latitude,
        longitude,
      })
    : generatedFleet({ baseImei, deviceCount, scenario, latitude, longitude });

  console.log(
    `\x1b[1m\x1b[36mStarting ${fleet.length} fake device(s) against ${host}:${port}` +
      ` [${describeScenarios(fleet)}]\x1b[0m\n`,
  );

  const devices = fleet.map(
    (member) =>
      new FakeDevice({
        host,
        port,
        imei: member.imei,
        scenario: member.scenario,
        intervalSeconds,
        latitude: member.latitude,
        longitude: member.longitude,
        maxPackets,
        batchSize,
        reconnect: values.reconnect === true ? true : undefined,
        reconnectDelaySeconds,
        maxStoredRecords,
      }),
  );

  let shuttingDown = false;

  process.on('SIGINT', () => {
    if (shuttingDown) {
      process.exit(130);
    }

    shuttingDown = true;
    console.log('\n\x1b[33mStopping simulator...\x1b[0m');
    devices.forEach((device) => {
      device.stop();
    });
  });

  // Waiting for every device means the summary reflects the whole run, and the process exits on
  // its own once the devices are done rather than hanging on an open socket.
  const stats = await Promise.all(
    devices.map((device) =>
      device.start().catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.error(`[${device.getStats().imei}] failed: ${detail}`);

        return device.getStats();
      }),
    ),
  );

  printSummary(
    stats,
    new Map(fleet.map((member) => [member.imei, member.label])),
  );
}

void main();
