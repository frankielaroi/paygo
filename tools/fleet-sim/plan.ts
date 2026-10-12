import type { TelemetryDataOptions } from '../fake-device/codec8-builder';

/** What the simulator needs to know about one bike, read from the database at the start of a run. */
export interface FleetBike {
  bikeId: string;
  imei: string;
  latitude: number | null;
  longitude: number | null;
  externalVoltageMv: number | null;
  odometerMeters: number | null;
  /** Locked (device-confirmed) or held in a yard: the bike cannot be ridden. */
  heldStill: boolean;
}

export type Activity = 'offline' | 'parked' | 'riding';

interface Town {
  name: string;
  lat: number;
  lng: number;
  altitude: number;
  /** The coast lies south of this latitude: a simulated bike must not ride into the sea. */
  minLat: number | null;
}

/** The branch towns of the demo seed. A bike belongs to whichever is nearest. */
export const TOWNS: readonly Town[] = [
  { name: 'Accra', lat: 5.6037, lng: -0.187, altitude: 60, minLat: 5.565 },
  { name: 'Kumasi', lat: 6.6885, lng: -1.6244, altitude: 260, minLat: null },
  { name: 'Tamale', lat: 9.4034, lng: -0.8424, altitude: 180, minLat: null },
  // The branch itself is on the shore, so riding centres on a point a little inland.
  { name: 'Takoradi', lat: 4.935, lng: -1.755, altitude: 20, minLat: 4.905 },
];

const METRES_PER_DEGREE = 111_320;
const ROAM_RADIUS_METRES = 6_000;
const PACK_FULL_MV = 54_600;
const PACK_LOW_MV = 43_000;
const OFFLINE_SHARE = 0.05;
const OFFLINE_SLOT_MS = 2 * 60 * 60 * 1000;
const RIDE_SLOT_MS = 15 * 60 * 1000;

/** FNV-1a, scaled to [0, 1). Stable across runs, so a bike keeps its behaviour for a whole slot. */
export function unitHash(key: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / 0x1_0000_0000;
}

/** Share of free bikes on the road at this hour. Ghana keeps UTC all year. */
export function rideShareAt(hourUtc: number): number {
  if (hourUtc >= 6 && hourUtc < 9) return 0.45;
  if (hourUtc >= 9 && hourUtc < 17) return 0.35;
  if (hourUtc >= 17 && hourUtc < 21) return 0.45;
  if (hourUtc >= 21 && hourUtc < 23) return 0.15;
  return 0.04;
}

/**
 * What a bike does during a run. It depends only on the bike and the clock, so consecutive runs
 * agree: a ride lasts its 15 minute slot and an outage its two hours, instead of flickering.
 */
export function activityOf(bike: FleetBike, now: Date): Activity {
  if (bike.heldStill) {
    return 'parked';
  }

  const time = now.getTime();
  const offlineSlot = Math.floor(time / OFFLINE_SLOT_MS);
  if (unitHash(`${bike.bikeId}:offline:${offlineSlot}`) < OFFLINE_SHARE) {
    return 'offline';
  }

  const rideSlot = Math.floor(time / RIDE_SLOT_MS);
  return unitHash(`${bike.bikeId}:ride:${rideSlot}`) <
    rideShareAt(now.getUTCHours())
    ? 'riding'
    : 'parked';
}

function metresBetween(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const north = (b.lat - a.lat) * METRES_PER_DEGREE;
  const east =
    (b.lng - a.lng) * METRES_PER_DEGREE * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(north, east);
}

function bearingTo(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
): number {
  const north = to.lat - from.lat;
  const east = (to.lng - from.lng) * Math.cos((from.lat * Math.PI) / 180);
  return ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360;
}

export function nearestTown(position: { lat: number; lng: number }): Town {
  return TOWNS.reduce((best, town) =>
    metresBetween(position, town) < metresBetween(position, best) ? town : best,
  );
}

/** mulberry32: small, seedable, good enough for wobble in a heading. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

/**
 * One bike's movement over a run: where it is, how fast, its pack voltage and its odometer.
 * Each call to `next` advances it by the time since the previous call.
 */
export class BikeMotion {
  private lat: number;
  private lng: number;
  private voltageMv: number;
  private odometerM: number;
  private heading: number;
  private speedKmh: number;
  private lastAt: number;
  private readonly town: Town;
  private readonly random: () => number;

  constructor(
    bike: FleetBike,
    private readonly activity: Exclude<Activity, 'offline'>,
    startedAt: number,
  ) {
    const slot = Math.floor(startedAt / RIDE_SLOT_MS);
    this.random = seededRandom(
      Math.floor(unitHash(`${bike.bikeId}:motion:${slot}`) * 0xffff_ffff),
    );

    if (bike.latitude === null || bike.longitude === null) {
      // Never reported: start it somewhere plausible in the first town.
      const start = TOWNS[0];
      this.lat = start.lat + 0.01 + this.random() * 0.03;
      this.lng = start.lng + (this.random() - 0.5) * 0.06;
    } else {
      this.lat = bike.latitude;
      this.lng = bike.longitude;
    }

    this.town = nearestTown({ lat: this.lat, lng: this.lng });
    this.voltageMv = bike.externalVoltageMv ?? 51_000;
    this.odometerM = bike.odometerMeters ?? 0;
    this.heading = this.random() * 360;
    this.speedKmh = 20 + this.random() * 20;
    this.lastAt = startedAt;
  }

  next(now: number): TelemetryDataOptions {
    const seconds = Math.max(0, (now - this.lastAt) / 1000);
    this.lastAt = now;

    if (this.activity === 'riding') {
      this.ride(seconds);
    } else {
      this.rest(seconds, new Date(now).getUTCHours());
    }

    const riding = this.activity === 'riding';

    return {
      timestamp: now,
      latitude: this.lat,
      longitude: this.lng,
      altitude: this.town.altitude,
      angle: riding ? Math.round(this.heading) % 360 : 0,
      satellites: 8 + Math.floor(this.random() * 7),
      speed: riding ? Math.round(this.speedKmh) : 0,
      ignition: riding,
      movement: riding,
      externalVoltageMv: Math.round(this.voltageMv),
      odometerMeters: Math.round(this.odometerM),
    };
  }

  private ride(seconds: number): void {
    const here = { lat: this.lat, lng: this.lng };
    const tooFar = metresBetween(here, this.town) > ROAM_RADIUS_METRES;
    const atTheCoast =
      this.town.minLat !== null && this.lat < this.town.minLat + 0.003;

    if (tooFar || atTheCoast) {
      this.heading = bearingTo(here, this.town);
    } else {
      this.heading = (this.heading + (this.random() - 0.5) * 40 + 360) % 360;
    }

    this.speedKmh = Math.min(
      48,
      Math.max(12, this.speedKmh + (this.random() - 0.5) * 12),
    );

    const metres = (this.speedKmh / 3.6) * seconds;
    const radians = (this.heading * Math.PI) / 180;
    this.lat += (metres * Math.cos(radians)) / METRES_PER_DEGREE;
    this.lng +=
      (metres * Math.sin(radians)) /
      (METRES_PER_DEGREE * Math.cos((this.lat * Math.PI) / 180));
    this.odometerM += metres;
    // A full pack lasts roughly 70 km.
    this.voltageMv = Math.max(PACK_LOW_MV, this.voltageMv - metres * 0.17);
  }

  /** Parked: the position does not move at all. Overnight, or when low, the pack charges. */
  private rest(seconds: number, hourUtc: number): void {
    const overnight = hourUtc >= 21 || hourUtc < 6;
    if (overnight || this.voltageMv < 46_000) {
      this.voltageMv = Math.min(PACK_FULL_MV, this.voltageMv + seconds);
    }
  }
}
