import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import type { Env } from '../config/env.validation';

export interface RefreshTokenContext {
  userAgent?: string;
  ipAddress?: string;
}

export interface IssuedRefreshToken {
  token: string;
  expiresAt: Date;
}

/** A rotation result: the new token plus the user it belongs to. */
export interface RotatedRefreshToken extends IssuedRefreshToken {
  userId: string;
}

@Injectable()
export class RefreshTokenService {
  private readonly logger = new Logger(RefreshTokenService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * Opaque random bytes rather than a JWT. A refresh token has to be revocable, and a
   * self-contained signed token cannot be revoked without a blocklist that ends up being
   * the same database lookup anyway.
   */
  private generate(): string {
    return randomBytes(32).toString('base64url');
  }

  /** Stored as a hash so a database leak yields nothing replayable. */
  private hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private ttlDays(): number {
    return this.config.get('REFRESH_TOKEN_TTL_DAYS', { infer: true });
  }

  private expiryFromNow(): Date {
    return new Date(Date.now() + this.ttlDays() * 24 * 60 * 60 * 1000);
  }

  async issue(
    userId: string,
    context: RefreshTokenContext = {},
  ): Promise<IssuedRefreshToken> {
    const token = this.generate();
    const expiresAt = this.expiryFromNow();

    await this.prisma.refreshToken.create({
      data: {
        tokenHash: this.hash(token),
        expiresAt,
        userId,
        userAgent: context.userAgent?.slice(0, 255),
        ipAddress: context.ipAddress?.slice(0, 64),
      },
    });

    return { token, expiresAt };
  }

  /**
   * Consumes a refresh token and issues its replacement. Rotation is unconditional: a token
   * is single use, so a stolen one is only useful until the legitimate holder refreshes.
   *
   * If an already-revoked token is presented, the token leaked (the real holder rotated it,
   * or someone replayed it). Every token for that user is then revoked, which logs the
   * attacker and the user out and forces a fresh login.
   */
  async rotate(
    presented: string,
    context: RefreshTokenContext = {},
  ): Promise<RotatedRefreshToken> {
    const tokenHash = this.hash(presented);

    const existing = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: { select: { id: true, isActive: true } } },
    });

    if (!existing) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    // Reuse detection runs OUTSIDE a transaction on purpose. The revocation has to commit
    // and the request has to fail, and those two cannot happen in one transaction: the
    // throw would roll the revocation back.
    if (existing.revokedAt) {
      const revoked = await this.revokeAllForUser(existing.userId);

      this.logger.warn(
        `Reuse of a revoked refresh token for user ${existing.userId}. ` +
          `Revoked ${revoked} session(s).`,
      );

      throw new UnauthorizedException('Invalid refresh token');
    }

    if (existing.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (!existing.user.isActive) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const token = this.generate();
    const expiresAt = this.expiryFromNow();

    return this.prisma.$transaction(async (tx) => {
      // Claim the row conditionally. Two concurrent refreshes with the same token both pass
      // the checks above; only the one that flips revokedAt from null wins, and the loser is
      // treated as a reuse rather than being handed a second valid session.
      const claimed = await tx.refreshToken.updateMany({
        where: { id: existing.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      if (claimed.count !== 1) {
        throw new UnauthorizedException('Invalid refresh token');
      }

      const replacement = await tx.refreshToken.create({
        data: {
          tokenHash: this.hash(token),
          expiresAt,
          userId: existing.userId,
          userAgent: context.userAgent?.slice(0, 255),
          ipAddress: context.ipAddress?.slice(0, 64),
        },
      });

      await tx.refreshToken.update({
        where: { id: existing.id },
        data: { replacedById: replacement.id },
      });

      return { token, expiresAt, userId: existing.userId };
    });
  }

  /** Logout. Revoking an unknown or already-revoked token is a no-op, never an error. */
  async revoke(presented: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: this.hash(presented), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** Every session for a user, e.g. after a password change or a suspected compromise. */
  async revokeAllForUser(userId: string): Promise<number> {
    const result = await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    return result.count;
  }

  /**
   * Constant-time comparison helper for callers that need to compare two opaque tokens.
   * Not used on the lookup path, which compares hashes in the database by unique index.
   */
  static tokensMatch(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);

    return left.length === right.length && timingSafeEqual(left, right);
  }
}
