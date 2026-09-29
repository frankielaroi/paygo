import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsString, MaxLength, MinLength } from 'class-validator';
import { MobilityState } from '../../generated/prisma/enums';

export class SetDesiredStateDto {
  @ApiProperty({
    enum: MobilityState,
    description:
      'IMMOBILIZED still waits for the stationary interlock. MOBILE is sent as soon as the ' +
      'device is reachable, and hands the bike back to automatic arrears control.',
  })
  @IsEnum(MobilityState)
  state!: MobilityState;

  @ApiProperty({
    example: 'Rider reported the bike stolen',
    description: 'Recorded in the audit log.',
  })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}
