import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDateString, IsInt, IsOptional, Max, Min } from 'class-validator';

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
}
