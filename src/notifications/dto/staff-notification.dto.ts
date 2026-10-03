import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  ValidateNested,
} from 'class-validator';
import { StaffNotificationTopic } from '../../generated/prisma/enums';

export class TopicPreferenceDto {
  @ApiProperty({
    enum: StaffNotificationTopic,
    description:
      'LOAN_OVERDUE is one message a day listing the loans that became overdue. ' +
      'BIKE_OFFLINE and GEOFENCE_EXIT are sent as they happen.',
  })
  @IsEnum(StaffNotificationTopic)
  topic!: StaffNotificationTopic;

  @ApiProperty({ description: 'Text this alert to my phone' })
  @IsBoolean()
  sms!: boolean;
}

export class UpdateNotificationPreferencesDto {
  @ApiProperty({ type: TopicPreferenceDto, isArray: true })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => TopicPreferenceDto)
  topics!: TopicPreferenceDto[];
}

export class NotificationPreferencesDto {
  @ApiProperty({
    nullable: true,
    description:
      'The number alerts are texted to (your profile phone); none are sent without one',
  })
  phone!: string | null;

  @ApiProperty({
    type: TopicPreferenceDto,
    isArray: true,
    description: 'Every topic, off unless you turned it on',
  })
  topics!: TopicPreferenceDto[];
}
