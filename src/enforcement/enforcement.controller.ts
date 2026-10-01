import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthenticatedStaff } from '../common/types/authenticated-staff';
import type { BikeEnforcement } from '../generated/prisma/client';
import { Permission } from '../users/enums/role.enum';
import {
  EnforcementEventDto,
  EnforcementStateDto,
  EnforcementViewDto,
} from './dto/enforcement-view.dto';
import { SetDesiredStateDto } from './dto/set-desired-state.dto';
import {
  EnforcementService,
  type EnforcementView,
} from './enforcement.service';

@ApiTags('enforcement')
@ApiBearerAuth('bearer')
@ApiForbiddenResponse({
  description: 'Requires the asset:immobilize permission',
})
@RequirePermissions(Permission.ASSET_IMMOBILIZE)
@Controller('enforcement')
export class EnforcementController {
  constructor(private readonly enforcement: EnforcementService) {}

  @Get('review')
  @RequirePermissions(Permission.ASSET_IMMOBILIZE_ANY)
  @ApiOperation({
    summary:
      'Bikes where an immobilize is wanted but telemetry is missing, stale or offline',
  })
  @ApiOkResponse({ type: EnforcementStateDto, isArray: true })
  async review(): Promise<EnforcementStateDto[]> {
    const rows = await this.enforcement.listForReview();
    return rows.map(toStateDto);
  }

  @Get('bikes/:bikeId')
  @ApiOperation({
    summary: 'Desired and confirmed state, with recent audit events',
  })
  @ApiOkResponse({ type: EnforcementViewDto })
  @ApiNotFoundResponse({
    description:
      'Bike not found, or (field agents) not held by one of your riders',
  })
  async get(
    @Param('bikeId', ParseUUIDPipe) bikeId: string,
    @CurrentUser() user: AuthenticatedStaff,
  ): Promise<EnforcementViewDto> {
    return toViewDto(
      bikeId,
      await this.enforcement.getEnforcement(bikeId, user),
    );
  }

  @Post('bikes/:bikeId/desired-state')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Manually lock or unlock a bike',
    description:
      'Sets the desired state; it does not send a command directly. An immobilize is sent ' +
      'only once the stationary interlock passes, so the response may show it deferred. ' +
      'Field agents may act only on bikes held by riders assigned to them.',
  })
  @ApiOkResponse({ type: EnforcementViewDto })
  @ApiNotFoundResponse({
    description:
      'Bike not found, or (field agents) not held by one of your riders',
  })
  async setDesiredState(
    @Param('bikeId', ParseUUIDPipe) bikeId: string,
    @Body() input: SetDesiredStateDto,
    @CurrentUser() user: AuthenticatedStaff,
  ): Promise<EnforcementViewDto> {
    return toViewDto(
      bikeId,
      await this.enforcement.setDesiredStateByStaff(
        bikeId,
        input.state,
        user,
        input.reason,
      ),
    );
  }
}

function toStateDto(row: BikeEnforcement): EnforcementStateDto {
  return {
    bikeId: row.bikeId,
    desiredState: row.desiredState,
    desiredSource: row.desiredSource,
    confirmedState: row.confirmedState,
    confirmedAt: row.confirmedAt,
    pendingCommand: row.pendingCommand,
    pendingSentAt: row.pendingSentAt,
    blockedReason: row.blockedReason,
    reviewReason: row.reviewReason,
    reviewSince: row.reviewSince,
  };
}

function toEventDto(
  event: EnforcementView['events'][number],
): EnforcementEventDto {
  return {
    id: event.id,
    type: event.type,
    actorUserId: event.actorUserId,
    actorName: event.actor
      ? `${event.actor.firstName} ${event.actor.lastName}${event.actor.isActive ? '' : ' (deactivated)'}`
      : null,
    trigger: event.trigger,
    fromState: event.fromState,
    toState: event.toState,
    reason: event.reason,
    telemetry: event.telemetry,
    detail: event.detail,
    deviceResponse: event.deviceResponse,
    createdAt: event.createdAt,
  };
}

function toViewDto(bikeId: string, view: EnforcementView): EnforcementViewDto {
  return {
    bikeId,
    state: view.state ? toStateDto(view.state) : null,
    events: view.events.map(toEventDto),
  };
}
