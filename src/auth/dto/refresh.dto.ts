import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

export class RefreshDto {
  @ApiProperty({
    description: 'The refresh token issued by POST /auth/login or a previous refresh',
  })
  @IsString()
  // 32 random bytes as base64url is 43 characters. Bounded so an oversized body cannot
  // reach the hashing path.
  @Length(20, 256)
  refreshToken!: string;
}
