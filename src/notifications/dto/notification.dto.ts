import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional, IsUUID } from 'class-validator';
import { PaginationMetaDto } from '../../common/dto/paginated-response.dto';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import {
  NotificationKind,
  NotificationStatus,
  StaffAlertKind,
} from '../../generated/prisma/enums';

export class NotificationQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: NotificationStatus })
  @IsOptional()
  @IsEnum(NotificationStatus)
  status?: NotificationStatus;

  @ApiPropertyOptional({ enum: NotificationKind })
  @IsOptional()
  @IsEnum(NotificationKind)
  kind?: NotificationKind;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  loanId?: string;
}

export class StaffAlertQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    default: true,
    description: 'Only alerts nobody has acknowledged yet',
  })
  @IsOptional()
  @Transform(({ value }) => value !== 'false' && value !== false)
  @IsBoolean()
  open: boolean = true;
}

export class NotificationDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ enum: NotificationKind })
  kind!: NotificationKind;

  @ApiProperty({
    enum: NotificationStatus,
    description:
      'SENT means the provider accepted it; only DELIVERED means it reached the phone',
  })
  status!: NotificationStatus;

  @ApiProperty()
  customerId!: string;

  @ApiProperty({ nullable: true })
  loanId!: string | null;

  @ApiProperty({ nullable: true })
  bikeId!: string | null;

  @ApiProperty()
  channel!: string;

  @ApiProperty()
  recipient!: string;

  @ApiProperty()
  body!: string;

  @ApiProperty()
  attempts!: number;

  @ApiProperty({ nullable: true })
  lastError!: string | null;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty({ nullable: true })
  sentAt!: Date | null;

  @ApiProperty({ nullable: true })
  deliveredAt!: Date | null;

  @ApiProperty({ nullable: true })
  failedAt!: Date | null;
}

export class NotificationPageDto {
  @ApiProperty({ type: NotificationDto, isArray: true })
  data!: NotificationDto[];

  @ApiProperty({ type: PaginationMetaDto })
  meta!: PaginationMetaDto;
}

export class StaffAlertDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ enum: StaffAlertKind })
  kind!: StaffAlertKind;

  @ApiProperty()
  title!: string;

  @ApiProperty()
  detail!: string;

  @ApiProperty({ nullable: true })
  bikeId!: string | null;

  @ApiProperty({ nullable: true })
  customerId!: string | null;

  @ApiProperty({ nullable: true })
  notificationId!: string | null;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty({ nullable: true })
  acknowledgedAt!: Date | null;

  @ApiProperty({ nullable: true })
  acknowledgedById!: string | null;
}

export class StaffAlertPageDto {
  @ApiProperty({ type: StaffAlertDto, isArray: true })
  data!: StaffAlertDto[];

  @ApiProperty({ type: PaginationMetaDto })
  meta!: PaginationMetaDto;
}
