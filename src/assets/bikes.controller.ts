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
import { Permission } from '../users/enums/role.enum';
import { BikesService } from './bikes.service';
import {
  AssignBikeDto,
  CreateBikeDto,
  EndAssignmentDto,
  InstallTrackerDto,
  ReasonDto,
  TransferBikeDto,
  UpdateBikeDto,
} from './dto/bike-input.dto';
import { BikeQueryDto } from './dto/bike-query.dto';
import {
  BikeDetailDto,
  BikeMapDto,
  BikePageDto,
} from './dto/bike-response.dto';

@ApiTags('bikes')
@ApiBearerAuth('bearer')
@ApiForbiddenResponse({ description: 'Missing the required permission' })
@Controller('bikes')
export class BikesController {
  constructor(private readonly bikes: BikesService) {}

  @Post()
  @RequirePermissions(Permission.ASSET_MANAGE)
  @ApiOperation({ summary: 'Add a bike to inventory' })
  @ApiCreatedResponse({ type: BikeDetailDto })
  @ApiConflictResponse({ description: 'VIN or plate already registered' })
  create(
    @Body() input: CreateBikeDto,
    @CurrentUser() user: AuthenticatedStaff,
  ): Promise<BikeDetailDto> {
    return this.bikes.create(input, user.id);
  }

  @Get()
  @RequirePermissions(Permission.ASSET_READ)
  @ApiOperation({
    summary: 'Search bikes by plate, VIN, label, IMEI or current rider',
  })
  @ApiOkResponse({ type: BikePageDto })
  list(
    @Query() query: BikeQueryDto,
    @CurrentUser() user: AuthenticatedStaff,
  ): Promise<BikePageDto> {
    return this.bikes.list(query, user);
  }

  // Declared before :id so "map" is not read as a bike id.
  @Get('map')
  @RequirePermissions(Permission.ASSET_READ)
  @ApiOperation({
    summary: 'Every trackable bike for the fleet map, unpaged',
    description:
      'The same live status and lock controls as GET /bikes, so a marker and a row in the ' +
      'list can never disagree, plus the operating zones each bike is outside of.',
  })
  @ApiOkResponse({ type: BikeMapDto, isArray: true })
  map(@CurrentUser() user: AuthenticatedStaff): Promise<BikeMapDto[]> {
    return this.bikes.map(user);
  }

  @Get(':id')
  @RequirePermissions(Permission.ASSET_READ)
  @ApiOperation({
    summary: 'A bike with its tracker, rider and status history',
  })
  @ApiOkResponse({ type: BikeDetailDto })
  @ApiNotFoundResponse({ description: 'Bike not found' })
  get(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedStaff,
  ): Promise<BikeDetailDto> {
    return this.bikes.get(id, user);
  }

  @Patch(':id')
  @RequirePermissions(Permission.ASSET_MANAGE)
  @ApiOperation({
    summary: 'Edit identity and purchase details',
    description: 'Status, tracker and rider change through their own actions.',
  })
  @ApiOkResponse({ type: BikeDetailDto })
  @ApiNotFoundResponse({ description: 'Bike not found' })
  @ApiConflictResponse({ description: 'VIN or plate already registered' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: UpdateBikeDto,
  ): Promise<BikeDetailDto> {
    return this.bikes.update(id, input);
  }

  @Post(':id/tracker')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.ASSET_MANAGE)
  @ApiOperation({
    summary: 'Fit a tracker, replacing any unit already on the bike',
    description:
      'Enforcement treats the new unit as unconfirmed and drives it to the desired state; ' +
      'an immobilize still waits for the stationary interlock.',
  })
  @ApiOkResponse({ type: BikeDetailDto })
  @ApiConflictResponse({
    description: 'Tracker already on another bike, or bike sold or retired',
  })
  installTracker(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: InstallTrackerDto,
    @CurrentUser() user: AuthenticatedStaff,
  ): Promise<BikeDetailDto> {
    return this.bikes.installTracker(id, input, user.id);
  }

  @Post(':id/tracker/removal')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.ASSET_MANAGE)
  @ApiOperation({ summary: 'Remove the fitted tracker' })
  @ApiOkResponse({ type: BikeDetailDto })
  @ApiConflictResponse({ description: 'No tracker fitted' })
  removeTracker(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: ReasonDto,
    @CurrentUser() user: AuthenticatedStaff,
  ): Promise<BikeDetailDto> {
    return this.bikes.removeTracker(id, input.reason, user.id);
  }

  @Post(':id/assignment')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.ASSET_MANAGE)
  @ApiOperation({
    summary: 'Assign a bike in inventory to a KYC-verified rider',
  })
  @ApiOkResponse({ type: BikeDetailDto })
  @ApiConflictResponse({
    description:
      'Bike already assigned or not in inventory, or rider not eligible',
  })
  assign(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: AssignBikeDto,
    @CurrentUser() user: AuthenticatedStaff,
  ): Promise<BikeDetailDto> {
    return this.bikes.assign(id, input, user.id);
  }

  @Post(':id/transfer')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.ASSET_MANAGE)
  @ApiOperation({
    summary: 'Move an assigned bike to another rider',
    description: "The previous rider's assignment is closed, not overwritten.",
  })
  @ApiOkResponse({ type: BikeDetailDto })
  @ApiConflictResponse({
    description: 'Bike not assigned, or rider not eligible',
  })
  transfer(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: TransferBikeDto,
    @CurrentUser() user: AuthenticatedStaff,
  ): Promise<BikeDetailDto> {
    return this.bikes.transfer(id, input, user.id);
  }

  @Post(':id/assignment/end')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.ASSET_MANAGE)
  @ApiOperation({
    summary: 'End the current assignment: returned, repossessed or sold',
  })
  @ApiOkResponse({ type: BikeDetailDto })
  @ApiConflictResponse({ description: 'Bike not assigned' })
  endAssignment(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: EndAssignmentDto,
    @CurrentUser() user: AuthenticatedStaff,
  ): Promise<BikeDetailDto> {
    return this.bikes.endAssignment(id, input, user.id);
  }

  @Post(':id/restock')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.ASSET_MANAGE)
  @ApiOperation({ summary: 'Return a repossessed bike to inventory' })
  @ApiOkResponse({ type: BikeDetailDto })
  @ApiConflictResponse({ description: 'Bike is not repossessed' })
  restock(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: ReasonDto,
    @CurrentUser() user: AuthenticatedStaff,
  ): Promise<BikeDetailDto> {
    return this.bikes.restock(id, input.reason, user.id);
  }

  @Post(':id/retirement')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.ASSET_MANAGE)
  @ApiOperation({
    summary: 'Retire a bike from service',
    description:
      'The record and its history are kept. Not allowed while assigned.',
  })
  @ApiOkResponse({ type: BikeDetailDto })
  @ApiConflictResponse({
    description: 'Bike is assigned, sold or already retired',
  })
  retire(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: ReasonDto,
    @CurrentUser() user: AuthenticatedStaff,
  ): Promise<BikeDetailDto> {
    return this.bikes.retire(id, input.reason, user.id);
  }
}
