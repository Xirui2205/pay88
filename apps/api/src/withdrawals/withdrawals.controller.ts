import { Body, Controller, Get, Headers, HttpCode, Inject, MessageEvent, Param, Post, Query, Req, Sse, UseGuards } from '@nestjs/common';
import { createTransferSchema, idempotencyKeySchema } from '@telebirr/contracts';
import { z } from 'zod';
import { MerchantAuthGuard } from '../auth/merchant-auth.guard';
import type { MerchantRequest } from '../auth/auth.types';
import { success } from '../common/envelope';
import { ZodPipe } from '../common/zod.pipe';
import { WithdrawalsService } from './withdrawals.service';
import type { RequestWithContext } from '../common/request-context';
import { concatMap, distinctUntilChanged, from, map, Observable, takeWhile, timer } from 'rxjs';

const completionSchema = z.object({ outcome: z.enum(['success', 'failed', 'unknown']) });

@Controller('v1')
export class WithdrawalsController {
  constructor(@Inject(WithdrawalsService) private readonly withdrawals: WithdrawalsService) {}

  @Post('transfers')
  @HttpCode(200)
  @UseGuards(MerchantAuthGuard)
  async create(
    @Req() request: MerchantRequest,
    @Body(new ZodPipe(createTransferSchema)) body: ReturnType<typeof createTransferSchema.parse>,
    @Headers('idempotency-key') idempotencyHeader?: string,
  ) {
    const key = idempotencyHeader ? idempotencyKeySchema.parse(idempotencyHeader) : body.reference;
    return success(request, await this.withdrawals.create(request.auth, body, key), 'Transfer accepted');
  }

  @Get('transfers/verify/:reference')
  @UseGuards(MerchantAuthGuard)
  async verify(@Req() request: MerchantRequest, @Param('reference') reference: string) {
    return success(request, await this.withdrawals.verify(request.auth, reference), 'Transfer retrieved');
  }

  @Get('banks')
  @UseGuards(MerchantAuthGuard)
  banks(@Req() request: MerchantRequest) {
    return success(request, [{ id: 855, code: '855', name: 'Telebirr', currency: 'ETB', account_type: 'mobile_wallet' }]);
  }

  @Get('balances')
  @UseGuards(MerchantAuthGuard)
  async balances(@Req() request: MerchantRequest) {
    return success(request, await this.withdrawals.balances(request.auth), 'Balances retrieved');
  }

  @Post('test/scenarios/transfers/:reference/complete')
  @HttpCode(200)
  @UseGuards(MerchantAuthGuard)
  async completeTest(
    @Req() request: MerchantRequest,
    @Param('reference') reference: string,
    @Body(new ZodPipe(completionSchema)) body: z.infer<typeof completionSchema>,
  ) {
    return success(request, await this.withdrawals.completeTest(request.auth, reference, body.outcome), 'Test scenario completed');
  }

  @Get('hosted/transfers/:reference')
  async hostedStatus(
    @Req() request: RequestWithContext,
    @Param('reference') reference: string,
    @Query('token') token: string,
  ) {
    return success(request, await this.withdrawals.hostedStatus(reference, token), 'Transfer status retrieved');
  }

  @Sse('hosted/transfers/:reference/events')
  async hostedEvents(
    @Param('reference') reference: string,
    @Query('token') token: string,
  ): Promise<Observable<MessageEvent>> {
    // Validate the scoped token before opening a long-lived response. Every poll
    // repeats the scoped lookup so revocation/deletion fails closed.
    await this.withdrawals.hostedStatus(reference, token);
    return timer(0, 2_000).pipe(
      concatMap(() => from(this.withdrawals.hostedStatus(reference, token))),
      distinctUntilChanged((previous, current) =>
        previous.p2p_status === current.p2p_status &&
        previous.provider_transaction_id === current.provider_transaction_id,
      ),
      map((data) => ({ type: 'transfer.status', data } satisfies MessageEvent)),
      takeWhile(
        (event) => !['success', 'failed', 'unknown', 'manual_review', 'cancelled'].includes(
          String((event.data as { p2p_status?: string }).p2p_status),
        ),
        true,
      ),
    );
  }
}
