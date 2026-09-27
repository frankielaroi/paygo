import type { StaffRole } from '../users/enums/role.enum';

/**
 * The signed token body. `kind` is part of the payload, not inferred from the subject:
 * a staff guard must be able to reject a customer token without a database lookup, and
 * once rider auth exists both kinds of token will be signed by the same key.
 */
export interface StaffJwtPayload {
  sub: string;
  kind: 'staff';
  email: string;
  role: StaffRole;
}

export function isStaffJwtPayload(value: unknown): value is StaffJwtPayload {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const payload = value as Record<string, unknown>;

  return (
    typeof payload.sub === 'string' &&
    payload.kind === 'staff' &&
    typeof payload.email === 'string' &&
    typeof payload.role === 'string'
  );
}
