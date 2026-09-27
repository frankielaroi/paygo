import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import type { LoginResponseDto } from './dto/login-response.dto';
import type { StaffJwtPayload } from './jwt-payload';
import type { LoginDto } from './dto/login.dto';
import { PasswordService } from './password.service';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly passwords: PasswordService,
    private readonly config: ConfigService,
  ) {}

  async login(dto: LoginDto): Promise<LoginResponseDto> {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
    });

    // One generic failure for every reason a login can fail (unknown email, wrong
    // password, deactivated account), so the response cannot be used to enumerate staff.
    const invalid = new UnauthorizedException('Invalid credentials');

    // Verify against a dummy hash when the user is missing so the response time does not
    // reveal whether the email exists.
    const passwordMatches = await this.passwords.verify(
      user?.passwordHash ?? DUMMY_HASH,
      dto.password,
    );

    if (!user || !passwordMatches || !user.isActive) {
      this.logger.warn(`Failed login for ${dto.email}`);
      throw invalid;
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const payload: StaffJwtPayload = {
      sub: user.id,
      kind: 'staff',
      email: user.email,
      role: user.role,
    };

    return {
      accessToken: await this.jwt.signAsync(payload),
      // Reported for the client's benefit only. The authoritative lifetime is the one
      // JwtModule signs with; this service does not touch the signing keys.
      expiresIn: this.config.get<string>('JWT_EXPIRES_IN') ?? '15m',
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
      },
    };
  }
}

/**
 * A valid argon2id hash of a value no password will match. Used to keep the failure path
 * for an unknown email as slow as the path for a known one.
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$Iy0N7DfBhGrBLJDjeBxpvCOjRUHOZHvZAUCz9DmTQ4g';
