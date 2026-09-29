import { ApiProperty } from '@nestjs/swagger';
import { PaginationMetaDto } from '../../common/dto/paginated-response.dto';
import {
  AssignmentEndReason,
  BikeStatus,
  MobilityState,
} from '../../generated/prisma/enums';

export class RiderRefDto {
  @ApiProperty()
  customerId!: string;

  @ApiProperty()
  firstName!: string;

  @ApiProperty()
  lastName!: string;

  @ApiProperty()
  phone!: string;
}

export class CurrentRiderDto extends RiderRefDto {
  @ApiProperty()
  assignmentId!: string;

  @ApiProperty()
  since!: Date;
}

/**
 * Mobility comes from enforcement, not from the bike's status: whether a bike is immobilized is
 * what the device confirmed, which a status column cannot know.
 */
export class MobilityDto {
  @ApiProperty({ enum: MobilityState })
  desiredState!: MobilityState;

  @ApiProperty({
    enum: MobilityState,
    nullable: true,
    description: 'Last state the device confirmed. Null means unknown.',
  })
  confirmedState!: MobilityState | null;
}

export class BikeSummaryDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  label!: string;

  @ApiProperty()
  vin!: string;

  @ApiProperty({ nullable: true })
  registrationNumber!: string | null;

  @ApiProperty()
  make!: string;

  @ApiProperty()
  model!: string;

  @ApiProperty({ nullable: true })
  year!: number | null;

  @ApiProperty({ nullable: true })
  color!: string | null;

  @ApiProperty({ enum: BikeStatus })
  status!: BikeStatus;

  @ApiProperty({ nullable: true, description: 'Tracker fitted now' })
  imei!: string | null;

  @ApiProperty({ type: CurrentRiderDto, nullable: true })
  currentRider!: CurrentRiderDto | null;

  @ApiProperty({
    type: MobilityDto,
    nullable: true,
    description: 'Null when enforcement has never acted on this bike',
  })
  mobility!: MobilityDto | null;

  @ApiProperty({ nullable: true })
  retiredAt!: Date | null;

  @ApiProperty()
  createdAt!: Date;
}

export class TrackerInstallationDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  imei!: string;

  @ApiProperty()
  installedAt!: Date;

  @ApiProperty({
    nullable: true,
    description: 'Null for trackers fitted before history was kept',
  })
  installedById!: string | null;

  @ApiProperty({ nullable: true })
  removedAt!: Date | null;

  @ApiProperty({ nullable: true })
  removedById!: string | null;

  @ApiProperty({ nullable: true })
  removedReason!: string | null;
}

export class AssignmentDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ type: RiderRefDto })
  rider!: RiderRefDto;

  @ApiProperty()
  startedAt!: Date;

  @ApiProperty()
  assignedById!: string;

  @ApiProperty({ nullable: true })
  endedAt!: Date | null;

  @ApiProperty({ enum: AssignmentEndReason, nullable: true })
  endReason!: AssignmentEndReason | null;

  @ApiProperty({ nullable: true })
  endedById!: string | null;

  @ApiProperty({ nullable: true })
  notes!: string | null;
}

export class StatusChangeDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ enum: BikeStatus, nullable: true })
  fromStatus!: BikeStatus | null;

  @ApiProperty({ enum: BikeStatus })
  toStatus!: BikeStatus;

  @ApiProperty()
  reason!: string;

  @ApiProperty()
  actorUserId!: string;

  @ApiProperty()
  createdAt!: Date;
}

export class BikeDetailDto extends BikeSummaryDto {
  @ApiProperty({ nullable: true, description: 'Minor units' })
  purchasePriceMinor!: number | null;

  @ApiProperty({ nullable: true })
  purchaseCurrency!: string | null;

  @ApiProperty({ nullable: true })
  purchasedAt!: Date | null;

  @ApiProperty({ nullable: true })
  supplier!: string | null;

  @ApiProperty({ type: TrackerInstallationDto, isArray: true })
  trackerHistory!: TrackerInstallationDto[];

  @ApiProperty({
    type: AssignmentDto,
    isArray: true,
    description: 'Every rider who has held this bike, newest first',
  })
  assignmentHistory!: AssignmentDto[];

  @ApiProperty({ type: StatusChangeDto, isArray: true })
  statusHistory!: StatusChangeDto[];
}

export class BikePageDto {
  @ApiProperty({ type: BikeSummaryDto, isArray: true })
  data!: BikeSummaryDto[];

  @ApiProperty({ type: PaginationMetaDto })
  meta!: PaginationMetaDto;
}
