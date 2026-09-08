import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { RequiresSession } from '../common/auth/requires-session.decorator';
import type { Request, Response } from 'express';

import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  SessionService,
} from '../common/session/session.service';
import { AuthService, Identity } from './auth.service';
import { LoginDto, RegisterDto, SwitchTenantDto } from './dto/auth.dto';

/** Cookie attributes. `httpOnly` is the point: script must never reach the id. */
function cookieOptions(): {
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    // Over plain HTTP locally; always on once deployed behind HTTPS.
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_SECONDS * 1000,
  };
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create an organization and its first admin. 409 if the email already exists.',
  })
  async register(@Body() dto: RegisterDto): Promise<{ tenantId: string; userId: string }> {
    return this.auth.register(dto);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Authenticate and resolve workspaces. Succeeds with 200 even when the user holds no memberships.',
  })
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Identity> {
    const { cookie, identity } = await this.auth.login(dto);
    response.cookie(SESSION_COOKIE, cookie, cookieOptions());
    return identity;
  }

  @Post('switch')
  @RequiresSession()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Change the active workspace. 403 if the caller is not a member.' })
  async switchTenant(@Body() dto: SwitchTenantDto, @Req() request: Request): Promise<Identity> {
    const cookie = SessionService.readCookie(request.headers.cookie, SESSION_COOKIE) ?? '';
    return this.auth.switchTenant(cookie, dto.tenantId);
  }

  @Get('me')
  @RequiresSession()
  @ApiOperation({ summary: 'The person, the active workspace, and every workspace they hold.' })
  async me(): Promise<Identity> {
    return this.auth.me();
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Destroy the session.' })
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.auth.logout(SessionService.readCookie(request.headers.cookie, SESSION_COOKIE));
    response.clearCookie(SESSION_COOKIE, { path: '/' });
  }
}
