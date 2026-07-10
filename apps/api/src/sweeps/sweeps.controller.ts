import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { idempotencyKeySchema, sweepRuleInputSchema } from '@telebirr/contracts';
import { z } from 'zod';
import { AdminGuard } from '../admin/admin.guard';
import type { PlatformRequest } from '../admin/admin-auth.types';
import { PasswordReauthGuard } from '../admin/password-reauth.guard';
import { PlatformWriteGuard } from '../admin/platform-write.guard';
import { MerchantAuthGuard } from '../auth/merchant-auth.guard';
import type { MerchantRequest } from '../auth/auth.types';
import { success } from '../common/envelope';
import { ZodPipe } from '../common/zod.pipe';
import { SweepsService } from './sweeps.service';

const reasonSchema = z.object({ reason: z.string().trim().min(5).max(1000) });

@Controller('v1/sweep-rules')
export class SweepsController {
  constructor(private readonly sweeps: SweepsService) {}

  @Post()
  @HttpCode(200)
  @UseGuards(MerchantAuthGuard)
  async create(
    @Req() request: MerchantRequest,
    @Body(new ZodPipe(sweepRuleInputSchema)) body: z.infer<typeof sweepRuleInputSchema>,
    @Headers('idempotency-key') idempotencyHeader?: string,
  ) {
    const key = idempotencyHeader ? idempotencyKeySchema.parse(idempotencyHeader) : body.name;
    return success(request, await this.sweeps.create(request.auth, body, key), 'Sweep rule submitted for platform approval');
  }

  @Get()
  @UseGuards(MerchantAuthGuard)
  async list(@Req() request: MerchantRequest) {
    return success(request, await this.sweeps.list(request.auth));
  }

  @Get(':id')
  @UseGuards(MerchantAuthGuard)
  async get(@Req() request: MerchantRequest, @Param('id') id: string) {
    return success(request, await this.sweeps.get(request.auth, id));
  }

  @Put(':id')
  @UseGuards(MerchantAuthGuard)
  async update(
    @Req() request: MerchantRequest,
    @Param('id') id: string,
    @Body(new ZodPipe(sweepRuleInputSchema)) body: z.infer<typeof sweepRuleInputSchema>,
    @Headers('idempotency-key') idempotencyHeader?: string,
  ) {
    const key = idempotencyHeader ? idempotencyKeySchema.parse(idempotencyHeader) : id;
    return success(request, await this.sweeps.update(request.auth, id, body, key), 'Sweep rule updated; platform reapproval is required');
  }

  @Delete(':id')
  @UseGuards(MerchantAuthGuard)
  async disable(
    @Req() request: MerchantRequest,
    @Param('id') id: string,
    @Body(new ZodPipe(reasonSchema)) body: z.infer<typeof reasonSchema>,
    @Headers('idempotency-key') idempotencyHeader?: string,
  ) {
    const key = idempotencyHeader ? idempotencyKeySchema.parse(idempotencyHeader) : id;
    return success(request, await this.sweeps.disable(request.auth, id, body.reason, key), 'Sweep rule disabled');
  }
}

@Controller('v1/admin/sweep-rules')
@UseGuards(AdminGuard, PlatformWriteGuard)
export class SweepsAdminController {
  constructor(private readonly sweeps: SweepsService) {}

  @Get()
  async list(@Req() request: PlatformRequest, @Query('status') status?: string) {
    return success(request, await this.sweeps.listForAdmin(status));
  }

  @Post(':id/approve')
  @UseGuards(PasswordReauthGuard)
  async approve(@Req() request: PlatformRequest, @Param('id') id: string, @Body(new ZodPipe(reasonSchema)) body: z.infer<typeof reasonSchema>) {
    return success(request, await this.sweeps.approve(id, body.reason, request.platformAuth.staffId), 'Sweep rule approved');
  }

  @Post(':id/reject')
  @UseGuards(PasswordReauthGuard)
  async reject(@Req() request: PlatformRequest, @Param('id') id: string, @Body(new ZodPipe(reasonSchema)) body: z.infer<typeof reasonSchema>) {
    return success(request, await this.sweeps.reject(id, body.reason, request.platformAuth.staffId), 'Sweep rule rejected');
  }

  @Post(':id/execute')
  @UseGuards(PasswordReauthGuard)
  async execute(@Req() request: PlatformRequest, @Param('id') id: string, @Body(new ZodPipe(reasonSchema)) body: z.infer<typeof reasonSchema>) {
    return success(request, await this.sweeps.executeNow(id, body.reason, request.platformAuth.staffId), 'Sweep rule evaluated and eligible transfers dispatched');
  }
}
