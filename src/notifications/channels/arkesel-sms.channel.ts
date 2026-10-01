import type {
  MessageChannel,
  OutgoingMessage,
  SendResult,
} from './message-channel';

export const ARKESEL_SEND_URL = 'https://sms.arkesel.com/api/v2/sms/send';

export interface ArkeselSettings {
  apiKey: string;
  senderId: string;
  sandbox: boolean;
  /** Where Arkesel should post the delivery report, if configured. */
  callbackUrl: string | null;
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Arkesel SMS API v2: POST /api/v2/sms/send with the key in the api-key header and a JSON body
 * of sender, message and recipients, plus callback_url and sandbox when set.
 *
 * The response body's exact shape is not published in a form we could verify, so it is read
 * defensively: success is a 2xx with status "success", and the message id is taken from
 * data[0].id when present. Confirm against a sandbox send before relying on delivery reports.
 */
export class ArkeselSmsChannel implements MessageChannel {
  readonly name = 'arkesel-sms';

  constructor(
    private readonly settings: ArkeselSettings,
    private readonly fetchImpl: Fetch = fetch,
    private readonly timeoutMs = 15_000,
  ) {}

  async send(message: OutgoingMessage): Promise<SendResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(ARKESEL_SEND_URL, {
        method: 'POST',
        headers: {
          'api-key': this.settings.apiKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          sender: this.settings.senderId,
          message: message.body,
          recipients: [message.to],
          ...(this.settings.callbackUrl
            ? { callback_url: this.settings.callbackUrl }
            : {}),
          ...(this.settings.sandbox ? { sandbox: true } : {}),
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      return {
        outcome: 'unavailable',
        error: `Arkesel unreachable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const body = await readJson(response);
    const detail = describe(body);

    if (response.ok && body?.status === 'success') {
      return { outcome: 'accepted', providerMessageId: messageId(body) };
    }
    // 422 is Arkesel refusing this recipient or message (e.g. an invalid number): final.
    if (response.status === 422) {
      return {
        outcome: 'rejected',
        error: `Arkesel rejected the message: ${detail}`,
      };
    }
    // Everything else is ours or theirs, not the rider's: bad key (401), unregistered sender
    // (403), rate limit (429), outage (5xx), or a 2xx we cannot read. Retry, and never count it
    // as a warning attempt.
    return {
      outcome: 'unavailable',
      error: `Arkesel HTTP ${response.status}: ${detail}`,
    };
  }
}

interface ArkeselBody {
  status?: unknown;
  message?: unknown;
  data?: unknown;
}

async function readJson(response: Response): Promise<ArkeselBody | null> {
  try {
    const parsed: unknown = await response.json();
    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function messageId(body: ArkeselBody): string | null {
  const first: unknown = Array.isArray(body.data) ? body.data[0] : body.data;
  if (first && typeof first === 'object' && 'id' in first) {
    const id = first.id;
    if (typeof id === 'string' || typeof id === 'number') {
      return String(id);
    }
  }
  return null;
}

function describe(body: ArkeselBody | null): string {
  if (!body) {
    return 'no readable body';
  }
  return typeof body.message === 'string' ? body.message : 'no message';
}
