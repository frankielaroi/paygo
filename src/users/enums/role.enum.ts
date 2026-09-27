import { StaffRole } from '../../generated/prisma/enums';

/**
 * Back-office staff roles, re-exported from the Prisma enum so there is exactly one
 * definition. Customers are NOT a role here, they are a separate model with their own
 * authentication path (see CLAUDE.md).
 */
export { StaffRole };

export const STAFF_ROLES = Object.values(StaffRole);

/**
 * Capabilities, kept in code rather than in database tables: with two fixed roles a
 * permissions table would be a join on every request and a migration for every change.
 * Move it to the database only when admins need to edit roles at runtime.
 */
export const Permission = {
  USER_MANAGE: 'user:manage',
  CUSTOMER_CREATE: 'customer:create',
  CUSTOMER_READ_OWN: 'customer:read:own',
  CUSTOMER_READ_ALL: 'customer:read:all',
  CUSTOMER_REASSIGN: 'customer:reassign',
  KYC_VERIFY: 'kyc:verify',
  /**
   * Remote immobilize / restore. Deliberately NOT granted to field agents: an agent in
   * the field is the most likely person to want it and the least able to verify the bike
   * is stopped. The safety interlock still applies on top of this permission.
   */
  ASSET_IMMOBILIZE: 'asset:immobilize',
} as const;

export type Permission = (typeof Permission)[keyof typeof Permission];

const ROLE_PERMISSIONS: Record<StaffRole, readonly Permission[]> = {
  [StaffRole.ADMIN]: [
    Permission.USER_MANAGE,
    Permission.CUSTOMER_CREATE,
    Permission.CUSTOMER_READ_OWN,
    Permission.CUSTOMER_READ_ALL,
    Permission.CUSTOMER_REASSIGN,
    Permission.KYC_VERIFY,
    Permission.ASSET_IMMOBILIZE,
  ],
  [StaffRole.FIELD_AGENT]: [
    Permission.CUSTOMER_CREATE,
    Permission.CUSTOMER_READ_OWN,
  ],
};

export function permissionsFor(role: StaffRole): readonly Permission[] {
  return ROLE_PERMISSIONS[role] ?? [];
}

export function roleHasPermission(
  role: StaffRole,
  permission: Permission,
): boolean {
  return permissionsFor(role).includes(permission);
}
