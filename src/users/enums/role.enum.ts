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
   * Manual immobilize / restore, limited to bikes held by riders assigned to you (checked in
   * the enforcement service). Granted to field agents deliberately: CLAUDE.md warns an agent in
   * the field is the most likely person to want this button and the least able to verify the
   * bike is stopped, so the stationary interlock applies to their locks exactly as to anyone
   * else's, and every use is in their activity log.
   */
  ASSET_IMMOBILIZE: 'asset:immobilize',
  /** Manual immobilize / restore of any bike, and the enforcement review list. */
  ASSET_IMMOBILIZE_ANY: 'asset:immobilize:any',
  /** Start a loan on a bike already assigned to a rider. */
  LOAN_CREATE: 'loan:create',
  /** Read loans of riders assigned to you (checked in the service). */
  LOAN_READ_OWN: 'loan:read:own',
  LOAN_READ_ALL: 'loan:read:all',
  /** Declare a loan defaulted, or repossess the bike under it. */
  LOAN_MANAGE: 'loan:manage',
  /**
   * Record money by hand, see unallocated payments and allocate them. Admin and finance: a
   * field agent must not move money, least of all onto their own riders' loans.
   */
  PAYMENT_MANAGE: 'payment:manage',
  /** See rider messages and their delivery, and read and acknowledge staff alerts. */
  NOTIFICATION_READ: 'notification:read',
  /**
   * The operations dashboard. Everyone has it; what it shows is scoped in the service: without
   * ASSET_READ (field agents) only bikes held by your own riders.
   */
  DASHBOARD_READ: 'dashboard:read',
  /** Send a rider an overdue reminder by hand from the dashboard. */
  REMINDER_SEND: 'reminder:send',
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
    Permission.ASSET_IMMOBILIZE_ANY,
    Permission.LOAN_CREATE,
    Permission.LOAN_READ_OWN,
    Permission.LOAN_READ_ALL,
    Permission.LOAN_MANAGE,
    Permission.PAYMENT_MANAGE,
    Permission.NOTIFICATION_READ,
    Permission.DASHBOARD_READ,
    Permission.REMINDER_SEND,
  ],
  [StaffRole.FIELD_AGENT]: [
    Permission.CUSTOMER_CREATE,
    Permission.CUSTOMER_READ_OWN,
    Permission.CUSTOMER_UPDATE,
    Permission.LOAN_READ_OWN,
    Permission.ASSET_IMMOBILIZE,
    Permission.DASHBOARD_READ,
    Permission.REMINDER_SEND,
  ],
  // Collections. Reads (the _OWN permissions are what the routes require; _ALL widens the
  // scope in the service) and moving money onto loans. Cannot lend, change terms, lock bikes,
  // edit riders or manage staff.
  [StaffRole.FINANCE]: [
    Permission.CUSTOMER_READ_OWN,
    Permission.CUSTOMER_READ_ALL,
    Permission.ASSET_READ,
    Permission.LOAN_READ_OWN,
    Permission.LOAN_READ_ALL,
    Permission.PAYMENT_MANAGE,
    Permission.NOTIFICATION_READ,
    Permission.DASHBOARD_READ,
    Permission.REMINDER_SEND,
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
