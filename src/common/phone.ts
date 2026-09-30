/**
 * Every form a phone number may have been stored in. Staff and rider numbers are saved as
 * entered, with only spaces, dashes, dots and brackets removed, so one Ghanaian number can
 * exist as 0241234567, 233241234567, +233241234567 or 00233241234567. Match on all of them.
 */
export function phoneLookupForms(input: string): string[] {
  const compact = input.replace(/[\s\-().]/g, '');
  const international = compact.startsWith('+')
    ? compact.slice(1)
    : compact.startsWith('00')
      ? compact.slice(2)
      : compact.startsWith('0')
        ? `233${compact.slice(1)}`
        : compact;

  const forms = new Set([compact]);
  if (/^\d{11,15}$/.test(international)) {
    forms.add(international);
    forms.add(`+${international}`);
    forms.add(`00${international}`);
    if (international.startsWith('233')) {
      forms.add(`0${international.slice(3)}`);
    }
  }
  return [...forms];
}
