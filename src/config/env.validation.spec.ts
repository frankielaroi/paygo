import { validateEnv } from './env.validation';

const PEM = Buffer.from(
  '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n',
).toString('base64');

const valid = {
  DATABASE_URL: 'postgresql://paygo:paygo@localhost:5432/paygo',
  JWT_PRIVATE_KEY_BASE64: PEM,
  JWT_PUBLIC_KEY_BASE64: PEM,
};

describe('validateEnv', () => {
  it('accepts a minimal valid environment and applies defaults', () => {
    const env = validateEnv(valid);

    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
    expect(env.JWT_EXPIRES_IN).toBe('15m');
    expect(env.REFRESH_TOKEN_TTL_DAYS).toBe(30);
    expect(env.LOGIN_MAX_ATTEMPTS).toBe(5);
    expect(env.TRACKING_OFFLINE_AFTER_SECONDS).toBe(300);
    expect(env.IMMOBILIZE_STATIONARY_SECONDS).toBe(120);
    expect(env.ENFORCEMENT_MAX_TELEMETRY_AGE_SECONDS).toBe(300);
    expect(env.ENFORCEMENT_COMMAND_RETRY_SECONDS).toBe(300);
    expect(env.ENFORCEMENT_SWEEP_INTERVAL_SECONDS).toBe(900);
    expect(env.SWAGGER_ENABLED).toBe(false);
  });

  // The gap this closes: without it, a deployment boots and fails on the first login.
  it('refuses to boot when a JWT key is missing', () => {
    const withoutKey: Partial<typeof valid> = { ...valid };
    delete withoutKey.JWT_PRIVATE_KEY_BASE64;

    expect(() => validateEnv(withoutKey)).toThrow(
      /JWT_PRIVATE_KEY_BASE64 is required/,
    );
  });

  it('refuses to boot when a JWT key is not a base64 PEM', () => {
    expect(() =>
      validateEnv({ ...valid, JWT_PUBLIC_KEY_BASE64: 'not-a-key' }),
    ).toThrow(/must be a base64-encoded PEM key/);
  });

  it('refuses a non-postgres DATABASE_URL', () => {
    expect(() =>
      validateEnv({ ...valid, DATABASE_URL: 'mysql://localhost/paygo' }),
    ).toThrow(/postgresql:\/\/ connection string/);
  });

  it('refuses a malformed token lifetime', () => {
    expect(() =>
      validateEnv({ ...valid, JWT_EXPIRES_IN: 'fifteen minutes' }),
    ).toThrow(/duration/);
  });

  it('coerces numeric strings, since env values are always strings', () => {
    const env = validateEnv({
      ...valid,
      PORT: '8080',
      LOGIN_MAX_ATTEMPTS: '3',
      REFRESH_TOKEN_TTL_DAYS: '7',
    });

    expect(env.PORT).toBe(8080);
    expect(env.LOGIN_MAX_ATTEMPTS).toBe(3);
    expect(env.REFRESH_TOKEN_TTL_DAYS).toBe(7);
  });

  it('reads SWAGGER_ENABLED as a boolean, not a string', () => {
    expect(
      validateEnv({ ...valid, SWAGGER_ENABLED: 'true' }).SWAGGER_ENABLED,
    ).toBe(true);
    expect(
      validateEnv({ ...valid, SWAGGER_ENABLED: 'false' }).SWAGGER_ENABLED,
    ).toBe(false);
  });

  describe('TRUST_PROXY', () => {
    const trustProxy = (value?: string) =>
      validateEnv({ ...valid, TRUST_PROXY: value }).TRUST_PROXY;

    it('trusts no proxy by default', () => {
      expect(trustProxy(undefined)).toBe(false);
      expect(trustProxy('')).toBe(false);
      expect(trustProxy('false')).toBe(false);
      expect(trustProxy('0')).toBe(false);
    });

    it('reads a hop count', () => {
      expect(trustProxy('1')).toBe(1);
    });

    it('reads a list of named ranges, addresses and CIDRs', () => {
      expect(trustProxy('loopback, 10.0.0.5,172.16.0.0/12,::1')).toEqual([
        'loopback',
        '10.0.0.5',
        '172.16.0.0/12',
        '::1',
      ]);
    });

    // Trusting every hop would let any client name its own IP and dodge the login limit.
    it('refuses "true"', () => {
      expect(() => trustProxy('true')).toThrow(/instead of "true"/);
    });

    it.each(['frontend.local', '10.0.0.0/33', '10.0.0.1/8/1', 'loopback,'])(
      'refuses %s',
      (value) => {
        expect(() => trustProxy(value)).toThrow(/TRUST_PROXY/);
      },
    );
  });

  it('rejects a seed password that is too short to be worth setting', () => {
    expect(() =>
      validateEnv({ ...valid, SEED_ADMIN_PASSWORD: 'short' }),
    ).toThrow();
  });

  it('reports every problem at once, not just the first', () => {
    let message = '';

    try {
      validateEnv({ DATABASE_URL: 'nope' });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('JWT_PRIVATE_KEY_BASE64');
    expect(message).toContain('JWT_PUBLIC_KEY_BASE64');
  });
});
