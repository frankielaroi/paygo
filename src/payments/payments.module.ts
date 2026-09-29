import { Module } from '@nestjs/common';
import { EnforcementModule } from '../enforcement/enforcement.module';
import { LedgerModule } from '../ledger/ledger.module';
import { LoansModule } from '../loans/loans.module';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { PaystackWebhookController } from './paystack/paystack-webhook.controller';

/**
 * Money in. Webhook processing is inline and idempotent for now; when BullMQ lands, the webhook
 * should acknowledge and enqueue, and a processor should call PaymentsService.ingest.
 */
@Module({
  imports: [LedgerModule, LoansModule, EnforcementModule],
  controllers: [PaystackWebhookController, PaymentsController],
  providers: [PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
