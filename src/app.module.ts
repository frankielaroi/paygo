import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { PrismaModule } from './prisma/prisma.module';
import { TcpModule } from './tcp/tcp.module';
import { TrackingModule } from './tracking/tracking.module';
import { EnforcementModule } from './enforcement/enforcement.module';
import { AssetsModule } from './assets/assets.module';
import { CustomersModule } from './customers/customers.module';
import { LoansModule } from './loans/loans.module';
import { PaymentsModule } from './payments/payments.module';
import { NotificationsModule } from './notifications/notifications.module';
import { UsersModule } from './users/users.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { type Env, validateEnv } from './config/env.validation';
import { throttlerOptions } from './config/throttler';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Aborts the bootstrap on a bad or missing variable, so a deployment cannot start and
      // then fail on the first login.
      validate: validateEnv,
    }),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        throttlerOptions({
          loginLimit: config.get('LOGIN_RATE_LIMIT', { infer: true }),
          loginWindowSeconds: config.get('LOGIN_RATE_WINDOW_SECONDS', {
            infer: true,
          }),
        }),
    }),
    EventEmitterModule.forRoot(),
    PrismaModule,
    AuthModule,
    TcpModule,
    TrackingModule,
    EnforcementModule,
    AssetsModule,
    CustomersModule,
    LoansModule,
    PaymentsModule,
    NotificationsModule,
    UsersModule,
    DashboardModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // Order matters: rate limit before doing any work, then authenticate, then authorize.
    // All three are global, so a new route is protected by default and must opt out.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
