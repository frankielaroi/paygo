import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import type { LoginResponseDto } from '../src/auth/dto/login-response.dto';
import type { RefreshResponseDto } from '../src/auth/dto/refresh-response.dto';

interface ErrorBody {
  message: string | string[];
}

/**
 * Runs against the real database, so it needs the seeded admin
 * (npm run db:seed) and the credentials in .env.
 */
describe('Auth (e2e)', () => {
  let app: INestApplication<App>;
  const email = process.env.SEED_ADMIN_EMAIL ?? 'admin@paygo.local';
  const password = process.env.SEED_ADMIN_PASSWORD ?? 'ChangeMe!2026';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects /auth/me without a token', async () => {
    await request(app.getHttpServer()).get('/auth/me').expect(401);
  });

  it('rejects a bad password with a generic message', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: 'definitely-wrong' })
      .expect(401);

    expect((response.body as ErrorBody).message).toBe('Invalid credentials');
  });

  it('returns the same message for an unknown email', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'nobody@paygo.local', password: 'definitely-wrong' })
      .expect(401);

    expect((response.body as ErrorBody).message).toBe('Invalid credentials');
  });

  it('strips unknown properties instead of accepting them', async () => {
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password, role: 'ADMIN' })
      .expect(400);
  });

  it('logs in and reaches a protected route', async () => {
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(200);

    const body = login.body as LoginResponseDto;
    expect(body.accessToken).toBeDefined();
    expect(body.user).not.toHaveProperty('passwordHash');

    const me = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${body.accessToken}`)
      .expect(200);

    expect(me.body).toMatchObject({ kind: 'staff', email });
  });

  it('rejects a token whose signature was altered', async () => {
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(200);

    const [header, payload, signature] = (
      login.body as LoginResponseDto
    ).accessToken.split('.');
    // Flip a character in the middle: the final base64url character of an RSA signature
    // carries unused bits, so changing it can decode to the same signature.
    const altered = signature[40] === 'A' ? 'B' : 'A';
    const tampered = `${header}.${payload}.${signature.slice(0, 40)}${altered}${signature.slice(41)}`;

    await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${tampered}`)
      .expect(401);
  });

  describe('refresh tokens', () => {
    const loginFresh = async (): Promise<LoginResponseDto> => {
      const response = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password })
        .expect(200);

      return response.body as LoginResponseDto;
    };

    it('rotates the refresh token and returns a working access token', async () => {
      const login = await loginFresh();

      const refreshed = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: login.refreshToken })
        .expect(200);

      const body = refreshed.body as RefreshResponseDto;
      expect(body.refreshToken).not.toBe(login.refreshToken);

      await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${body.accessToken}`)
        .expect(200);
    });

    // Theft detection: replaying a rotated token revokes the whole family, including the
    // replacement the legitimate client is holding.
    it('revokes every session when a rotated token is replayed', async () => {
      const login = await loginFresh();

      const refreshed = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: login.refreshToken })
        .expect(200);

      const replacement = (refreshed.body as RefreshResponseDto).refreshToken;

      await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: login.refreshToken })
        .expect(401);

      // This is the assertion that fails if the revocation is done inside the transaction
      // that then throws: the rollback would leave this token usable.
      await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: replacement })
        .expect(401);
    });

    it('rejects an unknown refresh token', async () => {
      await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: 'a'.repeat(43) })
        .expect(401);
    });

    it('logs out idempotently and invalidates the token', async () => {
      const login = await loginFresh();

      await request(app.getHttpServer())
        .post('/auth/logout')
        .send({ refreshToken: login.refreshToken })
        .expect(204);

      await request(app.getHttpServer())
        .post('/auth/logout')
        .send({ refreshToken: login.refreshToken })
        .expect(204);

      await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: login.refreshToken })
        .expect(401);
    });
  });
});
