import { Controller, Get, type INestApplication, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { setupCors } from './cors';

const FRONTEND = 'https://paygofrontend.vercel.app';

@Controller()
class ProbeController {
  @Get('probe')
  read(): { ok: true } {
    return { ok: true };
  }

  @Post('probe')
  write(): { ok: true } {
    return { ok: true };
  }
}

/**
 * Driven over real HTTP, because what matters is the headers a browser receives, and those
 * come from Express's cors middleware rather than from anything this module computes.
 */
describe('setupCors', () => {
  async function appWith(
    origins: string[],
  ): Promise<{ app: INestApplication<App>; enabled: boolean }> {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController],
    }).compile();
    const app = moduleRef.createNestApplication<INestApplication<App>>();
    const enabled = setupCors(app, origins);
    await app.init();
    return { app, enabled };
  }

  const preflight = (app: INestApplication<App>, origin: string) =>
    request(app.getHttpServer())
      .options('/probe')
      .set('Origin', origin)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type,authorization');

  describe('with the frontend allowed', () => {
    let app: INestApplication<App>;

    beforeAll(async () => {
      ({ app } = await appWith([FRONTEND]));
    });

    afterAll(async () => {
      await app.close();
    });

    // The failure this replaces: the preflight got a 404 with no CORS headers, and the browser
    // blocked every JSON or authorized request before it was sent.
    it('answers the preflight for the allowed origin', async () => {
      const response = await preflight(app, FRONTEND);

      expect(response.status).toBe(204);
      expect(response.headers['access-control-allow-origin']).toBe(FRONTEND);
      expect(response.headers['access-control-allow-methods']).toContain(
        'POST',
      );
      expect(response.headers['access-control-allow-headers']).toContain(
        'Authorization',
      );
    });

    it('names the origin on an actual response', async () => {
      const response = await request(app.getHttpServer())
        .get('/probe')
        .set('Origin', FRONTEND);

      expect(response.status).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBe(FRONTEND);
    });

    it('gives another origin no allow-origin header', async () => {
      const response = await preflight(app, 'https://evil.example.com');

      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });

    // A look-alike host must not pass because it starts with, or contains, the allowed one.
    it.each([
      'https://paygofrontend.vercel.app.evil.example.com',
      'http://paygofrontend.vercel.app',
      'https://other.vercel.app',
    ])('gives %s no allow-origin header', async (origin) => {
      const response = await request(app.getHttpServer())
        .get('/probe')
        .set('Origin', origin);

      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });

    // Tokens travel in headers and bodies. Allowing credentials would invite a cookie later
    // without anyone deciding to.
    it('does not allow credentials', async () => {
      const response = await preflight(app, FRONTEND);

      expect(
        response.headers['access-control-allow-credentials'],
      ).toBeUndefined();
    });
  });

  describe('with no origin configured', () => {
    let app: INestApplication<App>;
    let enabled: boolean;

    beforeAll(async () => {
      ({ app, enabled } = await appWith([]));
    });

    afterAll(async () => {
      await app.close();
    });

    it('reports that nothing was enabled', () => {
      expect(enabled).toBe(false);
    });

    it('sends no CORS headers at all', async () => {
      const response = await request(app.getHttpServer())
        .get('/probe')
        .set('Origin', FRONTEND);

      expect(response.status).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });
  });
});
