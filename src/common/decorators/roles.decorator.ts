import { SetMetadata } from '@nestjs/common';
import { StaffRole } from '../../users/enums/role.enum';

export const ROLES_KEY = 'roles';

/** Restrict a route to the given staff roles. Enforced by RolesGuard. */
export const Roles = (...roles: StaffRole[]) => SetMetadata(ROLES_KEY, roles);
