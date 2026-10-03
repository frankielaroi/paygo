import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import {
  LedgerAccount,
  LedgerTransactionType,
  LoanStatus,
} from '../generated/prisma/enums';
import { LedgerService } from '../ledger/ledger.service';
import { LoanArrearsService, type LoanPosition } from './loan-arrears.service';
import { allocatePayment } from './schedule';

/** Why money could not be applied to the loan it named. */
export type RepaymentRefusal =
  | 'loan-not-found'
  | 'loan-completed'
  | 'loan-repossessed'
  | 'loan-written-off'
  | 'currency-mismatch';

export type RepaymentResult =
  | { kind: 'refused'; reason: RepaymentRefusal }
  | {
      kind: 'applied';
      loanId: string;
      bikeId: string;
      appliedMinor: number;
      overpaidMinor: number;
      completed: boolean;
      position: LoanPosition;
    };

export interface MoneyIn {
  paymentId: string;
  amountMinor: number;
  currency: string;
  /** Where the money is sitting now: the provider for a new receipt, suspense for a reallocation. */
  from: 'PROVIDER_CLEARING' | 'UNALLOCATED_FUNDS';
  description: string;
}

/**
 * Applies money to a loan, inside the caller's transaction, in one pass:
 *
 * 1. Locks the loan row, so two payments for one loan apply one after the other and never
 *    both read the same unpaid installment.
 * 2. Splits the money oldest installment first (allocatePayment), updates the installment cache
 *    and writes allocation rows.
 * 3. Posts the ledger: debit where the money is, credit the loan's receivable, and credit any
 *    excess beyond the whole loan to the rider, owed back to them.
 * 4. Marks the loan COMPLETED when the ledger shows nothing owed.
 * 5. Returns the position read back from the ledger inside this transaction, which is what the
 *    restore decision must use (CLAUDE.md: restore on "became current", from the ledger).
 */
@Injectable()
export class LoanRepaymentService {
  constructor(
    private readonly ledger: LedgerService,
    private readonly arrears: LoanArrearsService,
  ) {}

  async apply(
    tx: Prisma.TransactionClient,
    loanId: string,
    money: MoneyIn,
    now: Date,
  ): Promise<RepaymentResult> {
    await tx.$queryRaw`SELECT "id" FROM "loans" WHERE "id" = ${loanId}::uuid FOR UPDATE`;
    const loan = await tx.loan.findUnique({
      where: { id: loanId },
      select: {
        id: true,
        bikeId: true,
        status: true,
        currency: true,
        graceDays: true,
      },
    });

    if (!loan) {
      return { kind: 'refused', reason: 'loan-not-found' };
    }
    if (loan.status === LoanStatus.COMPLETED) {
      return { kind: 'refused', reason: 'loan-completed' };
    }
    if (loan.status === LoanStatus.REPOSSESSED) {
      return { kind: 'refused', reason: 'loan-repossessed' };
    }
    if (loan.status === LoanStatus.WRITTEN_OFF) {
      return { kind: 'refused', reason: 'loan-written-off' };
    }
    if (loan.currency !== money.currency) {
      return { kind: 'refused', reason: 'currency-mismatch' };
    }

    const installments = await tx.loanInstallment.findMany({
      where: { loanId },
      select: { id: true, sequence: true, amountMinor: true, paidMinor: true },
      orderBy: { sequence: 'asc' },
    });
    const { allocations, leftoverMinor } = allocatePayment(
      installments,
      money.amountMinor,
    );
    const appliedMinor = money.amountMinor - leftoverMinor;

    for (const allocation of allocations) {
      const installment = installments.find(
        (row) => row.id === allocation.installmentId,
      );
      const paidAfter = (installment?.paidMinor ?? 0) + allocation.amountMinor;
      await tx.loanInstallment.update({
        where: { id: allocation.installmentId },
        data: {
          paidMinor: { increment: allocation.amountMinor },
          ...(installment && paidAfter === installment.amountMinor
            ? { paidAt: now }
            : {}),
        },
      });
    }
    if (allocations.length > 0) {
      await tx.paymentAllocation.createMany({
        data: allocations.map((allocation) => ({
          paymentId: money.paymentId,
          installmentId: allocation.installmentId,
          amountMinor: allocation.amountMinor,
        })),
      });
    }

    await this.ledger.post(tx, {
      type:
        money.from === 'PROVIDER_CLEARING'
          ? LedgerTransactionType.PAYMENT_RECEIVED
          : LedgerTransactionType.PAYMENT_ALLOCATED,
      description: money.description,
      currency: money.currency,
      loanId,
      paymentId: money.paymentId,
      lines: [
        { account: LedgerAccount[money.from], debitMinor: money.amountMinor },
        {
          account: LedgerAccount.LOAN_RECEIVABLE,
          loanId,
          creditMinor: appliedMinor,
        },
        { account: LedgerAccount.RIDER_CREDIT, creditMinor: leftoverMinor },
      ],
    });

    const position = await this.arrears.positionOf(tx, loan, now);
    const completed = position.owedMinor === 0;
    if (completed) {
      await tx.loan.update({
        where: { id: loanId },
        data: { status: LoanStatus.COMPLETED, completedAt: now },
      });
    }

    return {
      kind: 'applied',
      loanId,
      bikeId: loan.bikeId,
      appliedMinor,
      overpaidMinor: leftoverMinor,
      completed,
      position,
    };
  }
}
