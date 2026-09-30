/**
 * How a rider message leaves the system. Everything above this interface (what to say, to whom,
 * when, and whether it already went) is channel-agnostic, so SMS can be swapped or WhatsApp or
 * push added without touching loans, payments or enforcement.
 */
export interface OutgoingMessage {
  /** International number without "+", e.g. 233241234567. */
  to: string;
  body: string;
}

/**
 * The difference between the two failures matters for enforcement:
 *
 * - rejected: this recipient or message will never go through (invalid number, message refused).
 *   Final. It counts as an attempted warning, so an unreachable number cannot become a way to
 *   avoid enforcement; staff are alerted instead.
 * - unavailable: the provider or our configuration failed (outage, timeout, bad credentials).
 *   Retried, and never counts as a warning, so an outage cannot let a bike be locked unwarned.
 */
export type SendResult =
  | { outcome: 'accepted'; providerMessageId: string | null }
  | { outcome: 'rejected'; error: string }
  | { outcome: 'unavailable'; error: string };

export interface MessageChannel {
  /** Recorded on each notification, e.g. "arkesel-sms". */
  readonly name: string;
  send(message: OutgoingMessage): Promise<SendResult>;
}

export const MESSAGE_CHANNEL = Symbol('MESSAGE_CHANNEL');
