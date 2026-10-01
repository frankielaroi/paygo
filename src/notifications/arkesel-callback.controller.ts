import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { timingSafeEqual } from 'node:crypto';
import { Public } from '../common/decorators/public.decorator';
import type { Env } from '../config/env.validation';
import { NotificationsService } from './notifications.service';

const DELIVERED = new Set(['DELIVERED', 'DELIVRD', 'SUCCESS']);
const UNDELIVERED = new Set([
  'FAILED',
  'UNDELIVERED',
  'UNDELIV',
  'UNDELIVERABLE',
  'REJECTED',
  'REJECTD',
  'EXPIRED',
]);

/**
 * Arkesel delivery reports. Arkesel does not sign callbacks, so the URL we give it carries a
 * secret path token, and a report without the right token is a 404, as if the route did not
 * exist. The payload's exact field names are not documented where we could verify them, so the
 * message id and status are read from the common names, in the body or the query string; confirm
 * against a sandbox report. The worst a forged report could do, even with the token, is mark a
 * message delivered or failed: it cannot touch money or a bike.
 */
@ApiExcludeController()
@Public()
@SkipThrottle()
@Controller('webhooks/arkesel')
export class ArkeselCallbackController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @Post(':token')
  @HttpCode(HttpStatus.OK)
  receivePost(
    @Param('token') token: string,
    @Body() body: unknown,
    @Query() query: Record<string, unknown>,
  ): Promise<{ received: boolean }> {
    return this.receive(token, { ...query, ...asRecord(body) });
  }

  @Get(':token')
  receiveGet(
    @Param('token') token: string,
    @Query() query: Record<string, unknown>,
  ): Promise<{ received: boolean }> {
    return this.receive(token, query);
  }

  private async receive(
    token: string,
    fields: Record<string, unknown>,
  ): Promise<{ received: boolean }> {
    const expected = this.config.get('ARKESEL_CALLBACK_TOKEN', { infer: true });
    if (!expected || !sameSecret(token, expected)) {
      throw new NotFoundException();
    }

    const id = firstString(fields, ['sms_id', 'id', 'message_id', 'messageId']);
    const status = firstString(fields, [
      'status',
      'delivery_status',
      'dlr_status',
    ])
      ?.trim()
      .toUpperCase();
    if (!id || !status) {
      return { received: true };
    }
    if (DELIVERED.has(status)) {
      await this.notifications.recordDelivery(id, true, status);
    } else if (UNDELIVERED.has(status)) {
      await this.notifications.recordDelivery(id, false, status);
    }
    // Anything else (SUBMITTED, PENDING, SENT) is an intermediate state: nothing to record.
    return { received: true };
  }
}

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function firstString(
  fields: Record<string, unknown>,
  names: string[],
): string | null {
  for (const name of names) {
    const value = fields[name];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
    if (typeof value === 'number') {
      return String(value);
    }
  }
  return null;
}
