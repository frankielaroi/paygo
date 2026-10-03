import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  Max,
  Min,
} from 'class-validator';

export const HISTORY_KEEP = ['oldest', 'newest'] as const;
export type HistoryKeep = (typeof HISTORY_KEEP)[number];

export class TrackingQueryDto {
  @ApiProperty({
    description: 'Inclusive start of the device timestamp window',
  })
  @IsDateString()
  from!: string;

  @ApiProperty({ description: 'Inclusive end of the device timestamp window' })
  @IsDateString()
  to!: string;

  @ApiPropertyOptional({ default: 1000, minimum: 1, maximum: 5000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5000)
  limit: number = 1000;

  @ApiPropertyOptional({
    enum: HISTORY_KEEP,
    default: 'oldest',
    description:
      'Which positions to keep when the window holds more than limit. Either way the ' +
      'result is ordered oldest first.',
  })
  @IsOptional()
  @IsIn(HISTORY_KEEP)
  keep: HistoryKeep = 'oldest';
}
