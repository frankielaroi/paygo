import type { SimulationScenario } from './fake-device';

/**
 * Choosing a fleet from the application's own records, so a simulator run exercises the IMEIs
 * the server actually resolves instead of invented ones. This file is pure: it maps rows to
 * device options and nothing here opens a database connection, which keeps it testable without
 * one. `fleet-db.ts` is the part that reads Postgres.
 */

/** The shape `fleet-db.ts` selects. Declared here so the mapping can be tested with literals. */
export interface FleetRow {
  imei: string | null;
  label: string;
  currentPosition: {
    latitude: number;
    longitude: number;
    hasFix: boolean;
    speed: number;
    ignition: boolean | null;
    movement: boolean | null;
  } | null;
}

export interface FleetDevice {
  imei: string;
  label: string;
  latitude: number;
  longitude: number;
  scenario: SimulationScenario;
  /** True when the scenario came from the bike's own last telemetry rather than from --scenario. */
  derivedScenario: boolean;
  /** True when the coordinates came from the bike's last fix rather than from --lat/--lng. */
  derivedPosition: boolean;
}

export interface FleetSelection {
  devices: FleetDevice[];
  /** Labels of rows that could not be simulated, with the reason, for the caller to report. */
  skipped: { label: string; reason: string }[];
}

/** The handshake carries the IMEI as decimal digits; anything else the server would reject. */
const IMEI_PATTERN = /^\d{8,17}$/;

/**
 * Which scenario reproduces a bike's last known telemetry.
 *
 * Only two of the scenarios describe a steady telemetry state: `stationary` reports speed 0 with
 * ignition off, and `moving` reports speed 35 with ignition on. A bike last seen with its ignition
 * on but not rolling therefore maps to `moving`, not `stationary`: the two differ in speed, but
 * they agree on the thing enforcement reads, which is that immobilizing right now is unsafe.
 * Mapping it to `stationary` would hand the interlock a safe reading the bike never sent.
 *
 * A bike with no stored position has never reported, so there is nothing to reproduce and it
 * starts stationary.
 */
export function scenarioFromTelemetry(
  position: FleetRow['currentPosition'],
): SimulationScenario {
  if (!position) {
    return 'stationary';
  }

  const inMotion =
    position.speed > 0 ||
    position.movement === true ||
    position.ignition === true;

  return inMotion ? 'moving' : 'stationary';
}

export interface FleetMappingOptions {
  /**
   * Applied to every device when --scenario was passed. Left undefined, each bike gets the
   * scenario matching its own last telemetry, which is the point of running from the database.
   */
  forcedScenario?: SimulationScenario;
  /** Used for bikes with no usable fix, offset per device so they do not stack on one pixel. */
  fallbackLatitude: number;
  fallbackLongitude: number;
}

export function toFleetDevices(
  rows: readonly FleetRow[],
  options: FleetMappingOptions,
): FleetSelection {
  const devices: FleetDevice[] = [];
  const skipped: { label: string; reason: string }[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    if (row.imei === null || row.imei.trim() === '') {
      skipped.push({ label: row.label, reason: 'no tracker IMEI' });
      continue;
    }

    const imei = row.imei.trim();

    if (!IMEI_PATTERN.test(imei)) {
      skipped.push({
        label: row.label,
        reason: `IMEI "${imei}" is not 8 to 17 digits`,
      });
      continue;
    }

    // Two bikes cannot share an IMEI (the column is unique), but a simulator that silently ran
    // two devices on one IMEI would make the server's socket replacement look like a bug.
    if (seen.has(imei)) {
      skipped.push({
        label: row.label,
        reason: `IMEI ${imei} already simulated`,
      });
      continue;
    }

    seen.add(imei);

    const fix =
      row.currentPosition && row.currentPosition.hasFix
        ? row.currentPosition
        : null;
    const index = devices.length;

    devices.push({
      imei,
      label: row.label,
      latitude: fix ? fix.latitude : options.fallbackLatitude + index * 0.005,
      longitude: fix
        ? fix.longitude
        : options.fallbackLongitude + index * 0.005,
      scenario:
        options.forcedScenario ?? scenarioFromTelemetry(row.currentPosition),
      derivedScenario: options.forcedScenario === undefined,
      derivedPosition: fix !== null,
    });
  }

  return { devices, skipped };
}
