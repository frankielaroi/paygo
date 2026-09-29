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
} satisfies Prisma.LoanSelect;

type SummaryRow = Prisma.LoanGetPayload<{ select: typeof summarySelect }>;

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
   * Starts a loan on a bike already assigned to the rider, generates the whole schedule, and posts
   * the origination to the ledger, all in one transaction. The last due date is the loan's end
   * date by construction.
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

        const assignment = await tx.bikeAssignment.findFirst({
          where: { bikeId: input.bikeId, endedAt: null },
          select: { id: true, customerId: true },
        });
        if (!assignment || assignment.customerId !== input.customerId) {
          throw new ConflictException(
            'Assign the bike to this rider before starting a loan on it',
          );
        }

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
        throw new ConflictException('This bike already has an open loan');
      }
      throw error;
    }
  }

  async list(
    query: LoanQueryDto,
    actor: AuthenticatedStaff,
  ): Promise<LoanPageDto> {
    const where: Prisma.LoanWhereInput = {
      ...this.scope(actor),
      ...(query.status ? { status: query.status } : {}),
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(query.bikeId ? { bikeId: query.bikeId } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.loan.findMany({
        where,
        select: summarySelect,
        orderBy: { [query.sortBy ?? 'createdAt']: query.sortOrder ?? 'desc' },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.loan.count({ where }),
    ]);

    const now = new Date();
    const data = await Promise.all(
      rows.map(async (row) =>
        toSummary(row, await this.arrears.positionOf(this.prisma, row, now)),
      ),
    );
    return new PaginatedResponseDto(data, total, query.page, query.limit);
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

    const position = await this.arrears.positionOf(
      this.prisma,
      loan,
      new Date(),
    );
    const next = loan.installments.find(
      (installment) => installment.paidMinor < installment.amountMinor,
    );

    return {
      ...toSummary(loan, position),
      downPaymentMinor: loan.downPaymentMinor,
      assignmentId: loan.assignmentId,
      createdById: loan.createdById,
      completedAt: loan.completedAt,
      closedAt: loan.closedAt,
      closedReason: loan.closedReason,
      nextDue: next
        ? {
            sequence: next.sequence,
            dueDate: isoDay(next.dueDate),
            owingMinor: next.amountMinor - next.paidMinor,
          }
        : null,
      schedule: loan.installments.map((installment) => ({
        ...installment,
        dueDate: isoDay(installment.dueDate),
      })),
      payments: loan.payments,
    };
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
        where: {
          id,
          status: { in: [LoanStatus.ACTIVE, LoanStatus.DEFAULTED] },
        },
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

function toSummary(loan: SummaryRow, position: LoanPosition): LoanSummaryDto {
  return {
    id: loan.id,
    customerId: loan.customerId,
    bikeId: loan.bikeId,
    status: loan.status,
    currency: loan.currency,
    principalMinor: loan.principalMinor,
    installmentMinor: loan.installmentMinor,
    frequency: loan.frequency,
    graceDays: loan.graceDays,
    firstDueDate: isoDay(loan.firstDueDate),
    endDate: isoDay(loan.endDate),
    installmentCount: loan.installmentCount,
    balance: position,
    createdAt: loan.createdAt,
  };
}
