import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { RefreshTokenService } from './refresh-token.service';
import { PrismaService } from '../prisma/prisma.service';
import type { Env } from '../config/env.validation';
import { StaffRole } from '../users/enums/role.enum';

const activeAdmin = {
  id: 'user-1',
  email: 'admin@paygo.test',
  passwordHash: 'hash',
  firstName: 'Platform',
  lastName: 'Admin',
  role: StaffRole.ADMIN,
  isActive: true,
  failedLoginAttempts: 0,
  lockedUntil: null as Date | null,
};

const CONFIG_VALUES: Record<string, string | number> = {
  JWT_EXPIRES_IN: '15m',
  LOGIN_MAX_ATTEMPTS: 5,
  LOGIN_LOCKOUT_MINUTES: 15,
};

function build(
  overrides: {
    user?: unknown;
    /** Accounts a phone lookup finds. Defaults to the admin alone. */
    phoneMatches?: unknown[];
    passwordMatches?: boolean;
  } = {},
) {
  const prisma = {
    user: {
      // 'user' in overrides, not ?? : `user: null` is a case under test.
      findUnique: jest
        .fn()
        .mockResolvedValue('user' in overrides ? overrides.user : activeAdmin),
      findMany: jest
        .fn()
        .mockResolvedValue(overrides.phoneMatches ?? [activeAdmin]),
      update: jest.fn().mockResolvedValue(undefined),
    },
  } as unknown as PrismaService;

  const passwords = {
    verify: jest.fn().mockResolvedValue(overrides.passwordMatches ?? true),
  } as unknown as PasswordService;

  const jwt = {
    signAsync: jest.fn().mockResolvedValue('signed.jwt.token'),
  } as unknown as JwtService;

  const refreshTokens = {
    issue: jest.fn().mockResolvedValue({
      token: 'refresh-token',
      expiresAt: new Date('2026-01-01T00:00:00.000Z'),
    }),
    rotate: jest.fn(),
    revoke: jest.fn(),
  } as unknown as RefreshTokenService;

  const config = {
    getOrThrow: jest.fn(),
    // Keyed, not a single return value: the lockout maths compares against numbers, and a
    // blanket '15m' would make `attempts >= maxAttempts` silently false forever.
    get: jest.fn((key: string) => CONFIG_VALUES[key]),
  } as unknown as ConfigService<Env, true>;

  return {
    service: new AuthService(prisma, jwt, passwords, refreshTokens, config),
    prisma,
    passwords,
    jwt,
    refreshTokens,
  };
}

interface UserUpdateArgs {
  where: { id: string };
  data: {
    failedLoginAttempts?: number;
    lockedUntil?: Date | null;
    lastLoginAt?: Date;
  };
}

/** jest.Mock is `any`-typed by default, which defeats the no-any rules. Narrow it once. */
function updateCalls(prisma: PrismaService): UserUpdateArgs[] {
  const mock = prisma.user.update as unknown as jest.Mock<
    unknown,
    [UserUpdateArgs]
  >;

  return mock.mock.calls.map(([args]) => args);
}

const credentials = { email: 'admin@paygo.test', password: 'correct-horse' };

describe('AuthService.login', () => {
  it('returns a token and the user for valid credentials', async () => {
    const { service, jwt } = build();

    const result = await service.login(credentials);

    expect(result.accessToken).toBe('signed.jwt.token');
    expect(result.user).toEqual({
      id: 'user-1',
      email: 'admin@paygo.test',
      firstName: 'Platform',
      lastName: 'Admin',
      role: StaffRole.ADMIN,
    });
    expect(jwt.signAsync).toHaveBeenCalledWith({
      sub: 'user-1',
      kind: 'staff',
      email: 'admin@paygo.test',
      role: StaffRole.ADMIN,
    });
  });

  it('never returns the password hash', async () => {
    const { service } = build();

    const result = await service.login(credentials);

    expect(JSON.stringify(result)).not.toContain('hash');
  });

  it('lowercases the email before lookup', async () => {
    const { service, prisma } = build();

    await service.login({ ...credentials, email: 'Admin@PayGo.Test' });

    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { email: 'admin@paygo.test' },
    });
  });

  it('rejects a wrong password', async () => {
    const { service } = build({ passwordMatches: false });

    await expect(service.login(credentials)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects an unknown email', async () => {
    const { service } = build({ user: null, passwordMatches: false });

    await expect(service.login(credentials)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a deactivated account even with the right password', async () => {
    const { service } = build({
      user: { ...activeAdmin, isActive: false },
      passwordMatches: true,
    });

    await expect(service.login(credentials)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  // Enumeration resistance: every failure must look the same to the caller.
  it('gives the same message for an unknown email and a wrong password', async () => {
    const unknown = build({ user: null, passwordMatches: false });
    const wrongPassword = build({ passwordMatches: false });

    const messages = await Promise.all(
      [unknown, wrongPassword].map((h) =>
        h.service.login(credentials).catch((e: Error) => e.message),
      ),
    );

    expect(messages[0]).toBe(messages[1]);
    expect(messages[0]).toBe('Invalid credentials');
  });

  // Timing resistance: the unknown-email path must still run a hash verification.
  it('verifies against a dummy hash when the email is unknown', async () => {
    const { service, passwords } = build({
      user: null,
      passwordMatches: false,
    });

    await service.login(credentials).catch(() => undefined);

    expect(passwords.verify).toHaveBeenCalledTimes(1);
    const [hash] = (passwords.verify as jest.Mock).mock.calls[0] as string[];
    expect(hash).toMatch(/^\$argon2id\$/);
  });

  it('does not issue a token when login fails', async () => {
    const { service, jwt } = build({ passwordMatches: false });

    await service.login(credentials).catch(() => undefined);

    expect(jwt.signAsync).not.toHaveBeenCalled();
  });
});

describe('AuthService.login by phone', () => {
  const byPhone = { phone: '0241234567', password: 'correct-horse' };

  interface FindManyArgs {
    where: { phone: { in: string[] } };
  }

  it('signs in with a phone number in any stored form', async () => {
    const { service, prisma } = build();

    const result = await service.login(byPhone);

    expect(result.accessToken).toBe('signed.jwt.token');
    const findMany = prisma.user.findMany as unknown as jest.Mock<
      unknown,
      [FindManyArgs]
    >;
    expect(findMany.mock.calls[0][0].where.phone.in).toEqual(
      expect.arrayContaining(['0241234567', '+233241234567', '233241234567']),
    );
  });

  it('rejects an unknown phone with the same error as a wrong password', async () => {
    const { service, passwords } = build({
      phoneMatches: [],
      passwordMatches: false,
    });

    await expect(service.login(byPhone)).rejects.toThrow('Invalid credentials');
    // Still hashes, so timing does not reveal that the number is unknown.
    expect(passwords.verify).toHaveBeenCalledTimes(1);
  });

  // Two accounts holding one number in different forms: signing in either would be a guess.
  it('refuses a phone that matches more than one account', async () => {
    const { service, jwt } = build({
      phoneMatches: [activeAdmin, { ...activeAdmin, id: 'user-2' }],
    });

    await expect(service.login(byPhone)).rejects.toThrow(UnauthorizedException);
    expect(jwt.signAsync).not.toHaveBeenCalled();
  });

  it('counts failed phone attempts against the account', async () => {
    const { service, prisma } = build({ passwordMatches: false });

    await service.login(byPhone).catch(() => undefined);

    expect(updateCalls(prisma)[0].data.failedLoginAttempts).toBe(1);
  });

  it.each([
    ['both', { ...credentials, phone: '0241234567' }],
    ['neither', { password: 'correct-horse' }],
  ])('refuses %s email and phone', async (_case, dto) => {
    const { service } = build();

    await expect(service.login(dto)).rejects.toThrow(BadRequestException);
  });
});

describe('AuthService.login lockout', () => {
  it('counts a failed attempt against the account', async () => {
    const { service, prisma } = build({ passwordMatches: false });

    await service.login(credentials).catch(() => undefined);

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { failedLoginAttempts: 1, lockedUntil: null },
    });
  });

  it('locks the account once the attempt limit is reached', async () => {
    const { service, prisma } = build({
      user: { ...activeAdmin, failedLoginAttempts: 4 },
      passwordMatches: false,
    });

    await service.login(credentials).catch(() => undefined);

    const [call] = updateCalls(prisma);

    expect(call.data.failedLoginAttempts).toBe(0);
    expect(call.data.lockedUntil).toBeInstanceOf(Date);
    expect(call.data.lockedUntil?.getTime()).toBeGreaterThan(Date.now());
  });

  // The lockout must not become an oracle: "account locked" would confirm the email exists.
  it('gives the same error for a locked account as for a wrong password', async () => {
    const locked = build({
      user: {
        ...activeAdmin,
        lockedUntil: new Date(Date.now() + 60_000),
      },
      passwordMatches: true,
    });
    const wrong = build({ passwordMatches: false });

    const messages = await Promise.all(
      [locked, wrong].map((h) =>
        h.service.login(credentials).catch((e: Error) => e.message),
      ),
    );

    expect(messages[0]).toBe('Invalid credentials');
    expect(messages[1]).toBe('Invalid credentials');
  });

  it('refuses a locked account even when the password is correct', async () => {
    const { service, jwt } = build({
      user: { ...activeAdmin, lockedUntil: new Date(Date.now() + 60_000) },
      passwordMatches: true,
    });

    await expect(service.login(credentials)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(jwt.signAsync).not.toHaveBeenCalled();
  });

  it('still verifies a hash for a locked account, so timing does not reveal the lock', async () => {
    const { service, passwords } = build({
      user: { ...activeAdmin, lockedUntil: new Date(Date.now() + 60_000) },
      passwordMatches: true,
    });

    await service.login(credentials).catch(() => undefined);

    const [hash] = (passwords.verify as jest.Mock).mock.calls[0] as string[];
    expect(hash).toMatch(/^\$argon2id\$/);
  });

  it('accepts a login once the lockout has expired', async () => {
    const { service } = build({
      user: { ...activeAdmin, lockedUntil: new Date(Date.now() - 1000) },
      passwordMatches: true,
    });

    await expect(service.login(credentials)).resolves.toMatchObject({
      accessToken: 'signed.jwt.token',
    });
  });

  it('clears the counter and the lock on a successful login', async () => {
    const { service, prisma } = build({
      user: { ...activeAdmin, failedLoginAttempts: 3 },
    });

    await service.login(credentials);

    const [call] = updateCalls(prisma);

    expect(call.where).toEqual({ id: 'user-1' });
    expect(call.data.failedLoginAttempts).toBe(0);
    expect(call.data.lockedUntil).toBeNull();
    expect(call.data.lastLoginAt).toBeInstanceOf(Date);
  });

  it('does not count attempts against an email that does not exist', async () => {
    const { service, prisma } = build({ user: null, passwordMatches: false });

    await service.login(credentials).catch(() => undefined);

    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('issues a refresh token alongside the access token', async () => {
    const { service, refreshTokens } = build();

    const result = await service.login(credentials, {
      ipAddress: '10.0.0.1',
      userAgent: 'jest',
    });

    expect(result.refreshToken).toBe('refresh-token');
    expect(refreshTokens.issue).toHaveBeenCalledWith('user-1', {
      ipAddress: '10.0.0.1',
      userAgent: 'jest',
    });
  });
});
