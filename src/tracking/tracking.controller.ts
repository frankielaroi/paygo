import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  Sse,
  MessageEvent,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { Permission } from '../users/enums/role.enum';
import { BikePositionDto } from './dto/bike-position.dto';
import { BikeStatusDto } from './dto/bike-status.dto';
import { TrackingQueryDto } from './dto/tracking-query.dto';
import { map, Observable } from 'rxjs';
import { TrackingService } from './tracking.service';

/** Read-only telemetry views. Bikes are added and fitted with trackers in the assets module. */
@ApiTags('tracking')
@ApiBearerAuth('bearer')
@RequirePermissions(Permission.ASSET_READ)
@Controller('tracking')
export class TrackingController {
  constructor(private readonly tracking: TrackingService) {}

  @Get('bikes')
  @ApiOperation({ summary: 'List current status for tracked bikes' })
  @ApiOkResponse({ type: BikeStatusDto, isArray: true })
  listBikes(): Promise<BikeStatusDto[]> {
    return this.tracking.listBikeStatuses();
  }

  @Get('bikes/:bikeId')
  @ApiOperation({ summary: 'Get current status for a bike' })
  @ApiOkResponse({ type: BikeStatusDto })
  @ApiNotFoundResponse({ description: 'Bike not found' })
  getBike(
    @Param('bikeId', ParseUUIDPipe) bikeId: string,
  ): Promise<BikeStatusDto> {
    return this.tracking.getBikeStatus(bikeId);
  }

  @Get('bikes/:bikeId/positions')
  @ApiOperation({ summary: 'Read position history in a date window' })
  @ApiQuery({ name: 'from', required: true, type: String })
  @ApiQuery({ name: 'to', required: true, type: String })
  @ApiQuery({ name: 'limit', required: false, type: Number, maximum: 5000 })
  @ApiOkResponse({ type: BikePositionDto, isArray: true })
  @ApiNotFoundResponse({ description: 'Bike not found' })
  positionHistory(
    @Param('bikeId', ParseUUIDPipe) bikeId: string,
    @Query() query: TrackingQueryDto,
  ): Promise<BikePositionDto[]> {
    return this.tracking.getPositionHistory(
      bikeId,
      new Date(query.from),
      new Date(query.to),
      query.limit,
      query.keep,
    );
  }

  @Sse('events')
  @ApiOperation({ summary: 'Stream current position updates' })
  @ApiProduces('text/event-stream')
  positionEvents(): Observable<MessageEvent> {
    return this.tracking.watchPositionUpdates().pipe(map((data) => ({ data })));
  }
}
