import {
  Permission,
  permissionsFor,
  roleHasPermission,
  StaffRole,
} from './role.enum';

describe('the permission map', () => {
  it('gives every role an entry, so a new role cannot silently have no rules', () => {
    for (const role of Object.values(StaffRole)) {
      expect(permissionsFor(role).length).toBeGreaterThan(0);
    }
  });

  it('lists no permission twice for a role', () => {
    for (const role of Object.values(StaffRole)) {
      const permissions = permissionsFor(role);
      expect(new Set(permissions).size).toBe(permissions.length);
    }
  });

  it('keeps every route-level _OWN permission alongside the _ALL one that widens it', () => {
    // Routes require the _OWN permission and the service widens scope with _ALL, so _ALL
    // without _OWN would be refused at the route.
    for (const role of Object.values(StaffRole)) {
      if (roleHasPermission(role, Permission.CUSTOMER_READ_ALL)) {
        expect(roleHasPermission(role, Permission.CUSTOMER_READ_OWN)).toBe(
          true,
        );
      }
      if (roleHasPermission(role, Permission.LOAN_READ_ALL)) {
        expect(roleHasPermission(role, Permission.LOAN_READ_OWN)).toBe(true);
      }
      if (roleHasPermission(role, Permission.ASSET_IMMOBILIZE_ANY)) {
        expect(roleHasPermission(role, Permission.ASSET_IMMOBILIZE)).toBe(true);
      }
    }
  });

  describe('field agent', () => {
    const can = (permission: Permission) =>
      roleHasPermission(StaffRole.FIELD_AGENT, permission);

    it('may lock and unlock, but only their own riders', () => {
      expect(can(Permission.ASSET_IMMOBILIZE)).toBe(true);
      expect(can(Permission.ASSET_IMMOBILIZE_ANY)).toBe(false);
    });

    it.each([
      Permission.LOAN_CREATE,
      Permission.LOAN_READ_ALL,
      Permission.PAYMENT_MANAGE,
      Permission.USER_MANAGE,
      Permission.KYC_VERIFY,
      Permission.ASSET_READ,
    ])('may not %s', (permission) => {
      expect(can(permission)).toBe(false);
    });
  });

  describe('finance', () => {
    const can = (permission: Permission) =>
      roleHasPermission(StaffRole.FINANCE, permission);

    it.each([
      Permission.LOAN_READ_ALL,
      Permission.PAYMENT_MANAGE,
      Permission.CUSTOMER_READ_ALL,
      Permission.ASSET_READ,
      Permission.NOTIFICATION_READ,
    ])('may %s', (permission) => {
      expect(can(permission)).toBe(true);
    });

    it.each([
      Permission.LOAN_CREATE,
      Permission.LOAN_MANAGE,
      Permission.ASSET_IMMOBILIZE,
      Permission.ASSET_MANAGE,
      Permission.CUSTOMER_UPDATE,
      Permission.USER_MANAGE,
    ])('may not %s', (permission) => {
      expect(can(permission)).toBe(false);
    });
  });
});
