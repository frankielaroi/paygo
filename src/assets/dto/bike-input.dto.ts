import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsDateString,
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
import { AssignmentEndReason } from '../../generated/prisma/enums';

const trimUpper = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;
const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class CreateBikeDto {
  @ApiProperty({
    example: 'Bike 7',
    description: 'Short fleet name for the map',
  })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  label!: string;

  @ApiProperty({ example: 'MD2A11CZ9PWA12345', description: 'Chassis number' })
  @Transform(trimUpper)
  @IsString()
  @Matches(/^[A-Z0-9-]{6,30}$/, {
    message: 'vin must be 6 to 30 letters, digits or dashes',
  })
  vin!: string;

  @ApiPropertyOptional({ example: 'GR 1234-24', description: 'Number plate' })
  @IsOptional()
  @Transform(trimUpper)
  @IsString()
  @MaxLength(32)
  registrationNumber?: string;

  @ApiProperty({ example: 'Bajaj' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  make!: string;

  @ApiProperty({ example: 'Boxer 150' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  model!: string;

  @ApiPropertyOptional({ example: 2025 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1980)
  @Max(2100)
  year?: number;

  @ApiPropertyOptional({ example: 'Red' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  color?: string;

  @ApiPropertyOptional({
    example: 1850000,
    description:
      'Purchase cost in minor units (pesewas, cents). Requires purchaseCurrency.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  purchasePriceMinor?: number;

  @ApiPropertyOptional({ example: 'GHS', description: 'ISO 4217 code' })
  @IsOptional()
  @Transform(trimUpper)
  @Matches(/^[A-Z]{3}$/, {
    message: 'purchaseCurrency must be an ISO 4217 code',
  })
  purchaseCurrency?: string;

  @ApiPropertyOptional({ example: '2026-09-01' })
  @IsOptional()
  @IsDateString()
  purchasedAt?: string;

  @ApiPropertyOptional({ example: 'Accra Motors Ltd' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  supplier?: string;
}

/** Identity and purchase details only. Status and tracker change through their own actions. */
export class UpdateBikeDto extends PartialType(CreateBikeDto) {}

export class ReasonDto {
  @ApiProperty({ example: 'Inspected and serviced after repossession' })
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export class InstallTrackerDto {
  @ApiProperty({ example: '356307042441013' })
  @Transform(trim)
  @IsString()
  @Matches(/^\d{14,17}$/, { message: 'imei must be 14 to 17 digits' })
  imei!: string;

  @ApiPropertyOptional({
    example: 'Original unit failed',
    description: 'Recorded against the unit being replaced, if any.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class AssignBikeDto {
  @ApiProperty()
  @IsUUID()
  customerId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class TransferBikeDto extends ReasonDto {
  @ApiProperty({ description: 'The rider taking over the bike' })
  @IsUUID()
  customerId!: string;
}

/** TRANSFERRED is not accepted here: moving a bike to another rider goes through transfer. */
export const ENDABLE_REASONS = [
  AssignmentEndReason.RETURNED,
  AssignmentEndReason.REPOSSESSED,
  AssignmentEndReason.SOLD,
] as const;
export type EndableReason = (typeof ENDABLE_REASONS)[number];

export class EndAssignmentDto {
  @ApiProperty({
    enum: ENDABLE_REASONS,
    description:
      'RETURNED puts the bike back in inventory, REPOSSESSED marks it repossessed, SOLD passes ' +
      'ownership to the rider for good.',
  })
  @IsIn(ENDABLE_REASONS)
  reason!: EndableReason;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}
