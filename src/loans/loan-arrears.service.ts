import { Injectable } from '@nestjs/common';
import type { ArrearsSource, OverdueBike } from '../enforcement/arrears-source';
import type { Prisma } from '../generated/prisma/client';
import { LedgerService } from '../ledger/ledger.service';
import { PrismaService } from '../prisma/prisma.service';
import { PoliciesService } from '../settings/policies.service';
import { overdueMinor, utcDay } from './schedule';

/** Where a loan stands right now. Derived on every call; nothing here is cached. */
export interface LoanPosition {
  lentMinor: number;
  paidMinor: number;
  writtenOffMinor: number;
  owedMinor: number;
  overdueMinor: number;
}

interface OverdueRow {
  loanId: string;
  bikeId: string;
  currency: string;
  overdue: bigint | number | string;
  lockable: boolean;
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
    private readonly policies: PoliciesService,
  ) {}

  /**
   * Every open loan (ACTIVE or DEFAULTED) with money overdue past its grace period as of
   * `asOf`. Completed, repossessed and written-off loans never appear. One query for the whole
   * fleet.
   */
  async findOverdue(asOf: Date): Promise<OverdueBike[]> {
    const today = isoDay(asOf);
    // Read from the fleet policy on every call, so a change made in Settings applies at the
    // next sweep with no restart.
    const leadHours = await this.policies.lockoutWarningLeadHours();
    const warnedBy = isoTimestamp(
      new Date(asOf.getTime() - leadHours * 3_600_000),
    );
    // lockable: the rider was warned about an installment that is still unpaid, and the
    // warning went out (or failed for a reason specific to the rider, such as an invalid
    // number) at least the lead time ago. A warning still pending, for instance during a
    // provider outage, does not count: no warning attempt, no automatic lock.
    const rows = await this.prisma.$queryRaw<OverdueRow[]>`
      SELECT l."id" AS "loanId", l."bikeId" AS "bikeId", l."currency" AS "currency",
             due."amount" - COALESCE(paid."amount", 0) AS "overdue",
             EXISTS (
               SELECT 1
               FROM "notifications" n
               JOIN "loan_installments" wi ON wi."id" = n."installmentId"
               WHERE n."loanId" = l."id"
                 AND n."kind" = 'LOCKOUT_WARNING'
                 AND wi."paidMinor" < wi."amountMinor"
                 AND COALESCE(n."sentAt", n."failedAt") <= ${warnedBy}::timestamp
             ) AS "lockable"
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
      lockable: row.lockable,
      detail: {
        loanId: row.loanId,
        overdueMinor: Number(row.overdue),
        currency: row.currency,
        asOf: today,
        warned: row.lockable,
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
      // What was written off is no longer owed, so it is no longer overdue either. Only a
      // closed loan has any, and findOverdue never looks at a closed loan.
      overdueMinor: overdueMinor(
        schedule,
        receivable.paidMinor + receivable.writtenOffMinor,
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

/**
 * A UTC timestamp without the zone suffix, compared against Prisma's timestamp(3) columns,
 * which hold UTC. Passed as text for the same reason as isoDay.
 */
function isoTimestamp(date: Date): string {
  return date.toISOString().replace('Z', '');
}
