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
import {
  LOAN_STANDINGS,
  type InstallmentState,
  type LoanStanding,
} from '../loan-standing';

const trimUpper = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;
const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class CreateLoanDto {
  @ApiProperty({
    description:
      'The rider: KYC-verified, active, and with no other open loan.',
  })
  @IsUUID()
  customerId!: string;

  @ApiProperty({
    description:
      'A bike in stock, which is assigned to the rider as the loan starts, or one already ' +
      'assigned to this rider.',
  })
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

  @ApiPropertyOptional({
    enum: LOAN_STANDINGS,
    description:
      'Where the loan stands today: an active loan is on-track or overdue',
  })
  @IsOptional()
  @IsIn(LOAN_STANDINGS)
  standing?: LoanStanding;

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

  @ApiProperty({
    description:
      'Given up as uncollectable when the loan was written off; 0 otherwise. Never counted ' +
      'as paid.',
  })
  writtenOffMinor!: number;

  @ApiProperty({
    description:
      'Still owed: lent, less paid, less written off. On an open loan this is also the ' +
      'amount that settles it early.',
  })
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

  @ApiProperty({
    enum: ['paid', 'overdue', 'in-grace', 'due-today', 'upcoming'],
    description:
      'in-grace is past its due date but not yet overdue: the grace days have not run out',
  })
  state!: InstallmentState;
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

  @ApiProperty({
    nullable: true,
    description: 'How it was paid, e.g. cash or mobile_money',
  })
  channel!: string | null;

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

export class LoanRiderDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  firstName!: string;

  @ApiProperty()
  lastName!: string;

  @ApiProperty()
  phone!: string;
}

export class LoanBikeDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ example: 'ACC-014' })
  label!: string;

  @ApiProperty({ nullable: true, description: 'The plate' })
  registrationNumber!: string | null;

  @ApiProperty()
  make!: string;

  @ApiProperty()
  model!: string;
}

export class LoanSummaryDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  customerId!: string;

  @ApiProperty()
  bikeId!: string;

  @ApiProperty({ type: LoanRiderDto })
  rider!: LoanRiderDto;

  @ApiProperty({ type: LoanBikeDto })
  bike!: LoanBikeDto;

  @ApiProperty({ enum: LoanStatus })
  status!: LoanStatus;

  @ApiProperty({
    enum: LOAN_STANDINGS,
    description:
      'The status as staff see it: an active loan is on-track, or overdue once anything is ' +
      'owed past grace. Derived on every read from the same arrears as enforcement.',
  })
  standing!: LoanStanding;

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

  @ApiProperty({
    type: NextDueDto,
    nullable: true,
    description:
      'The oldest installment not fully paid; null once all are, or once the loan is closed',
  })
  nextDue!: NextDueDto | null;

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
    nullable: true,
    description:
      'When the rider stopped holding the bike under this loan; null while they still hold it',
  })
  assignmentEndedAt!: Date | null;

  @ApiProperty({ type: InstallmentDto, isArray: true })
  schedule!: InstallmentDto[];

  @ApiProperty({ type: LoanPaymentDto, isArray: true })
  payments!: LoanPaymentDto[];
}

/** Loans matching the search, by standing, before the standing filter applies. */
export class LoanCountsDto {
  @ApiProperty()
  all!: number;

  @ApiProperty()
  onTrack!: number;

  @ApiProperty()
  overdue!: number;

  @ApiProperty()
  completed!: number;

  @ApiProperty()
  defaulted!: number;

  @ApiProperty()
  repossessed!: number;

  @ApiProperty()
  writtenOff!: number;
}

export class LoanPageDto {
  @ApiProperty({ type: LoanSummaryDto, isArray: true })
  data!: LoanSummaryDto[];

  @ApiProperty({ type: PaginationMetaDto })
  meta!: PaginationMetaDto;

  @ApiProperty({ type: LoanCountsDto })
  counts!: LoanCountsDto;
}
