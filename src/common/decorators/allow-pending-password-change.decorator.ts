import { SetMetadata } from '@nestjs/common';

export const ALLOW_PENDING_PASSWORD_CHANGE_KEY = 'allowPendingPasswordChange';

/**
 * Marks a route an account holding a temporary password may still use: reading who it is,
 * changing the password, and logging out. Every other route refuses it until the password is
 * changed, so a password an admin chose or saw never stays in use.
 */
export const AllowPendingPasswordChange = () =>
  SetMetadata(ALLOW_PENDING_PASSWORD_CHANGE_KEY, true);
