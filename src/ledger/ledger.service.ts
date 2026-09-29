import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import {
  LedgerAccount,
  LedgerTransactionType,
} from '../generated/prisma/enums';

export interface LedgerLine {
  account: LedgerAccount;
  loanId?: string;
  debitMinor?: number;
  creditMinor?: number;
}

export interface LedgerPosting {
  type: LedgerTransactionType;
  description: string;
  currency: string;
  loanId?: string;
  paymentId?: string;
  lines: LedgerLine[];
}

type Db = Pick<Prisma.TransactionClient, 'ledgerTransaction' | 'ledgerEntry'>;

/**
 * The double-entry ledger: the source of truth for what is owed and what was received.
 *
 * Append-only. There is deliberately no update or delete here, and database triggers refuse both,
 * so a mistake is corrected with a new, reversing transaction. Every posting must balance; this
 * checks before writing, and a deferred database trigger checks again at commit.
 *
 * Postings take the caller's transaction client, so ledger rows commit or roll back together
 * with the payment or loan change they record.
 */
@Injectable()
export class LedgerService {
  async post(db: Db, posting: LedgerPosting): Promise<string> {
    const lines = posting.lines.filter(
      (line) => (line.debitMinor ?? 0) !== 0 || (line.creditMinor ?? 0) !== 0,
    );

    let debits = 0;
    let credits = 0;
    for (const line of lines) {
      const debit = line.debitMinor ?? 0;
      const credit = line.creditMinor ?? 0;
      if (
        !Number.isSafeInteger(debit) ||
        !Number.isSafeInteger(credit) ||
        debit < 0 ||
        credit < 0 ||
        debit > 0 === credit > 0
      ) {
        throw new Error(
          `Ledger line on ${line.account} must be exactly one positive integer debit or credit`,
        );
      }
      debits += debit;
      credits += credit;
    }
    if (lines.length < 2 || debits !== credits) {
      throw new Error(
        `Unbalanced ledger posting "${posting.description}": debits ${debits}, credits ${credits}`,
      );
    }

    const created = await db.ledgerTransaction.create({
      data: {
        type: posting.type,
        description: posting.description,
        loanId: posting.loanId,
        paymentId: posting.paymentId,
        entries: {
          create: lines.map((line) => ({
            account: line.account,
            loanId: line.loanId,
            debitMinor: line.debitMinor ?? 0,
            creditMinor: line.creditMinor ?? 0,
            currency: posting.currency,
          })),
        },
      },
      select: { id: true },
    });
    return created.id;
  }

  /**
   * A loan's receivable account: what was lent (debits), what has been paid against it (credits),
   * and what is still owed.
   */
  async loanReceivable(
    db: Pick<Prisma.TransactionClient, 'ledgerEntry'>,
    loanId: string,
  ): Promise<{ lentMinor: number; paidMinor: number; owedMinor: number }> {
    const totals = await db.ledgerEntry.aggregate({
      where: { loanId, account: LedgerAccount.LOAN_RECEIVABLE },
      _sum: { debitMinor: true, creditMinor: true },
    });
    const lentMinor = totals._sum.debitMinor ?? 0;
    const paidMinor = totals._sum.creditMinor ?? 0;
    return { lentMinor, paidMinor, owedMinor: lentMinor - paidMinor };
  }
}
