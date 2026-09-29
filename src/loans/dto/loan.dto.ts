import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PaginationMetaDto } from '../../common/dto/paginated-response.dto';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import {
  LoanFrequency,
  LoanStatus,
  PaymentStatus,
} from '../../generated/prisma/enums';

const trimUpper = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;
const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class CreateLoanDto {
  @ApiProperty({
    description: 'The rider. The bike must already be assigned to them.',
  })
  @IsUUID()
  customerId!: string;

  @ApiProperty()
  @IsUUID()
  bikeId!: string;

  @ApiProperty({
    example: 'GHS',
    description: 'ISO 4217; payments must match it',
  })
  @Transform(trimUpper)
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be an ISO 4217 code' })
  currency!: string;

  @ApiProperty({
    example: 1500000,
    description:
      'Amount repaid through installments, in minor units (pesewas). Any markup included.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  principalMinor!: number;

  @ApiPropertyOptional({
    example: 300000,
    description: 'Paid before the loan started. Recorded, not owed.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  downPaymentMinor?: number;

  @ApiProperty({
    example: 5000,
    description: 'Each installment, in minor units',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  installmentMinor!: number;

  @ApiProperty({ enum: LoanFrequency })
  @IsEnum(LoanFrequency)
  frequency!: LoanFrequency;

  @ApiProperty({
    example: 2,
    description:
      'Whole days after a due date before an unpaid installment is overdue. With 2, an ' +
      'installment due on the 10th is overdue from the 13th.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(60)
  graceDays!: number;

  @ApiProperty({
    example: '2026-10-02',
    description: 'Due date of the first installment',
  })
  @IsDateString()
  firstDueDate!: string;
}

export class LoanReasonDto {
  @ApiProperty({ example: 'Rider unreachable for 30 days' })
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export const LOAN_SORT_FIELDS = [
  'createdAt',
  'firstDueDate',
  'status',
] as const;
export type LoanSortField = (typeof LOAN_SORT_FIELDS)[number];

export class LoanQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: LoanStatus })
  @IsOptional()
  @IsEnum(LoanStatus)
  status?: LoanStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  bikeId?: string;

  @ApiPropertyOptional({ enum: LOAN_SORT_FIELDS, default: 'createdAt' })
  @IsOptional()
  @IsIn(LOAN_SORT_FIELDS)
  sortBy?: LoanSortField = 'createdAt';
}

export class LoanBalanceDto {
  @ApiProperty({ description: 'Total lent, from the ledger' })
  lentMinor!: number;

  @ApiProperty({ description: 'Total paid against the loan, from the ledger' })
  paidMinor!: number;

  @ApiProperty({ description: 'Still owed' })
  owedMinor!: number;

  @ApiProperty({
    description:
      'Fallen due past grace and not yet paid. The loan is current only when this is 0.',
  })
  overdueMinor!: number;
}

export class InstallmentDto {
  @ApiProperty()
  sequence!: number;

  @ApiProperty({ example: '2026-10-02' })
  dueDate!: string;

  @ApiProperty()
  amountMinor!: number;

  @ApiProperty()
  paidMinor!: number;

  @ApiProperty({ nullable: true })
  paidAt!: Date | null;
}

export class NextDueDto {
  @ApiProperty()
  sequence!: number;

  @ApiProperty({ example: '2026-10-02' })
  dueDate!: string;

  @ApiProperty({ description: 'Still owing on this installment' })
  owingMinor!: number;
}

export class LoanPaymentDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  provider!: string;

  @ApiProperty({ description: 'Reference on the provider statement' })
  providerReference!: string;

  @ApiProperty()
  amountMinor!: number;

  @ApiProperty()
  currency!: string;

  @ApiProperty()
  paidAt!: Date;

  @ApiProperty({ enum: PaymentStatus })
  status!: PaymentStatus;

  @ApiProperty()
  overpaidMinor!: number;
}

export class LoanSummaryDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  customerId!: string;

  @ApiProperty()
  bikeId!: string;

  @ApiProperty({ enum: LoanStatus })
  status!: LoanStatus;

  @ApiProperty()
  currency!: string;

  @ApiProperty()
  principalMinor!: number;

  @ApiProperty()
  installmentMinor!: number;

  @ApiProperty({ enum: LoanFrequency })
  frequency!: LoanFrequency;

  @ApiProperty()
  graceDays!: number;

  @ApiProperty({ example: '2026-10-02' })
  firstDueDate!: string;

  @ApiProperty({ example: '2027-03-31' })
  endDate!: string;

  @ApiProperty()
  installmentCount!: number;

  @ApiProperty({ type: LoanBalanceDto })
  balance!: LoanBalanceDto;

  @ApiProperty()
  createdAt!: Date;
}

export class LoanDetailDto extends LoanSummaryDto {
  @ApiProperty()
  downPaymentMinor!: number;

  @ApiProperty()
  assignmentId!: string;

  @ApiProperty()
  createdById!: string;

  @ApiProperty({ nullable: true })
  completedAt!: Date | null;

  @ApiProperty({ nullable: true })
  closedAt!: Date | null;

  @ApiProperty({ nullable: true })
  closedReason!: string | null;

  @ApiProperty({
    type: NextDueDto,
    nullable: true,
    description: 'The oldest installment not fully paid; null once all are',
  })
  nextDue!: NextDueDto | null;

  @ApiProperty({ type: InstallmentDto, isArray: true })
  schedule!: InstallmentDto[];

  @ApiProperty({ type: LoanPaymentDto, isArray: true })
  payments!: LoanPaymentDto[];
}

export class LoanPageDto {
  @ApiProperty({ type: LoanSummaryDto, isArray: true })
  data!: LoanSummaryDto[];

  @ApiProperty({ type: PaginationMetaDto })
  meta!: PaginationMetaDto;
}
