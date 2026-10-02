import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { BikesService } from '../assets/bikes.service';
import { PaginatedResponseDto } from '../common/dto/paginated-response.dto';
import { isUniqueViolation } from '../common/prisma-errors';
import type { AuthenticatedStaff } from '../common/types/authenticated-staff';
import type { Prisma } from '../generated/prisma/client';
import {
  CustomerStatus,
  LedgerAccount,
  LedgerTransactionType,
  LoanStatus,
} from '../generated/prisma/enums';
import { LedgerService } from '../ledger/ledger.service';
import { PrismaService } from '../prisma/prisma.service';
import { Permission, roleHasPermission } from '../users/enums/role.enum';
import type {
  CreateLoanDto,
  LoanDetailDto,
  LoanPageDto,
  LoanQueryDto,
  LoanSummaryDto,
} from './dto/loan.dto';
import { LoanArrearsService, type LoanPosition } from './loan-arrears.service';
import {
  installmentStateOf,
  loanStandingOf,
  type LoanStanding,
} from './loan-standing';
import { generateSchedule } from './schedule';

const summarySelect = {
  id: true,
  customerId: true,
  bikeId: true,
  status: true,
  currency: true,
  principalMinor: true,
  installmentMinor: true,
  frequency: true,
  graceDays: true,
  firstDueDate: true,
  endDate: true,
  installmentCount: true,
  createdAt: true,
  customer: {
    select: { id: true, firstName: true, lastName: true, phone: true },
  },
  bike: {
    select: {
      id: true,
      label: true,
      registrationNumber: true,
      make: true,
      model: true,
    },
  },
} satisfies Prisma.LoanSelect;

type SummaryRow = Prisma.LoanGetPayload<{ select: typeof summarySelect }>;

interface NextDue {
  sequence: number;
  dueDate: string;
  owingMinor: number;
}

/**
 * Loans: the terms, the schedule generated from them, and the lifecycle. Money never moves here
 * except at origination; payments go through LoanRepaymentService. Every balance shown is derived
 * from the ledger at read time.
 */
@Injectable()
export class LoansService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly arrears: LoanArrearsService,
    private readonly bikes: BikesService,
  ) {}

  /**
   * Starts a loan, generates the whole schedule, and posts the origination to the ledger, all in
   * one transaction. The bike is either already with this rider or in stock; a bike in stock is
   * assigned to the rider in the same transaction. A rider holds one open loan at a time. The
   * last due date is the loan's end date by construction.
   */
  async create(
    input: CreateLoanDto,
    actor: AuthenticatedStaff,
  ): Promise<LoanDetailDto> {
    let schedule: ReturnType<typeof generateSchedule>;
    try {
      schedule = generateSchedule({
        principalMinor: input.principalMinor,
        installmentMinor: input.installmentMinor,
        frequency: input.frequency,
        firstDueDate: new Date(input.firstDueDate),
      });
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : 'Invalid loan terms',
      );
    }
    const last = schedule[schedule.length - 1];

    try {
      const loanId = await this.prisma.$transaction(async (tx) => {
        // The rider row is locked so two loans for one rider are checked one after the other;
        // without it both could see "no open loan" and both be created.
        await tx.$queryRaw`SELECT "id" FROM "customers" WHERE "id" = ${input.customerId}::uuid FOR UPDATE`;
        const rider = await tx.customer.findUnique({
          where: { id: input.customerId },
          select: { status: true },
        });
        if (!rider) {
          throw new NotFoundException('Rider not found');
        }
        if (rider.status !== CustomerStatus.ACTIVE) {
          throw new ConflictException(
            `A rider who is ${rider.status.toLowerCase()} cannot take a loan`,
          );
        }
        const openLoan = await tx.loan.findFirst({
          where: { customerId: input.customerId, status: { in: OPEN } },
          select: { id: true },
        });
        if (openLoan) {
          throw new ConflictException(
            'This rider already has an open loan; it must be closed before another starts',
          );
        }

        const held = await tx.bikeAssignment.findFirst({
          where: { bikeId: input.bikeId, endedAt: null },
          select: { id: true, customerId: true },
        });
        if (held && held.customerId !== input.customerId) {
          throw new ConflictException('This bike is assigned to another rider');
        }
        const assignment = held ?? {
          id: await this.bikes.assignUnderLoan(
            tx,
            input.bikeId,
            input.customerId,
            actor.id,
          ),
        };

        const loan = await tx.loan.create({
          data: {
            customerId: input.customerId,
            bikeId: input.bikeId,
            assignmentId: assignment.id,
            currency: input.currency,
            principalMinor: input.principalMinor,
            downPaymentMinor: input.downPaymentMinor ?? 0,
            installmentMinor: input.installmentMinor,
            frequency: input.frequency,
            graceDays: input.graceDays,
            firstDueDate: schedule[0].dueDate,
            endDate: last.dueDate,
            installmentCount: schedule.length,
            createdById: actor.id,
            installments: { create: schedule },
          },
          select: { id: true },
        });

        await this.ledger.post(tx, {
          type: LedgerTransactionType.LOAN_ORIGINATION,
          description: 'Loan started',
          currency: input.currency,
          loanId: loan.id,
          lines: [
            {
              account: LedgerAccount.LOAN_RECEIVABLE,
              loanId: loan.id,
              debitMinor: input.principalMinor,
            },
            {
              account: LedgerAccount.FINANCED_ASSETS,
              creditMinor: input.principalMinor,
            },
          ],
        });
        return loan.id;
      });
      return this.get(loanId, actor);
    } catch (error) {
      if (isUniqueViolation(error)) {
        // Either unique index can fire here: the bike's open loan, or its open assignment
        // when someone else assigned it at the same moment.
        throw new ConflictException(
          'This bike already has an open loan or was just assigned; reload and try again',
        );
      }
      throw error;
    }
  }

  async list(
    query: LoanQueryDto,
    actor: AuthenticatedStaff,
  ): Promise<LoanPageDto> {
    const contains = (word: string) => ({
      contains: word,
      mode: 'insensitive' as const,
    });
    const where: Prisma.LoanWhereInput = {
      ...this.scope(actor),
      ...(query.status ? { status: query.status } : {}),
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(query.bikeId ? { bikeId: query.bikeId } : {}),
      // Every word must match the rider's name or the bike's plate or label.
      AND: searchWords(query.search).map((word) => ({
        OR: [
          { customer: { firstName: contains(word) } },
          { customer: { lastName: contains(word) } },
          { bike: { registrationNumber: contains(word) } },
          { bike: { label: contains(word) } },
        ],
      })),
    };

    // Standing is derived from arrears, so every loan matching the search is loaded and the
    // standing filter and paging apply in memory, as for riders. Fine for a few thousand
    // loans; beyond that, persist the standing and filter in the database.
    const now = new Date();
    const [rows, overdue] = await Promise.all([
      this.prisma.loan.findMany({
        where,
        select: summarySelect,
        orderBy: { [query.sortBy ?? 'createdAt']: query.sortOrder ?? 'desc' },
      }),
      this.arrears.findOverdue(now),
    ]);
    const overdueByLoan = new Map(
      overdue.map((row) => [
        row.detail.loanId,
        Number(row.detail.overdueMinor),
      ]),
    );
    const standings = rows.map((row) => ({
      row,
      standing: loanStandingOf(row.status, overdueByLoan.get(row.id) ?? 0),
    }));
    const matching = standings.filter(
      ({ standing }) => !query.standing || standing === query.standing,
    );
    const page = matching.slice(query.skip, query.skip + query.limit);

    // Balances and the next installment are read only for the page being returned.
    const nextDue = await this.nextDueByLoan(page.map(({ row }) => row.id));
    const data = await Promise.all(
      page.map(async ({ row, standing }) =>
        toSummary(
          row,
          await this.arrears.positionOf(this.prisma, row, now),
          standing,
          nextDue.get(row.id) ?? null,
        ),
      ),
    );

    const count = (standing: LoanStanding): number =>
      standings.filter((loan) => loan.standing === standing).length;
    return Object.assign(
      new PaginatedResponseDto(data, matching.length, query.page, query.limit),
      {
        counts: {
          all: standings.length,
          onTrack: count('on-track'),
          overdue: count('overdue'),
          completed: count('completed'),
          defaulted: count('defaulted'),
          repossessed: count('repossessed'),
          writtenOff: count('written-off'),
        },
      },
    );
  }

  async get(id: string, actor: AuthenticatedStaff): Promise<LoanDetailDto> {
    const loan = await this.prisma.loan.findFirst({
      where: { id, ...this.scope(actor) },
      select: {
        ...summarySelect,
        downPaymentMinor: true,
        assignmentId: true,
        createdById: true,
        completedAt: true,
        closedAt: true,
        closedReason: true,
        assignment: { select: { endedAt: true } },
        installments: {
          orderBy: { sequence: 'asc' },
          select: {
            sequence: true,
            dueDate: true,
            amountMinor: true,
            paidMinor: true,
            paidAt: true,
          },
        },
        payments: {
          orderBy: { paidAt: 'asc' },
          select: {
            id: true,
            provider: true,
            providerReference: true,
            channel: true,
            amountMinor: true,
            currency: true,
            paidAt: true,
            status: true,
            overpaidMinor: true,
          },
        },
      },
    });
    if (!loan) {
      throw new NotFoundException('Loan not found');
    }

    const now = new Date();
    const position = await this.arrears.positionOf(this.prisma, loan, now);
    const next = loan.installments.find(
      (installment) => installment.paidMinor < installment.amountMinor,
    );

    return {
      ...toSummary(
        loan,
        position,
        loanStandingOf(loan.status, position.overdueMinor),
        next && isOpen(loan.status)
          ? {
              sequence: next.sequence,
              dueDate: isoDay(next.dueDate),
              owingMinor: next.amountMinor - next.paidMinor,
            }
          : null,
      ),
      downPaymentMinor: loan.downPaymentMinor,
      assignmentId: loan.assignmentId,
      createdById: loan.createdById,
      completedAt: loan.completedAt,
      closedAt: loan.closedAt,
      closedReason: loan.closedReason,
      assignmentEndedAt: loan.assignment.endedAt,
      schedule: loan.installments.map((installment) => ({
        ...installment,
        dueDate: isoDay(installment.dueDate),
        state: installmentStateOf(installment, loan.graceDays, now),
      })),
      payments: loan.payments,
    };
  }

  /** The oldest installment not fully paid, for each open loan among `loanIds`. */
  private async nextDueByLoan(
    loanIds: string[],
  ): Promise<Map<string, NextDue>> {
    if (loanIds.length === 0) {
      return new Map();
    }
    const unpaid = await this.prisma.loanInstallment.findMany({
      where: {
        loanId: { in: loanIds },
        loan: { status: { in: OPEN } },
        paidMinor: { lt: this.prisma.loanInstallment.fields.amountMinor },
      },
      orderBy: [{ loanId: 'asc' }, { sequence: 'asc' }],
      distinct: ['loanId'],
      select: {
        loanId: true,
        sequence: true,
        dueDate: true,
        amountMinor: true,
        paidMinor: true,
      },
    });
    return new Map(
      unpaid.map((installment) => [
        installment.loanId,
        {
          sequence: installment.sequence,
          dueDate: isoDay(installment.dueDate),
          owingMinor: installment.amountMinor - installment.paidMinor,
        },
      ]),
    );
  }

  /** Declares an active loan in default. It stays collectable and stays enforced. */
  async markDefaulted(
    id: string,
    reason: string,
    actor: AuthenticatedStaff,
  ): Promise<LoanDetailDto> {
    await this.requireVisible(id, actor);
    const moved = await this.prisma.loan.updateMany({
      where: { id, status: LoanStatus.ACTIVE },
      data: {
        status: LoanStatus.DEFAULTED,
        closedReason: reason,
        closedById: actor.id,
      },
    });
    if (moved.count !== 1) {
      throw new ConflictException(
        'Only an active loan can be declared in default',
      );
    }
    return this.get(id, actor);
  }

  /**
   * Repossesses the bike under an open loan: the loan becomes REPOSSESSED and the rider's
   * assignment ends as repossessed, in one transaction, so the loan and who holds the bike never
   * disagree. What is still owed stays in the ledger.
   */
  async repossess(
    id: string,
    reason: string,
    actor: AuthenticatedStaff,
  ): Promise<LoanDetailDto> {
    await this.requireVisible(id, actor);
    await this.prisma.$transaction(async (tx) => {
      const loan = await tx.loan.findUnique({
        where: { id },
        select: { bikeId: true },
      });
      const moved = await tx.loan.updateMany({
        where: { id, status: { in: OPEN } },
        data: {
          status: LoanStatus.REPOSSESSED,
          closedAt: new Date(),
          closedById: actor.id,
          closedReason: reason,
        },
      });
      if (moved.count !== 1 || !loan) {
        throw new ConflictException('Only an open loan can be repossessed');
      }
      await this.bikes.repossessUnderLoan(tx, loan.bikeId, reason, actor.id);
    });
    return this.get(id, actor);
  }

  /**
   * Gives up collecting an open loan. What is still owed is posted to the ledger as a loss, the
   * loan closes as WRITTEN_OFF, and the bike is no longer held by it: it can be returned to
   * stock, retired, or financed again. The rider's assignment is left as it is, because who
   * physically has the bike is a separate fact that staff record on the bike.
   *
   * Nothing is paid and nothing is deleted: the receivable keeps every payment, and the loss
   * sits in its own account. A staff lock on the bike stays; a lock for arrears lifts at the
   * next sweep, since nothing is overdue any more.
   */
  async writeOff(
    id: string,
    reason: string,
    actor: AuthenticatedStaff,
  ): Promise<LoanDetailDto> {
    await this.requireVisible(id, actor);
    await this.prisma.$transaction(async (tx) => {
      // Locked so a payment landing at the same moment is applied before or refused after,
      // never counted in the amount written off and then applied as well.
      await tx.$queryRaw`SELECT "id" FROM "loans" WHERE "id" = ${id}::uuid FOR UPDATE`;
      const loan = await tx.loan.findUnique({
        where: { id },
        select: { status: true, currency: true },
      });
      if (!loan || !isOpen(loan.status)) {
        throw new ConflictException('Only an open loan can be written off');
      }
      const { owedMinor } = await this.ledger.loanReceivable(tx, id);

      await this.ledger.post(tx, {
        type: LedgerTransactionType.LOAN_WRITE_OFF,
        description: `Loan written off: ${reason}`,
        currency: loan.currency,
        loanId: id,
        lines: [
          { account: LedgerAccount.WRITE_OFF_LOSS, debitMinor: owedMinor },
          {
            account: LedgerAccount.LOAN_WRITTEN_OFF,
            loanId: id,
            creditMinor: owedMinor,
          },
        ],
      });
      await tx.loan.update({
        where: { id },
        data: {
          status: LoanStatus.WRITTEN_OFF,
          closedAt: new Date(),
          closedById: actor.id,
          closedReason: reason,
        },
      });
    });
    return this.get(id, actor);
  }

  private async requireVisible(
    id: string,
    actor: AuthenticatedStaff,
  ): Promise<void> {
    const loan = await this.prisma.loan.findFirst({
      where: { id, ...this.scope(actor) },
      select: { id: true },
    });
    if (!loan) {
      throw new NotFoundException('Loan not found');
    }
  }

  /** Loans a caller may see: all with LOAN_READ_ALL, otherwise their own riders' loans. */
  private scope(actor: AuthenticatedStaff): Prisma.LoanWhereInput {
    return roleHasPermission(actor.role, Permission.LOAN_READ_ALL)
      ? {}
      : { customer: { assignedAgentId: actor.id } };
  }
}

export function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** An open loan still takes payments, is still enforced, and still holds its bike. */
const OPEN: LoanStatus[] = [LoanStatus.ACTIVE, LoanStatus.DEFAULTED];

function isOpen(status: LoanStatus): boolean {
  return OPEN.includes(status);
}

function searchWords(search: string | undefined): string[] {
  return (search ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 5);
}

function toSummary(
  loan: SummaryRow,
  position: LoanPosition,
  standing: LoanStanding,
  nextDue: NextDue | null,
): LoanSummaryDto {
  return {
    id: loan.id,
    customerId: loan.customerId,
    bikeId: loan.bikeId,
    rider: loan.customer,
    bike: loan.bike,
    status: loan.status,
    standing,
    currency: loan.currency,
    principalMinor: loan.principalMinor,
    installmentMinor: loan.installmentMinor,
    frequency: loan.frequency,
    graceDays: loan.graceDays,
    firstDueDate: isoDay(loan.firstDueDate),
    endDate: isoDay(loan.endDate),
    installmentCount: loan.installmentCount,
    balance: position,
    nextDue,
    createdAt: loan.createdAt,
  };
}
