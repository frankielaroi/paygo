import { ApiProperty } from '@nestjs/swagger';
import {
  DesiredStateSource,
  EnforcementEventType,
  MobilityState,
} from '../../generated/prisma/enums';

export class EnforcementStateDto {
  @ApiProperty()
  bikeId!: string;

  @ApiProperty({ enum: MobilityState })
  desiredState!: MobilityState;

  @ApiProperty({
    enum: DesiredStateSource,
    description:
      'STAFF locks are never lifted by the arrears sweep or payments.',
  })
  desiredSource!: DesiredStateSource;

  @ApiProperty({
    enum: MobilityState,
    nullable: true,
    description: 'What the device last confirmed. Null means unknown.',
  })
  confirmedState!: MobilityState | null;

  @ApiProperty({ nullable: true })
  confirmedAt!: Date | null;

  @ApiProperty({
    enum: MobilityState,
    nullable: true,
    description: 'A command written to the device and not yet confirmed.',
  })
  pendingCommand!: MobilityState | null;

  @ApiProperty({ nullable: true })
  pendingSentAt!: Date | null;

  @ApiProperty({
    nullable: true,
    description: 'Why the last reconcile did not send, e.g. interlock:moving.',
  })
  blockedReason!: string | null;

  @ApiProperty({ nullable: true })
  reviewReason!: string | null;

  @ApiProperty({ nullable: true })
  reviewSince!: Date | null;
}

export class EnforcementEventDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ enum: EnforcementEventType })
  type!: EnforcementEventType;

  @ApiProperty({
    nullable: true,
    description: 'The staff member who acted. Null for automatic actions.',
  })
  actorUserId!: string | null;

  @ApiProperty({
    nullable: true,
    example: 'Kwame Asante (deactivated)',
    description:
      'Who acted, still shown after their account is deactivated. Null for automatic actions.',
  })
  actorName!: string | null;

  @ApiProperty()
  trigger!: string;

  @ApiProperty({ enum: MobilityState, nullable: true })
  fromState!: MobilityState | null;

  @ApiProperty({ enum: MobilityState, nullable: true })
  toState!: MobilityState | null;

  @ApiProperty()
  reason!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    description: 'The telemetry the interlock relied on.',
  })
  telemetry!: unknown;

  @ApiProperty({ type: 'object', additionalProperties: true, nullable: true })
  detail!: unknown;

  @ApiProperty({ nullable: true })
  deviceResponse!: string | null;

  @ApiProperty()
  createdAt!: Date;
}

export class EnforcementViewDto {
  @ApiProperty()
  bikeId!: string;

  @ApiProperty({
    type: EnforcementStateDto,
    nullable: true,
    description: 'Null when enforcement has never acted on this bike.',
  })
  state!: EnforcementStateDto | null;

  @ApiProperty({ type: EnforcementEventDto, isArray: true })
  events!: EnforcementEventDto[];
}
