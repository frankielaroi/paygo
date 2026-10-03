import {
  ApiProperty,
  ApiPropertyOptional,
  PartialType,
  PickType,
} from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEmail,
  IsEnum,
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
import { StaffRole } from '../enums/role.enum';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;
const lower = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;
const phone = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.replace(/[\s\-().]/g, '') : value;

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

export class CreateStaffDto {
  @ApiProperty({ example: 'ama.owusu@paygo.example' })
  @Transform(lower)
  @IsEmail()
  @MaxLength(200)
  email!: string;

  @ApiProperty({ example: 'Ama' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  firstName!: string;

  @ApiProperty({ example: 'Owusu' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  lastName!: string;

  @ApiPropertyOptional({ example: '+233241234567' })
  @IsOptional()
  @Transform(phone)
  @Matches(/^\+?\d{9,15}$/, {
    message: 'phone must be 9 to 15 digits, optionally starting with +',
  })
  phone?: string;

  @ApiProperty({ enum: StaffRole, enumName: 'StaffRole' })
  @IsEnum(StaffRole)
  role!: StaffRole;

  @ApiPropertyOptional({ example: 'Kumasi' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  branch?: string;

  @ApiPropertyOptional({ description: 'An active staff member' })
  @IsOptional()
  @IsUUID()
  supervisorId?: string;
}

/** Everything an admin may change. Email is the login identity and stays fixed. */
export class UpdateStaffDto extends PartialType(
  PickType(CreateStaffDto, [
    'firstName',
    'lastName',
    'phone',
    'role',
    'branch',
    'supervisorId',
  ] as const),
) {}

/** What staff may change about themselves: never their role, branch or email. */
export class UpdateMeDto extends PartialType(
  PickType(CreateStaffDto, ['firstName', 'lastName', 'phone'] as const),
) {}

export class ChangePasswordDto {
  @ApiProperty()
  @IsString()
  @MaxLength(PASSWORD_MAX)
  currentPassword!: string;

  @ApiProperty({ minLength: PASSWORD_MIN, maxLength: PASSWORD_MAX })
  @IsString()
  @MinLength(PASSWORD_MIN)
  @MaxLength(PASSWORD_MAX)
  newPassword!: string;
}

export class DeactivateStaffDto {
  @ApiProperty({ example: 'Left the company' })
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export class StaffQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: StaffRole, enumName: 'StaffRole' })
  @IsOptional()
  @IsEnum(StaffRole)
  role?: StaffRole;

  @ApiPropertyOptional({ description: 'Only active, or only deactivated' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }): unknown =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  active?: boolean;
}

export class ActivityQueryDto {
  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit: number = 50;

  @ApiPropertyOptional({
    description: 'Only actions before this instant, to page back in time',
  })
  @IsOptional()
  @IsDateString()
  before?: string;
}

export class StaffDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  email!: string;

  @ApiProperty()
  firstName!: string;

  @ApiProperty()
  lastName!: string;

  @ApiProperty({ nullable: true })
  phone!: string | null;

  @ApiProperty({ enum: StaffRole, enumName: 'StaffRole' })
  role!: StaffRole;

  @ApiProperty({
    type: String,
    isArray: true,
    description:
      'Derived from the role alone, so two people with the same role always match',
  })
  permissions!: string[];

  @ApiProperty({ nullable: true })
  branch!: string | null;

  @ApiProperty({ nullable: true })
  supervisorId!: string | null;

  @ApiProperty()
  isActive!: boolean;

  @ApiProperty({ description: 'Still holding a temporary password' })
  mustChangePassword!: boolean;

  @ApiProperty({ nullable: true })
  passwordChangedAt!: Date | null;

  @ApiProperty({ nullable: true })
  lastLoginAt!: Date | null;

  @ApiProperty({ nullable: true })
  deactivatedAt!: Date | null;

  @ApiProperty({ nullable: true })
  deactivationReason!: string | null;

  @ApiProperty()
  createdAt!: Date;
}

export class StaffWithPasswordDto {
  @ApiProperty({ type: StaffDto })
  staff!: StaffDto;

  @ApiProperty({
    description:
      'Shown once and never stored in clear. Give it to the person directly; they must ' +
      'change it before they can do anything else.',
  })
  temporaryPassword!: string;
}

export class StaffPageDto {
  @ApiProperty({ type: StaffDto, isArray: true })
  data!: StaffDto[];

  @ApiProperty({ type: PaginationMetaDto })
  meta!: PaginationMetaDto;
}

export class ActivityItemDto {
  @ApiProperty()
  at!: Date;

  @ApiProperty({
    example: 'MANUAL_LOCK',
    description:
      'MANUAL_LOCK, MANUAL_UNLOCK, LOAN_CREATED, LOAN_DEFAULTED, LOAN_REPOSSESSED, ' +
      'LOAN_WRITTEN_OFF, ' +
      'PAYMENT_RECORDED, PAYMENT_ALLOCATED, BIKE_STATUS_CHANGED, TRACKER_FITTED, ' +
      'TRACKER_REMOVED, RIDER_REGISTERED, KYC_VERIFIED, ALERT_ACKNOWLEDGED, or a staff ' +
      'account change',
  })
  action!: string;

  @ApiProperty()
  summary!: string;

  @ApiProperty({ nullable: true })
  bikeId!: string | null;

  @ApiProperty({ nullable: true })
  customerId!: string | null;

  @ApiProperty({ nullable: true })
  loanId!: string | null;

  @ApiProperty({ nullable: true })
  paymentId!: string | null;

  @ApiProperty({ nullable: true })
  staffId!: string | null;
}
