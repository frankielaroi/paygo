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
}

/** Response shape for a successful login. Never includes the password hash. */
export class LoginResponseDto {
  @ApiProperty({
    description: 'RS256 JWT. Send as `Authorization: Bearer <token>`.',
  })
  accessToken!: string;

  @ApiProperty({ example: '15m', description: 'Lifetime of the access token' })
  expiresIn!: string | number;

  @ApiProperty({ type: LoggedInUserDto })
  user!: LoggedInUserDto;
}
