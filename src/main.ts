import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import type { Env } from './config/env.validation';
import { SWAGGER_PATH, setupSwagger } from './config/swagger';

async function bootstrap() {
  // rawBody: the Paystack webhook signature is an HMAC over the exact bytes received.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });
  const logger = new Logger('Bootstrap');

  // request.ip, and so the per-IP throttler, reads X-Forwarded-For only from these proxies.
  const trustProxy = app
    .get<ConfigService<Env, true>>(ConfigService)
    .get('TRUST_PROXY', { infer: true });
  app.set('trust proxy', trustProxy);
  if (trustProxy !== false) {
    logger.log(`Trusting X-Forwarded-For from: ${String(trustProxy)}`);
  }

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const docsMounted = setupSwagger(app);

  const port = process.env.PORT ?? 3000;
  await app.listen(port);

  logger.log(`API listening on http://localhost:${port}`);
  if (docsMounted) {
    logger.log(`Swagger UI at http://localhost:${port}/${SWAGGER_PATH}`);
  }
}

void bootstrap();
