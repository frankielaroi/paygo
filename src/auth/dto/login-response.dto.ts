import { ApiProperty } from '@nestjs/swagger';
import { StaffRole } from '../../users/enums/role.enum';

export class LoggedInUserDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'admin@paygo.local' })
  email!: string;

  @ApiProperty()
  firstName!: string;

  @ApiProperty()
  lastName!: string;

  @ApiProperty({ enum: StaffRole, enumName: 'StaffRole' })
  role!: StaffRole;

  @ApiProperty({
    description:
      'The password is temporary: send the user to POST /me/password before anything else',
  })
  mustChangePassword!: boolean;
}

/** Response shape for a successful login. Never includes the password hash. */
export class LoginResponseDto {
  @ApiProperty({
    description:
      'Short-lived RS256 JWT. Send as `Authorization: Bearer <token>`.',
  })
  accessToken!: string;

  @ApiProperty({
    description:
      'Opaque single-use token. Exchange it at POST /auth/refresh, which returns a new ' +
      'one and invalidates this one. Presenting a rotated token revokes every session ' +
      'for the account.',
  })
  refreshToken!: string;

  @ApiProperty({ format: 'date-time' })
  refreshTokenExpiresAt!: string;

  @ApiProperty({ example: '15m', description: 'Lifetime of the access token' })
  expiresIn!: string;

  @ApiProperty({ type: LoggedInUserDto })
  user!: LoggedInUserDto;
}
