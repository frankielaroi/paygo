import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import { LoanFrequency } from '../../generated/prisma/enums';

export const LEAD_HOURS_MAX = 168;
export const GRACE_DAYS_MAX = 60;

export class UpdatePolicyDto {
  @ApiPropertyOptional({
    minimum: 0,
    maximum: LEAD_HOURS_MAX,
    description:
      'Hours a rider must have been warned before an overdue bike is locked automatically. ' +
      'Applies to every loan from the next enforcement sweep.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(LEAD_HOURS_MAX)
  lockoutWarningLeadHours?: number;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Installment suggested when a loan is opened, in minor units; null for no suggestion. ' +
      'Only a starting point: each loan keeps the terms it was opened with.',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  defaultInstallmentMinor?: number | null;

  @ApiPropertyOptional({ enum: LoanFrequency })
  @IsOptional()
  @IsEnum(LoanFrequency)
  defaultFrequency?: LoanFrequency;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: GRACE_DAYS_MAX,
    description:
      'Grace days suggested when a loan is opened. Existing loans keep their own.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(GRACE_DAYS_MAX)
  defaultGraceDays?: number;
}

export class PolicyEditorDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  firstName!: string;

  @ApiProperty()
  lastName!: string;
}

export class PolicyDto {
  @ApiProperty()
  lockoutWarningLeadHours!: number;

  @ApiProperty({ nullable: true })
  defaultInstallmentMinor!: number | null;

  @ApiProperty({ enum: LoanFrequency })
  defaultFrequency!: LoanFrequency;

  @ApiProperty()
  defaultGraceDays!: number;

  @ApiProperty()
  updatedAt!: Date;

  @ApiProperty({
    type: PolicyEditorDto,
    nullable: true,
    description: 'Who last changed a policy; null while still on the defaults',
  })
  updatedBy!: PolicyEditorDto | null;
}
