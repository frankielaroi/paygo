import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AllowPendingPasswordChange } from '../common/decorators/allow-pending-password-change.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CredentialThrottle } from '../common/decorators/credential-throttle.decorator';
import type { AuthenticatedStaff } from '../common/types/authenticated-staff';
import { ChangePasswordDto, StaffDto, UpdateMeDto } from './dto/staff.dto';
import { StaffService } from './staff.service';

/**
 * Self-service for every signed-in staff member, whatever their role: no permission needed,
 * and only ever the caller's own account.
 */
@ApiTags('me')
@ApiBearerAuth('bearer')
@Controller('me')
export class MeController {
  constructor(private readonly staff: StaffService) {}

  @Get()
  @AllowPendingPasswordChange()
  @ApiOperation({ summary: 'Your own profile' })
  @ApiOkResponse({ type: StaffDto })
  get(@CurrentUser() user: AuthenticatedStaff): Promise<StaffDto> {
    return this.staff.getMe(user);
  }

  @Patch()
  @ApiOperation({
    summary: 'Update your name or phone',
    description: 'Role, branch and email are changed by an admin.',
  })
  @ApiOkResponse({ type: StaffDto })
  update(
    @Body() input: UpdateMeDto,
    @CurrentUser() user: AuthenticatedStaff,
  ): Promise<StaffDto> {
    return this.staff.updateMe(input, user);
  }

  @Post('password')
  @AllowPendingPasswordChange()
  @CredentialThrottle()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Change your password',
    description:
      'Needs the current password. Ends every session, including this one: sign in again ' +
      'with the new password.',
  })
  @ApiNoContentResponse({ description: 'Changed; all sessions ended' })
  @ApiUnauthorizedResponse({ description: 'Current password is incorrect' })
  @ApiBadRequestResponse({ description: 'New password too short or unchanged' })
  changePassword(
    @Body() input: ChangePasswordDto,
    @CurrentUser() user: AuthenticatedStaff,
  ): Promise<void> {
    return this.staff.changePassword(
      user,
      input.currentPassword,
      input.newPassword,
    );
  }
}
