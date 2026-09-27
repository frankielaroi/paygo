import { ApiProperty } from '@nestjs/swagger';

export class RefreshResponseDto {
  @ApiProperty({ description: 'New short-lived access token' })
  accessToken!: string;

  @ApiProperty({
    description: 'New refresh token. The one you presented is now revoked.',
  })
  refreshToken!: string;

  @ApiProperty({ format: 'date-time' })
  refreshTokenExpiresAt!: string;

  @ApiProperty({ example: '15m' })
  expiresIn!: string;
}
