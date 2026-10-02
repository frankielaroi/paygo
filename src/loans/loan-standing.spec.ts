import { installmentStateOf, loanStandingOf } from './loan-standing';

describe('loanStandingOf', () => {
  it('splits an active loan by whether anything is owed past grace', () => {
    expect(loanStandingOf('ACTIVE', 0)).toBe('on-track');
    expect(loanStandingOf('ACTIVE', 1)).toBe('overdue');
  });

  it('follows the stored status once the loan is no longer active', () => {
    expect(loanStandingOf('COMPLETED', 0)).toBe('completed');
    // A defaulted loan usually owes past grace; it is still shown as defaulted.
    expect(loanStandingOf('DEFAULTED', 9000)).toBe('defaulted');
    expect(loanStandingOf('REPOSSESSED', 9000)).toBe('repossessed');
    expect(loanStandingOf('WRITTEN_OFF', 0)).toBe('written-off');
  });
});

describe('installmentStateOf', () => {
  const today = new Date('2026-10-10T15:30:00Z');
  const due = (day: string, paidMinor = 0) => ({
    dueDate: new Date(`${day}T00:00:00Z`),
    amountMinor: 4500,
    paidMinor,
  });

  it('is paid once covered in full, whatever the date', () => {
    expect(installmentStateOf(due('2026-10-01', 4500), 2, today)).toBe('paid');
    expect(installmentStateOf(due('2026-10-20', 4500), 2, today)).toBe('paid');
  });

  it('is upcoming before its due date and due today on it', () => {
    expect(installmentStateOf(due('2026-10-11'), 2, today)).toBe('upcoming');
    expect(installmentStateOf(due('2026-10-10'), 2, today)).toBe('due-today');
  });

  it('stays in grace until the grace days have fully passed', () => {
    // Due on the 8th with 2 grace days: overdue from the start of the 11th.
    expect(installmentStateOf(due('2026-10-08'), 2, today)).toBe('in-grace');
    expect(installmentStateOf(due('2026-10-07'), 2, today)).toBe('overdue');
  });

  it('is overdue the day after it was due when there is no grace', () => {
    expect(installmentStateOf(due('2026-10-09'), 0, today)).toBe('overdue');
  });

  it('counts a part-paid installment as unpaid', () => {
    expect(installmentStateOf(due('2026-10-07', 2000), 2, today)).toBe(
      'overdue',
    );
  });
});
