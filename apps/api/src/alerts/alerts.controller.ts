import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AdminGuard } from '../admin/admin.guard';
import { success } from '../common/envelope';
import type { RequestWithContext } from '../common/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { AlertsService } from './alerts.service';
import { PasswordReauthGuard } from '../admin/password-reauth.guard';
import { PlatformWriteGuard } from '../admin/platform-write.guard';
import type { PlatformRequest } from '../admin/admin-auth.types';

const testAlertSchema = z.object({ reason: z.string().min(5).max(500) });
const actionSchema = z.object({ reason: z.string().trim().min(10).max(1000) });
const configurationSchema = z.object({
  chat_id: z.string().trim().max(255),
  enabled_types: z.array(z.enum(['*', 'device_offline', 'stale_balance', 'wallet_high_water', 'low_liquidity', 'daily_limit_risk', 'unknown_payout', 'unmatched_receipt', 'reconciliation_drift', 'webhook_backlog', 'openclaw_failure'])),
  reason: z.string().trim().min(10).max(1000),
});

@Controller('v1/admin/alerts')
@UseGuards(AdminGuard)
export class AlertsController {
  constructor(private readonly alerts: AlertsService) {}

  @Get()
  async list(@Req() request: RequestWithContext) {
    return success(request, await this.alerts.recent());
  }

  @Post('test')
  async test(
    @Req() request: RequestWithContext,
    @Body(new ZodPipe(testAlertSchema)) body: z.infer<typeof testAlertSchema>,
  ) {
    await this.alerts.notify('openclaw_failure', `Test alert: ${body.reason}`, { test: true });
    return success(request, { accepted: true }, 'Test alert dispatched');
  }

  @Post('configuration')
  @UseGuards(PlatformWriteGuard, PasswordReauthGuard)
  async configure(
    @Req() request: PlatformRequest,
    @Body(new ZodPipe(configurationSchema)) body: z.infer<typeof configurationSchema>,
  ) {
    return success(request, await this.alerts.configureTelegram({ chat_id: body.chat_id, enabled_types: body.enabled_types }, request.platformAuth.staffId, body.reason), 'Alert configuration updated');
  }

  @Post(':id/acknowledge')
  @UseGuards(PlatformWriteGuard)
  async acknowledge(@Req() request: PlatformRequest, @Param('id') id: string, @Body(new ZodPipe(actionSchema)) body: z.infer<typeof actionSchema>) {
    return success(request, await this.alerts.acknowledge(z.string().uuid().parse(id), request.platformAuth.staffId, body.reason), 'Alert acknowledged');
  }

  @Post(':id/resolve')
  @UseGuards(PlatformWriteGuard, PasswordReauthGuard)
  async resolve(@Req() request: PlatformRequest, @Param('id') id: string, @Body(new ZodPipe(actionSchema)) body: z.infer<typeof actionSchema>) {
    return success(request, await this.alerts.resolve(z.string().uuid().parse(id), request.platformAuth.staffId, body.reason), 'Alert resolved');
  }
}
