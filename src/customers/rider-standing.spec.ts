import { riderStandingOf } from './rider-standing';

describe('riderStandingOf', () => {
  const overdue = new Map([['bike-late', 4500]]);

  it('is no-bike for a rider holding nothing, whatever they once owed', () => {
    expect(riderStandingOf([], overdue)).toBe('no-bike');
  });

  it('is overdue when any held bike owes past grace', () => {
    expect(riderStandingOf(['bike-ok', 'bike-late'], overdue)).toBe('overdue');
  });

  it('is active when every held bike is up to date', () => {
    expect(riderStandingOf(['bike-ok'], overdue)).toBe('active');
    expect(riderStandingOf(['bike-ok'], new Map([['bike-ok', 0]]))).toBe(
      'active',
    );
  });
});
