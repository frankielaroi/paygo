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
  /** Edit a rider's profile. Field agents only reach their own riders (checked in the service). */
  CUSTOMER_UPDATE: 'customer:update',
  /** Deactivate a rider. */
  CUSTOMER_MANAGE: 'customer:manage',
  KYC_VERIFY: 'kyc:verify',
  /**
   * Read bike inventory. Admin only for now: a bike record names its rider, and field agents
   * reach their own riders' bikes through the customer record instead.
   */
  ASSET_READ: 'asset:read',
  /** Add and edit bikes, fit trackers, assign, transfer, repossess, retire. */
  ASSET_MANAGE: 'asset:manage',
  /**
   * Remote immobilize / restore. Deliberately NOT granted to field agents: an agent in
   * the field is the most likely person to want it and the least able to verify the bike
   * is stopped. The safety interlock still applies on top of this permission.
   */
  ASSET_IMMOBILIZE: 'asset:immobilize',
  /** Start a loan on a bike already assigned to a rider. */
  LOAN_CREATE: 'loan:create',
  /** Read loans of riders assigned to you (checked in the service). */
  LOAN_READ_OWN: 'loan:read:own',
  LOAN_READ_ALL: 'loan:read:all',
  /** Declare a loan defaulted, or repossess the bike under it. */
  LOAN_MANAGE: 'loan:manage',
  /**
   * Record money by hand, see unallocated payments and allocate them. Moves money, so admin
   * only: a field agent must not move money, least of all onto their own riders' loans.
   */
  PAYMENT_MANAGE: 'payment:manage',
  /** See rider messages and their delivery, and read and acknowledge staff alerts. */
  NOTIFICATION_READ: 'notification:read',
} as const;

export type Permission = (typeof Permission)[keyof typeof Permission];

const ROLE_PERMISSIONS: Record<StaffRole, readonly Permission[]> = {
  [StaffRole.ADMIN]: [
    Permission.USER_MANAGE,
    Permission.CUSTOMER_CREATE,
    Permission.CUSTOMER_READ_OWN,
    Permission.CUSTOMER_READ_ALL,
    Permission.CUSTOMER_REASSIGN,
    Permission.CUSTOMER_UPDATE,
    Permission.CUSTOMER_MANAGE,
    Permission.KYC_VERIFY,
    Permission.ASSET_READ,
    Permission.ASSET_MANAGE,
    Permission.ASSET_IMMOBILIZE,
    Permission.LOAN_CREATE,
    Permission.LOAN_READ_OWN,
    Permission.LOAN_READ_ALL,
    Permission.LOAN_MANAGE,
    Permission.PAYMENT_MANAGE,
    Permission.NOTIFICATION_READ,
  ],
  [StaffRole.FIELD_AGENT]: [
    Permission.CUSTOMER_CREATE,
    Permission.CUSTOMER_READ_OWN,
    Permission.CUSTOMER_UPDATE,
    Permission.LOAN_READ_OWN,
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
