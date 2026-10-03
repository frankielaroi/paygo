import { addDays, utcDay } from './schedule';

/**
 * Where a loan stands today, as staff talk about it. The stored status says how the loan was
 * left (active, completed, defaulted, repossessed, written off); an active loan is further
 * split by whether anything is owed past grace. That split uses the same overdue amount as enforcement, the
 * dashboard's overdue queue and a rider's standing, so they can never disagree. Never stored.
 */
export type LoanStanding =
  | 'on-track'
  | 'overdue'
  | 'completed'
  | 'defaulted'
  | 'repossessed'
  | 'written-off';

export const LOAN_STANDINGS: readonly LoanStanding[] = [
  'on-track',
  'overdue',
  'completed',
  'defaulted',
  'repossessed',
  'written-off',
];

type StoredStatus =
  'ACTIVE' | 'COMPLETED' | 'DEFAULTED' | 'REPOSSESSED' | 'WRITTEN_OFF';

/** @param overdueMinor minor units owed past grace; only matters while the loan is active */
export function loanStandingOf(
  status: StoredStatus,
  overdueMinor: number,
): LoanStanding {
  switch (status) {
    case 'COMPLETED':
      return 'completed';
    case 'DEFAULTED':
      return 'defaulted';
    case 'REPOSSESSED':
      return 'repossessed';
    case 'WRITTEN_OFF':
      return 'written-off';
    default:
      return overdueMinor > 0 ? 'overdue' : 'on-track';
  }
}

/**
 * One installment at a glance. `in-grace` is past its due date but not yet overdue: the grace
 * days have not run out, so nothing is enforced for it yet.
 */
export type InstallmentState =
  'paid' | 'overdue' | 'in-grace' | 'due-today' | 'upcoming';

export function installmentStateOf(
  installment: { dueDate: Date; amountMinor: number; paidMinor: number },
  graceDays: number,
  asOf: Date,
): InstallmentState {
  if (installment.paidMinor >= installment.amountMinor) {
    return 'paid';
  }
  const today = utcDay(asOf).getTime();
  const due = utcDay(installment.dueDate).getTime();
  if (due > today) {
    return 'upcoming';
  }
  if (due === today) {
    return 'due-today';
  }
  // The same rule as overdueMinor: overdue once the due date plus grace has fully passed.
  return addDays(installment.dueDate, graceDays).getTime() < today
    ? 'overdue'
    : 'in-grace';
}
