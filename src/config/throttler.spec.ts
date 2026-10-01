import { Controller, Get, type INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import type { App } from 'supertest/types';
import { CredentialThrottle } from '../common/decorators/credential-throttle.decorator';
import { throttlerOptions } from './throttler';

const LOGIN_LIMIT = 3;

@Controller()
class ProbeController {
  @Get('page')
  page(): string {
    return 'ok';
  }

  @CredentialThrottle()
  @Get('sign-in')
  signIn(): string {
    return 'ok';
  }
}

describe('throttlerOptions', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot(
          throttlerOptions({ loginLimit: LOGIN_LIMIT, loginWindowSeconds: 60 }),
        ),
      ],
      controllers: [ProbeController],
      providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(() => app.close());

  const hit = async (path: string, times: number): Promise<number[]> => {
    const statuses: number[] = [];
    for (let i = 0; i < times; i++) {
      statuses.push((await request(app.getHttpServer()).get(path)).status);
    }
    return statuses;
  };

  // The regression: the login limit used to apply to every route, so ordinary pages were
  // capped at LOGIN_RATE_LIMIT a minute.
  it('does not apply the login limit to ordinary routes', async () => {
    expect(await hit('/page', LOGIN_LIMIT * 4)).toEqual(
      Array<number>(LOGIN_LIMIT * 4).fill(200),
    );
  });

  it('applies the login limit to routes marked @CredentialThrottle()', async () => {
    expect(await hit('/sign-in', LOGIN_LIMIT + 1)).toEqual([
      ...Array<number>(LOGIN_LIMIT).fill(200),
      429,
    ]);
  });
});
