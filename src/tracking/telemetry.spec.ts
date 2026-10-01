import {
  batteryPercentOf,
  odometerKmOf,
  powerAndOdometerOf,
  TELTONIKA_IO,
} from './telemetry';

describe('powerAndOdometerOf', () => {
  it('reads external voltage and total odometer from the IO values', () => {
    expect(
      powerAndOdometerOf({
        [TELTONIKA_IO.EXTERNAL_VOLTAGE]: 51200,
        [TELTONIKA_IO.TOTAL_ODOMETER]: 3_120_400,
        239: 1,
      }),
    ).toEqual({ externalVoltageMv: 51200, odometerMeters: 3_120_400 });
  });

  // Missing means "not reported", which must not read as an empty battery.
  it('gives null for properties the device did not send', () => {
    expect(powerAndOdometerOf({ 239: 1 })).toEqual({
      externalVoltageMv: null,
      odometerMeters: null,
    });
  });

  it('keeps a genuine zero', () => {
    expect(
      powerAndOdometerOf({ [TELTONIKA_IO.TOTAL_ODOMETER]: 0 }).odometerMeters,
    ).toBe(0);
  });
});

describe('batteryPercentOf', () => {
  const EMPTY = 42000;
  const FULL = 54600;

  it.each([
    [42000, 0],
    [48300, 50],
    [54600, 100],
    [51450, 75],
  ])('%i mV is %i%%', (mv, percent) => {
    expect(batteryPercentOf(mv, EMPTY, FULL)).toBe(percent);
  });

  it('clamps readings outside the range', () => {
    expect(batteryPercentOf(30000, EMPTY, FULL)).toBe(0);
    expect(batteryPercentOf(58000, EMPTY, FULL)).toBe(100);
  });

  it('is null without a reading', () => {
    expect(batteryPercentOf(null, EMPTY, FULL)).toBeNull();
  });
});

describe('odometerKmOf', () => {
  it('converts metres to kilometres with one decimal', () => {
    expect(odometerKmOf(3_120_449)).toBe(3120.4);
    expect(odometerKmOf(null)).toBeNull();
  });
});
