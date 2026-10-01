import { ApiProperty } from '@nestjs/swagger';
import { PaginationMetaDto } from '../../common/dto/paginated-response.dto';
import { RIDER_STANDINGS, type RiderStanding } from '../rider-standing';
import {
  AssignmentEndReason,
  ContactType,
  CustomerStatus,
} from '../../generated/prisma/enums';

export class BikeRefDto {
  @ApiProperty()
  bikeId!: string;

  @ApiProperty()
  label!: string;

  @ApiProperty({ nullable: true })
  registrationNumber!: string | null;

  @ApiProperty()
  vin!: string;
}

export class CustomerSummaryDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ enum: CustomerStatus })
  status!: CustomerStatus;

  @ApiProperty()
  firstName!: string;

  @ApiProperty()
  lastName!: string;

  @ApiProperty()
  phone!: string;

  @ApiProperty()
  nationalId!: string;

  @ApiProperty({ nullable: true })
  district!: string | null;

  @ApiProperty({ nullable: true })
  region!: string | null;

  @ApiProperty({ nullable: true })
  assignedAgentId!: string | null;

  @ApiProperty({ nullable: true })
  kycVerifiedAt!: Date | null;

  @ApiProperty({ type: BikeRefDto, isArray: true })
  currentBikes!: BikeRefDto[];

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty({
    enum: RIDER_STANDINGS,
    description:
      'active: holds a bike and is up to date. overdue: owes past grace on a held bike (the ' +
      "same arrears as the dashboard's overdue queue). no-bike: holds nothing right now.",
  })
  standing!: RiderStanding;
}

export class ContactDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ enum: ContactType })
  type!: ContactType;

  @ApiProperty()
  firstName!: string;

  @ApiProperty()
  lastName!: string;

  @ApiProperty()
  phone!: string;

  @ApiProperty({ nullable: true })
  relationship!: string | null;

  @ApiProperty({ nullable: true })
  nationalId!: string | null;

  @ApiProperty({ nullable: true })
  addressLine!: string | null;
}

export class RiderBikeHistoryDto {
  @ApiProperty()
  assignmentId!: string;

  @ApiProperty({ type: BikeRefDto })
  bike!: BikeRefDto;

  @ApiProperty()
  startedAt!: Date;

  @ApiProperty({ nullable: true })
  endedAt!: Date | null;

  @ApiProperty({ enum: AssignmentEndReason, nullable: true })
  endReason!: AssignmentEndReason | null;
}

/** Facts from the rider's own history. Not a score: the numbers are there for a person to read. */
export class RiderRiskDto {
  @ApiProperty({ description: 'Bikes ever assigned' })
  bikesHeld!: number;

  @ApiProperty({ description: 'Bikes held right now' })
  currentlyHolding!: number;

  @ApiProperty({ description: 'Assignments that ended in repossession' })
  repossessions!: number;

  @ApiProperty({ description: 'Bikes paid off and sold to the rider' })
  paidOff!: number;
}

export class CustomerDetailDto extends CustomerSummaryDto {
  @ApiProperty({ nullable: true })
  alternatePhone!: string | null;

  @ApiProperty({ nullable: true })
  dateOfBirth!: Date | null;

  @ApiProperty({ nullable: true })
  photoUrl!: string | null;

  @ApiProperty({ nullable: true })
  idDocumentUrl!: string | null;

  @ApiProperty({ nullable: true })
  addressLine!: string | null;

  @ApiProperty({ nullable: true })
  ward!: string | null;

  @ApiProperty()
  registeredById!: string;

  @ApiProperty({ nullable: true })
  kycVerifiedById!: string | null;

  @ApiProperty({ nullable: true })
  deactivatedAt!: Date | null;

  @ApiProperty({ nullable: true })
  deactivationReason!: string | null;

  @ApiProperty({ type: ContactDto, isArray: true })
  contacts!: ContactDto[];

  @ApiProperty({
    type: RiderBikeHistoryDto,
    isArray: true,
    description:
      'Every bike this rider has held, newest first. Contracts attach here once they exist.',
  })
  bikeHistory!: RiderBikeHistoryDto[];

  @ApiProperty({ type: RiderRiskDto })
  risk!: RiderRiskDto;
}

/** Riders matching the search, by standing, before the standing filter applies. */
export class RiderCountsDto {
  @ApiProperty()
  all!: number;

  @ApiProperty()
  active!: number;

  @ApiProperty()
  overdue!: number;

  @ApiProperty()
  noBike!: number;
}

export class CustomerPageDto {
  @ApiProperty({ type: CustomerSummaryDto, isArray: true })
  data!: CustomerSummaryDto[];

  @ApiProperty({ type: PaginationMetaDto })
  meta!: PaginationMetaDto;

  @ApiProperty({ type: RiderCountsDto })
  counts!: RiderCountsDto;
}
