import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PaginatedResponseDto } from '../common/dto/paginated-response.dto';
import { isUniqueViolation } from '../common/prisma-errors';
import { EnforcementService } from '../enforcement/enforcement.service';
import type { Prisma } from '../generated/prisma/client';
import {
  LedgerAccount,
  LedgerTransactionType,
  PaymentStatus,
} from '../generated/prisma/enums';
import { LedgerService } from '../ledger/ledger.service';
import {
  LoanRepaymentService,
  type RepaymentRefusal,
} from '../loans/loan-repayment.service';
import { PrismaService } from '../prisma/prisma.service';
import type {
  PaymentDto,
  PaymentPageDto,
  PaymentQueryDto,
} from './dto/payment.dto';

/** Money arriving from any source, normalised. */
export interface IncomingPayment {
  provider: string;
  reference: string;
  providerTransactionId?: string | null;
  amountMinor: number;
  currency: string;
  paidAt: Date;
  channel?: string | null;
  payerPhone?: string | null;
  loanId: string | null;
  recordedById?: string;
}

export type IngestResult =
  | { outcome: 'duplicate'; paymentId: string }
  | { outcome: 'recorded'; paymentId: string; status: PaymentStatus };

/** What to do when the named loan cannot take the money. */
type OnRefusal = 'park' | 'reject';

const REFUSAL_TEXT: Record<RepaymentRefusal | 'no-loan-named', string> = {
  'no-loan-named': 'The payment did not name a loan',
  'loan-not-found': 'The named loan does not exist',
  'loan-completed': 'The named loan is already fully paid',
  'loan-repossessed': 'The named loan was closed by repossession',
  'currency-mismatch': 'The payment currency differs from the loan currency',
};

interface Applied {
  bikeId: string;
  loanId: string;
  overdueMinor: number;
}

/**
 * Receives money exactly once and puts it where it belongs.
 *
 * Idempotency is the unique (provider, providerReference) constraint, not a lookup: the payment
 * row is inserted first, in the same transaction as everything it causes, so a replayed webhook,
 * even one arriving concurrently with the original, fails on the constraint and changes nothing.
 *
 * Money is never lost. A webhook for a loan that cannot take it (none named, unknown, closed,
 * wrong currency) is still recorded, as UNALLOCATED and held in the ledger's unallocated account,
 * until staff allocate it. Refusing it would only make Paystack retry money we already have.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly repayment: LoanRepaymentService,
    private readonly enforcement: EnforcementService,
  ) {}

  /** For webhooks: never refuses money, parks what cannot be applied. */
  ingest(input: IncomingPayment): Promise<IngestResult> {
    return this.receive(input, 'park');
  }

  /**
   * For staff recording money by hand. Unlike a webhook, a bad request here is refused outright:
   * nothing is recorded against a loan that does not exist or is closed.
   */
  async recordManual(
    loanId: string,
    input: Omit<IncomingPayment, 'provider' | 'loanId'>,
  ): Promise<PaymentDto> {
    const loan = await this.prisma.loan.findUnique({
      where: { id: loanId },
      select: { id: true },
    });
    if (!loan) {
      throw new NotFoundException('Loan not found');
    }

    const result = await this.receive(
      { ...input, provider: 'manual', loanId },
      'reject',
    );
    if (result.outcome === 'duplicate') {
      throw new ConflictException(
        `Reference ${input.reference} has already been recorded`,
      );
    }
    return this.get(result.paymentId);
  }

  /** Applies a parked payment to a loan. Refused, with nothing changed, if the loan cannot take it. */
  async allocate(
    paymentId: string,
    loanId: string,
    userId: string,
  ): Promise<PaymentDto> {
    const applied = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "payments" WHERE "id" = ${paymentId}::uuid FOR UPDATE`;
      const payment = await tx.payment.findUnique({
        where: { id: paymentId },
        select: {
          status: true,
          amountMinor: true,
          currency: true,
          providerReference: true,
        },
      });
      if (!payment) {
        throw new NotFoundException('Payment not found');
      }
      if (payment.status !== PaymentStatus.UNALLOCATED) {
        throw new ConflictException(
          'This payment is already applied to a loan',
        );
      }

      const result = await this.repayment.apply(
        tx,
        loanId,
        {
          paymentId,
          amountMinor: payment.amountMinor,
          currency: payment.currency,
          from: 'UNALLOCATED_FUNDS',
          description: `Allocated payment ${payment.providerReference}`,
        },
        new Date(),
      );
      if (result.kind === 'refused') {
        throw this.refusal(result.reason);
      }

      await tx.payment.update({
        where: { id: paymentId },
        data: {
          status: PaymentStatus.APPLIED,
          statusReason: null,
          loanId,
          overpaidMinor: result.overpaidMinor,
          allocatedById: userId,
          allocatedAt: new Date(),
        },
      });
      return {
        bikeId: result.bikeId,
        loanId,
        overdueMinor: result.position.overdueMinor,
      };
    });

    await this.restoreIfCurrent(applied, paymentId);
    return this.get(paymentId);
  }

  async list(query: PaymentQueryDto): Promise<PaymentPageDto> {
    const where: Prisma.PaymentWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.provider ? { provider: query.provider } : {}),
      ...(query.reference ? { providerReference: query.reference } : {}),
      ...(query.loanId ? { loanId: query.loanId } : {}),
      ...(query.from || query.to
        ? {
            paidAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.payment.findMany({
        where,
        select: paymentSelect,
        orderBy: { paidAt: query.sortOrder ?? 'desc' },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.payment.count({ where }),
    ]);
    return new PaginatedResponseDto(rows, total, query.page, query.limit);
  }

  async get(id: string): Promise<PaymentDto> {
    const payment = await this.prisma.payment.findUnique({
      where: { id },
      select: paymentSelect,
    });
    if (!payment) {
      throw new NotFoundException('Payment not found');
    }
    return payment;
  }

  private async receive(
    input: IncomingPayment,
    onRefusal: OnRefusal,
  ): Promise<IngestResult> {
    let recorded: {
      paymentId: string;
      status: PaymentStatus;
      applied: Applied | null;
    };

    try {
      recorded = await this.prisma.$transaction(async (tx) => {
        // First write, so a duplicate fails here and nothing after it happens.
        const payment = await tx.payment.create({
          data: {
            provider: input.provider,
            providerReference: input.reference,
            providerTransactionId: input.providerTransactionId ?? null,
            channel: input.channel ?? null,
            payerPhone: input.payerPhone ?? null,
            amountMinor: input.amountMinor,
            currency: input.currency,
            paidAt: input.paidAt,
            status: PaymentStatus.UNALLOCATED,
            recordedById: input.recordedById,
          },
          select: { id: true },
        });

        const result = input.loanId
          ? await this.repayment.apply(
              tx,
              input.loanId,
              {
                paymentId: payment.id,
                amountMinor: input.amountMinor,
                currency: input.currency,
                from: 'PROVIDER_CLEARING',
                description: `${input.provider} payment ${input.reference}`,
              },
              new Date(),
            )
          : ({ kind: 'refused', reason: 'no-loan-named' } as const);

        if (result.kind === 'applied') {
          await tx.payment.update({
            where: { id: payment.id },
            data: {
              status: PaymentStatus.APPLIED,
              loanId: result.loanId,
              overpaidMinor: result.overpaidMinor,
            },
          });
          return {
            paymentId: payment.id,
            status: PaymentStatus.APPLIED,
            applied: {
              bikeId: result.bikeId,
              loanId: result.loanId,
              overdueMinor: result.position.overdueMinor,
            },
          };
        }

        if (onRefusal === 'reject') {
          throw this.refusal(result.reason);
        }

        await tx.payment.update({
          where: { id: payment.id },
          data: { statusReason: REFUSAL_TEXT[result.reason] },
        });
        await this.ledger.post(tx, {
          type: LedgerTransactionType.PAYMENT_RECEIVED,
          description: `${input.provider} payment ${input.reference} held unallocated`,
          currency: input.currency,
          paymentId: payment.id,
          lines: [
            {
              account: LedgerAccount.PROVIDER_CLEARING,
              debitMinor: input.amountMinor,
            },
            {
              account: LedgerAccount.UNALLOCATED_FUNDS,
              creditMinor: input.amountMinor,
            },
          ],
        });
        this.logger.warn(
          `Payment ${input.provider}/${input.reference} held unallocated: ${REFUSAL_TEXT[result.reason]}`,
        );
        return {
          paymentId: payment.id,
          status: PaymentStatus.UNALLOCATED,
          applied: null,
        };
      });
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      const existing = await this.prisma.payment.findUnique({
        where: {
          provider_providerReference: {
            provider: input.provider,
            providerReference: input.reference,
          },
        },
        select: { id: true },
      });
      if (!existing) {
        throw error;
      }
      this.logger.log(
        `Duplicate ${input.provider} payment ${input.reference} ignored`,
      );
      return { outcome: 'duplicate', paymentId: existing.id };
    }

    if (recorded.applied) {
      await this.restoreIfCurrent(recorded.applied, recorded.paymentId);
    }
    return {
      outcome: 'recorded',
      paymentId: recorded.paymentId,
      status: recorded.status,
    };
  }

  /**
   * Tells enforcement the loan is current, which restores a bike locked for arrears without
   * waiting for the sweep. Only when current: a payment never causes a lock. The decision uses
   * the position read from the ledger inside the transaction that posted the payment.
   *
   * A failure here is logged, not thrown: the money is recorded, and the next sweep reaches the
   * same conclusion from the same ledger.
   */
  private async restoreIfCurrent(
    applied: Applied,
    paymentId: string,
  ): Promise<void> {
    if (applied.overdueMinor > 0) {
      return;
    }
    try {
      await this.enforcement.applyArrears(
        applied.bikeId,
        false,
        'Payment brought the loan current',
        { loanId: applied.loanId, paymentId },
      );
    } catch (error) {
      this.logger.error(
        `Could not notify enforcement for loan ${applied.loanId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private refusal(reason: RepaymentRefusal | 'no-loan-named'): Error {
    return reason === 'loan-not-found'
      ? new NotFoundException(REFUSAL_TEXT[reason])
      : new ConflictException(REFUSAL_TEXT[reason]);
  }
}

const paymentSelect = {
  id: true,
  provider: true,
  providerReference: true,
  providerTransactionId: true,
  channel: true,
  payerPhone: true,
  amountMinor: true,
  currency: true,
  paidAt: true,
  receivedAt: true,
  status: true,
  statusReason: true,
  loanId: true,
  overpaidMinor: true,
  recordedById: true,
  allocatedById: true,
  allocatedAt: true,
} satisfies Prisma.PaymentSelect;
