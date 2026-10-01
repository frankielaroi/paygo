import {
  formatDay,
  formatMoney,
  immobilizedText,
  lockoutWarningText,
  overdueReminderText,
  reminderText,
  restoredText,
  toMsisdn,
} from './messages';

const rider = { firstName: 'Kofi', bikeName: 'GR 1234-24' };
const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

/** GSM 7-bit basic set, minus the extension characters: what fits 160 per SMS. */
const GSM_SAFE = /^[A-Za-z0-9 .,:;!?'"()@#%&*+\-/=<>_$]*$/;

describe('formatMoney', () => {
  it.each([
    [5000, 'GHS 50.00'],
    [5, 'GHS 0.05'],
    [0, 'GHS 0.00'],
    [123456789, 'GHS 1,234,567.89'],
    [-2550, 'GHS -25.50'],
  ])('formats %s pesewas as %s', (minor, expected) => {
    expect(formatMoney(minor, 'GHS')).toBe(expected);
  });
});

describe('formatDay', () => {
  it('names the weekday, day and month of the UTC day', () => {
    expect(formatDay(day('2026-10-02'))).toBe('Fri 2 Oct');
    expect(formatDay(day('2027-01-31'))).toBe('Sun 31 Jan');
  });
});

describe('rider messages', () => {
  const messages = [
    reminderText(rider, 5000, 'GHS', day('2026-10-02')),
    lockoutWarningText(rider, 15000, 'GHS', day('2026-10-04')),
    immobilizedText(rider, {
      kind: 'arrears',
      overdueMinor: 15000,
      currency: 'GHS',
    }),
    immobilizedText(rider, { kind: 'staff' }),
    restoredText(rider, true),
    restoredText(rider, false),
    overdueReminderText(rider, 4500, 'GHS'),
  ];

  it('states the amount and the due date in a reminder', () => {
    expect(messages[0]).toBe(
      'Hi Kofi, GHS 50.00 for bike GR 1234-24 is due on Fri 2 Oct. Pay on time to keep riding.',
    );
  });

  it('gives the deadline and the consequence in a warning', () => {
    expect(messages[1]).toContain('GHS 150.00');
    expect(messages[1]).toContain('Pay by end of Sun 4 Oct');
    expect(messages[1]).toContain('immobilized');
  });

  it('says why a bike was immobilized', () => {
    expect(messages[2]).toContain('GHS 150.00 is overdue');
    expect(messages[3]).toContain('by PayGo');
  });

  it.each(messages.map((text, index) => [index, text]))(
    'keeps message %s within one SMS of plain GSM characters',
    (_index, text) => {
      expect(text.length).toBeLessThanOrEqual(160);
      expect(text).toMatch(GSM_SAFE);
    },
  );

  it('stays within one SMS for a long name and plate', () => {
    const long = { firstName: 'Kwabena-Ofori', bikeName: 'GW 12345-26' };
    expect(
      lockoutWarningText(long, 1234567, 'GHS', day('2026-10-04')).length,
    ).toBeLessThanOrEqual(160);
  });
});

describe('toMsisdn', () => {
  it.each([
    ['+233241234567', '233241234567'],
    ['0241234567', '233241234567'],
    ['024 123 4567', '233241234567'],
    ['00233241234567', '233241234567'],
    ['233241234567', '233241234567'],
    ['+2348012345678', '2348012345678'],
  ])('reads %s as %s', (input, expected) => {
    expect(toMsisdn(input)).toBe(expected);
  });

  it.each(['12345', '+23324123', 'not a phone', ''])('refuses %s', (input) => {
    expect(toMsisdn(input)).toBeNull();
  });
});
