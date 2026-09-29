import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/**
 * Paystack signs every webhook with HMAC-SHA512 of the raw request body, keyed with the account's
 * secret key, hex-encoded in the x-paystack-signature header. It must be computed over the exact
 * bytes received: re-serialising parsed JSON can reorder or reformat it and never match.
 */
export function isValidPaystackSignature(
  rawBody: Buffer,
  signature: string | undefined,
  secretKey: string,
): boolean {
  if (!signature || !/^[0-9a-f]{128}$/i.test(signature)) {
    return false;
  }
  const expected = createHmac('sha512', secretKey).update(rawBody).digest();
  const received = Buffer.from(signature, 'hex');
  return (
    received.length === expected.length && timingSafeEqual(received, expected)
  );
}

const chargeData = z.object({
  id: z.union([z.number(), z.string()]),
  reference: z.string().min(1).max(200),
  status: z.string(),
  /** In the currency's subunit: pesewas for GHS. */
  amount: z.number().int().positive(),
  currency: z.string().length(3),
  paid_at: z.string().nullish(),
  paidAt: z.string().nullish(),
  channel: z.string().nullish(),
  metadata: z.unknown().optional(),
  customer: z.object({ phone: z.string().nullish() }).partial().nullish(),
  authorization: z
    .object({ mobile_money_number: z.string().nullish() })
    .partial()
    .nullish(),
});

const webhookEvent = z.object({
  event: z.string(),
  data: z.unknown(),
});

/** A successful charge, reduced to the fields this system records. */
export interface PaystackCharge {
  reference: string;
  transactionId: string;
  amountMinor: number;
  currency: string;
  paidAt: Date;
  channel: string | null;
  payerPhone: string | null;
  /** The loan named in the charge metadata, if it is a well-formed id. */
  loanId: string | null;
}

export type ParsedPaystackEvent =
  | { kind: 'charge'; charge: PaystackCharge }
  | { kind: 'ignored'; reason: string }
  | { kind: 'malformed'; reason: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Turns a verified webhook body into a charge, or says why it is not one. Only charge.success
 * with status "success" is money received; every other event is acknowledged and ignored.
 */
export function parsePaystackEvent(
  body: unknown,
  now: Date,
): ParsedPaystackEvent {
  const envelope = webhookEvent.safeParse(body);
  if (!envelope.success) {
    return { kind: 'malformed', reason: 'not a Paystack event' };
  }
  if (envelope.data.event !== 'charge.success') {
    return { kind: 'ignored', reason: `event ${envelope.data.event}` };
  }

  const data = chargeData.safeParse(envelope.data.data);
  if (!data.success) {
    return {
      kind: 'malformed',
      reason: data.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; '),
    };
  }
  const charge = data.data;
  if (charge.status !== 'success') {
    return { kind: 'ignored', reason: `charge status ${charge.status}` };
  }

  const paidAtText = charge.paid_at ?? charge.paidAt;
  const paidAt = paidAtText ? new Date(paidAtText) : now;

  return {
    kind: 'charge',
    charge: {
      reference: charge.reference,
      transactionId: String(charge.id),
      amountMinor: charge.amount,
      currency: charge.currency.toUpperCase(),
      paidAt: Number.isNaN(paidAt.getTime()) ? now : paidAt,
      channel: charge.channel ?? null,
      payerPhone:
        charge.authorization?.mobile_money_number ??
        charge.customer?.phone ??
        null,
      loanId: loanIdFrom(charge.metadata),
    },
  };
}

/**
 * Paystack hands metadata back as it was sent, which may be an object or a JSON string. The loan
 * is expected under loan_id (or loanId); anything else, or a malformed id, means "not named".
 */
function loanIdFrom(metadata: unknown): string | null {
  let value: unknown = metadata;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (value === null || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  const candidate = record.loan_id ?? record.loanId;
  return typeof candidate === 'string' && UUID.test(candidate)
    ? candidate
    : null;
}
