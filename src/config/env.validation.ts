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

export const envSchema = z.object({
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

  SWAGGER_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),

  // Seed-only, so optional: the app itself never reads them.
  SEED_ADMIN_EMAIL: z.string().email().optional(),
  SEED_ADMIN_PASSWORD: z.string().min(12).optional(),
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
