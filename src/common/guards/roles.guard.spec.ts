import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';
import { Permission, StaffRole } from '../../users/enums/role.enum';
import type { AuthenticatedStaff } from '../types/authenticated-staff';

const admin: AuthenticatedStaff = {
  kind: 'staff',
  id: 'a',
  email: 'a@paygo.test',
  role: StaffRole.ADMIN,
  mustChangePassword: false,
};
const agent: AuthenticatedStaff = {
  kind: 'staff',
  id: 'b',
  email: 'b@paygo.test',
  role: StaffRole.FIELD_AGENT,
  mustChangePassword: false,
};

function contextWith(user?: unknown): ExecutionContext {
  return {
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

/** Stubs the metadata lookups the guard makes, by key. */
function guardWith(meta: {
  isPublic?: boolean;
  roles?: StaffRole[];
  permissions?: Permission[];
  allowPendingPasswordChange?: boolean;
}): RolesGuard {
  const reflector = {
    getAllAndOverride: jest.fn((key: string) => {
      if (key === 'isPublic') return meta.isPublic;
      if (key === 'roles') return meta.roles;
      if (key === 'permissions') return meta.permissions;
      if (key === 'allowPendingPasswordChange')
        return meta.allowPendingPasswordChange;
      return undefined;
    }),
  } as unknown as Reflector;
  return new RolesGuard(reflector);
}

describe('RolesGuard', () => {
  describe('an account holding a temporary password', () => {
    const pending: AuthenticatedStaff = { ...admin, mustChangePassword: true };

    it('is refused on a route with no requirements at all', () => {
      expect(() => guardWith({}).canActivate(contextWith(pending))).toThrow(
        ForbiddenException,
      );
    });

    it('is refused even where its role would otherwise be enough', () => {
      expect(() =>
        guardWith({ roles: [StaffRole.ADMIN] }).canActivate(
          contextWith(pending),
        ),
      ).toThrow(ForbiddenException);
    });

    it('may use a route marked for changing the password', () => {
      expect(
        guardWith({ allowPendingPasswordChange: true }).canActivate(
          contextWith(pending),
        ),
      ).toBe(true);
    });

    it('does not affect an account with a real password', () => {
      expect(guardWith({}).canActivate(contextWith(admin))).toBe(true);
    });
  });

  it('allows a public route with no principal', () => {
    expect(guardWith({ isPublic: true }).canActivate(contextWith())).toBe(true);
  });

  it('allows an unannotated route through to the auth layer', () => {
    expect(guardWith({}).canActivate(contextWith())).toBe(true);
  });

  it('fails closed when a restricted route has no principal', () => {
    expect(() =>
      guardWith({ roles: [StaffRole.ADMIN] }).canActivate(contextWith()),
    ).toThrow(UnauthorizedException);
  });

  it('allows a matching role', () => {
    expect(
      guardWith({ roles: [StaffRole.ADMIN] }).canActivate(contextWith(admin)),
    ).toBe(true);
  });

  it('denies a non-matching role', () => {
    expect(() =>
      guardWith({ roles: [StaffRole.ADMIN] }).canActivate(contextWith(agent)),
    ).toThrow(ForbiddenException);
  });

  // Field agents may lock and unlock their own riders' bikes (granted deliberately, scoped in
  // the enforcement service), but never any bike.
  it('denies a field agent immobilizing any bike', () => {
    expect(() =>
      guardWith({
        permissions: [Permission.ASSET_IMMOBILIZE_ANY],
      }).canActivate(contextWith(agent)),
    ).toThrow(ForbiddenException);
  });

  it('grants an admin the immobilize permission', () => {
    expect(
      guardWith({ permissions: [Permission.ASSET_IMMOBILIZE] }).canActivate(
        contextWith(admin),
      ),
    ).toBe(true);
  });

  it('requires every listed permission, not just one', () => {
    expect(() =>
      guardWith({
        permissions: [Permission.CUSTOMER_CREATE, Permission.KYC_VERIFY],
      }).canActivate(contextWith(agent)),
    ).toThrow(ForbiddenException);
  });

  // The reason AuthenticatedStaff carries an explicit `kind`.
  it('rejects a non-staff principal that otherwise looks valid', () => {
    expect(() =>
      guardWith({ roles: [StaffRole.ADMIN] }).canActivate(
        contextWith({ kind: 'customer', id: 'c', role: StaffRole.ADMIN }),
      ),
    ).toThrow(ForbiddenException);
  });

  it('rejects a principal carrying an unknown role', () => {
    expect(() =>
      guardWith({ permissions: [Permission.CUSTOMER_CREATE] }).canActivate(
        contextWith({ kind: 'staff', id: 'x', role: 'SUPERUSER' }),
      ),
    ).toThrow(ForbiddenException);
  });
});
