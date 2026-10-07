import type { INestApplication } from '@nestjs/common';

/**
 * Lets the named browser origins call the API. Returns false without enabling anything when
 * the list is empty, which is the default: same-origin pages and non-browser clients are
 * unaffected either way, since CORS only restricts what a browser will let a page read.
 *
 * No credentials: the access token travels in the Authorization header and the refresh token
 * in the request body, so there is no cookie for a browser to attach, and leaving this off
 * keeps it that way.
 */
export function setupCors(
  app: INestApplication,
  origins: readonly string[],
): boolean {
  if (origins.length === 0) {
    return false;
  }

  app.enableCors({
    origin: [...origins],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Last-Event-ID'],
    // Ten minutes: every JSON or authorized request is preflighted, and without a cache each
    // one costs the browser a second round trip.
    maxAge: 600,
  });

  return true;
}
