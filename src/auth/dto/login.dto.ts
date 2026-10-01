import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

const compactPhone = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.replace(/[\s\-().]/g, '') : value;

/** Sign in with an email or a phone number, not both (checked in AuthService.login). */
export class LoginDto {
  @ApiPropertyOptional({
    example: 'admin@paygo.local',
    maxLength: 255,
    description: 'Send this or phone.',
  })
  @ValidateIf((dto: LoginDto) => dto.phone === undefined)
  @IsEmail()
  @MaxLength(255)
  email?: string;

  @ApiPropertyOptional({
    example: '0241234567',
    description:
      'Send this or email. Local (0241234567) or international (+233241234567) form; ' +
      'spaces and dashes are ignored.',
  })
  @ValidateIf((dto: LoginDto) => dto.email === undefined)
  @Transform(compactPhone)
  @Matches(/^\+?\d{9,15}$/, {
    message: 'phone must be 9 to 15 digits, optionally starting with +',
  })
  phone?: string;

  @ApiProperty({ example: 'ChangeMe!2026', minLength: 8, maxLength: 128 })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;
}
