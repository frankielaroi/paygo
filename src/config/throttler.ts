import { seconds, type ThrottlerModuleOptions } from '@nestjs/throttler';
import { isCredentialEndpoint } from '../common/decorators/credential-throttle.decorator';

/**
 * Rate limits, per client (request.ip, which honours TRUST_PROXY) and per route:
 * - 'default': ordinary traffic, on every route.
 * - 'login': the tight credential limit, only on routes marked @CredentialThrottle().
 */
export function throttlerOptions(limits: {
  loginLimit: number;
  loginWindowSeconds: number;
}): ThrottlerModuleOptions {
  return {
    throttlers: [
      { name: 'default', ttl: seconds(60), limit: 120 },
      {
        name: 'login',
        ttl: seconds(limits.loginWindowSeconds),
        limit: limits.loginLimit,
        // Named throttlers apply to every route unless skipped: opt in, don't opt out.
        skipIf: (context) => !isCredentialEndpoint(context),
      },
    ],
  };
}
