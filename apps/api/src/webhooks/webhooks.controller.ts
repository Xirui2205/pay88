import { Body, Controller, Get, Headers, HttpCode, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { idempotencyKeySchema } from '@telebirr/contracts';
import { z } from 'zod';
import { MerchantAuthGuard } from '../auth/merchant-auth.guard';
import type { MerchantRequest } from '../auth/auth.types';
import { success } from '../common/envelope';
import { ZodPipe } from '../common/zod.pipe';
import { WebhooksService } from './webhooks.service';
import { sha256 } from '../common/crypto';

const registerSchema = z.object({ url: z.string().url().max(2000) });
const endpointStateSchema = z.object({ enabled: z.boolean() });

@Controller('v1/webhooks')
@UseGuards(MerchantAuthGuard)
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Get()
  async list(@Req() request: MerchantRequest) {
    return success(request, await this.webhooks.list(request.auth));
  }

  @Post()
  @HttpCode(200)
  async register(
    @Req() request: MerchantRequest,
    @Body(new ZodPipe(registerSchema)) body: z.infer<typeof registerSchema>,
    @Headers('idempotency-key') idempotencyHeader?: string,
  ) {
    const key = idempotencyHeader
      ? idempotencyKeySchema.parse(idempotencyHeader)
      : `webhook:${sha256(body.url).slice(0, 32)}`;
    return success(request, await this.webhooks.register(request.auth, body.url, key), 'Webhook registered; store the secret now');
  }

  @Post('deliveries/:deliveryId/replay')
  @HttpCode(200)
  async replay(
    @Req() request: MerchantRequest,
    @Param('deliveryId') deliveryId: string,
    @Headers('idempotency-key') idempotencyHeader?: string,
  ) {
    const key = idempotencyHeader ? idempotencyKeySchema.parse(idempotencyHeader) : deliveryId;
    return success(request, await this.webhooks.replay(request.auth, deliveryId, key), 'Webhook replay queued');
  }

  @Patch(':endpointId')
  async setEnabled(@Req() request: MerchantRequest, @Param('endpointId') endpointId: string, @Body(new ZodPipe(endpointStateSchema)) body: z.infer<typeof endpointStateSchema>) {
    return success(request, await this.webhooks.setEnabled(request.auth, z.string().uuid().parse(endpointId), body.enabled), body.enabled ? 'Webhook enabled' : 'Webhook disabled');
  }

  @Post(':endpointId/rotate-secret')
  @HttpCode(200)
  async rotate(
    @Req() request: MerchantRequest,
    @Param('endpointId') endpointId: string,
    @Headers('idempotency-key') idempotencyHeader: string,
  ) {
    const key = idempotencyKeySchema.parse(idempotencyHeader);
    return success(request, await this.webhooks.rotateSecret(request.auth, z.string().uuid().parse(endpointId), key), 'Webhook secret rotated; store it now');
  }
}
