import {
  deferralText,
  fleetStatusOf,
  mobilityControlsOf,
} from './fleet-status';

const healthy = {
  confirmedState: 'MOBILE' as const,
  online: true,
  overdueMinor: 0,
};

describe('fleetStatusOf', () => {
  it('is active when online, mobile and paid up', () => {
    expect(fleetStatusOf(healthy)).toBe('active');
  });

  it('is overdue when the loan owes past grace', () => {
    expect(fleetStatusOf({ ...healthy, overdueMinor: 4500 })).toBe('overdue');
  });

  it('is offline when the tracker is not reporting, even if overdue', () => {
    expect(
      fleetStatusOf({ ...healthy, online: false, overdueMinor: 4500 }),
    ).toBe('offline');
  });

  it('is immobilized when the device confirmed it, whatever else is true', () => {
    expect(
      fleetStatusOf({
        confirmedState: 'IMMOBILIZED',
        online: false,
        overdueMinor: 9000,
      }),
    ).toBe('immobilized');
  });

  it('does not call a bike immobilized on a lock that is only requested', () => {
    expect(fleetStatusOf({ ...healthy, confirmedState: null })).toBe('active');
  });
});

describe('deferralText', () => {
  it('explains interlock reasons in plain words', () => {
    expect(deferralText('interlock:moving')).toBe('Bike in motion');
    expect(deferralText('interlock:stale-telemetry')).toBe(
      'Position data too old',
    );
  });

  it('passes an unknown reason through rather than hiding it', () => {
    expect(deferralText('something-new')).toBe('something-new');
  });
});

describe('mobilityControlsOf', () => {
  const facts = {
    canImmobilize: true,
    online: true,
    desiredState: 'MOBILE' as const,
    confirmedState: 'MOBILE' as const,
  };

  it('offers a lock on a reachable, running bike', () => {
    expect(mobilityControlsOf(facts)).toEqual({
      canLock: true,
      canUnlock: false,
      lockPending: false,
    });
  });

  // Nothing is sent to a bike that is not reporting, so a lock could only wait.
  it('offers no lock on an offline bike', () => {
    expect(mobilityControlsOf({ ...facts, online: false }).canLock).toBe(false);
  });

  it('shows a requested lock as pending until the device confirms it', () => {
    expect(
      mobilityControlsOf({ ...facts, desiredState: 'IMMOBILIZED' }),
    ).toEqual({ canLock: false, canUnlock: true, lockPending: true });
    expect(
      mobilityControlsOf({
        ...facts,
        desiredState: 'IMMOBILIZED',
        confirmedState: 'IMMOBILIZED',
      }),
    ).toEqual({ canLock: false, canUnlock: true, lockPending: false });
  });

  it('offers nothing to a viewer who may not immobilize', () => {
    expect(
      mobilityControlsOf({
        ...facts,
        canImmobilize: false,
        desiredState: 'IMMOBILIZED',
      }),
    ).toEqual({ canLock: false, canUnlock: false, lockPending: true });
  });
});
