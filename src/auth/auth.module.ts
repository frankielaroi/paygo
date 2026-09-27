import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { RefreshTokenService } from './refresh-token.service';
import { JwtStrategy } from './strategy/jwt.strategy';
import { jwtKeyConfig } from '../config/jwt.config';
import type { Env } from '../config/env.validation';

@Module({
  imports: [
    PassportModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        const { privateKey, publicKey, expiresIn, issuer } =
          jwtKeyConfig(config);

        return {
          privateKey,
          publicKey,
          signOptions: { algorithm: 'RS256' as const, expiresIn, issuer },
          verifyOptions: { algorithms: ['RS256' as const], issuer },
        };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, PasswordService, RefreshTokenService, JwtStrategy],
  exports: [AuthService, PasswordService, RefreshTokenService],
})
export class AuthModule {}
