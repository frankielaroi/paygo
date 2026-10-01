/**
 * The one status the dashboard shows for a bike on the road. The statuses are mutually
 * exclusive, so the filter chips always add up to the total, and ordered by what needs
 * attention: a bike that is already immobilized is shown as that even though its loan is
 * overdue, and a bike that cannot be reached is shown as offline, since nothing can be sent to
 * it until it reports again.
 */
export type FleetStatus = 'immobilized' | 'offline' | 'overdue' | 'active';

export const FLEET_STATUSES: readonly FleetStatus[] = [
  'immobilized',
  'offline',
  'overdue',
  'active',
];

export interface FleetFacts {
  /** What the device last confirmed. */
  confirmedState: 'MOBILE' | 'IMMOBILIZED' | null;
  /** A tracker is fitted and reported within the offline threshold. */
  online: boolean;
  /** Owed past grace on the bike's open loan, in minor units. */
  overdueMinor: number;
}

export function fleetStatusOf(facts: FleetFacts): FleetStatus {
  if (facts.confirmedState === 'IMMOBILIZED') {
    return 'immobilized';
  }
  if (!facts.online) {
    return 'offline';
  }
  if (facts.overdueMinor > 0) {
    return 'overdue';
  }
  return 'active';
}

/** Readable text for why the reconciler did not act, as shown in the activity feed. */
export function deferralText(reason: string): string {
  const known: Record<string, string> = {
    'interlock:moving': 'Bike in motion',
    'interlock:not-sustained': 'Bike not stopped long enough yet',
    'interlock:ignition-on': 'Ignition on',
    'interlock:ignition-unknown': 'Ignition state not reported',
    'interlock:no-gps-fix': 'No GPS fix',
    'interlock:offline': 'Tracker offline',
    'interlock:stale-telemetry': 'Position data too old',
    'interlock:no-telemetry': 'No position data yet',
    'interlock:awaiting-fresh-telemetry':
      'Waiting for a reading since the tracker reconnected',
    'device-not-connected': 'Tracker not connected',
    'no-tracker-fitted': 'No tracker fitted',
  };
  return known[reason] ?? reason;
}

export interface MobilityFacts {
  /** The viewer holds asset:immobilize. */
  canImmobilize: boolean;
  online: boolean;
  desiredState: 'MOBILE' | 'IMMOBILIZED';
  confirmedState: 'MOBILE' | 'IMMOBILIZED' | null;
}

export interface MobilityControls {
  canLock: boolean;
  canUnlock: boolean;
  /** A lock was requested and the device has not confirmed it yet. */
  lockPending: boolean;
}

/**
 * Which lock controls to offer for a bike. Shared by the dashboard and /bikes so both screens
 * offer the same actions. Nothing is ever sent to a bike that is not reporting, so an offline
 * bike is shown as unreachable rather than offered a lock that could only wait.
 */
export function mobilityControlsOf(facts: MobilityFacts): MobilityControls {
  return {
    canLock:
      facts.canImmobilize &&
      facts.online &&
      facts.desiredState !== 'IMMOBILIZED',
    canUnlock:
      facts.canImmobilize &&
      (facts.desiredState === 'IMMOBILIZED' ||
        facts.confirmedState === 'IMMOBILIZED'),
    lockPending:
      facts.desiredState === 'IMMOBILIZED' &&
      facts.confirmedState !== 'IMMOBILIZED',
  };
}
