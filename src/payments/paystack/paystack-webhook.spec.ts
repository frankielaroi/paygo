import { createHmac } from 'node:crypto';
import {
  isValidPaystackSignature,
  parsePaystackEvent,
} from './paystack-webhook';

const SECRET = 'sk_test_0123456789abcdef';
const LOAN = '8f14e45f-ceea-4e67-9a2b-0c1d2e3f4a5b';
const now = new Date('2026-10-01T12:00:00.000Z');

// Signed here with node's HMAC directly, independent of the implementation's helper.
const sign = (body: Buffer, key = SECRET): string =>
  createHmac('sha512', key).update(body).digest('hex');

function charge(data: Record<string, unknown> = {}, event = 'charge.success') {
  return {
    event,
    data: {
      id: 4099260516,
      reference: 'T633468781648531',
      status: 'success',
      amount: 5000,
      currency: 'GHS',
      paid_at: '2026-10-01T11:58:00.000Z',
      channel: 'mobile_money',
      metadata: { loan_id: LOAN },
      authorization: { mobile_money_number: '0551234987' },
      ...data,
    },
  };
}

describe('isValidPaystackSignature', () => {
  const body = Buffer.from(JSON.stringify(charge()));

  it('accepts the signature Paystack would send', () => {
    expect(isValidPaystackSignature(body, sign(body), SECRET)).toBe(true);
  });

  it('rejects a signature made with another key', () => {
    expect(
      isValidPaystackSignature(
        body,
        sign(body, 'sk_test_someone_else_1'),
        SECRET,
      ),
    ).toBe(false);
  });

  it('rejects a body changed after signing, even by one byte', () => {
    const tampered = Buffer.from(body.toString().replace('5000', '5001'));
    expect(isValidPaystackSignature(tampered, sign(body), SECRET)).toBe(false);
  });

  it('checks the raw bytes, so re-serialised JSON with other spacing does not match', () => {
    const spaced = Buffer.from(JSON.stringify(charge(), null, 2));
    expect(isValidPaystackSignature(spaced, sign(body), SECRET)).toBe(false);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['not hex', 'z'.repeat(128)],
    ['the wrong length', 'ab'.repeat(32)],
  ])('rejects a signature that is %s', (_label, signature) => {
    expect(isValidPaystackSignature(body, signature, SECRET)).toBe(false);
  });
});

describe('parsePaystackEvent', () => {
  it('reads a successful mobile money charge', () => {
    expect(parsePaystackEvent(charge(), now)).toEqual({
      kind: 'charge',
      charge: {
        reference: 'T633468781648531',
        transactionId: '4099260516',
        amountMinor: 5000,
        currency: 'GHS',
        paidAt: new Date('2026-10-01T11:58:00.000Z'),
        channel: 'mobile_money',
        payerPhone: '0551234987',
        loanId: LOAN,
      },
    });
  });

  it('reads the loan from metadata sent back as a JSON string', () => {
    const parsed = parsePaystackEvent(
      charge({ metadata: JSON.stringify({ loanId: LOAN }) }),
      now,
    );
    expect(parsed.kind === 'charge' && parsed.charge.loanId).toBe(LOAN);
  });

  it.each([
    ['no metadata', undefined],
    ['a malformed loan id', { loan_id: 'loan-7' }],
    ['unparseable metadata', '{not json'],
  ])('treats %s as no loan named', (_label, metadata) => {
    const parsed = parsePaystackEvent(charge({ metadata }), now);
    expect(parsed.kind === 'charge' && parsed.charge.loanId).toBeNull();
  });

  it('ignores events that are not a successful charge', () => {
    expect(parsePaystackEvent(charge({}, 'transfer.success'), now).kind).toBe(
      'ignored',
    );
    expect(parsePaystackEvent(charge({ status: 'failed' }), now).kind).toBe(
      'ignored',
    );
  });

  it.each([
    ['a fractional amount', { amount: 50.5 }],
    ['a zero amount', { amount: 0 }],
    ['no reference', { reference: '' }],
    ['a bad currency', { currency: 'CEDI' }],
  ])('refuses a charge with %s', (_label, data) => {
    expect(parsePaystackEvent(charge(data), now).kind).toBe('malformed');
  });
});
