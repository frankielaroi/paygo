import { SetMetadata } from '@nestjs/common';
import type { Permission } from '../../users/enums/role.enum';

export const PERMISSIONS_KEY = 'permissions';

/**
 * Restrict a route to staff whose role carries every listed permission. Prefer this over
 * @Roles for capabilities — it survives adding a role without revisiting every route.
 */
export const RequirePermissions = (...permissions: Permission[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);
