import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { RefreshTokenService } from './refresh-token.service';
import { PrismaService } from '../prisma/prisma.service';
import { StaffRole } from '../users/enums/role.enum';

const activeAdmin = {
  id: 'user-1',
  email: 'admin@paygo.test',
  passwordHash: 'hash',
  firstName: 'Platform',
  lastName: 'Admin',
  role: StaffRole.ADMIN,
  isActive: true,
};

function build(
  overrides: {
    user?: unknown;
    passwordMatches?: boolean;
  } = {},
) {
  const prisma = {
    user: {
      // 'user' in overrides, not ?? : `user: null` is a case under test.
      findUnique: jest
        .fn()
        .mockResolvedValue('user' in overrides ? overrides.user : activeAdmin),
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
    get: jest.fn().mockReturnValue('15m'),
  } as unknown as ConfigService;

  return {
    service: new AuthService(prisma, jwt, passwords, refreshTokens, config),
    prisma,
    passwords,
    jwt,
    refreshTokens,
  };
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
