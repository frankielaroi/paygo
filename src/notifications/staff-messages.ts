/**
 * Text of the SMS alerts sent to staff, as pure functions so the wording is tested directly.
 * Same rules as rider messages: short, plain ASCII, one SMS part where possible.
 */

/** Plates listed in an overdue digest before the rest are counted as "+N more". */
const DIGEST_PLATES = 5;

const time = (at: Date): string =>
  `${String(at.getUTCHours()).padStart(2, '0')}:${String(at.getUTCMinutes()).padStart(2, '0')}`;

const withRider = (bikeName: string, rider: string | null): string =>
  rider ? `${bikeName} (${rider})` : bikeName;

/** `lastReportedAt` is shown in UTC, which is Ghana time all year. */
export function bikeOfflineText(
  bikeName: string,
  rider: string | null,
  lastReportedAt: Date,
): string {
  return `Bike ${withRider(bikeName, rider)} stopped reporting. Last heard from at ${time(lastReportedAt)}.`;
}

export function zoneExitText(
  bikeName: string,
  rider: string | null,
  zoneName: string,
): string {
  return `Bike ${withRider(bikeName, rider)} has left ${zoneName}.`;
}

/** One message a day for all the loans that became overdue, however many there are. */
export function overdueDigestText(bikeNames: string[]): string {
  const count = bikeNames.length;
  const listed = bikeNames.slice(0, DIGEST_PLATES).join(', ');
  const more = count > DIGEST_PLATES ? `, +${count - DIGEST_PLATES} more` : '';
  return `${count} ${count === 1 ? 'loan' : 'loans'} became overdue today: ${listed}${more}.`;
}
