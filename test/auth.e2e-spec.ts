import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import type { LoginResponseDto } from '../src/auth/dto/login-response.dto';

interface ErrorBody {
  message: string | string[];
}

/**
 * Runs against the real database, so it needs the seeded admin
 * (npm run db:seed) and the credentials in .env.
 */
describe('Auth (e2e)', () => {
  let app: INestApplication;
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
});
