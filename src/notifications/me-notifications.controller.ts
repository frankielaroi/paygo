import { Body, Controller, Get, Put } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedStaff } from '../common/types/authenticated-staff';
import {
  NotificationPreferencesDto,
  UpdateNotificationPreferencesDto,
} from './dto/staff-notification.dto';
import { StaffNotifierService } from './staff-notifier.service';

/**
 * Each staff member's own alert preferences. No permission needed and no user id in the path:
 * nobody reads or changes anyone else's.
 */
@ApiTags('me')
@ApiBearerAuth('bearer')
@Controller('me/notification-preferences')
export class MeNotificationsController {
  constructor(private readonly notifier: StaffNotifierService) {}

  @Get()
  @ApiOperation({ summary: 'Which alerts are texted to you' })
  @ApiOkResponse({ type: NotificationPreferencesDto })
  get(
    @CurrentUser() user: AuthenticatedStaff,
  ): Promise<NotificationPreferencesDto> {
    return this.notifier.preferencesOf(user.id);
  }

  @Put()
  @ApiOperation({
    summary: 'Turn your own alerts on or off',
    description:
      'Takes effect from the next alert. Topics left out keep their current setting.',
  })
  @ApiOkResponse({ type: NotificationPreferencesDto })
  update(
    @Body() input: UpdateNotificationPreferencesDto,
    @CurrentUser() user: AuthenticatedStaff,
  ): Promise<NotificationPreferencesDto> {
    return this.notifier.setPreferences(user.id, input.topics);
  }
}
