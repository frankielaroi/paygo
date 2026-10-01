import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.validation';
import { LoanArrearsModule } from '../loans/loan-arrears.module';
import { ArkeselCallbackController } from './arkesel-callback.controller';
import { ArkeselSmsChannel } from './channels/arkesel-sms.channel';
import { LogChannel, UnconfiguredChannel } from './channels/fallback.channels';
import {
  MESSAGE_CHANNEL,
  type MessageChannel,
} from './channels/message-channel';
import { EnforcementNotifierService } from './enforcement-notifier.service';
import { NotificationSchedulerService } from './notification-scheduler.service';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { StaffAlertsService } from './staff-alerts.service';

/**
 * Picks the delivery channel once, at boot. Arkesel when a key is set; otherwise the log channel
 * in development, and in production a channel that sends nothing, so messages wait and staff
 * are alerted rather than riders being locked without notice.
 */
function channelFactory(config: ConfigService<Env, true>): MessageChannel {
  const apiKey = config.get('ARKESEL_API_KEY', { infer: true });
  if (apiKey) {
    const base = config.get('ARKESEL_CALLBACK_BASE_URL', { infer: true });
    const token = config.get('ARKESEL_CALLBACK_TOKEN', { infer: true });
    return new ArkeselSmsChannel({
      apiKey,
      senderId: config.get('ARKESEL_SENDER_ID', { infer: true }),
      sandbox: config.get('ARKESEL_SANDBOX', { infer: true }),
      callbackUrl:
        base && token
          ? `${base.replace(/\/$/, '')}/webhooks/arkesel/${token}`
          : null,
    });
  }
  const logger = new Logger('NotificationsModule');
  if (config.get('NODE_ENV', { infer: true }) === 'production') {
    logger.error('ARKESEL_API_KEY is not set: no rider messages will be sent');
    return new UnconfiguredChannel();
  }
  logger.warn('ARKESEL_API_KEY is not set: rider messages go to the log only');
  return new LogChannel();
}

@Module({
  imports: [LoanArrearsModule],
  controllers: [NotificationsController, ArkeselCallbackController],
  providers: [
    {
      provide: MESSAGE_CHANNEL,
      inject: [ConfigService],
      useFactory: channelFactory,
    },
    NotificationsService,
    StaffAlertsService,
    NotificationSchedulerService,
    EnforcementNotifierService,
  ],
  exports: [
    NotificationsService,
    StaffAlertsService,
    NotificationSchedulerService,
  ],
})
export class NotificationsModule {}
