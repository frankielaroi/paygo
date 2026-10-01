import type { StaffRole } from '../../users/enums/role.enum';

/**
 * The principal type for staff. `kind` is explicit so a customer token can never be
 * mistaken for a staff token once a rider-facing auth path exists, a staff guard must
 * reject anything that is not `kind: 'staff'` rather than trusting the id alone.
 */
export interface AuthenticatedStaff {
  kind: 'staff';
  id: string;
  email: string;
  role: StaffRole;
  /**
   * The account holds a temporary password set by an admin. Read from the database on every
   * request, like the role, and enforced by RolesGuard: only routes marked
   * @AllowPendingPasswordChange() are reachable until the password is changed.
   */
  mustChangePassword: boolean;
}
