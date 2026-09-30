/**
 * Rider message text, as pure functions so the wording, amounts and dates are tested directly.
 * Kept short: one SMS is 160 GSM characters, and every extra part costs money and can arrive out
 * of order. Plain ASCII only, since a single non-GSM character halves the length of every part.
 */

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** 5000 GHS minor units -> "GHS 50.00". Integer arithmetic only; no floating point. */
export function formatMoney(minor: number, currency: string): string {
  const sign = minor < 0 ? '-' : '';
  const absolute = Math.abs(minor);
  const whole = Math.floor(absolute / 100).toLocaleString('en-GB');
  const cents = String(absolute % 100).padStart(2, '0');
  return `${currency} ${sign}${whole}.${cents}`;
}

/** A UTC calendar day as "Fri 2 Oct". */
export function formatDay(day: Date): string {
  return `${DAYS[day.getUTCDay()]} ${day.getUTCDate()} ${MONTHS[day.getUTCMonth()]}`;
}

export interface RiderContext {
  firstName: string;
  /** Plate if registered, otherwise the fleet label. */
  bikeName: string;
}

export function reminderText(
  rider: RiderContext,
  amountMinor: number,
  currency: string,
  dueDate: Date,
): string {
  return (
    `Hi ${rider.firstName}, ${formatMoney(amountMinor, currency)} for bike ` +
    `${rider.bikeName} is due on ${formatDay(dueDate)}. Pay on time to keep riding.`
  );
}

/**
 * The pre-lockout warning. States the amount, the last day to pay, and the consequence, and
 * tells a rider who has just paid to ignore it, since a payment can cross with the message.
 */
export function lockoutWarningText(
  rider: RiderContext,
  amountMinor: number,
  currency: string,
  payBy: Date,
): string {
  return (
    `Hi ${rider.firstName}, ${formatMoney(amountMinor, currency)} is due on bike ` +
    `${rider.bikeName}. Pay by end of ${formatDay(payBy)} or the bike will be ` +
    `immobilized. Already paid? Ignore this.`
  );
}

/** Why the bike was locked, in words the rider can act on. */
export function immobilizedText(
  rider: RiderContext,
  reason:
    | { kind: 'arrears'; overdueMinor: number; currency: string }
    | { kind: 'staff' },
): string {
  if (reason.kind === 'staff') {
    return (
      `Hi ${rider.firstName}, bike ${rider.bikeName} has been immobilized by PayGo. ` +
      `Please contact us.`
    );
  }
  return (
    `Hi ${rider.firstName}, bike ${rider.bikeName} has been immobilized: ` +
    `${formatMoney(reason.overdueMinor, reason.currency)} is overdue. ` +
    `Pay now and it unlocks automatically.`
  );
}

export function restoredText(
  rider: RiderContext,
  afterPayment: boolean,
): string {
  return afterPayment
    ? `Hi ${rider.firstName}, thank you for your payment. Bike ${rider.bikeName} is unlocked. Ride safe.`
    : `Hi ${rider.firstName}, bike ${rider.bikeName} is unlocked and ready to ride.`;
}

/**
 * A rider number in the international form Arkesel expects (233XXXXXXXXX), or null if it cannot
 * be one. Local Ghanaian numbers (0XXXXXXXXX) gain the 233 prefix.
 */
export function toMsisdn(phone: string): string | null {
  const compact = phone.replace(/[\s\-().]/g, '');
  const digits = compact.startsWith('+')
    ? compact.slice(1)
    : compact.startsWith('00')
      ? compact.slice(2)
      : compact.startsWith('0')
        ? `233${compact.slice(1)}`
        : compact;
  return /^\d{11,15}$/.test(digits) ? digits : null;
}
