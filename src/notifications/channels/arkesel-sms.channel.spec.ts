import { ARKESEL_SEND_URL, ArkeselSmsChannel } from './arkesel-sms.channel';

type FetchArgs = [string, RequestInit];

function channel(
  respond: () => Promise<Response>,
  settings: Partial<ConstructorParameters<typeof ArkeselSmsChannel>[0]> = {},
) {
  const fetchMock = jest.fn<Promise<Response>, FetchArgs>(respond);
  const sms = new ArkeselSmsChannel(
    {
      apiKey: 'test-api-key-123',
      senderId: 'PayGo',
      sandbox: false,
      callbackUrl: null,
      ...settings,
    },
    fetchMock,
  );
  return { sms, fetchMock };
}

const json = (status: number, body: unknown): Promise<Response> =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );

const message = { to: '233241234567', body: 'Hello' };

describe('ArkeselSmsChannel', () => {
  it('posts the documented v2 request: api-key header, sender, message, recipients', async () => {
    const { sms, fetchMock } = channel(() =>
      json(200, {
        status: 'success',
        data: [{ recipient: '233241234567', id: 'abc-1' }],
      }),
    );

    await sms.send(message);

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(ARKESEL_SEND_URL);
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>)['api-key']).toBe(
      'test-api-key-123',
    );
    expect(JSON.parse(init?.body as string)).toEqual({
      sender: 'PayGo',
      message: 'Hello',
      recipients: ['233241234567'],
    });
  });

  it('adds the callback URL and sandbox flag only when configured', async () => {
    const { sms, fetchMock } = channel(() => json(200, { status: 'success' }), {
      sandbox: true,
      callbackUrl: 'https://api.example.test/webhooks/arkesel/token',
    });

    await sms.send(message);

    expect(
      JSON.parse(fetchMock.mock.calls[0]?.[1].body as string),
    ).toMatchObject({
      sandbox: true,
      callback_url: 'https://api.example.test/webhooks/arkesel/token',
    });
  });

  it('reports an accepted message with its provider id', async () => {
    const { sms } = channel(() =>
      json(200, { status: 'success', data: [{ id: 'abc-1' }] }),
    );
    await expect(sms.send(message)).resolves.toEqual({
      outcome: 'accepted',
      providerMessageId: 'abc-1',
    });
  });

  it('accepts a success without an id, rather than resending a message that went out', async () => {
    const { sms } = channel(() => json(200, { status: 'success' }));
    await expect(sms.send(message)).resolves.toEqual({
      outcome: 'accepted',
      providerMessageId: null,
    });
  });

  it('treats a 422 as final: this recipient or message will never go through', async () => {
    const { sms } = channel(() =>
      json(422, { status: 'error', message: 'Invalid phone number' }),
    );
    await expect(sms.send(message)).resolves.toMatchObject({
      outcome: 'rejected',
    });
  });

  it.each([
    ['a bad API key', 401],
    ['an unregistered sender', 403],
    ['a rate limit', 429],
    ['an outage', 503],
  ])(
    'treats %s as unavailable, never as a rider failure',
    async (_label, status) => {
      const { sms } = channel(() => json(status, { status: 'error' }));
      await expect(sms.send(message)).resolves.toMatchObject({
        outcome: 'unavailable',
      });
    },
  );

  it('treats a network failure as unavailable', async () => {
    const { sms } = channel(() => Promise.reject(new Error('ECONNRESET')));
    const result = await sms.send(message);
    expect(result.outcome).toBe('unavailable');
    expect(result.outcome !== 'accepted' && result.error).toContain(
      'ECONNRESET',
    );
  });

  it('treats an unreadable 200 as unavailable, not as sent', async () => {
    const { sms } = channel(() =>
      Promise.resolve(new Response('<html>gateway</html>', { status: 200 })),
    );
    await expect(sms.send(message)).resolves.toMatchObject({
      outcome: 'unavailable',
    });
  });
});
