import { Injectable } from '@nestjs/common';
import type { ArrearsSource, OverdueBike } from '../enforcement/arrears-source';
import type { Prisma } from '../generated/prisma/client';
import { LedgerService } from '../ledger/ledger.service';
import { PrismaService } from '../prisma/prisma.service';
import { overdueMinor, utcDay } from './schedule';

/** Where a loan stands right now. Derived on every call; nothing here is cached. */
export interface LoanPosition {
  lentMinor: number;
  paidMinor: number;
  owedMinor: number;
  overdueMinor: number;
}

interface OverdueRow {
  loanId: string;
  bikeId: string;
  currency: string;
  overdue: bigint | number | string;
}

/**
 * Answers "is this loan overdue" for enforcement and for payments, from the schedule and the
 * ledger. "Paid" is always the credits on the loan's receivable account, never the cached
 * paidMinor on installments, so the answer cannot drift from the money actually recorded.
 *
 * Kept in its own module with no dependency on enforcement, so enforcement can import it as its
 * arrears source without a circular import.
 */
@Injectable()
export class LoanArrearsService implements ArrearsSource {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
  ) {}

  /**
   * Every open loan (ACTIVE or DEFAULTED) with money overdue past its grace period as of
   * `asOf`. Completed and repossessed loans never appear. One query for the whole fleet.
   */
  async findOverdue(asOf: Date): Promise<OverdueBike[]> {
    const today = isoDay(asOf);
    const rows = await this.prisma.$queryRaw<OverdueRow[]>`
      SELECT l."id" AS "loanId", l."bikeId" AS "bikeId", l."currency" AS "currency",
             due."amount" - COALESCE(paid."amount", 0) AS "overdue"
      FROM "loans" l
      JOIN (
        SELECT i."loanId", SUM(i."amountMinor") AS "amount"
        FROM "loan_installments" i
        JOIN "loans" li ON li."id" = i."loanId"
        WHERE i."dueDate" + li."graceDays" < ${today}::date
        GROUP BY i."loanId"
      ) due ON due."loanId" = l."id"
      LEFT JOIN (
        SELECT e."loanId", SUM(e."creditMinor") AS "amount"
        FROM "ledger_entries" e
        WHERE e."account" = 'LOAN_RECEIVABLE'
        GROUP BY e."loanId"
      ) paid ON paid."loanId" = l."id"
      WHERE l."status" IN ('ACTIVE', 'DEFAULTED')
        AND due."amount" - COALESCE(paid."amount", 0) > 0
    `;

    return rows.map((row) => ({
      bikeId: row.bikeId,
      detail: {
        loanId: row.loanId,
        overdueMinor: Number(row.overdue),
        currency: row.currency,
        asOf: today,
      },
    }));
  }

  /**
   * One loan's position, using the same rule as findOverdue. Pass the transaction client when
   * called while posting a payment, so the answer includes the entries just written.
   */
  async positionOf(
    db: Pick<Prisma.TransactionClient, 'ledgerEntry' | 'loanInstallment'>,
    loan: { id: string; graceDays: number },
    asOf: Date,
  ): Promise<LoanPosition> {
    const [receivable, schedule] = await Promise.all([
      this.ledger.loanReceivable(db, loan.id),
      db.loanInstallment.findMany({
        where: { loanId: loan.id },
        select: { dueDate: true, amountMinor: true },
      }),
    ]);
    return {
      ...receivable,
      overdueMinor: overdueMinor(
        schedule,
        receivable.paidMinor,
        loan.graceDays,
        asOf,
      ),
    };
  }
}

/** YYYY-MM-DD of the UTC day, passed as text so the database session time zone cannot shift it. */
function isoDay(date: Date): string {
  return utcDay(date).toISOString().slice(0, 10);
}
