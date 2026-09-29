import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class CreateBikeDto {
  @ApiProperty({ example: 'Bike 7' })
  @IsString()
  @MaxLength(100)
  label!: string;

  @ApiProperty({ example: '356307042441013' })
  @IsString()
  @Matches(/^\d{14,17}$/)
  imei!: string;

  @ApiPropertyOptional({ example: 'KAA 123A' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  registrationNumber?: string;
}
