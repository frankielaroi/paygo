import {
  ApiProperty,
  ApiPropertyOptional,
  OmitType,
  PartialType,
} from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { ContactType, CustomerStatus } from '../../generated/prisma/enums';

/** Spaces, dashes, dots and brackets are how people write numbers, not part of them. */
export function normalizePhone(value: string): string {
  return value.replace(/[\s\-().]/g, '');
}

const phone = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? normalizePhone(value) : value;
const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;
const trimUpper = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

const PHONE_PATTERN = /^\+?\d{9,15}$/;
const PHONE_MESSAGE = 'must be 9 to 15 digits, optionally starting with +';

export class CreateContactDto {
  @ApiProperty({ enum: ContactType })
  @IsEnum(ContactType)
  type!: ContactType;

  @ApiProperty()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  firstName!: string;

  @ApiProperty()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  lastName!: string;

  @ApiProperty({ example: '+233241234567' })
  @Transform(phone)
  @Matches(PHONE_PATTERN, { message: `phone ${PHONE_MESSAGE}` })
  phone!: string;

  @ApiPropertyOptional({ example: 'Brother' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  relationship?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trimUpper)
  @IsString()
  @MaxLength(40)
  nationalId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  addressLine?: string;
}

export class CreateCustomerDto {
  @ApiProperty({ example: 'Kofi' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  firstName!: string;

  @ApiProperty({ example: 'Mensah' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  lastName!: string;

  @ApiProperty({
    example: '+233241234567',
    description: 'The rider identity. Unique.',
  })
  @Transform(phone)
  @Matches(PHONE_PATTERN, { message: `phone ${PHONE_MESSAGE}` })
  phone!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(phone)
  @Matches(PHONE_PATTERN, { message: `alternatePhone ${PHONE_MESSAGE}` })
  alternatePhone?: string;

  @ApiProperty({ example: 'GHA-123456789-0', description: 'Unique.' })
  @Transform(trimUpper)
  @IsString()
  @MinLength(4)
  @MaxLength(40)
  nationalId!: string;

  @ApiPropertyOptional({ example: '1994-03-12' })
  @IsOptional()
  @IsDateString()
  dateOfBirth?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl({ require_tld: false })
  @MaxLength(500)
  photoUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl({ require_tld: false })
  @MaxLength(500)
  idDocumentUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  addressLine?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  ward?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  district?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  region?: string;

  @ApiPropertyOptional({
    description:
      'Admins only: the field agent who owns this rider. A field agent always owns the ' +
      'riders they register.',
  })
  @IsOptional()
  @IsUUID()
  assignedAgentId?: string;

  @ApiPropertyOptional({ type: CreateContactDto, isArray: true })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => CreateContactDto)
  contacts?: CreateContactDto[];
}

/**
 * Changing a name, national ID, date of birth, photo or ID document undoes KYC: what was
 * verified is no longer what is on file.
 */
export class UpdateCustomerDto extends PartialType(
  OmitType(CreateCustomerDto, ['assignedAgentId', 'contacts'] as const),
) {}

export class DeactivateCustomerDto {
  @ApiProperty({ example: 'Relocated outside the service area' })
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export const CUSTOMER_SORT_FIELDS = [
  'lastName',
  'firstName',
  'createdAt',
  'status',
] as const;
export type CustomerSortField = (typeof CUSTOMER_SORT_FIELDS)[number];

/**
 * `search` matches name, phone or national ID. Every word must match somewhere, so a full name
 * works, and phone numbers match with or without spaces.
 */
export class CustomerQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: CustomerStatus })
  @IsOptional()
  @IsEnum(CustomerStatus)
  status?: CustomerStatus;

  @ApiPropertyOptional({ enum: CUSTOMER_SORT_FIELDS, default: 'createdAt' })
  @IsOptional()
  @IsIn(CUSTOMER_SORT_FIELDS)
  sortBy?: CustomerSortField = 'createdAt';
}
