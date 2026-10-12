import {
  activityOf,
  BikeMotion,
  nearestTown,
  rideShareAt,
  TOWNS,
  unitHash,
  type FleetBike,
} from './plan';

const bike = (over: Partial<FleetBike> = {}): FleetBike => ({
  bikeId: 'b7f6c3de-0000-4000-8000-000000000001',
  imei: '352094012345678',
  latitude: 5.62,
  longitude: -0.2,
  externalVoltageMv: 50_000,
  odometerMeters: 1_000_000,
  heldStill: false,
  ...over,
});

const fleet = (n: number): FleetBike[] =>
  Array.from({ length: n }, (_, i) => bike({ bikeId: `bike-${i}` }));

const NOON = new Date('2026-10-12T12:00:00Z');

describe('unitHash', () => {
  it('is stable and stays in [0, 1)', () => {
    expect(unitHash('abc')).toBe(unitHash('abc'));
    for (const key of ['', 'a', 'bike-1:ride:42', 'x'.repeat(200)]) {
      expect(unitHash(key)).toBeGreaterThanOrEqual(0);
      expect(unitHash(key)).toBeLessThan(1);
    }
  });
});

describe('activityOf', () => {
  it('never moves a bike that is locked or in a yard, at any hour', () => {
    for (let hour = 0; hour < 24; hour += 1) {
      const at = new Date(Date.UTC(2026, 9, 12, hour));
      for (const b of fleet(200)) {
        expect(activityOf({ ...b, heldStill: true }, at)).toBe('parked');
      }
    }
  });

  it('gives the same answer for the whole 15 minute slot', () => {
    for (const b of fleet(100)) {
      const first = activityOf(b, new Date('2026-10-12T12:00:01Z'));
      expect(activityOf(b, new Date('2026-10-12T12:05:00Z'))).toBe(first);
      expect(activityOf(b, new Date('2026-10-12T12:14:59Z'))).toBe(first);
    }
  });

  it('puts roughly the daytime share on the road and a few offline', () => {
    const bikes = fleet(2000);
    const riding = bikes.filter((b) => activityOf(b, NOON) === 'riding').length;
    const offline = bikes.filter(
      (b) => activityOf(b, NOON) === 'offline',
    ).length;

    expect(riding / bikes.length).toBeGreaterThan(rideShareAt(12) - 0.08);
    expect(riding / bikes.length).toBeLessThan(rideShareAt(12) + 0.08);
    expect(offline / bikes.length).toBeGreaterThan(0.02);
    expect(offline / bikes.length).toBeLessThan(0.09);
  });

  it('keeps most bikes parked at night', () => {
    const bikes = fleet(2000);
    const at = new Date('2026-10-12T02:00:00Z');
    const riding = bikes.filter((b) => activityOf(b, at) === 'riding').length;
    expect(riding / bikes.length).toBeLessThan(0.1);
  });
});

describe('BikeMotion', () => {
  it('parked: reports a position that does not move, speed 0 and ignition off', () => {
    const start = NOON.getTime();
    const motion = new BikeMotion(bike(), 'parked', start);
    for (let i = 1; i <= 10; i += 1) {
      const record = motion.next(start + i * 60_000);
      expect(record.latitude).toBe(5.62);
      expect(record.longitude).toBe(-0.2);
      expect(record.speed).toBe(0);
      expect(record.ignition).toBe(false);
      expect(record.movement).toBe(false);
      expect(record.odometerMeters).toBe(1_000_000);
    }
  });

  it('riding: the odometer advances by the distance the speed implies, and the pack drains', () => {
    const start = NOON.getTime();
    const motion = new BikeMotion(bike(), 'riding', start);
    let previous = 1_000_000;
    let last = motion.next(start);

    for (let i = 1; i <= 30; i += 1) {
      last = motion.next(start + i * 20_000);
      const stepped = (last.odometerMeters ?? 0) - previous;
      previous = last.odometerMeters ?? 0;
      // 12 to 48 km/h over 20 s is 67 to 267 m.
      expect(stepped).toBeGreaterThanOrEqual(66);
      expect(stepped).toBeLessThanOrEqual(268);
      expect(last.ignition).toBe(true);
      expect(last.speed).toBeGreaterThanOrEqual(12);
    }

    expect(last.externalVoltageMv).toBeLessThan(50_000);
  });

  it('riding: stays near its town and out of the sea over a long ride', () => {
    for (const town of TOWNS) {
      const start = NOON.getTime();
      const motion = new BikeMotion(
        bike({
          bikeId: `rider-${town.name}`,
          latitude: town.lat + 0.01,
          longitude: town.lng,
        }),
        'riding',
        start,
      );

      for (let i = 1; i <= 2000; i += 1) {
        const record = motion.next(start + i * 20_000);
        const north = (record.latitude - town.lat) * 111_320;
        const east =
          (record.longitude - town.lng) *
          111_320 *
          Math.cos((town.lat * Math.PI) / 180);
        expect(Math.hypot(north, east)).toBeLessThan(7_000);
        if (town.minLat !== null) {
          expect(record.latitude).toBeGreaterThan(town.minLat - 0.002);
        }
      }
    }
  });

  it('never drains the pack below its floor or charges it past full', () => {
    const start = new Date('2026-10-12T23:00:00Z').getTime();
    const low = new BikeMotion(
      bike({ externalVoltageMv: 43_050 }),
      'riding',
      start,
    );
    const full = new BikeMotion(
      bike({ externalVoltageMv: 54_590 }),
      'parked',
      start,
    );

    for (let i = 1; i <= 50; i += 1) {
      expect(
        low.next(start + i * 20_000).externalVoltageMv,
      ).toBeGreaterThanOrEqual(43_000);
      expect(
        full.next(start + i * 60_000).externalVoltageMv,
      ).toBeLessThanOrEqual(54_600);
    }
  });
});

describe('nearestTown', () => {
  it('assigns a position to the town it is in', () => {
    expect(nearestTown({ lat: 6.7, lng: -1.6 }).name).toBe('Kumasi');
    expect(nearestTown({ lat: 4.9, lng: -1.76 }).name).toBe('Takoradi');
  });
});
