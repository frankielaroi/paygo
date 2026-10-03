import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { MAX_POLYGON_POINTS, MIN_POLYGON_POINTS } from '../geometry';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

const POLYGON_DESCRIPTION =
  'The zone outline: its corners in order as [latitude, longitude] pairs, not closed ' +
  '(the last corner joins the first).';

export class CreateGeofenceDto {
  @ApiProperty({ example: 'Greater Accra service area' })
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name!: string;

  @ApiProperty({
    description: POLYGON_DESCRIPTION,
    example: [
      [5.52, -0.3],
      [5.72, -0.3],
      [5.72, -0.05],
      [5.52, -0.05],
    ],
  })
  @IsArray()
  @ArrayMinSize(MIN_POLYGON_POINTS)
  @ArrayMaxSize(MAX_POLYGON_POINTS)
  polygon!: unknown[];
}

export class UpdateGeofenceDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name?: string;

  @ApiPropertyOptional({
    description:
      POLYGON_DESCRIPTION +
      ' Redrawing a zone starts it afresh: bikes are placed against the new outline without ' +
      'raising alerts for the move.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(MIN_POLYGON_POINTS)
  @ArrayMaxSize(MAX_POLYGON_POINTS)
  polygon?: unknown[];
}

export class GeofenceDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({
    description: POLYGON_DESCRIPTION,
    type: 'array',
    items: { type: 'array', items: { type: 'number' } },
  })
  polygon!: [number, number][];

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}
