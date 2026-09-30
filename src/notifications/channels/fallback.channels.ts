import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  MessageChannel,
  OutgoingMessage,
  SendResult,
} from './message-channel';

/**
 * Development only, when no SMS key is set: records the message in the log and reports it
 * accepted, so the whole flow can be exercised locally without texting anyone. Never selected in
 * production.
 */
export class LogChannel implements MessageChannel {
  readonly name = 'log';
  private readonly logger = new Logger('SmsLog');

  send(message: OutgoingMessage): Promise<SendResult> {
    // The number is masked: even development logs should not collect rider phone numbers.
    const masked = `${message.to.slice(0, 4)}****${message.to.slice(-3)}`;
    this.logger.log(`SMS to ${masked}: ${message.body}`);
    return Promise.resolve({
      outcome: 'accepted',
      providerMessageId: `log-${randomUUID()}`,
    });
  }
}

/**
 * Production without an SMS key. Every send is "unavailable", so messages stay pending and staff
 * are alerted, and no warning ever counts as given: automatic locks stop rather than happen
 * without notice.
 */
export class UnconfiguredChannel implements MessageChannel {
  readonly name = 'unconfigured';

  send(): Promise<SendResult> {
    return Promise.resolve({
      outcome: 'unavailable',
      error: 'No SMS provider configured (ARKESEL_API_KEY is not set)',
    });
  }
}
