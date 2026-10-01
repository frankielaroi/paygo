import { type ExecutionContext, SetMetadata } from '@nestjs/common';

const CREDENTIAL_ENDPOINT = 'credentialEndpoint';

/**
 * Counts a route against the tight 'login' rate limit (LOGIN_RATE_LIMIT per
 * LOGIN_RATE_WINDOW_SECONDS, per client) as well as the default one. For endpoints that take a
 * password or a refresh token.
 *
 * Every named throttler applies to every route unless skipped, and `@Throttle({ login: {} })`
 * sets no limits, so it does nothing. Without this opt-in, the login limit capped every route:
 * a user could load only ten pages a minute.
 */
export const CredentialThrottle = (): MethodDecorator & ClassDecorator =>
  SetMetadata(CREDENTIAL_ENDPOINT, true);

/** Whether the route opted into the login limit with @CredentialThrottle(). */
export function isCredentialEndpoint(context: ExecutionContext): boolean {
  return [context.getHandler(), context.getClass()].some(
    (target) => Reflect.getMetadata(CREDENTIAL_ENDPOINT, target) === true,
  );
}
