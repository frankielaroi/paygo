import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { jwtKeyConfig } from '../../config/jwt.config';
import { PrismaService } from '../../prisma/prisma.service';
import { StaffRole } from '../../users/enums/role.enum';
import type { AuthenticatedStaff } from '../../common/types/authenticated-staff';
import { isStaffJwtPayload } from '../jwt-payload';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    const { publicKey, issuer } = jwtKeyConfig(config);

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      algorithms: ['RS256'],
      issuer,
      secretOrKey: publicKey,
    });
  }

  /**
   * Re-reads the user on every request. The token proves who signed in; it does not prove
   * the account is still active or still holds the role it had when the token was issued.
   * Role changes and deactivations must take effect before the token expires.
   */
  async validate(payload: unknown): Promise<AuthenticatedStaff> {
    if (!isStaffJwtPayload(payload)) {
      throw new UnauthorizedException();
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, email: true, role: true, isActive: true },
    });

    if (!user || !user.isActive) {
      throw new UnauthorizedException();
    }

    if (!Object.values(StaffRole).includes(user.role)) {
      throw new UnauthorizedException();
    }

    return {
      kind: 'staff',
      id: user.id,
      email: user.email,
      // From the database, not the token: a demoted user must not keep their old role
      // until expiry.
      role: user.role,
    };
  }
}
