import { ApiProperty } from '@nestjs/swagger';
import { StaffRole } from '../../users/enums/role.enum';

/** Swagger view of the principal returned by GET /auth/me. */
export class AuthenticatedStaffDto {
  @ApiProperty({
    example: 'staff',
    description: 'Principal kind. Always "staff" here.',
  })
  kind!: 'staff';

  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  email!: string;

  @ApiProperty({
    enum: StaffRole,
    enumName: 'StaffRole',
    description: 'Read from the database on every request, not from the token.',
  })
  role!: StaffRole;

  @ApiProperty({
    description:
      'True while the account holds a temporary password. Every route except this one, ' +
      'POST /me/password and logout refuses the account until it is changed.',
  })
  mustChangePassword!: boolean;
}
