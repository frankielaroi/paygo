import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { AuthenticatedStaffDto } from './dto/authenticated-staff.dto';
import { LoginDto } from './dto/login.dto';
import { LoginResponseDto } from './dto/login-response.dto';
import type { AuthenticatedStaff } from '../common/types/authenticated-staff';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sign in as staff',
    description:
      'Returns an RS256 access token. Every failure (unknown email, wrong password, ' +
      'deactivated account) returns the same 401 so the endpoint cannot be used to ' +
      'enumerate staff accounts.',
  })
  @ApiOkResponse({ type: LoginResponseDto })
  @ApiUnauthorizedResponse({ description: 'Invalid credentials' })
  login(@Body() dto: LoginDto): Promise<LoginResponseDto> {
    return this.auth.login(dto);
  }

  @Get('me')
  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'The current principal',
    description:
      'Resolved from the database on every request, so a deactivation or role change ' +
      'takes effect before the token expires.',
  })
  @ApiOkResponse({ type: AuthenticatedStaffDto })
  @ApiUnauthorizedResponse({ description: 'Missing, expired or invalid token' })
  me(@CurrentUser() user: AuthenticatedStaff): AuthenticatedStaff {
    return user;
  }
}
