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
import { PaginatedResponseDto } from '../common/dto/paginated-response.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthenticatedStaff } from '../common/types/authenticated-staff';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { Permission } from '../users/enums/role.enum';
import {
  NotificationPageDto,
  NotificationQueryDto,
  StaffAlertDto,
  StaffAlertPageDto,
  StaffAlertQueryDto,
} from './dto/notification.dto';
import { StaffAlertsService } from './staff-alerts.service';

@ApiTags('notifications')
@ApiBearerAuth('bearer')
@ApiForbiddenResponse({
  description: 'Requires the notification:read permission',
})
@RequirePermissions(Permission.NOTIFICATION_READ)
@Controller()
export class NotificationsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly alerts: StaffAlertsService,
  ) {}

  @Get('notifications')
  @ApiOperation({
    summary: 'Rider messages and whether each went out, e.g. failed warnings',
  })
  @ApiOkResponse({ type: NotificationPageDto })
  async list(
    @Query() query: NotificationQueryDto,
  ): Promise<NotificationPageDto> {
    const where: Prisma.NotificationWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(query.loanId ? { loanId: query.loanId } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: query.sortOrder ?? 'desc' },
        skip: query.skip,
        take: query.limit,
        select: {
          id: true,
          kind: true,
          status: true,
          customerId: true,
          loanId: true,
          bikeId: true,
          channel: true,
          recipient: true,
          body: true,
          attempts: true,
          lastError: true,
          createdAt: true,
          sentAt: true,
          deliveredAt: true,
          failedAt: true,
        },
      }),
      this.prisma.notification.count({ where }),
    ]);
    return new PaginatedResponseDto(rows, total, query.page, query.limit);
  }

  @Get('staff-alerts')
  @ApiOperation({ summary: 'Things a person needs to look at' })
  @ApiOkResponse({ type: StaffAlertPageDto })
  async alertsList(
    @Query() query: StaffAlertQueryDto,
  ): Promise<StaffAlertPageDto> {
    const [rows, total] = await this.alerts.list(
      query.open,
      query.limit,
      query.skip,
    );
    return new PaginatedResponseDto(
      rows.map(toAlertDto),
      total,
      query.page,
      query.limit,
    );
  }

  @Post('staff-alerts/:id/acknowledgement')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark an alert as handled' })
  @ApiOkResponse({ type: StaffAlertDto })
  @ApiNotFoundResponse({ description: 'Alert not found' })
  @ApiConflictResponse({ description: 'Already acknowledged' })
  async acknowledge(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedStaff,
  ): Promise<StaffAlertDto> {
    return toAlertDto(await this.alerts.acknowledge(id, user.id));
  }
}

function toAlertDto(alert: StaffAlertDto): StaffAlertDto {
  return {
    id: alert.id,
    kind: alert.kind,
    title: alert.title,
    detail: alert.detail,
    bikeId: alert.bikeId,
    customerId: alert.customerId,
    notificationId: alert.notificationId,
    createdAt: alert.createdAt,
    acknowledgedAt: alert.acknowledgedAt,
    acknowledgedById: alert.acknowledgedById,
  };
}
