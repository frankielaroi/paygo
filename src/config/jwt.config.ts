import type { ConfigService } from '@nestjs/config';
import type { StringValue } from 'ms';
import type { Env } from './env.validation';

/**
 * RS256 keys are stored base64-encoded so a PEM fits on one line in a .env file or a
 * secrets manager without newline escaping. This is the only place that turns the env value
 * into a key. The format is validated at boot by env.validation.ts, so a failure here means
 * the value changed after startup.
 */
function decodeKey(pemBase64: string, variable: string): string {
  const pem = Buffer.from(pemBase64, 'base64').toString('utf8');

  if (!pem.includes('-----BEGIN')) {
    throw new Error(
      `${variable} does not decode to a PEM key. Expected base64-encoded PEM.`,
    );
  }

  return pem;
}

export interface JwtKeyConfig {
  privateKey: string;
  publicKey: string;
  /** The type jsonwebtoken accepts, e.g. "15m". A bare string will not compile. */
  expiresIn: StringValue;
  issuer: string;
}

export function jwtKeyConfig(config: ConfigService<Env, true>): JwtKeyConfig {
  return {
    privateKey: decodeKey(
      config.get('JWT_PRIVATE_KEY_BASE64', { infer: true }),
      'JWT_PRIVATE_KEY_BASE64',
    ),
    publicKey: decodeKey(
      config.get('JWT_PUBLIC_KEY_BASE64', { infer: true }),
      'JWT_PUBLIC_KEY_BASE64',
    ),
    expiresIn: config.get('JWT_EXPIRES_IN', { infer: true }),
    issuer: config.get('JWT_ISSUER', { infer: true }),
  };
}
