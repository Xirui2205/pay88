import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { RuntimeEnvironment } from '@prisma/client';
import { createSettlementSchema, idempotencyKeySchema, initializeTransactionSchema } from '@telebirr/contracts';
import { z } from 'zod';
import type { PortalRequest } from '../auth/auth.types';
import { success } from '../common/envelope';
import type { RequestWithContext } from '../common/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { PortalSessionGuard } from './portal-session.guard';
import { PortalService } from './portal.service';
import { DepositsService } from '../deposits/deposits.service';
import { SettlementsService } from '../settlements/settlements.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { sha256 } from '../common/crypto';
import { ApiException } from '../common/api-exception';
import { ConfigurationService } from '../configuration/configuration.service';
import { SupportCasesService } from '../support/support-cases.service';
import { createSupportCaseSchema, supportMessageSchema, supportStatusSchema } from '../support/support-cases.schemas';

const passwordSchema = z.string().min(12).max(128);
const webhookStateSchema = z.object({ environment: z.enum(['test', 'live']), enabled: z.boolean() });
const webhookEnvironmentSchema = z.object({ environment: z.enum(['test', 'live']) });
const environmentSchema = z.enum(['test', 'live']).default('live');
const loginSchema = z.object({ email: z.string().email().max(320), password: z.string().min(1).max(128), merchant_slug: z.string().regex(/^[a-z0-9-]{2,80}$/).optional() });
const acceptSchema = z.object({ token: z.string().startsWith('mi_').max(100), display_name: z.string().trim().min(2).max(160), password: passwordSchema });
const inviteSchema = z.object({ email: z.string().email().max(320), role: z.enum(['owner', 'admin', 'support']) });
const apiKeySchema = z.object({ environment: z.enum(['test', 'live']), label: z.string().trim().min(2).max(100) });
const webhookSchema = z.object({ environment: z.enum(['test', 'live']), url: z.string().url().max(2000) });
const merchantConfigurationSchema = z.object({ proposed: z.record(z.string(), z.unknown()), reason: z.string().trim().min(10).max(1000) });

@Controller('v1/portal/auth')
export class PortalAuthController {
  constructor(private readonly portal: PortalService) {}

  @Post('login')
  @HttpCode(200)
  async login(@Req() request: RequestWithContext, @Body(new ZodPipe(loginSchema)) body: z.infer<typeof loginSchema>) {
    return success(request, await this.portal.login({ email: body.email, password: body.password, merchantSlug: body.merchant_slug }, { ip: request.ip, userAgent: request.header('user-agent') }), 'Signed in');
  }

  @Post('invitations/accept')
  @HttpCode(200)
  async accept(@Req() request: RequestWithContext, @Body(new ZodPipe(acceptSchema)) body: z.infer<typeof acceptSchema>) {
    return success(request, await this.portal.acceptInvitation({ token: body.token, displayName: body.display_name, password: body.password }, { ip: request.ip, userAgent: request.header('user-agent') }), 'Invitation accepted');
  }

  @Get('me')
  @UseGuards(PortalSessionGuard)
  me(@Req() request: PortalRequest) { return success(request, this.portal.me(request.portalAuth)); }

  @Post('logout')
  @HttpCode(200)
  @UseGuards(PortalSessionGuard)
  async logout(@Req() request: PortalRequest) { return success(request, await this.portal.logout(request.portalAuth), 'Signed out'); }
}

@Controller('v1/portal')
@UseGuards(PortalSessionGuard)
export class PortalController {
  constructor(
    private readonly portal: PortalService,
    private readonly deposits: DepositsService,
    private readonly settlements: SettlementsService,
    private readonly webhooks: WebhooksService,
    private readonly configuration: ConfigurationService,
    private readonly supportCases: SupportCasesService,
  ) {}

  private financialAuth(request: PortalRequest, environment: RuntimeEnvironment) {
    return { merchantId: request.portalAuth.merchantId, environment, apiKeyId: `portal:${request.portalAuth.userId}` };
  }

  @Get('summary')
  async summary(@Req() request: PortalRequest, @Query('environment') rawEnvironment?: string) {
    const environment = environmentSchema.parse(rawEnvironment) as RuntimeEnvironment;
    return success(request, await this.portal.summary(request.portalAuth, environment));
  }

  @Get('transactions')
  async transactions(@Req() request: PortalRequest, @Query('environment') rawEnvironment?: string, @Query('limit') rawLimit?: string) {
    const environment = environmentSchema.parse(rawEnvironment) as RuntimeEnvironment;
    const limit = z.coerce.number().int().min(1).max(200).default(100).parse(rawLimit);
    return success(request, await this.portal.transactions(request.portalAuth, environment, limit));
  }

  @Get('users')
  async users(@Req() request: PortalRequest) { return success(request, await this.portal.users(request.portalAuth)); }

  @Get('support/cases')
  async supportCaseList(
    @Req() request: PortalRequest,
    @Query('environment') rawEnvironment?: string,
    @Query('status') rawStatus?: string,
    @Query('limit') rawLimit?: string,
  ) {
    const environment = rawEnvironment ? environmentSchema.parse(rawEnvironment) as RuntimeEnvironment : undefined;
    const status = rawStatus ? supportStatusSchema.parse(rawStatus) : undefined;
    const limit = z.coerce.number().int().min(1).max(200).default(100).parse(rawLimit);
    return success(request, await this.supportCases.listForMerchant(request.portalAuth, { environment, status, limit }));
  }

  @Post('support/cases')
  @HttpCode(200)
  async createSupportCase(@Req() request: PortalRequest, @Body(new ZodPipe(createSupportCaseSchema)) body: z.infer<typeof createSupportCaseSchema>) {
    return success(request, await this.supportCases.createForMerchant(request.portalAuth, {
      environment: body.environment,
      category: body.category,
      subject: body.subject,
      reference: body.reference,
      message: body.message,
      evidenceReference: body.evidence_reference,
      proposedMatch: body.proposed_match,
    }), 'Support case opened');
  }

  @Get('support/cases/:caseId')
  async supportCase(@Req() request: PortalRequest, @Param('caseId') caseId: string) {
    return success(request, await this.supportCases.getForMerchant(request.portalAuth, z.string().uuid().parse(caseId)));
  }

  @Post('support/cases/:caseId/messages')
  @HttpCode(200)
  async addSupportMessage(
    @Req() request: PortalRequest,
    @Param('caseId') caseId: string,
    @Body(new ZodPipe(supportMessageSchema)) body: z.infer<typeof supportMessageSchema>,
  ) {
    return success(request, await this.supportCases.addMerchantMessage(request.portalAuth, z.string().uuid().parse(caseId), {
      message: body.message,
      evidenceReference: body.evidence_reference,
      proposedMatch: body.proposed_match,
    }), 'Support update added');
  }

  @Get('settings/changes')
  async settingChanges(@Req() request: PortalRequest) {
    return success(request, await this.configuration.list({ scopeType: 'merchant', scopeId: request.portalAuth.merchantId }));
  }

  @Get('settings/current')
  async currentSettings(@Req() request: PortalRequest) {
    return success(request, await this.configuration.activeMerchant(request.portalAuth.merchantId));
  }

  @Post('settings/changes')
  @HttpCode(200)
  async proposeSettings(@Req() request: PortalRequest, @Body(new ZodPipe(merchantConfigurationSchema)) body: z.infer<typeof merchantConfigurationSchema>) {
    if (request.portalAuth.role === 'support') throw new ApiException('forbidden', 'Owner or administrator access is required', 403);
    return success(request, await this.configuration.propose('merchant', request.portalAuth.merchantId, body.proposed, `portal:${request.portalAuth.userId}`, body.reason), 'Setting change submitted for platform approval');
  }

  @Post('invitations')
  @HttpCode(200)
  async invite(@Req() request: PortalRequest, @Body(new ZodPipe(inviteSchema)) body: z.infer<typeof inviteSchema>) {
    return success(request, await this.portal.invite(request.portalAuth, body), 'Invitation created; deliver its token through an approved channel');
  }

  @Get('api-keys')
  async apiKeys(@Req() request: PortalRequest, @Query('environment') rawEnvironment?: string) {
    if (request.portalAuth.role === 'support') throw new ApiException('forbidden', 'Owner or administrator access is required', 403);
    const environment = environmentSchema.parse(rawEnvironment) as RuntimeEnvironment;
    return success(request, await this.portal.apiKeys(request.portalAuth, environment));
  }

  @Post('api-keys')
  @HttpCode(200)
  async createApiKey(@Req() request: PortalRequest, @Body(new ZodPipe(apiKeySchema)) body: z.infer<typeof apiKeySchema>) {
    if (request.portalAuth.role === 'support') throw new ApiException('forbidden', 'Owner or administrator access is required', 403);
    return success(request, await this.portal.createApiKey(request.portalAuth, body.environment, body.label), 'API secret created; it will not be shown again');
  }

  @Delete('api-keys/:keyId')
  async revokeApiKey(@Req() request: PortalRequest, @Param('keyId') keyId: string) {
    if (request.portalAuth.role === 'support') throw new ApiException('forbidden', 'Owner or administrator access is required', 403);
    return success(request, await this.portal.revokeApiKey(request.portalAuth, z.string().uuid().parse(keyId)), 'API key revoked');
  }

  @Get('webhook-logs')
  async webhookLogs(@Req() request: PortalRequest, @Query('environment') rawEnvironment?: string) {
    const environment = environmentSchema.parse(rawEnvironment) as RuntimeEnvironment;
    return success(request, await this.portal.webhookLogs(request.portalAuth, environment));
  }

  @Post('topups')
  @HttpCode(200)
  async createTopup(
    @Req() request: PortalRequest,
    @Body(new ZodPipe(initializeTransactionSchema)) body: z.infer<typeof initializeTransactionSchema>,
    @Query('environment') rawEnvironment?: string,
    @Headers('idempotency-key') rawKey?: string,
  ) {
    const environment = environmentSchema.parse(rawEnvironment) as RuntimeEnvironment;
    if (request.portalAuth.role === 'support') throw new ApiException('forbidden', 'Owner or administrator access is required', 403);
    const key = rawKey ? idempotencyKeySchema.parse(rawKey) : body.tx_ref;
    const input = { ...body, customer_id: `merchant-topup:${request.portalAuth.merchantId}`, metadata: { ...(body.metadata ?? {}), intent_type: 'merchant_topup', requested_by: request.portalAuth.userId } };
    return success(request, await this.deposits.initialize(this.financialAuth(request, environment), input, key, 'merchant_topup'), 'Merchant top-up initialized');
  }

  @Post('settlements')
  @HttpCode(200)
  async createSettlement(
    @Req() request: PortalRequest,
    @Body(new ZodPipe(createSettlementSchema)) body: z.infer<typeof createSettlementSchema>,
    @Query('environment') rawEnvironment?: string,
    @Headers('idempotency-key') rawKey?: string,
  ) {
    const environment = environmentSchema.parse(rawEnvironment) as RuntimeEnvironment;
    if (request.portalAuth.role === 'support') throw new ApiException('forbidden', 'Owner or administrator access is required', 403);
    const key = rawKey ? idempotencyKeySchema.parse(rawKey) : body.reference;
    return success(request, await this.settlements.request(this.financialAuth(request, environment), body, key), 'Settlement requested for platform review');
  }

  @Get('settlements')
  async settlementsList(@Req() request: PortalRequest, @Query('environment') rawEnvironment?: string) {
    const environment = environmentSchema.parse(rawEnvironment) as RuntimeEnvironment;
    return success(request, await this.settlements.list(this.financialAuth(request, environment)));
  }

  @Post('webhook-endpoints')
  @HttpCode(200)
  async createWebhook(@Req() request: PortalRequest, @Body(new ZodPipe(webhookSchema)) body: z.infer<typeof webhookSchema>, @Headers('idempotency-key') rawKey?: string) {
    if (request.portalAuth.role === 'support') throw new ApiException('forbidden', 'Owner or administrator access is required', 403);
    const key = rawKey ? idempotencyKeySchema.parse(rawKey) : `webhook:${sha256(body.url).slice(0, 32)}`;
    return success(request, await this.webhooks.register(this.financialAuth(request, body.environment), body.url, key), 'Webhook registered; store the secret now');
  }

  @Post('webhook-deliveries/:deliveryId/replay')
  @HttpCode(200)
  async replayWebhook(@Req() request: PortalRequest, @Param('deliveryId') deliveryId: string, @Headers('idempotency-key') rawKey?: string) {
    const environment = environmentSchema.parse(request.query.environment) as RuntimeEnvironment;
    const key = rawKey ? idempotencyKeySchema.parse(rawKey) : deliveryId;
    return success(request, await this.webhooks.replay(this.financialAuth(request, environment), z.string().uuid().parse(deliveryId), key), 'Webhook replay queued');
  }

  @Patch('webhook-endpoints/:endpointId')
  async setWebhookEnabled(@Req() request: PortalRequest, @Param('endpointId') endpointId: string, @Body(new ZodPipe(webhookStateSchema)) body: z.infer<typeof webhookStateSchema>) {
    if (request.portalAuth.role === 'support') throw new ApiException('forbidden', 'Owner or administrator access is required', 403);
    return success(request, await this.webhooks.setEnabled(this.financialAuth(request, body.environment), z.string().uuid().parse(endpointId), body.enabled), body.enabled ? 'Webhook enabled' : 'Webhook disabled');
  }

  @Post('webhook-endpoints/:endpointId/rotate-secret')
  @HttpCode(200)
  async rotateWebhookSecret(
    @Req() request: PortalRequest,
    @Param('endpointId') endpointId: string,
    @Body(new ZodPipe(webhookEnvironmentSchema)) body: z.infer<typeof webhookEnvironmentSchema>,
    @Headers('idempotency-key') rawKey: string,
  ) {
    if (request.portalAuth.role === 'support') throw new ApiException('forbidden', 'Owner or administrator access is required', 403);
    const key = idempotencyKeySchema.parse(rawKey);
    return success(request, await this.webhooks.rotateSecret(this.financialAuth(request, body.environment), z.string().uuid().parse(endpointId), key), 'Webhook secret rotated; store it now');
  }
}
