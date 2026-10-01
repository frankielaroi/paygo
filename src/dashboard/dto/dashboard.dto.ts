import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { PaginationMetaDto } from '../../common/dto/paginated-response.dto';
import { FLEET_STATUSES, type FleetStatus } from '../fleet-status';

export class MoneyDto {
  @ApiProperty({ example: 'GHS' })
  currency!: string;

  @ApiProperty({ example: 824000, description: 'Minor units (pesewas)' })
  amountMinor!: number;
}

export class DashboardKpisDto {
  @ApiProperty({
    description: 'Bikes on the road whose tracker reported recently',
  })
  bikesOnline!: number;

  @ApiProperty({ description: 'Bikes on the road (assigned to a rider)' })
  bikesTotal!: number;

  @ApiProperty({ description: 'Open loans owing past grace' })
  overdueLoans!: number;

  @ApiProperty({
    type: MoneyDto,
    isArray: true,
    description: 'Owed past grace, per currency',
  })
  overdueTotal!: MoneyDto[];

  @ApiProperty({
    type: MoneyDto,
    isArray: true,
    description: 'Money received since midnight UTC (Ghana time), per currency',
  })
  collectedToday!: MoneyDto[];

  @ApiProperty({ description: 'Distinct loans paid into today' })
  loansPaidToday!: number;

  @ApiProperty({
    description:
      'Bikes enforcement wants to lock but whose position cannot be trusted',
  })
  flaggedForReview!: number;
}

export class StatusCountsDto {
  @ApiProperty()
  all!: number;

  @ApiProperty()
  active!: number;

  @ApiProperty()
  overdue!: number;

  @ApiProperty()
  immobilized!: number;

  @ApiProperty()
  offline!: number;
}

export class OverdueItemDto {
  @ApiProperty()
  loanId!: string;

  @ApiProperty()
  bikeId!: string;

  @ApiProperty()
  customerId!: string;

  @ApiProperty({ example: 'Yaw Owusu' })
  rider!: string;

  @ApiProperty({ example: 'M-24-GR 8834' })
  plate!: string;

  @ApiProperty({ type: MoneyDto })
  overdue!: MoneyDto;

  @ApiProperty({
    description: 'Whole days since the oldest unpaid installment passed grace',
  })
  daysOverdue!: number;

  @ApiProperty({ description: 'The bike is immobilized right now' })
  immobilized!: boolean;

  @ApiProperty({
    description:
      'A reminder was already sent by hand today; the button should show "Sent"',
  })
  reminderSentToday!: boolean;
}

export class ActivityDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({
    example: 'System',
    description: 'Staff name, or System for automatic actions',
  })
  actor!: string;

  @ApiProperty({ example: 'immobilized M-22-GR 1187' })
  action!: string;

  @ApiProperty({ example: 'Loan overdue GHS 45.00' })
  detail!: string;

  @ApiProperty({
    description: 'When it happened; clients show it as "58 min ago"',
  })
  at!: Date;

  @ApiProperty({ nullable: true })
  bikeId!: string | null;
}

export class ViewerDto {
  @ApiProperty({ description: 'Show Lock and Unlock buttons' })
  canImmobilize!: boolean;

  @ApiProperty({ description: 'Show Send reminder buttons' })
  canSendReminders!: boolean;

  @ApiProperty({ description: 'The view is limited to riders assigned to you' })
  ownRidersOnly!: boolean;
}

export class DashboardSummaryDto {
  @ApiProperty({ type: ViewerDto })
  viewer!: ViewerDto;

  @ApiProperty({ type: DashboardKpisDto })
  kpis!: DashboardKpisDto;

  @ApiProperty({ type: StatusCountsDto })
  statusCounts!: StatusCountsDto;

  @ApiProperty({
    type: OverdueItemDto,
    isArray: true,
    description: 'Longest overdue first',
  })
  overdueQueue!: OverdueItemDto[];

  @ApiProperty({
    type: ActivityDto,
    isArray: true,
    description: 'Newest first',
  })
  recentActivity!: ActivityDto[];

  @ApiProperty()
  generatedAt!: Date;
}

export class FleetRowDto {
  @ApiProperty()
  bikeId!: string;

  @ApiProperty({ example: 'M-24-GR 4471' })
  plate!: string;

  @ApiProperty({ example: 'ACC-014' })
  label!: string;

  @ApiProperty()
  customerId!: string;

  @ApiProperty({ example: 'Kwame Boateng' })
  rider!: string;

  @ApiProperty({
    nullable: true,
    description: 'The open loan on this bike, if any',
  })
  loanId!: string | null;

  @ApiProperty({ enum: FLEET_STATUSES })
  status!: FleetStatus;

  @ApiProperty({
    nullable: true,
    description: 'km/h from the last reading; null when offline',
  })
  speedKmh!: number | null;

  @ApiProperty({ nullable: true, description: 'Last report from the tracker' })
  lastSeenAt!: Date | null;

  @ApiProperty({
    type: MoneyDto,
    nullable: true,
    description: 'Owed past grace, if any',
  })
  overdue!: MoneyDto | null;

  @ApiProperty({
    description:
      'A lock may be requested. It is still sent only once the stationary interlock passes.',
  })
  canLock!: boolean;

  @ApiProperty({ description: 'An unlock may be requested' })
  canUnlock!: boolean;

  @ApiProperty({
    description: 'A lock is requested but not yet confirmed by the device',
  })
  lockPending!: boolean;
}

export class FleetPageDto {
  @ApiProperty({ type: FleetRowDto, isArray: true })
  data!: FleetRowDto[];

  @ApiProperty({ type: PaginationMetaDto })
  meta!: PaginationMetaDto;
}

export class FleetQueryDto {
  @ApiPropertyOptional({ enum: FLEET_STATUSES })
  @IsOptional()
  @IsIn(FLEET_STATUSES)
  status?: FleetStatus;

  @ApiPropertyOptional({ description: 'Plate, fleet label or rider name' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ default: 25, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 25;
}

export class SummaryQueryDto {
  @ApiPropertyOptional({ default: 10, minimum: 1, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  overdueLimit: number = 10;

  @ApiPropertyOptional({ default: 15, minimum: 1, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  activityLimit: number = 15;
}

export class ReminderResultDto {
  @ApiProperty({
    description: 'False when one was already sent today: nothing new went out',
  })
  sent!: boolean;

  @ApiProperty()
  sentAt!: Date;
}
