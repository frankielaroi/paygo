import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthenticatedStaff } from '../common/types/authenticated-staff';
import { Permission } from '../users/enums/role.enum';
import { DashboardService } from './dashboard.service';
import {
  DashboardSummaryDto,
  FleetPageDto,
  FleetQueryDto,
  ReminderResultDto,
  SummaryQueryDto,
} from './dto/dashboard.dto';

/**
 * The FleetView dashboard. Lock and unlock are not here: clients call
 * POST /enforcement/bikes/:bikeId/desired-state, which applies the safety interlock.
 */
@ApiTags('dashboard')
@ApiBearerAuth('bearer')
@ApiForbiddenResponse({ description: 'Missing the required permission' })
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get()
  @RequirePermissions(Permission.DASHBOARD_READ)
  @ApiOperation({
    summary: 'KPIs, status counts, the overdue queue and recent activity',
    description:
      'Field agents see only their own riders. viewer says which actions to offer.',
  })
  @ApiOkResponse({ type: DashboardSummaryDto })
  summary(
    @CurrentUser() user: AuthenticatedStaff,
    @Query() query: SummaryQueryDto,
  ): Promise<DashboardSummaryDto> {
    return this.dashboard.summary(user, query);
  }

  @Get('fleet')
  @RequirePermissions(Permission.DASHBOARD_READ)
  @ApiOperation({
    summary:
      'Bikes on the road, filtered by status and searched by plate or rider',
    description: 'Immobilized first, then overdue, then offline, then active.',
  })
  @ApiOkResponse({ type: FleetPageDto })
  fleet(
    @CurrentUser() user: AuthenticatedStaff,
    @Query() query: FleetQueryDto,
  ): Promise<FleetPageDto> {
    return this.dashboard.fleet(user, query);
  }

  @Post('overdue/:loanId/reminder')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.REMINDER_SEND)
  @ApiOperation({
    summary: 'Send the rider an overdue reminder by SMS',
    description:
      'At most one per loan per day: pressing again returns the first one with sent: false.',
  })
  @ApiOkResponse({ type: ReminderResultDto })
  @ApiNotFoundResponse({ description: 'No open loan, or not your rider' })
  @ApiConflictResponse({
    description: 'Loan not overdue, or outside messaging hours',
  })
  sendReminder(
    @CurrentUser() user: AuthenticatedStaff,
    @Param('loanId', ParseUUIDPipe) loanId: string,
  ): Promise<ReminderResultDto> {
    return this.dashboard.sendReminder(user, loanId);
  }
}
