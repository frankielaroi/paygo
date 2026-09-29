import { ApiProperty } from '@nestjs/swagger';
import { BikePositionDataDto } from './bike-position.dto';

export class BikeStatusDto {
  @ApiProperty()
  bikeId!: string;

  @ApiProperty()
  label!: string;

  @ApiProperty({
    nullable: true,
    description: 'Null until a tracker is fitted',
  })
  imei!: string | null;

  @ApiProperty({ nullable: true })
  registrationNumber!: string | null;

  @ApiProperty({ nullable: true })
  lastReportedAt!: Date | null;

  @ApiProperty()
  online!: boolean;

  @ApiProperty({ type: BikePositionDataDto, nullable: true })
  current!: BikePositionDataDto | null;
}
