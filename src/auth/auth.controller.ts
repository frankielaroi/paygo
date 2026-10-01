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
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CredentialThrottle } from '../common/decorators/credential-throttle.decorator';
import { Public } from '../common/decorators/public.decorator';
import { AllowPendingPasswordChange } from '../common/decorators/allow-pending-password-change.decorator';
import {
  RequestMeta,
  type RequestContext,
} from '../common/decorators/request-context.decorator';
import { AuthenticatedStaffDto } from './dto/authenticated-staff.dto';
import { LoginDto } from './dto/login.dto';
import { LoginResponseDto } from './dto/login-response.dto';
import { RefreshDto } from './dto/refresh.dto';
import { RefreshResponseDto } from './dto/refresh-response.dto';
import type { AuthenticatedStaff } from '../common/types/authenticated-staff';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  // Tighter than the global limit. Named 'login' so it draws from its own bucket rather
  // than sharing one with ordinary traffic.
  @CredentialThrottle()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sign in as staff',
    description:
      'Returns a short-lived access token and a single-use refresh token. Every failure ' +
      '(unknown email, wrong password, locked or deactivated account) returns the same ' +
      '401, so the endpoint cannot be used to enumerate accounts or discover a lockout.',
  })
  @ApiOkResponse({ type: LoginResponseDto })
  @ApiUnauthorizedResponse({ description: 'Invalid credentials' })
  @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded' })
  login(
    @Body() dto: LoginDto,
    @RequestMeta() context: RequestContext,
  ): Promise<LoginResponseDto> {
    return this.auth.login(dto, context);
  }

  @Public()
  @CredentialThrottle()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Exchange a refresh token',
    description:
      'Rotates the refresh token: the presented one is revoked and a new one returned. ' +
      'Presenting an already-rotated token is treated as a leak and revokes every session ' +
      'for that account.',
  })
  @ApiOkResponse({ type: RefreshResponseDto })
  @ApiUnauthorizedResponse({ description: 'Invalid refresh token' })
  @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded' })
  refresh(
    @Body() dto: RefreshDto,
    @RequestMeta() context: RequestContext,
  ): Promise<RefreshResponseDto> {
    return this.auth.refresh(dto.refreshToken, context);
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Revoke a refresh token',
    description:
      'Idempotent: revoking an unknown or already-revoked token succeeds, so a client can ' +
      'always complete a logout.',
  })
  @ApiNoContentResponse({
    description: 'Token revoked, or was already invalid',
  })
  logout(@Body() dto: RefreshDto): Promise<void> {
    return this.auth.logout(dto.refreshToken);
  }

  @Get('me')
  @AllowPendingPasswordChange()
  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'The current principal',
    description:
      'Resolved from the database on every request, so a deactivation or role change takes ' +
      'effect before the access token expires.',
  })
  @ApiOkResponse({ type: AuthenticatedStaffDto })
  @ApiUnauthorizedResponse({ description: 'Missing, expired or invalid token' })
  me(@CurrentUser() user: AuthenticatedStaff): AuthenticatedStaff {
    return user;
  }
}
