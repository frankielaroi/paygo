import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PaginationMetaDto } from '../../common/dto/paginated-response.dto';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { PaymentStatus } from '../../generated/prisma/enums';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;
const trimUpper = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

export class RecordPaymentDto {
  @ApiProperty({ example: 5000, description: 'Minor units (pesewas)' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  amountMinor!: number;

  @ApiProperty({ example: 'GHS' })
  @Transform(trimUpper)
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be an ISO 4217 code' })
  currency!: string;

  @ApiProperty({
    example: 'CASH-ACCRA-2026-10-01-0007',
    description: 'Receipt number; must be unique across manual payments',
  })
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  reference!: string;

  @ApiPropertyOptional({
    description: 'When the money was received; defaults to now',
  })
  @IsOptional()
  @IsDateString()
  paidAt?: string;
}

export class AllocatePaymentDto {
  @ApiProperty()
  @IsUUID()
  loanId!: string;
}

export class PaymentQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: PaymentStatus })
  @IsOptional()
  @IsEnum(PaymentStatus)
  status?: PaymentStatus;

  @ApiPropertyOptional({ example: 'paystack' })
  @IsOptional()
  @IsString()
  provider?: string;

  @ApiPropertyOptional({
    description: 'Exact provider reference, for reconciliation',
  })
  @IsOptional()
  @IsString()
  reference?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  loanId?: string;

  @ApiPropertyOptional({ description: 'paidAt on or after' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ description: 'paidAt on or before' })
  @IsOptional()
  @IsDateString()
  to?: string;
}

export class PaymentDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ example: 'paystack' })
  provider!: string;

  @ApiProperty({ description: 'The reference on the provider statement' })
  providerReference!: string;

  @ApiProperty({ nullable: true })
  providerTransactionId!: string | null;

  @ApiProperty({ nullable: true })
  channel!: string | null;

  @ApiProperty({ nullable: true })
  payerPhone!: string | null;

  @ApiProperty()
  amountMinor!: number;

  @ApiProperty()
  currency!: string;

  @ApiProperty()
  paidAt!: Date;

  @ApiProperty()
  receivedAt!: Date;

  @ApiProperty({ enum: PaymentStatus })
  status!: PaymentStatus;

  @ApiProperty({
    nullable: true,
    description: 'Why an UNALLOCATED payment was not applied',
  })
  statusReason!: string | null;

  @ApiProperty({ nullable: true })
  loanId!: string | null;

  @ApiProperty({
    description: 'Paid beyond the whole loan; owed back to the rider',
  })
  overpaidMinor!: number;

  @ApiProperty({ nullable: true })
  recordedById!: string | null;

  @ApiProperty({ nullable: true })
  allocatedById!: string | null;

  @ApiProperty({ nullable: true })
  allocatedAt!: Date | null;
}

export class PaymentPageDto {
  @ApiProperty({ type: PaymentDto, isArray: true })
  data!: PaymentDto[];

  @ApiProperty({ type: PaginationMetaDto })
  meta!: PaginationMetaDto;
}

export class WebhookAckDto {
  @ApiProperty()
  received!: boolean;
}
