import { ApiProperty } from '@nestjs/swagger';

export class BikePositionDataDto {
  @ApiProperty()
  recordedAt!: Date;

  @ApiProperty()
  receivedAt!: Date;

  @ApiProperty()
  latitude!: number;

  @ApiProperty()
  longitude!: number;

  @ApiProperty()
  altitude!: number;

  @ApiProperty()
  angle!: number;

  @ApiProperty()
  satellites!: number;

  @ApiProperty({ description: 'Speed in km/h' })
  speed!: number;

  @ApiProperty({ nullable: true })
  ignition!: boolean | null;

  @ApiProperty({ nullable: true })
  movement!: boolean | null;

  @ApiProperty()
  hasFix!: boolean;

  @ApiProperty({
    nullable: true,
    description:
      'Pack voltage in mV (Teltonika IO 66). Null when not reported.',
  })
  externalVoltageMv!: number | null;

  @ApiProperty({
    nullable: true,
    description:
      'Tracker total odometer in metres (Teltonika IO 16). Null when not reported.',
  })
  odometerMeters!: number | null;
}

export class BikePositionDto extends BikePositionDataDto {
  @ApiProperty()
  id!: string;
}
