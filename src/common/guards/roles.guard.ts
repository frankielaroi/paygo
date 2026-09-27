import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';
import { ROLES_KEY } from '../decorators/roles.decorator';
import type { AuthenticatedStaff } from '../types/authenticated-staff';
import {
  type Permission,
  StaffRole,
  roleHasPermission,
} from '../../users/enums/role.enum';

/**
 * Enforces @Roles and @RequirePermissions. Runs after authentication, so it assumes the
 * auth layer has already put the principal on the request.
 *
 * This guard proves only that the caller's ROLE allows the operation. It never proves the
 * record belongs to them, ownership (e.g. a field agent's own customers) is checked in
 * the service against the resource (see CLAUDE.md).
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];

    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) {
      return true;
    }

    const requiredRoles =
      this.reflector.getAllAndOverride<StaffRole[]>(ROLES_KEY, targets) ?? [];
    const requiredPermissions =
      this.reflector.getAllAndOverride<Permission[]>(
        PERMISSIONS_KEY,
        targets,
      ) ?? [];

    if (requiredRoles.length === 0 && requiredPermissions.length === 0) {
      return true;
    }

    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthenticatedStaff }>();
    const user = request.user;

    // A route with role requirements and no principal is a misconfiguration, not an
    // allow: fail closed.
    if (!user) {
      throw new UnauthorizedException();
    }

    // A customer token must never satisfy a staff route, whatever its id says.
    if (
      user.kind !== 'staff' ||
      !Object.values(StaffRole).includes(user.role)
    ) {
      throw new ForbiddenException('Insufficient permissions');
    }

    const roleAllowed =
      requiredRoles.length === 0 || requiredRoles.includes(user.role);
    const permissionsAllowed = requiredPermissions.every((permission) =>
      roleHasPermission(user.role, permission),
    );

    if (!roleAllowed || !permissionsAllowed) {
      throw new ForbiddenException('Insufficient permissions');
    }

    return true;
  }
}
