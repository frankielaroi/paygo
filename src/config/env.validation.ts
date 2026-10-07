import { isIP } from 'node:net';
import { z } from 'zod';

/**
 * Decodes a base64 PEM and fails if the result is not a key. This is the check that turns
 * "a missing or malformed JWT key" from a 500 on the first login into a refusal to boot.
 */
const base64Pem = (label: string) =>
  // A missing variable is preprocessed to '' so the failure reads as "is required" rather
  // than zod's "expected string, received undefined". This message goes to whoever is
  // trying to deploy.
  z.preprocess(
    (value) => value ?? '',
    z
      .string()
      .min(1, `${label} is required`)
      .refine(
        (value) => {
          // Already reported by min(1). Returning true here keeps one message per variable
          // instead of both "is required" and "must be a base64-encoded PEM key".
          if (value === '') {
            return true;
          }

          try {
            return Buffer.from(value, 'base64')
              .toString('utf8')
              .includes('-----BEGIN');
          } catch {
            return false;
          }
        },
        { message: `${label} must be a base64-encoded PEM key` },
      ),
  );

/** Accepts "15m", "7d", "3600s" or a plain number of seconds. */
const duration = z
  .string()
  .regex(
    /^\d+(ms|s|m|h|d|w|y)?$/,
    'must be a duration such as 15m, 7d, or a number of seconds',
  );

const port = z.coerce.number().int().positive().max(65535);

/** An empty variable (KEY= in .env) means "not set", not an empty value to validate. */
const emptyAsUndefined = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema);

/** Express's named ranges for `trust proxy`. */
const PROXY_RANGE_NAMES = new Set(['loopback', 'linklocal', 'uniquelocal']);

/** "loopback", "10.0.0.5" or "10.0.0.0/8": one entry of a `trust proxy` list. */
function isProxyAddress(entry: string): boolean {
  if (PROXY_RANGE_NAMES.has(entry)) {
    return true;
  }
  const [address, bits, ...rest] = entry.split('/');
  const version = isIP(address);
  if (version === 0 || rest.length > 0) {
    return false;
  }
  return (
    bits === undefined ||
    (/^\d+$/.test(bits) && Number(bits) <= (version === 4 ? 32 : 128))
  );
}

/**
 * Parsed for Express's `trust proxy`: false (the default), a hop count, or the proxies
 * whose X-Forwarded-For may be believed. "true" is refused: trusting every hop lets any
 * client name its own IP and so dodge the per-IP login limit.
 */
const trustProxy = emptyAsUndefined(
  z
    .string()
    .trim()
    .superRefine((value, context) => {
      if (value === 'true') {
        context.addIssue({
          code: 'custom',
          message:
            'name the proxies (or give a hop count) instead of "true": trusting every hop lets any client choose its own IP',
        });
        return;
      }
      const valid =
        value === 'false' ||
        /^\d+$/.test(value) ||
        value.split(',').every((entry) => isProxyAddress(entry.trim()));
      if (!valid) {
        context.addIssue({
          code: 'custom',
          message:
            'must be "false", a hop count, or comma-separated IPs, CIDRs, loopback, linklocal or uniquelocal',
        });
      }
    })
    .optional(),
).transform((value): false | number | string[] => {
  if (value === undefined || value === 'false') {
    return false;
  }
  if (/^\d+$/.test(value)) {
    return Number(value) || false;
  }
  return value.split(',').map((entry) => entry.trim());
});

/** "https://app.example.com" or "http://localhost:5173": exactly what a browser sends as Origin. */
function isOrigin(entry: string): boolean {
  let url: URL;
  try {
    url = new URL(entry);
  } catch {
    return false;
  }
  // url.origin drops a path, query, credentials and trailing slash, so comparing it with the
  // entry refuses all of those: a browser's Origin header never carries them, and an entry
  // that does would silently never match. The URL parser accepts "*" in a host name, and
  // origins are compared as exact strings, so a wildcard host would match nothing either.
  return (
    (url.protocol === 'https:' || url.protocol === 'http:') &&
    url.origin === entry &&
    !entry.includes('*')
  );
}

/**
 * The browser origins allowed to call the API, parsed to a list. Empty (the default) leaves
 * CORS off, so only same-origin pages and non-browser clients get through. "*" is refused:
 * the API is a back office behind bearer tokens, and naming the frontends is what keeps a
 * token lifted from one of them from being usable by a page on any other site.
 */
const corsOrigins = emptyAsUndefined(
  z
    .string()
    .trim()
    .superRefine((value, context) => {
      const entries = value.split(',').map((entry) => entry.trim());
      if (entries.includes('*')) {
        context.addIssue({
          code: 'custom',
          message: 'name the frontend origins instead of "*"',
        });
        return;
      }
      const invalid = entries.filter((entry) => !isOrigin(entry));
      if (invalid.length > 0) {
        context.addIssue({
          code: 'custom',
          message: `must be comma-separated origins such as https://app.example.com, with no path or trailing slash (got ${invalid.map((entry) => `"${entry}"`).join(', ')})`,
        });
      }
    })
    .optional(),
).transform((value): string[] =>
  value === undefined ? [] : value.split(',').map((entry) => entry.trim()),
);

export const envSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    PORT: port.default(3000),

    DATABASE_URL: z
      .string()
      .min(1)
      .refine((value) => /^postgres(ql)?:\/\//.test(value), {
        message: 'must be a postgresql:// connection string',
      }),

    JWT_PRIVATE_KEY_BASE64: base64Pem('JWT_PRIVATE_KEY_BASE64'),
    JWT_PUBLIC_KEY_BASE64: base64Pem('JWT_PUBLIC_KEY_BASE64'),
    JWT_EXPIRES_IN: duration.default('15m'),
    JWT_ISSUER: z.string().min(1).default('paygo'),

    REFRESH_TOKEN_TTL_DAYS: z.coerce
      .number()
      .int()
      .positive()
      .max(365)
      .default(30),

    LOGIN_MAX_ATTEMPTS: z.coerce.number().int().positive().max(100).default(5),
    LOGIN_LOCKOUT_MINUTES: z.coerce
      .number()
      .int()
      .positive()
      .max(1440)
      .default(15),
    LOGIN_RATE_LIMIT: z.coerce.number().int().positive().default(10),
    LOGIN_RATE_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),

    // Proxies whose X-Forwarded-For header is believed. The client IP behind per-IP rate
    // limits and the IP recorded against refresh tokens come from it. Unset, every request is
    // attributed to whatever connected directly, so behind the web frontend (which calls this
    // API from its server) all staff share one login limit. Set it to the frontend's or load
    // balancer's address; leave it unset when clients connect directly.
    TRUST_PROXY: trustProxy,

    // Browser origins allowed to call the API. Unset means no cross-origin access at all.
    CORS_ORIGINS: corsOrigins,

    // Device TCP listener. Disabled in tests unless a spec turns it on with port 0, so a test run
    // does not fight the dev server for the port.
    TCP_DEVICE_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),
    TCP_DEVICE_PORT: port.default(5027),

    TRACKING_OFFLINE_AFTER_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .max(86400)
      .default(300),

    // Battery % is estimated from pack voltage (Teltonika IO 66) between these two readings.
    // Defaults suit a 48 V lithium pack (13S: 3.23 V/cell empty, 4.2 V/cell full).
    BIKE_BATTERY_EMPTY_MV: z.coerce
      .number()
      .int()
      .positive()
      .max(200000)
      .default(42000),
    BIKE_BATTERY_FULL_MV: z.coerce
      .number()
      .int()
      .positive()
      .max(200000)
      .default(54600),

    // Enforcement interlock. How long a bike must have been stopped (speed 0, ignition off, with
    // a GPS fix) before it may be immobilized, and how old its latest reading may be. A tracker's
    // "on stop" report period must be shorter than the maximum age, or a parked bike never has
    // fresh enough data to be immobilized and is flagged for review instead.
    IMMOBILIZE_STATIONARY_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .max(86400)
      .default(120),
    ENFORCEMENT_MAX_TELEMETRY_AGE_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .max(86400)
      .default(300),
    // How long to wait for a device to confirm a command before sending it again.
    ENFORCEMENT_COMMAND_RETRY_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .max(86400)
      .default(300),
    ENFORCEMENT_SWEEP_INTERVAL_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .max(86400)
      .default(900),

    // Paystack secret key (sk_test_... or sk_live_...). Webhooks are signed with it (HMAC-SHA512
    // over the raw body). Optional so the app boots without it, but the webhook then refuses
    // every request: an unverified "payment succeeded" could unlock a bike.
    PAYSTACK_SECRET_KEY: z.string().min(16).optional(),

    // Rider SMS through Arkesel. Without a key, development records messages to the log instead,
    // and production sends nothing: warnings then stay pending, so the arrears sweep will not
    // lock anyone (it only locks riders who were warned).
    ARKESEL_API_KEY: emptyAsUndefined(z.string().min(10).optional()),
    ARKESEL_SENDER_ID: z
      .string()
      .regex(/^[A-Za-z0-9 ]{3,11}$/, 'sender ID is 3 to 11 letters or digits')
      .default('PayGo'),
    ARKESEL_SANDBOX: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    // Public base URL Arkesel posts delivery reports to, and the secret path token that proves a
    // report came from the URL we gave them (Arkesel does not sign its callbacks).
    ARKESEL_CALLBACK_BASE_URL: emptyAsUndefined(z.string().url().optional()),
    ARKESEL_CALLBACK_TOKEN: emptyAsUndefined(z.string().min(24).optional()),

    // Notifications. The scheduler sends reminders and warnings and retries undelivered messages.
    NOTIFICATIONS_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),
    NOTIFICATIONS_INTERVAL_SECONDS: z.coerce
      .number()
      .int()
      .min(30)
      .max(3600)
      .default(300),
    // Days before a due date to remind the rider; 0 turns reminders off. With 1, a daily loan
    // means a reminder every day.
    PAYMENT_REMINDER_LEAD_DAYS: z.coerce
      .number()
      .int()
      .min(0)
      .max(14)
      .default(1),
    // How long before an automatic lock the rider must have been warned.
    LOCKOUT_WARNING_LEAD_HOURS: z.coerce
      .number()
      .int()
      .min(0)
      .max(168)
      .default(12),
    // Reminders and warnings go out only between these UTC hours (Ghana time). Lock and unlock
    // confirmations go out at any hour, since they report what just happened.
    RIDER_MESSAGE_START_HOUR: z.coerce.number().int().min(0).max(23).default(7),
    RIDER_MESSAGE_END_HOUR: z.coerce.number().int().min(1).max(24).default(20),
    // Transport attempts before staff are alerted that a message is stuck. It keeps retrying.
    NOTIFICATION_MAX_ATTEMPTS: z.coerce
      .number()
      .int()
      .min(1)
      .max(20)
      .default(3),

    SWAGGER_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),

    // Seed-only, so optional: the app itself never reads them.
    SEED_ADMIN_EMAIL: z.string().email().optional(),
    SEED_ADMIN_PASSWORD: z.string().min(12).optional(),
  })
  .superRefine((env, context) => {
    // A callback URL without its token would accept delivery reports from anyone.
    if (env.ARKESEL_CALLBACK_BASE_URL && !env.ARKESEL_CALLBACK_TOKEN) {
      context.addIssue({
        code: 'custom',
        path: ['ARKESEL_CALLBACK_TOKEN'],
        message: 'required when ARKESEL_CALLBACK_BASE_URL is set',
      });
    }
    if (env.BIKE_BATTERY_EMPTY_MV >= env.BIKE_BATTERY_FULL_MV) {
      context.addIssue({
        code: 'custom',
        path: ['BIKE_BATTERY_FULL_MV'],
        message: 'must be higher than BIKE_BATTERY_EMPTY_MV',
      });
    }
    if (env.RIDER_MESSAGE_START_HOUR >= env.RIDER_MESSAGE_END_HOUR) {
      context.addIssue({
        code: 'custom',
        path: ['RIDER_MESSAGE_END_HOUR'],
        message: 'must be later than RIDER_MESSAGE_START_HOUR',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

/**
 * Passed to ConfigModule as `validate`. Throwing here aborts the bootstrap, which is the
 * point: a deployment missing a key should fail loudly at startup rather than serving
 * traffic and failing on the first login.
 */
export function validateEnv(config: Record<string, unknown>): Env {
  const result = envSchema.safeParse(config);

  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');

    throw new Error(`Invalid environment configuration:\n${problems}`);
  }

  return result.data;
}
