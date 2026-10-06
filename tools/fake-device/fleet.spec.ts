import { scenarioFromTelemetry, toFleetDevices, type FleetRow } from './fleet';

/**
 * The mapping from bike records to simulated devices. No database: the point of keeping
 * `fleet.ts` free of Prisma is that these cases can be written as literals.
 */

const position = (
  overrides: Partial<NonNullable<FleetRow['currentPosition']>> = {},
): NonNullable<FleetRow['currentPosition']> => ({
  latitude: 5.6037,
  longitude: -0.187,
  hasFix: true,
  speed: 0,
  ignition: false,
  movement: false,
  ...overrides,
});

const bike = (overrides: Partial<FleetRow> = {}): FleetRow => ({
  imei: '356892080000001',
  label: 'Bike 1',
  currentPosition: position(),
  ...overrides,
});

const mappingOptions = {
  fallbackLatitude: -1.2921,
  fallbackLongitude: 36.8219,
};

describe('scenarioFromTelemetry', () => {
  it('is stationary for a bike that has never reported', () => {
    expect(scenarioFromTelemetry(null)).toBe('stationary');
  });

  it('is stationary when stopped with the ignition off', () => {
    expect(scenarioFromTelemetry(position())).toBe('stationary');
  });

  it('is moving when the bike was rolling', () => {
    expect(scenarioFromTelemetry(position({ speed: 35 }))).toBe('moving');
  });

  // The reason this is not "stationary": ignition on is exactly the reading that must stop an
  // immobilize, and only the moving scenario reports ignition on. Mapping it to stationary would
  // feed the interlock a safe reading the bike never sent.
  it('is moving when stopped with the ignition on', () => {
    expect(scenarioFromTelemetry(position({ ignition: true }))).toBe('moving');
  });

  it('is moving when the device reported movement without speed', () => {
    expect(scenarioFromTelemetry(position({ movement: true }))).toBe('moving');
  });

  it('treats an unreported ignition as not running, not as unknown-is-unsafe', () => {
    expect(scenarioFromTelemetry(position({ ignition: null }))).toBe(
      'stationary',
    );
  });
});

describe('toFleetDevices', () => {
  it('uses each bike real IMEI and resumes from its last fix', () => {
    const { devices } = toFleetDevices(
      [
        bike({ imei: '356892080000001', label: 'Bike 1' }),
        bike({
          imei: '356892080000002',
          label: 'Bike 2',
          currentPosition: position({ latitude: 5.7, longitude: -0.2 }),
        }),
      ],
      mappingOptions,
    );

    expect(devices.map((d) => d.imei)).toEqual([
      '356892080000001',
      '356892080000002',
    ]);
    expect(devices[1].latitude).toBe(5.7);
    expect(devices[1].longitude).toBe(-0.2);
    expect(devices[1].derivedPosition).toBe(true);
  });

  it('falls back to the given coordinates when the last position had no fix', () => {
    const { devices } = toFleetDevices(
      [bike({ currentPosition: position({ hasFix: false }) })],
      mappingOptions,
    );

    expect(devices[0].latitude).toBe(mappingOptions.fallbackLatitude);
    expect(devices[0].longitude).toBe(mappingOptions.fallbackLongitude);
    expect(devices[0].derivedPosition).toBe(false);
  });

  // A 0/0 coordinate with no fix is the Gulf of Guinea; the parser already refuses to store it
  // as a position, and the simulator must not replay it as one either.
  it('does not place a bike at the stored coordinates of a fixless position', () => {
    const { devices } = toFleetDevices(
      [
        bike({
          currentPosition: position({
            hasFix: false,
            latitude: 0,
            longitude: 0,
          }),
        }),
      ],
      mappingOptions,
    );

    expect(devices[0].latitude).not.toBe(0);
  });

  it('spreads fixless bikes apart instead of stacking them on one point', () => {
    const { devices } = toFleetDevices(
      [
        bike({ imei: '356892080000001', currentPosition: null }),
        bike({ imei: '356892080000002', currentPosition: null }),
      ],
      mappingOptions,
    );

    expect(devices[0].latitude).not.toBe(devices[1].latitude);
  });

  it('derives a scenario per bike when none is forced', () => {
    const { devices } = toFleetDevices(
      [
        bike({ imei: '356892080000001', currentPosition: position() }),
        bike({
          imei: '356892080000002',
          currentPosition: position({ speed: 35 }),
        }),
      ],
      mappingOptions,
    );

    expect(devices.map((d) => d.scenario)).toEqual(['stationary', 'moving']);
    expect(devices.every((d) => d.derivedScenario)).toBe(true);
  });

  it('applies a forced scenario to every bike regardless of telemetry', () => {
    const { devices } = toFleetDevices(
      [
        bike({ imei: '356892080000001', currentPosition: position() }),
        bike({
          imei: '356892080000002',
          currentPosition: position({ speed: 35 }),
        }),
      ],
      { ...mappingOptions, forcedScenario: 'corrupt-crc' },
    );

    expect(devices.map((d) => d.scenario)).toEqual([
      'corrupt-crc',
      'corrupt-crc',
    ]);
    expect(devices.every((d) => d.derivedScenario)).toBe(false);
  });

  it('skips a bike with no IMEI and says why', () => {
    const { devices, skipped } = toFleetDevices(
      [bike({ imei: null, label: 'Bike 9' })],
      mappingOptions,
    );

    expect(devices).toHaveLength(0);
    expect(skipped).toEqual([{ label: 'Bike 9', reason: 'no tracker IMEI' }]);
  });

  it('skips an IMEI the handshake would be rejected for', () => {
    const { devices, skipped } = toFleetDevices(
      [bike({ imei: 'not-digits', label: 'Bike 9' })],
      mappingOptions,
    );

    expect(devices).toHaveLength(0);
    expect(skipped[0].reason).toContain('not 8 to 17 digits');
  });

  // Two devices on one IMEI would make the server's socket replacement look like a bug: the
  // second handshake legitimately displaces the first.
  it('simulates a repeated IMEI only once', () => {
    const { devices, skipped } = toFleetDevices(
      [
        bike({ imei: '356892080000001', label: 'Bike 1' }),
        bike({ imei: '356892080000001', label: 'Bike 2' }),
      ],
      mappingOptions,
    );

    expect(devices).toHaveLength(1);
    expect(skipped[0]).toEqual({
      label: 'Bike 2',
      reason: 'IMEI 356892080000001 already simulated',
    });
  });

  it('trims surrounding whitespace from a stored IMEI', () => {
    const { devices } = toFleetDevices(
      [bike({ imei: ' 356892080000001 ' })],
      mappingOptions,
    );

    expect(devices[0].imei).toBe('356892080000001');
  });
});
