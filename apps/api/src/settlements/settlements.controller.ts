import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { createSettlementSchema, idempotencyKeySchema } from '@telebirr/contracts';
import { z } from 'zod';
import { AdminGuard } from '../admin/admin.guard';
import type { PlatformRequest } from '../admin/admin-auth.types';
import { PasswordReauthGuard } from '../admin/password-reauth.guard';
import { PlatformWriteGuard } from '../admin/platform-write.guard';
import { MerchantAuthGuard } from '../auth/merchant-auth.guard';
import type { MerchantRequest } from '../auth/auth.types';
import { success } from '../common/envelope';
import { ZodPipe } from '../common/zod.pipe';
import { SettlementsService } from './settlements.service';

const reviewSchema = z.object({ reason: z.string().trim().min(5).max(1000) });

@Controller('v1/settlements')
export class SettlementsController {
  constructor(private readonly settlements: SettlementsService) {}

  @Post()
  @HttpCode(200)
  @UseGuards(MerchantAuthGuard)
  async request(
    @Req() request: MerchantRequest,
    @Body(new ZodPipe(createSettlementSchema)) body: z.infer<typeof createSettlementSchema>,
    @Headers('idempotency-key') idempotencyHeader?: string,
  ) {
    const key = idempotencyHeader ? idempotencyKeySchema.parse(idempotencyHeader) : body.reference;
    return success(request, await this.settlements.request(request.auth, body, key), 'Settlement requested for platform review');
  }

  @Get()
  @UseGuards(MerchantAuthGuard)
  async list(@Req() request: MerchantRequest) {
    return success(request, await this.settlements.list(request.auth));
  }

  @Get(':reference')
  @UseGuards(MerchantAuthGuard)
  async get(@Req() request: MerchantRequest, @Param('reference') reference: string) {
    return success(request, await this.settlements.get(request.auth, reference));
  }
}

@Controller('v1/admin/settlements')
@UseGuards(AdminGuard, PlatformWriteGuard)
export class SettlementAdminController {
  constructor(private readonly settlements: SettlementsService) {}

  @Get()
  async list(@Req() request: PlatformRequest, @Query('status') status?: string) {
    return success(request, await this.settlements.listForAdmin(status));
  }

  @Post(':id/approve')
  @UseGuards(PasswordReauthGuard)
  async approve(@Req() request: PlatformRequest, @Param('id') id: string, @Body(new ZodPipe(reviewSchema)) body: z.infer<typeof reviewSchema>) {
    return success(request, await this.settlements.approve(id, body.reason, request.platformAuth.staffId), 'Settlement approved and dispatched');
  }

  @Post(':id/reject')
  @UseGuards(PasswordReauthGuard)
  async reject(@Req() request: PlatformRequest, @Param('id') id: string, @Body(new ZodPipe(reviewSchema)) body: z.infer<typeof reviewSchema>) {
    return success(request, await this.settlements.reject(id, body.reason, request.platformAuth.staffId), 'Settlement rejected');
  }
}
