import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthenticatedStaff } from '../common/types/authenticated-staff';
import { Permission } from '../users/enums/role.enum';
import {
  CreateGeofenceDto,
  GeofenceDto,
  UpdateGeofenceDto,
} from './dto/geofence.dto';
import { GeofencesService } from './geofences.service';

/** Operating zones shown on the fleet map. Anyone who can see bikes can see them. */
@ApiTags('geofences')
@ApiBearerAuth('bearer')
@ApiForbiddenResponse({ description: 'Missing the required permission' })
@Controller('geofences')
export class GeofencesController {
  constructor(private readonly geofences: GeofencesService) {}

  @Get()
  @RequirePermissions(Permission.ASSET_READ)
  @ApiOperation({ summary: 'The operating zones' })
  @ApiOkResponse({ type: GeofenceDto, isArray: true })
  list(): Promise<GeofenceDto[]> {
    return this.geofences.list();
  }

  @Post()
  @RequirePermissions(Permission.ASSET_MANAGE)
  @ApiOperation({
    summary: 'Draw an operating zone',
    description:
      'From then on a bike crossing its boundary is recorded and shown in the dashboard ' +
      'activity feed. Bikes already outside it when it is drawn raise nothing.',
  })
  @ApiCreatedResponse({ type: GeofenceDto })
  @ApiBadRequestResponse({
    description: 'The outline does not enclose an area',
  })
  create(
    @Body() input: CreateGeofenceDto,
    @CurrentUser() user: AuthenticatedStaff,
  ): Promise<GeofenceDto> {
    return this.geofences.create(input, user.id);
  }

  @Patch(':id')
  @RequirePermissions(Permission.ASSET_MANAGE)
  @ApiOperation({ summary: 'Rename or redraw a zone' })
  @ApiOkResponse({ type: GeofenceDto })
  @ApiNotFoundResponse({ description: 'Zone not found' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: UpdateGeofenceDto,
  ): Promise<GeofenceDto> {
    return this.geofences.update(id, input);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(Permission.ASSET_MANAGE)
  @ApiOperation({
    summary: 'Remove a zone',
    description: 'Past crossings of it stay in the activity feed.',
  })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ description: 'Zone not found' })
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.geofences.remove(id);
  }
}
