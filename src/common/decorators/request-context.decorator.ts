import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import type { Request } from 'express';

export interface RequestContext {
  userAgent?: string;
  ipAddress?: string;
}

/**
 * User agent and IP, recorded against refresh tokens for audit. Never used for
 * authorization: both are client-controlled, and the IP is whatever the last proxy said.
 */
export const RequestMeta = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): RequestContext => {
    const request = ctx.switchToHttp().getRequest<Request>();
    const userAgent = request.get('user-agent');

    return {
      userAgent: userAgent ?? undefined,
      ipAddress: request.ip,
    };
  },
);
