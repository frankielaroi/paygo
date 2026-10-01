import { phoneLookupForms } from './phone';

describe('phoneLookupForms', () => {
  const GHANA_FORMS = [
    '0241234567',
    '233241234567',
    '+233241234567',
    '00233241234567',
  ];

  it.each(GHANA_FORMS)('finds every stored form of %s', (input) => {
    expect(phoneLookupForms(input).sort()).toEqual([...GHANA_FORMS].sort());
  });

  it('ignores spaces, dashes, dots and brackets', () => {
    expect(phoneLookupForms('(024) 123-45.67')).toContain('+233241234567');
  });

  it('keeps a foreign number in its international forms only', () => {
    expect(phoneLookupForms('+447700900123').sort()).toEqual(
      ['447700900123', '+447700900123', '00447700900123'].sort(),
    );
  });

  it('matches a number too short to be international exactly as given', () => {
    expect(phoneLookupForms('241234567')).toEqual(['241234567']);
  });
});
