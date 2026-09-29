import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsIn, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { BikeStatus } from '../../generated/prisma/enums';

export const BIKE_SORT_FIELDS = [
  'label',
  'registrationNumber',
  'createdAt',
  'status',
] as const;
export type BikeSortField = (typeof BIKE_SORT_FIELDS)[number];

/**
 * `search` matches plate, VIN, label, tracker IMEI, or the current rider's name or phone. Every
 * word must match somewhere, so "kofi mensah" finds a rider by full name.
 */
export class BikeQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: BikeStatus })
  @IsOptional()
  @IsEnum(BikeStatus)
  status?: BikeStatus;

  @ApiPropertyOptional({ enum: BIKE_SORT_FIELDS, default: 'createdAt' })
  @IsOptional()
  @IsIn(BIKE_SORT_FIELDS)
  sortBy?: BikeSortField = 'createdAt';
}
