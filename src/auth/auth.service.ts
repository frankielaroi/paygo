import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import type { Env } from '../config/env.validation';
import type { LoginResponseDto } from './dto/login-response.dto';
import type { RefreshResponseDto } from './dto/refresh-response.dto';
import type { StaffJwtPayload } from './jwt-payload';
import type { LoginDto } from './dto/login.dto';
import { PasswordService } from './password.service';
import {
  type RefreshTokenContext,
  RefreshTokenService,
} from './refresh-token.service';

/**
 * A valid argon2id hash of a value no password will match. Keeps the failure path for an
 * unknown email as slow as the path for a known one.
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$Iy0N7DfBhGrBLJDjeBxpvCOjRUHOZHvZAUCz9DmTQ4g';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly passwords: PasswordService,
    private readonly refreshTokens: RefreshTokenService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async login(
    dto: LoginDto,
    context: RefreshTokenContext = {},
  ): Promise<LoginResponseDto> {
    const email = dto.email.toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email } });

    // One generic failure for every reason a login can fail, so the endpoint cannot be used
    // to enumerate staff or to discover that an account is locked.
    const invalid = new UnauthorizedException('Invalid credentials');

    const locked =
      user?.lockedUntil !== null &&
      user?.lockedUntil !== undefined &&
      user.lockedUntil.getTime() > Date.now();

    // Verify against a dummy hash when the user is missing or locked, so the response time
    // does not reveal either fact.
    const passwordMatches = await this.passwords.verify(
      user && !locked ? user.passwordHash : DUMMY_HASH,
      dto.password,
    );

    if (!user || locked || !passwordMatches || !user.isActive) {
      if (user && !locked && !passwordMatches) {
        await this.recordFailedAttempt(user.id, user.failedLoginAttempts);
      }

      this.logger.warn(`Failed login for ${email}`);
      throw invalid;
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        lastLoginAt: new Date(),
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    });

    const refresh = await this.refreshTokens.issue(user.id, context);

    return {
      accessToken: await this.signAccessToken({
        sub: user.id,
        kind: 'staff',
        email: user.email,
        role: user.role,
      }),
      refreshToken: refresh.token,
      refreshTokenExpiresAt: refresh.expiresAt.toISOString(),
      expiresIn: this.config.get('JWT_EXPIRES_IN', { infer: true }),
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
      },
    };
  }

  /**
   * Exchanges a refresh token for a new access token and a new refresh token. The user's
   * role is read from the database, so a demotion applies to the next access token rather
   * than surviving as long as the session does.
   */
  async refresh(
    presented: string,
    context: RefreshTokenContext = {},
  ): Promise<RefreshResponseDto> {
    const rotated = await this.refreshTokens.rotate(presented, context);

    const user = await this.prisma.user.findUnique({
      where: { id: rotated.userId },
      select: { id: true, email: true, role: true, isActive: true },
    });

    if (!user || !user.isActive) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    return {
      accessToken: await this.signAccessToken({
        sub: user.id,
        kind: 'staff',
        email: user.email,
        role: user.role,
      }),
      refreshToken: rotated.token,
      refreshTokenExpiresAt: rotated.expiresAt.toISOString(),
      expiresIn: this.config.get('JWT_EXPIRES_IN', { infer: true }),
    };
  }

  async logout(presented: string): Promise<void> {
    await this.refreshTokens.revoke(presented);
  }

  private signAccessToken(payload: StaffJwtPayload): Promise<string> {
    return this.jwt.signAsync(payload);
  }

  /**
   * Per-account lockout, which IP rate limiting cannot provide: a distributed attack on one
   * known admin address comes from many addresses. The window is deliberately short, because
   * a long lockout hands an attacker who knows an email a way to keep that person out.
   */
  private async recordFailedAttempt(
    userId: string,
    previousAttempts: number,
  ): Promise<void> {
    const maxAttempts = this.config.get('LOGIN_MAX_ATTEMPTS', { infer: true });
    const lockoutMinutes = this.config.get('LOGIN_LOCKOUT_MINUTES', {
      infer: true,
    });

    const attempts = previousAttempts + 1;
    const reachedLimit = attempts >= maxAttempts;

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        failedLoginAttempts: reachedLimit ? 0 : attempts,
        lockedUntil: reachedLimit
          ? new Date(Date.now() + lockoutMinutes * 60 * 1000)
          : null,
      },
    });

    if (reachedLimit) {
      this.logger.warn(
        `Account ${userId} locked for ${lockoutMinutes} minutes after ${attempts} failed attempts`,
      );
    }
  }
}
