import { ApiProperty } from '@nestjs/swagger';
import { BikePositionDataDto } from './bike-position.dto';

export class BikeStatusDto {
  @ApiProperty()
  bikeId!: string;

  @ApiProperty()
  label!: string;

  @ApiProperty()
  imei!: string;

  @ApiProperty({ nullable: true })
  registrationNumber!: string | null;

  @ApiProperty({ nullable: true })
  lastReportedAt!: Date | null;

  @ApiProperty()
  online!: boolean;

  @ApiProperty({ type: BikePositionDataDto, nullable: true })
  current!: BikePositionDataDto | null;
}
