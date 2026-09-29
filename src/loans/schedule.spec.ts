import {
  addDays,
  allocatePayment,
  generateSchedule,
  type InstallmentBalance,
  MAX_INSTALLMENTS,
  overdueMinor,
} from './schedule';

const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

describe('generateSchedule', () => {
  it('spaces daily installments one day apart and ends on the last due date', () => {
    const schedule = generateSchedule({
      principalMinor: 3000_00,
      installmentMinor: 100_00,
      frequency: 'DAILY',
      firstDueDate: day('2026-10-01'),
    });

    expect(schedule).toHaveLength(30);
    expect(schedule[0]).toEqual({
      sequence: 1,
      dueDate: day('2026-10-01'),
      amountMinor: 100_00,
    });
    expect(schedule.at(-1)?.dueDate).toEqual(day('2026-10-30'));
  });

  it('spaces weekly installments seven days apart', () => {
    const schedule = generateSchedule({
      principalMinor: 1200_00,
      installmentMinor: 100_00,
      frequency: 'WEEKLY',
      firstDueDate: day('2026-10-05'),
    });

    expect(schedule).toHaveLength(12);
    expect(schedule[1]?.dueDate).toEqual(day('2026-10-12'));
    expect(schedule.at(-1)?.dueDate).toEqual(addDays(day('2026-10-05'), 77));
  });

  it('makes the last installment the remainder, so the schedule sums to the principal exactly', () => {
    const schedule = generateSchedule({
      principalMinor: 1000_50,
      installmentMinor: 300_00,
      frequency: 'WEEKLY',
      firstDueDate: day('2026-10-05'),
    });

    expect(schedule.map((row) => row.amountMinor)).toEqual([
      300_00, 300_00, 300_00, 100_50,
    ]);
    expect(schedule.reduce((sum, row) => sum + row.amountMinor, 0)).toBe(
      1000_50,
    );
  });

  it('crosses a month and a year end on calendar days', () => {
    const schedule = generateSchedule({
      principalMinor: 300,
      installmentMinor: 100,
      frequency: 'DAILY',
      firstDueDate: day('2026-12-31'),
    });

    expect(schedule.map((row) => row.dueDate)).toEqual([
      day('2026-12-31'),
      day('2027-01-01'),
      day('2027-01-02'),
    ]);
  });

  it('ignores the time of day on the first due date', () => {
    const [first] = generateSchedule({
      principalMinor: 100,
      installmentMinor: 100,
      frequency: 'DAILY',
      firstDueDate: new Date('2026-10-01T17:45:00.000Z'),
    });

    expect(first?.dueDate).toEqual(day('2026-10-01'));
  });

  it.each([
    ['a zero principal', 0, 100],
    ['a negative installment', 1000, -5],
    ['a fractional amount', 1000.5, 100],
    ['an installment larger than the principal', 100, 200],
  ])('refuses %s', (_label, principalMinor, installmentMinor) => {
    expect(() =>
      generateSchedule({
        principalMinor,
        installmentMinor,
        frequency: 'DAILY',
        firstDueDate: day('2026-10-01'),
      }),
    ).toThrow(RangeError);
  });

  it('refuses a schedule longer than the maximum', () => {
    expect(() =>
      generateSchedule({
        principalMinor: MAX_INSTALLMENTS + 1,
        installmentMinor: 1,
        frequency: 'DAILY',
        firstDueDate: day('2026-10-01'),
      }),
    ).toThrow(/maximum/);
  });
});

describe('allocatePayment', () => {
  const unpaid = (): InstallmentBalance[] => [
    { id: 'i1', sequence: 1, amountMinor: 100_00, paidMinor: 0 },
    { id: 'i2', sequence: 2, amountMinor: 100_00, paidMinor: 0 },
    { id: 'i3', sequence: 3, amountMinor: 50_00, paidMinor: 0 },
  ];

  it('covers exactly the next installment with an exact payment', () => {
    expect(allocatePayment(unpaid(), 100_00)).toEqual({
      allocations: [{ installmentId: 'i1', amountMinor: 100_00 }],
      leftoverMinor: 0,
    });
  });

  it('puts a partial payment on the oldest installment without covering it', () => {
    expect(allocatePayment(unpaid(), 40_00)).toEqual({
      allocations: [{ installmentId: 'i1', amountMinor: 40_00 }],
      leftoverMinor: 0,
    });
  });

  it('finishes a part-paid installment before starting the next', () => {
    const installments = unpaid();
    installments[0] = { ...installments[0], paidMinor: 40_00 };

    expect(allocatePayment(installments, 100_00)).toEqual({
      allocations: [
        { installmentId: 'i1', amountMinor: 60_00 },
        { installmentId: 'i2', amountMinor: 40_00 },
      ],
      leftoverMinor: 0,
    });
  });

  it('spreads an overpayment across future installments', () => {
    expect(allocatePayment(unpaid(), 150_00).allocations).toEqual([
      { installmentId: 'i1', amountMinor: 100_00 },
      { installmentId: 'i2', amountMinor: 50_00 },
    ]);
  });

  it('returns anything beyond the whole loan as leftover, never absorbing it', () => {
    expect(allocatePayment(unpaid(), 300_00)).toEqual({
      allocations: [
        { installmentId: 'i1', amountMinor: 100_00 },
        { installmentId: 'i2', amountMinor: 100_00 },
        { installmentId: 'i3', amountMinor: 50_00 },
      ],
      leftoverMinor: 50_00,
    });
  });

  it('allocates in sequence order whatever order the rows arrive in', () => {
    expect(
      allocatePayment([...unpaid()].reverse(), 100_00).allocations,
    ).toEqual([{ installmentId: 'i1', amountMinor: 100_00 }]);
  });

  it.each([0, -1, 10.5])('refuses a payment of %s', (amount) => {
    expect(() => allocatePayment(unpaid(), amount)).toThrow(RangeError);
  });
});

describe('overdueMinor', () => {
  const schedule = [
    { dueDate: day('2026-10-10'), amountMinor: 100_00 },
    { dueDate: day('2026-10-11'), amountMinor: 100_00 },
  ];

  it('is not overdue on the due date itself', () => {
    expect(overdueMinor(schedule, 0, 0, day('2026-10-10'))).toBe(0);
  });

  it('is overdue the day after the due date with no grace', () => {
    expect(overdueMinor(schedule, 0, 0, day('2026-10-11'))).toBe(100_00);
  });

  it('is not overdue until the grace days have fully passed', () => {
    // Due on the 10th with 2 grace days: still fine through the 12th, overdue from the 13th.
    expect(overdueMinor(schedule, 0, 2, new Date('2026-10-12T23:59:59Z'))).toBe(
      0,
    );
    expect(overdueMinor(schedule, 0, 2, day('2026-10-13'))).toBe(100_00);
  });

  it('is cleared by an exact payment of what fell due', () => {
    expect(overdueMinor(schedule, 100_00, 0, day('2026-10-11'))).toBe(0);
  });

  it('is reduced but not cleared by a partial payment', () => {
    expect(overdueMinor(schedule, 99_99, 0, day('2026-10-11'))).toBe(1);
  });

  it('counts every installment that has fallen due', () => {
    expect(overdueMinor(schedule, 50_00, 0, day('2026-10-20'))).toBe(150_00);
  });

  it('never goes negative when the rider has paid ahead', () => {
    expect(overdueMinor(schedule, 500_00, 0, day('2026-10-20'))).toBe(0);
  });
});
