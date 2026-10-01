import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthenticatedStaff } from '../common/types/authenticated-staff';
import {
  ActivityItemDto,
  ActivityQueryDto,
  CreateStaffDto,
  DeactivateStaffDto,
  StaffDto,
  StaffPageDto,
  StaffQueryDto,
  StaffWithPasswordDto,
  UpdateStaffDto,
} from './dto/staff.dto';
import { Permission } from './enums/role.enum';
import { StaffActivityService } from './staff-activity.service';
import { StaffService } from './staff.service';

@ApiTags('staff')
@ApiBearerAuth('bearer')
@ApiForbiddenResponse({ description: 'Requires the user:manage permission' })
@RequirePermissions(Permission.USER_MANAGE)
@Controller('staff')
export class StaffController {
  constructor(
    private readonly staff: StaffService,
    private readonly activity: StaffActivityService,
  ) {}

  @Post()
  @ApiOperation({
    summary: 'Create a staff account',
    description:
      'Returns a temporary password once. The account can do nothing but change it until it does.',
  })
  @ApiCreatedResponse({ type: StaffWithPasswordDto })
  @ApiConflictResponse({ description: 'Email or phone already in use' })
  create(
    @Body() input: CreateStaffDto,
    @CurrentUser() user: AuthenticatedStaff,
  ): Promise<StaffWithPasswordDto> {
    return this.staff.create(input, user);
  }

  @Get()
  @ApiOperation({ summary: 'Search staff by name, email or phone' })
  @ApiOkResponse({ type: StaffPageDto })
  list(@Query() query: StaffQueryDto): Promise<StaffPageDto> {
    return this.staff.list(query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'A staff member, with the permissions their role grants',
  })
  @ApiOkResponse({ type: StaffDto })
  @ApiNotFoundResponse({ description: 'Staff member not found' })
  get(@Param('id', ParseUUIDPipe) id: string): Promise<StaffDto> {
    return this.staff.get(id);
  }

  @Get(':id/activity')
  @ApiOperation({
    summary: "A staff member's recent actions, from every module's audit trail",
  })
  @ApiOkResponse({ type: ActivityItemDto, isArray: true })
  @ApiNotFoundResponse({ description: 'Staff member not found' })
  activityFor(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ActivityQueryDto,
  ): Promise<ActivityItemDto[]> {
    return this.activity.forStaff(
      id,
      query.limit,
      query.before ? new Date(query.before) : undefined,
    );
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Edit a staff member, including their role' })
  @ApiOkResponse({ type: StaffDto })
  @ApiNotFoundResponse({ description: 'Staff member not found' })
  @ApiConflictResponse({
    description: 'Own role, the last active admin, or email or phone in use',
  })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: UpdateStaffDto,
    @CurrentUser() user: AuthenticatedStaff,
  ): Promise<StaffDto> {
    return this.staff.update(id, input, user);
  }

  @Post(':id/deactivation')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Deactivate a staff account',
    description:
      'Sign-in stops at once and every session ends. The account and every record naming it stay.',
  })
  @ApiOkResponse({ type: StaffDto })
  @ApiConflictResponse({
    description: 'Own account, already deactivated, or the last active admin',
  })
  deactivate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: DeactivateStaffDto,
    @CurrentUser() user: AuthenticatedStaff,
  ): Promise<StaffDto> {
    return this.staff.deactivate(id, input.reason, user);
  }

  @Post(':id/reactivation')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reactivate a staff account' })
  @ApiOkResponse({ type: StaffDto })
  @ApiConflictResponse({ description: 'Already active' })
  reactivate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedStaff,
  ): Promise<StaffDto> {
    return this.staff.reactivate(id, user);
  }

  @Post(':id/password-reset')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Issue a new temporary password',
    description: 'Shown once. Every session of the account ends.',
  })
  @ApiOkResponse({ type: StaffWithPasswordDto })
  @ApiConflictResponse({
    description: 'Your own account: use POST /me/password',
  })
  resetPassword(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedStaff,
  ): Promise<StaffWithPasswordDto> {
    return this.staff.resetPassword(id, user);
  }
}
