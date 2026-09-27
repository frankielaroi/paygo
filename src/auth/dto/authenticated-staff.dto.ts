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
}
