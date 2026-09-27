import { z } from 'zod';

/**
 * Decodes a base64 PEM and fails if the result is not a key. This is the check that turns
 * "a missing or malformed JWT key" from a 500 on the first login into a refusal to boot.
 */
const base64Pem = (label: string) =>
  z
    .string()
    .min(1, `${label} is required`)
    .refine(
      (value) => {
        try {
          return Buffer.from(value, 'base64')
            .toString('utf8')
            .includes('-----BEGIN');
        } catch {
          return false;
        }
      },
      { message: `${label} must be a base64-encoded PEM key` },
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

  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().max(365).default(30),

  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().positive().max(100).default(5),
  LOGIN_LOCKOUT_MINUTES: z.coerce.number().int().positive().max(1440).default(15),
  LOGIN_RATE_LIMIT: z.coerce.number().int().positive().default(10),
  LOGIN_RATE_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),

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
