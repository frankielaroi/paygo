import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

export const SWAGGER_PATH = 'api';

/**
 * Mounted at /api. Returns false without mounting when docs are disabled, which is the
 * default in production: the schema names every endpoint and role boundary in the system,
 * so it is not published by accident.
 */
export function setupSwagger(app: INestApplication): boolean {
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  const explicitlyEnabled = process.env.SWAGGER_ENABLED === 'true';

  if (nodeEnv === 'production' && !explicitlyEnabled) {
    return false;
  }

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('PayGo API')
      .setDescription(
        'Pay-as-you-go motorbike financing. Staff endpoints require a bearer token; ' +
          'obtain one from POST /auth/login.',
      )
      .setVersion('0.1.0')
      .addBearerAuth(
        {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Access token from POST /auth/login',
        },
        'bearer',
      )
      .addTag('auth', 'Sign in and inspect the current principal')
      .build(),
  );

  SwaggerModule.setup(SWAGGER_PATH, app, document, {
    swaggerOptions: {
      // Keeps the token across page reloads while developing.
      persistAuthorization: true,
    },
  });

  return true;
}
