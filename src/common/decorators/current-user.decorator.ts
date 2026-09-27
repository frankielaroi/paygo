import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthenticatedStaff } from '../types/authenticated-staff';

/** The authenticated staff principal, as placed on the request by the auth layer. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedStaff | undefined => {
    const request = ctx
      .switchToHttp()
      .getRequest<Request & { user?: AuthenticatedStaff }>();
    return request.user;
  },
);
