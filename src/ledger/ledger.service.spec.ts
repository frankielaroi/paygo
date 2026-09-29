import type { Prisma } from '../generated/prisma/client';
import {
  LedgerAccount,
  LedgerTransactionType,
} from '../generated/prisma/enums';
import { type LedgerLine, LedgerService } from './ledger.service';

type CreateArgs = {
  data: {
    entries: {
      create: Array<{
        debitMinor: number;
        creditMinor: number;
        account: string;
      }>;
    };
  };
};

function fakeDb() {
  const create = jest.fn<Promise<{ id: string }>, [CreateArgs]>(() =>
    Promise.resolve({ id: 'txn-1' }),
  );
  return {
    create,
    db: {
      ledgerTransaction: { create },
      ledgerEntry: {},
    } as unknown as Pick<
      Prisma.TransactionClient,
      'ledgerTransaction' | 'ledgerEntry'
    >,
  };
}

function post(lines: LedgerLine[]) {
  const { db, create } = fakeDb();
  const result = new LedgerService().post(db, {
    type: LedgerTransactionType.PAYMENT_RECEIVED,
    description: 'test',
    currency: 'GHS',
    lines,
  });
  return { result, create };
}

describe('LedgerService.post', () => {
  it('writes a balanced posting', async () => {
    const { result, create } = post([
      { account: LedgerAccount.PROVIDER_CLEARING, debitMinor: 150_00 },
      { account: LedgerAccount.LOAN_RECEIVABLE, creditMinor: 100_00 },
      { account: LedgerAccount.RIDER_CREDIT, creditMinor: 50_00 },
    ]);

    await expect(result).resolves.toBe('txn-1');
    expect(create.mock.calls[0]?.[0].data.entries.create).toHaveLength(3);
  });

  it('refuses a posting whose debits and credits differ, and writes nothing', async () => {
    const { result, create } = post([
      { account: LedgerAccount.PROVIDER_CLEARING, debitMinor: 100_00 },
      { account: LedgerAccount.LOAN_RECEIVABLE, creditMinor: 99_99 },
    ]);

    await expect(result).rejects.toThrow(/Unbalanced/);
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    ['both sides on one line', { debitMinor: 5, creditMinor: 5 }],
    ['a negative amount', { debitMinor: -5 }],
    ['a fractional amount', { debitMinor: 0.5 }],
  ])('refuses %s', async (_label, bad) => {
    const { result, create } = post([
      { account: LedgerAccount.PROVIDER_CLEARING, ...bad },
      { account: LedgerAccount.LOAN_RECEIVABLE, creditMinor: 5 },
    ]);

    await expect(result).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  });

  it('drops zero lines, and refuses a posting left with a single side', async () => {
    const { result } = post([
      { account: LedgerAccount.PROVIDER_CLEARING, debitMinor: 0 },
      { account: LedgerAccount.LOAN_RECEIVABLE, creditMinor: 0 },
    ]);

    await expect(result).rejects.toThrow(/Unbalanced/);
  });
});
