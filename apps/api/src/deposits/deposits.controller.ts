import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { initializeTransactionSchema, idempotencyKeySchema } from '@telebirr/contracts';
import { MerchantAuthGuard } from '../auth/merchant-auth.guard';
import type { MerchantRequest } from '../auth/auth.types';
import type { RequestWithContext } from '../common/request-context';
import { success } from '../common/envelope';
import { ZodPipe } from '../common/zod.pipe';
import { DepositsService } from './deposits.service';

@Controller('v1')
export class DepositsController {
  constructor(@Inject(DepositsService) private readonly deposits: DepositsService) {}

  @Post('transaction/initialize')
  @HttpCode(200)
  @UseGuards(MerchantAuthGuard)
  async initialize(
    @Req() request: MerchantRequest,
    @Body(new ZodPipe(initializeTransactionSchema)) body: ReturnType<typeof initializeTransactionSchema.parse>,
    @Headers('idempotency-key') idempotencyHeader?: string,
  ) {
    const key = idempotencyHeader ? idempotencyKeySchema.parse(idempotencyHeader) : body.tx_ref;
    return success(request, await this.deposits.initialize(request.auth, body, key), 'Transaction initialized');
  }

  @Post('topups/initialize')
  @HttpCode(200)
  @UseGuards(MerchantAuthGuard)
  async initializeTopup(
    @Req() request: MerchantRequest,
    @Body(new ZodPipe(initializeTransactionSchema)) body: ReturnType<typeof initializeTransactionSchema.parse>,
    @Headers('idempotency-key') idempotencyHeader?: string,
  ) {
    const key = idempotencyHeader ? idempotencyKeySchema.parse(idempotencyHeader) : body.tx_ref;
    const topup = {
      ...body,
      customer_id: `merchant-topup:${body.customer_id}`,
      metadata: { ...(body.metadata ?? {}), intent_type: 'merchant_topup' },
    };
    return success(request, await this.deposits.initialize(request.auth, topup, key, 'merchant_topup'), 'Merchant top-up initialized');
  }

  @Get('transaction/verify/:txRef')
  @UseGuards(MerchantAuthGuard)
  async verify(@Req() request: MerchantRequest, @Param('txRef') txRef: string) {
    return success(request, await this.deposits.verify(request.auth, txRef), 'Transaction retrieved');
  }

  @Get('checkout/:txRef')
  async checkout(@Req() request: RequestWithContext, @Param('txRef') txRef: string, @Query('token') token: string) {
    return success(request, await this.deposits.hostedCheckout(txRef, token), 'Checkout retrieved');
  }
}
