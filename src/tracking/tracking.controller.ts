import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Sse,
  MessageEvent,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Roles } from '../common/decorators/roles.decorator';
import { StaffRole } from '../users/enums/role.enum';
import { BikePositionDto } from './dto/bike-position.dto';
import { BikeStatusDto } from './dto/bike-status.dto';
import { CreateBikeDto } from './dto/create-bike.dto';
import { TrackingQueryDto } from './dto/tracking-query.dto';
import { map, Observable } from 'rxjs';
import { TrackingService } from './tracking.service';

@ApiTags('tracking')
@ApiBearerAuth('bearer')
@Roles(StaffRole.ADMIN)
@Controller('tracking')
export class TrackingController {
  constructor(private readonly tracking: TrackingService) {}

  @Post('bikes')
  @ApiOperation({ summary: 'Register a bike and its tracker IMEI' })
  @ApiCreatedResponse({ type: BikeStatusDto })
  registerBike(@Body() input: CreateBikeDto): Promise<BikeStatusDto> {
    return this.tracking.registerBike(input);
  }

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
    );
  }

  @Sse('events')
  @ApiOperation({ summary: 'Stream current position updates' })
  @ApiProduces('text/event-stream')
  positionEvents(): Observable<MessageEvent> {
    return this.tracking.watchPositionUpdates().pipe(map((data) => ({ data })));
  }
}
