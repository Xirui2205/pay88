import { Body, Controller, Get, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { success } from '../common/envelope';
import type { RequestWithContext } from '../common/request-context';
import { ZodPipe } from '../common/zod.pipe';
import type { PlatformRequest } from './admin-auth.types';
import { AdminGuard } from './admin.guard';
import { PlatformAuthService } from './platform-auth.service';

const loginSchema = z.object({ email: z.string().email().max(320), password: z.string().min(1).max(128) });
const reauthSchema = z.object({ password: z.string().min(1).max(128) });

@Controller('v1/admin/auth')
export class PlatformAuthController {
  constructor(private readonly auth: PlatformAuthService) {}

  @Post('login')
  @HttpCode(200)
  async login(@Req() request: RequestWithContext, @Body(new ZodPipe(loginSchema)) body: z.infer<typeof loginSchema>) {
    return success(request, await this.auth.login(body, { ip: request.ip, userAgent: request.header('user-agent') }), 'Signed in');
  }

  @Get('me')
  @UseGuards(AdminGuard)
  me(@Req() request: PlatformRequest) { return success(request, this.auth.me(request.platformAuth)); }

  @Post('logout')
  @UseGuards(AdminGuard)
  async logout(@Req() request: PlatformRequest) { return success(request, await this.auth.logout(request.platformAuth), 'Signed out'); }

  @Post('reauthenticate')
  @UseGuards(AdminGuard)
  async reauthenticate(@Req() request: PlatformRequest, @Body(new ZodPipe(reauthSchema)) body: z.infer<typeof reauthSchema>) {
    return success(request, await this.auth.reauthenticate(request.platformAuth, body.password), 'Password confirmed');
  }
}
