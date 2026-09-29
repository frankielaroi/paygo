import type {
  SafetyReading,
  TrackingSafetySnapshot,
} from '../tracking/tracking.service';
import { checkLatest, checkSustained, windowStart } from './interlock';

const now = new Date('2026-09-29T12:00:00.000Z');
const settings = { stationarySeconds: 120, maxTelemetryAgeSeconds: 300 };
const connectedSince = new Date('2026-09-29T11:00:00.000Z');

function secondsAgo(seconds: number): Date {
  return new Date(now.getTime() - seconds * 1000);
}

const stopped: TrackingSafetySnapshot = {
  bikeId: 'bike-1',
  speed: 0,
  ignition: false,
  movement: false,
  hasFix: true,
  recordedAt: secondsAgo(10),
  receivedAt: secondsAgo(9),
  lastReportedAt: secondsAgo(9),
  online: true,
};

function reading(overrides: Partial<SafetyReading> = {}): SafetyReading {
  return {
    recordedAt: secondsAgo(60),
    speed: 0,
    ignition: false,
    movement: false,
    hasFix: true,
    ...overrides,
  };
}

describe('checkLatest', () => {
  it('passes a fresh, fixed, stopped reading with ignition off', () => {
    expect(checkLatest(stopped, now, settings, connectedSince)).toEqual({
      safe: true,
    });
  });

  it.each([
    ['a moving bike', { speed: 12 }, 'moving'],
    [
      'a bike whose accelerometer reports movement',
      { movement: true },
      'moving',
    ],
    ['ignition on', { ignition: true }, 'ignition-on'],
    ['ignition not reported', { ignition: null }, 'ignition-unknown'],
    [
      'no GPS fix, where speed 0 is no measurement',
      { hasFix: false },
      'no-gps-fix',
    ],
    ['an offline tracker', { online: false }, 'offline'],
    [
      'a reading older than the maximum age',
      { recordedAt: secondsAgo(301) },
      'stale-telemetry',
    ],
  ] as const)('refuses %s', (_label, overrides, reason) => {
    expect(
      checkLatest({ ...stopped, ...overrides }, now, settings, connectedSince),
    ).toMatchObject({ safe: false, reason });
  });

  it('refuses when there is no telemetry at all, and asks for review', () => {
    expect(checkLatest(null, now, settings, connectedSince)).toEqual({
      safe: false,
      reason: 'no-telemetry',
      needsReview: true,
    });
  });

  it('asks for review when the data is stale or offline, not when the bike is moving', () => {
    const stale = checkLatest(
      { ...stopped, recordedAt: secondsAgo(900) },
      now,
      settings,
      connectedSince,
    );
    const moving = checkLatest(
      { ...stopped, speed: 30 },
      now,
      settings,
      connectedSince,
    );

    expect(stale).toMatchObject({ needsReview: true });
    expect(moving).toMatchObject({ needsReview: false });
  });

  it('refuses a stopped reading received before the current connection', () => {
    expect(checkLatest(stopped, now, settings, secondsAgo(5))).toMatchObject({
      safe: false,
      reason: 'awaiting-fresh-telemetry',
    });
  });
});

describe('checkSustained', () => {
  it('passes when the anchor and every reading since are stopped', () => {
    expect(
      checkSustained({
        anchor: reading({ recordedAt: secondsAgo(200) }),
        readings: [reading(), reading({ recordedAt: secondsAgo(10) })],
      }),
    ).toEqual({ safe: true });
  });

  it('refuses a bike with no reading as old as the window, one that has only just stopped', () => {
    expect(
      checkSustained({ anchor: null, readings: [reading()] }),
    ).toMatchObject({ safe: false, reason: 'not-sustained' });
  });

  it.each([
    ['moved', { speed: 8 }],
    ['had ignition on', { ignition: true }],
    ['had unknown ignition', { ignition: null }],
    ['lost its fix', { hasFix: false }],
  ] as const)(
    'refuses a bike that %s inside the window',
    (_label, overrides) => {
      expect(
        checkSustained({
          anchor: reading({ recordedAt: secondsAgo(200) }),
          readings: [
            reading(overrides),
            reading({ recordedAt: secondsAgo(10) }),
          ],
        }),
      ).toMatchObject({ safe: false, reason: 'not-sustained' });
    },
  );

  it('refuses when the anchor itself was not stopped', () => {
    expect(
      checkSustained({
        anchor: reading({ recordedAt: secondsAgo(200), speed: 20 }),
        readings: [],
      }),
    ).toMatchObject({ safe: false, reason: 'not-sustained' });
  });

  it('opens the window the configured time before the latest reading', () => {
    expect(windowStart(stopped, settings)).toEqual(secondsAgo(130));
  });
});
