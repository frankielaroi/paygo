import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { RefreshTokenService } from './refresh-token.service';
import { PrismaService } from '../prisma/prisma.service';
import type { Env } from '../config/env.validation';

interface StoredToken {
  id: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  replacedById: string | null;
  userId: string;
  user: { id: string; isActive: boolean };
}

const hash = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

/**
 * A small in-memory stand-in for the refresh_tokens table. Worth the few lines: rotation and
 * reuse detection are about what happens to OTHER rows, which a per-call mock cannot show.
 */
function buildStore(seed: Partial<StoredToken> & { tokenHash: string }) {
  const rows: StoredToken[] = [
    {
      id: 'token-1',
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
      replacedById: null,
      userId: 'user-1',
      user: { id: 'user-1', isActive: true },
      ...seed,
    },
  ];

  let created = 0;

  const tx = {
    refreshToken: {
      findUnique: jest.fn(
        ({ where }: { where: { tokenHash: string } }) =>
          rows.find((r) => r.tokenHash === where.tokenHash) ?? null,
      ),
      // Matches Prisma's conditional-update semantics, which the rotation relies on to
      // claim a row exactly once.
      create: jest.fn(
        ({ data }: { data: { tokenHash: string; userId: string } }) => {
          created += 1;
          const row: StoredToken = {
            id: `token-new-${created}`,
            tokenHash: data.tokenHash,
            expiresAt: new Date(Date.now() + 60_000),
            revokedAt: null,
            replacedById: null,
            userId: data.userId,
            user: { id: data.userId, isActive: true },
          };
          rows.push(row);
          return row;
        },
      ),
      update: jest.fn(
        ({
          where,
          data,
        }: {
          where: { id: string };
          data: Partial<StoredToken>;
        }) => {
          const row = rows.find((r) => r.id === where.id);
          if (row) Object.assign(row, data);
          return row;
        },
      ),
      updateMany: jest.fn(
        ({
          where,
          data,
        }: {
          where: { id?: string; userId?: string; revokedAt: null };
          data: Partial<StoredToken>;
        }) => {
          const affected = rows.filter(
            (r) =>
              (where.id === undefined || r.id === where.id) &&
              (where.userId === undefined || r.userId === where.userId) &&
              r.revokedAt === null,
          );
          affected.forEach((r) => Object.assign(r, data));
          return { count: affected.length };
        },
      ),
    },
  };

  const prisma = {
    ...tx,
    // Rolls back on throw, like a real transaction. Without this the double is wrong in the
    // one way that matters here: a write followed by a throw would look committed, so a
    // rollback bug in the service would pass its own tests.
    $transaction: jest.fn(
      async (fn: (client: typeof tx) => Promise<unknown>) => {
        const snapshot = rows.map((row) => ({ ...row, user: { ...row.user } }));

        try {
          return await fn(tx);
        } catch (error) {
          rows.length = 0;
          rows.push(...snapshot);
          throw error;
        }
      },
    ),
  } as unknown as PrismaService;

  const config = {
    get: jest.fn(() => 30),
  } as unknown as ConfigService<Env, true>;

  return { service: new RefreshTokenService(prisma, config), rows, tx };
}

describe('RefreshTokenService', () => {
  it('stores only a hash of the token, never the token itself', async () => {
    const { service, tx } = buildStore({ tokenHash: hash('original') });

    const issued = await service.issue('user-1');
    const created = tx.refreshToken.create.mock.calls[0][0] as {
      data: { tokenHash: string };
    };

    expect(created.data.tokenHash).toBe(hash(issued.token));
    expect(created.data.tokenHash).not.toBe(issued.token);
    expect(JSON.stringify(created)).not.toContain(issued.token);
  });

  it('rotates: the presented token is revoked and a new one returned', async () => {
    const { service, rows } = buildStore({ tokenHash: hash('original') });

    const rotated = await service.rotate('original');

    expect(rotated.token).not.toBe('original');
    expect(rotated.userId).toBe('user-1');
    expect(rows[0].revokedAt).not.toBeNull();
    expect(rows[0].replacedById).toBe('token-new-1');
    expect(rows[1].revokedAt).toBeNull();
  });

  it('rejects an unknown token', async () => {
    const { service } = buildStore({ tokenHash: hash('original') });

    await expect(service.rotate('never-issued')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects an expired token', async () => {
    const { service } = buildStore({
      tokenHash: hash('original'),
      expiresAt: new Date(Date.now() - 1),
    });

    await expect(service.rotate('original')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a token belonging to a deactivated user', async () => {
    const { service } = buildStore({
      tokenHash: hash('original'),
      user: { id: 'user-1', isActive: false },
    });

    await expect(service.rotate('original')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  // The theft-detection property: replaying a rotated token kills every session, because
  // either the token leaked or someone is replaying it, and neither is recoverable quietly.
  it('revokes every session for the user when a rotated token is presented again', async () => {
    const { service, rows } = buildStore({ tokenHash: hash('original') });

    const first = await service.rotate('original');
    expect(
      rows.find((r) => r.tokenHash === hash(first.token))?.revokedAt,
    ).toBeNull();

    await expect(service.rotate('original')).rejects.toThrow(
      UnauthorizedException,
    );

    // Including the legitimate replacement, which is the point: the real user is forced to
    // log in again rather than sharing a session with an attacker. This assertion is what
    // catches doing the revocation inside the transaction that then throws.
    expect(rows.every((r) => r.revokedAt !== null)).toBe(true);
  });

  it('issues a different token every time', async () => {
    const { service } = buildStore({ tokenHash: hash('original') });

    const tokens = await Promise.all([
      service.issue('user-1'),
      service.issue('user-1'),
      service.issue('user-1'),
    ]);

    expect(new Set(tokens.map((t) => t.token)).size).toBe(3);
  });

  it('treats revoking an unknown token as a no-op rather than an error', async () => {
    const { service } = buildStore({ tokenHash: hash('original') });

    await expect(service.revoke('never-issued')).resolves.toBeUndefined();
  });

  it('revokes all sessions for a user and reports how many', async () => {
    const { service } = buildStore({ tokenHash: hash('original') });

    await service.issue('user-1');

    expect(await service.revokeAllForUser('user-1')).toBe(2);
    expect(await service.revokeAllForUser('user-1')).toBe(0);
  });

  it('truncates audit metadata instead of letting an oversized header through', async () => {
    const { service, tx } = buildStore({ tokenHash: hash('original') });

    await service.issue('user-1', {
      userAgent: 'x'.repeat(5000),
      ipAddress: '1.2.3.4',
    });
    const created = tx.refreshToken.create.mock.calls[0][0] as {
      data: { userAgent: string };
    };

    expect(created.data.userAgent).toHaveLength(255);
  });

  it('rejects a concurrent second rotation of the same token', async () => {
    const { service, rows } = buildStore({ tokenHash: hash('original') });

    const [first, second] = await Promise.allSettled([
      service.rotate('original'),
      service.rotate('original'),
    ]);

    // Exactly one wins. The other must not be handed a valid session.
    const fulfilled = [first, second].filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    expect(rows.filter((r) => r.revokedAt === null)).toHaveLength(1);
  });
});
