import type {
  SafetyReading,
  TrackingSafetySnapshot,
} from '../tracking/tracking.service';

/**
 * Why an immobilize was refused. Every one of these means "do nothing this time"; none of them
 * is an error. The ones in REVIEW_REASONS also mean nobody can currently see the bike, so a
 * person should look rather than wait for the system.
 */
export type InterlockBlock =
  | 'no-telemetry'
  | 'offline'
  | 'stale-telemetry'
  | 'awaiting-fresh-telemetry'
  | 'no-gps-fix'
  | 'moving'
  | 'ignition-on'
  | 'ignition-unknown'
  | 'not-sustained';

const REVIEW_REASONS: ReadonlySet<InterlockBlock> = new Set([
  'no-telemetry',
  'offline',
  'stale-telemetry',
]);

export type InterlockVerdict =
  | { safe: true }
  | { safe: false; reason: InterlockBlock; needsReview: boolean };

export interface InterlockSettings {
  stationarySeconds: number;
  maxTelemetryAgeSeconds: number;
}

function block(reason: InterlockBlock): InterlockVerdict {
  return { safe: false, reason, needsReview: REVIEW_REASONS.has(reason) };
}

/**
 * The strict definition of stopped. Without a fix, a speed of 0 is not a measurement, only the
 * absence of one, and a null ignition is unknown rather than off. Movement is an extra signal:
 * a reported true refuses, but not every device configuration reports it, so null does not.
 */
function stationaryBlock(reading: SafetyReading): InterlockBlock | null {
  if (!reading.hasFix) {
    return 'no-gps-fix';
  }
  if (reading.speed !== 0 || reading.movement === true) {
    return 'moving';
  }
  if (reading.ignition === null) {
    return 'ignition-unknown';
  }
  if (reading.ignition) {
    return 'ignition-on';
  }
  return null;
}

/**
 * First half of the interlock, on the latest snapshot alone: is there recent, trustworthy
 * telemetry, and does it say the bike is stopped right now? Cheap, so it runs before any
 * history is read.
 */
export function checkLatest(
  snapshot: TrackingSafetySnapshot | null,
  now: Date,
  settings: InterlockSettings,
  connectedSince: Date | null,
): InterlockVerdict {
  if (!snapshot) {
    return block('no-telemetry');
  }
  if (!snapshot.online) {
    return block('offline');
  }

  // A reading from before the current connection says nothing about what happened during the
  // gap, and a device reconnecting is often one that was just switched on and ridden off.
  if (connectedSince && snapshot.receivedAt < connectedSince) {
    return block('awaiting-fresh-telemetry');
  }

  // Device time, not server time: a device replaying a stored backlog is online while its
  // latest reading is old, and an old "stopped" says nothing about now.
  const ageMs = now.getTime() - snapshot.recordedAt.getTime();
  if (ageMs > settings.maxTelemetryAgeSeconds * 1000) {
    return block('stale-telemetry');
  }

  const latest = stationaryBlock(snapshot);
  return latest ? block(latest) : { safe: true };
}

/**
 * Second half: has the bike been stopped for the whole window ending at the latest reading?
 * Needs an anchor reading at or before the window start, proving the state when the window
 * opened, and every reading since must also be stopped. A bike that has only just stopped has
 * no anchor inside the window and is refused until it has one.
 */
export function checkSustained(window: {
  anchor: SafetyReading | null;
  readings: SafetyReading[];
}): InterlockVerdict {
  if (!window.anchor) {
    return block('not-sustained');
  }

  const allStopped = [window.anchor, ...window.readings].every(
    (reading) => stationaryBlock(reading) === null,
  );

  return allStopped ? { safe: true } : block('not-sustained');
}

/** Where the sustained window starts for a snapshot. */
export function windowStart(
  snapshot: TrackingSafetySnapshot,
  settings: InterlockSettings,
): Date {
  return new Date(
    snapshot.recordedAt.getTime() - settings.stationarySeconds * 1000,
  );
}
