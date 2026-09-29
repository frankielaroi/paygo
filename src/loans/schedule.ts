/**
 * Pure loan arithmetic: the schedule, how a payment is split across it, and what is overdue.
 * No database, no clock, no floating point: every amount is an integer in minor units, and every
 * date is a UTC calendar day (Ghana keeps GMT all year, so a UTC day is the local business day).
 * Everything that decides money lives here so it can be tested with explicit numbers.
 */

export type Frequency = 'DAILY' | 'WEEKLY';

const DAYS_PER_PERIOD: Record<Frequency, number> = { DAILY: 1, WEEKLY: 7 };
const MS_PER_DAY = 86_400_000;

/** Longest schedule accepted: ten years of daily payments. Beyond that the terms are a typo. */
export const MAX_INSTALLMENTS = 3650;

export interface ScheduleTerms {
  /** Amount repaid through installments, in minor units. */
  principalMinor: number;
  installmentMinor: number;
  frequency: Frequency;
  /** UTC calendar day of the first installment. */
  firstDueDate: Date;
}

export interface ScheduledInstallment {
  sequence: number;
  dueDate: Date;
  amountMinor: number;
}

/** Midnight UTC of the day `date` falls on. */
export function utcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

export function addDays(day: Date, days: number): Date {
  return new Date(utcDay(day).getTime() + days * MS_PER_DAY);
}

/**
 * The full schedule, generated once when the loan starts. Every installment is the agreed amount
 * except the last, which is whatever remains, so the schedule always sums to the principal
 * exactly and never asks for a pesewa more.
 */
export function generateSchedule(terms: ScheduleTerms): ScheduledInstallment[] {
  const { principalMinor, installmentMinor } = terms;

  if (!Number.isSafeInteger(principalMinor) || principalMinor <= 0) {
    throw new RangeError('principalMinor must be a positive integer');
  }
  if (!Number.isSafeInteger(installmentMinor) || installmentMinor <= 0) {
    throw new RangeError('installmentMinor must be a positive integer');
  }
  if (installmentMinor > principalMinor) {
    throw new RangeError('installmentMinor cannot exceed principalMinor');
  }

  const count = Math.ceil(principalMinor / installmentMinor);
  if (count > MAX_INSTALLMENTS) {
    throw new RangeError(
      `Schedule would have ${count} installments; the maximum is ${MAX_INSTALLMENTS}`,
    );
  }

  const step = DAYS_PER_PERIOD[terms.frequency];
  const first = utcDay(terms.firstDueDate);

  return Array.from({ length: count }, (_, index) => ({
    sequence: index + 1,
    dueDate: addDays(first, index * step),
    amountMinor:
      index === count - 1
        ? principalMinor - installmentMinor * (count - 1)
        : installmentMinor,
  }));
}

export interface InstallmentBalance {
  id: string;
  sequence: number;
  amountMinor: number;
  paidMinor: number;
}

export interface Allocation {
  installmentId: string;
  amountMinor: number;
}

/**
 * Splits a payment across the schedule, oldest unpaid installment first. Whatever is left after
 * every installment is covered is returned as `leftoverMinor`: money the rider paid beyond the
 * whole loan, which is owed back to them, never silently absorbed.
 */
export function allocatePayment(
  installments: InstallmentBalance[],
  amountMinor: number,
): { allocations: Allocation[]; leftoverMinor: number } {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new RangeError('A payment must be a positive integer amount');
  }

  let remaining = amountMinor;
  const allocations: Allocation[] = [];

  for (const installment of [...installments].sort(
    (a, b) => a.sequence - b.sequence,
  )) {
    if (remaining === 0) {
      break;
    }
    const owing = installment.amountMinor - installment.paidMinor;
    if (owing <= 0) {
      continue;
    }
    const applied = Math.min(owing, remaining);
    allocations.push({ installmentId: installment.id, amountMinor: applied });
    remaining -= applied;
  }

  return { allocations, leftoverMinor: remaining };
}

export interface DueInstallment {
  dueDate: Date;
  amountMinor: number;
}

/**
 * The catch-up rule, in one place. An installment is overdue once its due date plus the grace
 * days has fully passed: with 2 grace days, an installment due on the 10th is overdue from the
 * start of the 13th. Payments count oldest-first, so the amount overdue is what fell due (past
 * grace) minus everything paid, floored at zero.
 *
 * A partial payment reduces the amount overdue but does not clear it: the loan is current only
 * when this returns 0. There is no tolerance and no "one installment behind" allowance.
 */
export function overdueMinor(
  schedule: DueInstallment[],
  totalPaidMinor: number,
  graceDays: number,
  asOf: Date,
): number {
  const today = utcDay(asOf);
  const fellDue = schedule
    .filter((installment) => addDays(installment.dueDate, graceDays) < today)
    .reduce((sum, installment) => sum + installment.amountMinor, 0);

  return Math.max(0, fellDue - totalPaidMinor);
}
