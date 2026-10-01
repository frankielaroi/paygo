import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { isUniqueViolation } from '../common/prisma-errors';
import type { Prisma, StaffAlert } from '../generated/prisma/client';
import { StaffAlertKind } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';

export interface NewStaffAlert {
  kind: StaffAlertKind;
  /** Names the cause, so the same cause never raises two alerts. */
  dedupeKey: string;
  title: string;
  detail: string;
  bikeId?: string | null;
  customerId?: string | null;
  notificationId?: string | null;
}

/**
 * Things a person needs to look at: enforcement deferrals it cannot resolve itself, and rider
 * messages that did not go through. Alerts are acknowledged, never deleted.
 */
@Injectable()
export class StaffAlertsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Raises an alert once per cause. Returns false if it was already raised. */
  async raise(alert: NewStaffAlert): Promise<boolean> {
    try {
      await this.prisma.staffAlert.create({ data: alert });
      return true;
    } catch (error) {
      if (isUniqueViolation(error)) {
        return false;
      }
      throw error;
    }
  }

  list(open: boolean, take: number, skip: number) {
    const where: Prisma.StaffAlertWhereInput = open
      ? { acknowledgedAt: null }
      : {};
    return Promise.all([
      this.prisma.staffAlert.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
        skip,
      }),
      this.prisma.staffAlert.count({ where }),
    ]);
  }

  async acknowledge(id: string, userId: string): Promise<StaffAlert> {
    const acknowledged = await this.prisma.staffAlert.updateMany({
      where: { id, acknowledgedAt: null },
      data: { acknowledgedAt: new Date(), acknowledgedById: userId },
    });
    const alert = await this.prisma.staffAlert.findUnique({ where: { id } });
    if (!alert) {
      throw new NotFoundException('Alert not found');
    }
    if (acknowledged.count !== 1) {
      throw new ConflictException('This alert was already acknowledged');
    }
    return alert;
  }
}
