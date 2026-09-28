import { parseArgs } from 'node:util';
import {
  FakeDevice,
  type FakeDeviceStats,
  type SimulationScenario,
} from './fake-device';

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
  --help                     Show this message

\x1b[1mNOTE:\x1b[0m negative numbers need the equals form, because a leading dash reads as a flag:
  \x1b[32mnpm run simulator -- --lat=-1.30 --lng=36.85\x1b[0m

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

function printSummary(stats: FakeDeviceStats[]): void {
  console.log('\n\x1b[1m\x1b[36mSummary\x1b[0m');

  for (const s of stats) {
    console.log(
      `  ${s.imei} [${s.scenario}] connections=${s.connections} ` +
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
      scenario: { type: 'string' as const, short: 's', default: 'stationary' },
      interval: { type: 'string' as const, short: 't', default: '10' },
      lat: { type: 'string' as const, default: '-1.2921' },
      lng: { type: 'string' as const, default: '36.8219' },
      count: { type: 'string' as const, short: 'c', default: '0' },
      devices: { type: 'string' as const, short: 'd', default: '1' },
      batch: { type: 'string' as const, short: 'b', default: '1' },
      reconnect: { type: 'boolean' as const, default: false },
      'reconnect-delay': { type: 'string' as const, default: '3' },
      store: { type: 'string' as const, default: '500' },
      help: { type: 'boolean' as const, default: false },
    },
    allowPositionals: true,
  });

  if (values.help) {
    printHelp();
    return;
  }

  const scenario = (values.scenario ?? 'stationary') as SimulationScenario;

  if (!SCENARIOS.includes(scenario)) {
    console.error(
      `Invalid scenario: "${scenario}". Valid choices: ${SCENARIOS.join(', ')}`,
    );
    process.exit(1);
  }

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

  if (!/^\d{8,17}$/.test(baseImei)) {
    console.error(`Invalid --imei: "${baseImei}". Expected 8 to 17 digits.`);
    process.exit(1);
  }

  console.log(
    `\x1b[1m\x1b[36mStarting ${deviceCount} fake device(s) against ${host}:${port} [scenario: ${scenario}]\x1b[0m\n`,
  );

  const devices: FakeDevice[] = [];

  for (let i = 0; i < deviceCount; i += 1) {
    const imei = (BigInt(baseImei) + BigInt(i)).toString().padStart(15, '0');

    devices.push(
      new FakeDevice({
        host,
        port,
        imei,
        scenario,
        intervalSeconds,
        latitude: latitude + i * 0.005,
        longitude: longitude + i * 0.005,
        maxPackets,
        batchSize,
        reconnect: values.reconnect === true ? true : undefined,
        reconnectDelaySeconds,
        maxStoredRecords,
      }),
    );
  }

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

  printSummary(stats);
}

void main();
