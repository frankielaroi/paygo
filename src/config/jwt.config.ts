import { ConfigService } from '@nestjs/config';
import type { StringValue } from 'ms';

/**
 * RS256 keys are stored base64-encoded so a PEM fits on one line in a .env file or a
 * secrets manager without newline escaping. Decoded here, which is the only place in the
 * app that turns the env value into a key.
 */
function decodeKey(config: ConfigService, variable: string): string {
  const encoded = config.getOrThrow<string>(variable);
  const pem = Buffer.from(encoded, 'base64').toString('utf8');

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
  expiresIn: StringValue | number;
  issuer: string;
}

export function jwtKeyConfig(config: ConfigService): JwtKeyConfig {
  return {
    privateKey: decodeKey(config, 'JWT_PRIVATE_KEY_BASE64'),
    publicKey: decodeKey(config, 'JWT_PUBLIC_KEY_BASE64'),
    expiresIn: (config.get<string>('JWT_EXPIRES_IN') ?? '15m') as StringValue,
    issuer: config.get<string>('JWT_ISSUER') ?? 'paygo',
  };
}
