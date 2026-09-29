import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  type RawBodyRequest,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import type { Env } from '../../config/env.validation';
import type { WebhookAckDto } from '../dto/payment.dto';
import { PaymentsService } from '../payments.service';
import {
  isValidPaystackSignature,
  parsePaystackEvent,
} from './paystack-webhook';

/**
 * Paystack webhooks. Public, because Paystack has no bearer token; the HMAC signature over the
 * raw body is the authentication, and nothing is read from the body before it is verified.
 *
 * Replies 200 for anything verified, including duplicates and events we ignore, so Paystack stops
 * retrying. Replies non-200 only when the request is not trustworthy (401), cannot be read (400),
 * or recording failed (5xx), which is exactly when a retry is wanted: processing is idempotent.
 *
 * Not rate limited: Paystack sends bursts from a few addresses, and the signature already stops
 * anyone else. Excluded from the Swagger document, which is for staff clients.
 */
@ApiExcludeController()
@Public()
@SkipThrottle()
@Controller('webhooks/paystack')
export class PaystackWebhookController {
  private readonly logger = new Logger(PaystackWebhookController.name);

  constructor(
    private readonly payments: PaymentsService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async receive(
    @Req() request: RawBodyRequest<Request>,
    @Headers('x-paystack-signature') signature: string | undefined,
  ): Promise<WebhookAckDto> {
    const secret = this.config.get('PAYSTACK_SECRET_KEY', { infer: true });
    if (!secret) {
      this.logger.error(
        'Paystack webhook received but PAYSTACK_SECRET_KEY is not set',
      );
      throw new ServiceUnavailableException('Webhook not configured');
    }
    if (!request.rawBody) {
      throw new BadRequestException('Empty body');
    }
    if (!isValidPaystackSignature(request.rawBody, signature, secret)) {
      this.logger.warn('Rejected a Paystack webhook with an invalid signature');
      throw new UnauthorizedException('Invalid signature');
    }

    const parsed = parsePaystackEvent(request.body, new Date());
    if (parsed.kind === 'malformed') {
      // Signed by Paystack but unreadable: worth a retry once a fix ships, so not a 200.
      this.logger.error(`Malformed Paystack webhook: ${parsed.reason}`);
      throw new BadRequestException('Unreadable event');
    }
    if (parsed.kind === 'ignored') {
      return { received: true };
    }

    const { charge } = parsed;
    const result = await this.payments.ingest({
      provider: 'paystack',
      reference: charge.reference,
      providerTransactionId: charge.transactionId,
      amountMinor: charge.amountMinor,
      currency: charge.currency,
      paidAt: charge.paidAt,
      channel: charge.channel,
      payerPhone: charge.payerPhone,
      loanId: charge.loanId,
    });
    this.logger.log(
      `Paystack ${charge.reference}: ${result.outcome === 'duplicate' ? 'duplicate, ignored' : result.status}`,
    );
    return { received: true };
  }
}
