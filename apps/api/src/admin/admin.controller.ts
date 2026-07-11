import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { etbAmountSchema, ethiopianPhoneSchema } from '@telebirr/contracts';
import { z } from 'zod';
import type { RequestWithContext } from '../common/request-context';
import { success } from '../common/envelope';
import { ApiException } from '../common/api-exception';
import { ZodPipe } from '../common/zod.pipe';
import { AdminGuard } from './admin.guard';
import { AdminService } from './admin.service';
import { PasswordReauthGuard } from './password-reauth.guard';
import { PlatformWriteGuard } from './platform-write.guard';
import type { PlatformRequest } from './admin-auth.types';
import { WithdrawalsService } from '../withdrawals/withdrawals.service';
import { ConfigurationService } from '../configuration/configuration.service';
import { SupportCasesService } from '../support/support-cases.service';
import { changeSupportStatusSchema, supportMessageSchema, supportStatusSchema } from '../support/support-cases.schemas';
import { DepositsService } from '../deposits/deposits.service';
import { randomUUID } from 'node:crypto';

const merchantSchema = z.object({ slug: z.string().regex(/^[a-z0-9-]{2,80}$/), name: z.string().min(2).max(200), owner_email: z.string().email().max(320), initial_test_balance: etbAmountSchema.optional() });
const locationSchema = z.object({ code: z.string().regex(/^[A-Z0-9-]{2,40}$/), name: z.string().min(2).max(120) });
const groupSchema = z.object({ location_id: z.string().uuid(), code: z.string().regex(/^[A-Z0-9-]{2,40}$/), name: z.string().min(2).max(120) });
const merchantGroupPolicySchema = z.object({ dedicated: z.boolean(), priority: z.number().int().min(1).max(1000), reason: z.string().trim().min(10).max(1000) });
const deviceSchema = z.object({
  group_id: z.string().uuid(),
  name: z.string().min(2).max(120),
  model: z.string().max(100).optional(),
  sims: z.array(z.object({ slot: z.number().int().min(0).max(1), iccid: z.string().min(8).max(32), phone_number: ethiopianPhoneSchema, account_name: z.string().min(2).max(200) })).min(1).max(2),
}).refine((value) => new Set(value.sims.map((sim) => sim.slot)).size === value.sims.length, 'SIM slots must be unique');
const quarantineSchema = z.object({ reason: z.string().min(5).max(1000) });
const deviceRecoverySchema = z.object({
  reason: z.string().trim().min(10).max(1000),
  replacement_hardware: z.boolean().default(false),
  sims: z.array(z.object({
    slot: z.number().int().min(0).max(1),
    iccid: z.string().regex(/^\d{10,24}$/),
    phone_number: ethiopianPhoneSchema,
    account_name: z.string().trim().min(2).max(200),
  })).min(1).max(2),
}).refine((value) => new Set(value.sims.map((sim) => sim.slot)).size === value.sims.length, 'SIM slots must be unique');
const deviceRetireSchema = z.object({ reason: z.string().trim().min(10).max(1000) });
const merchantWithdrawalSchema = z.object({
  merchant_id: z.string().uuid(),
  environment: z.enum(['test', 'live']).default('live'),
  account_number: ethiopianPhoneSchema,
  expected_name: z.string().min(2).max(200),
  amount: etbAmountSchema,
  reference: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
  reason: z.string().min(5).max(1000),
});
const resolveDepositSchema = z.object({ deposit_id: z.string().uuid(), reason: z.string().min(5).max(1000) });
const qualificationCheckSchema = z.object({ status: z.enum(['passed', 'failed']), evidence_reference: z.string().trim().min(5).max(500), notes: z.string().trim().min(5).max(1000).optional() });
const qualificationDecisionSchema = z.object({ reason: z.string().trim().min(10).max(1000) });
const deviceOnlineSchema = z.object({ online: z.boolean() });
const adminTestDepositSchema = z.object({
  merchant_id: z.string().uuid(),
  amount: etbAmountSchema,
  first_name: z.string().trim().min(1).max(100),
  last_name: z.string().trim().max(100).optional(),
  phone_number: ethiopianPhoneSchema,
});
const adminTestWithdrawalSchema = z.object({
  merchant_id: z.string().uuid(),
  amount: etbAmountSchema,
  account_number: ethiopianPhoneSchema,
  expected_name: z.string().trim().min(2).max(200),
});
const cancelTransferSchema = z.object({ reason: z.string().trim().min(10).max(1000) });
const treasuryWalletSchema = z.object({
  merchant_id: z.string().uuid().optional(),
  environment: z.enum(['test', 'live']).default('live'),
  phone_number: ethiopianPhoneSchema,
  account_name: z.string().trim().min(2).max(200),
  reason: z.string().trim().min(10).max(1000),
});
const treasuryBalanceSchema = z.object({ balance: z.string().regex(/^(0|[1-9]\d*)\.\d{2}$/), reason: z.string().trim().min(10).max(1000) });
const configurationChangeSchema = z.object({ scope_type: z.enum(['platform_defaults', 'merchant', 'device_group']), scope_id: z.string().min(1).max(128), proposed: z.record(z.string(), z.unknown()), reason: z.string().trim().min(10).max(1000) });
const nonNegativeEtb = z.string().regex(/^(0|[1-9]\d*)\.\d{2}$/);
const resolveTransferSchema = z.object({
  outcome: z.enum(['success', 'failed']),
  provider_transaction_id: z.string().trim().min(5).max(64).optional(),
  resolved_name: z.string().trim().min(2).max(200).optional(),
  service_fee: nonNegativeEtb.optional(),
  vat: nonNegativeEtb.optional(),
  current_main_balance: nonNegativeEtb.optional(),
  failure_evidence_reference: z.string().trim().min(5).max(500).optional(),
  reason: z.string().trim().min(10).max(1000),
}).superRefine((value, context) => {
  if (value.outcome === 'success' && !value.provider_transaction_id) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['provider_transaction_id'], message: 'required when success is proven' });
  }
  if (value.outcome === 'success' && value.service_fee === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['service_fee'], message: 'required when success is proven' });
  }
  if (value.outcome === 'success' && value.vat === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['vat'], message: 'required when success is proven' });
  }
  if (value.outcome === 'failed' && !value.failure_evidence_reference) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['failure_evidence_reference'], message: 'conclusive provider failure evidence is required' });
  }
});

@Controller('v1/admin')
@UseGuards(AdminGuard, PlatformWriteGuard)
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly deposits: DepositsService,
    private readonly withdrawals: WithdrawalsService,
    private readonly configuration: ConfigurationService,
    private readonly supportCases: SupportCasesService,
  ) {}

  @Get('dashboard')
  async dashboard(@Req() request: RequestWithContext) { return success(request, await this.admin.dashboard()); }

  @Get('operations/:kind')
  async operations(@Req() request: RequestWithContext, @Param('kind') kind: string) {
    return success(request, await this.admin.operations(z.enum(['jobs', 'deposits', 'withdrawals']).parse(kind)));
  }

  @Get('merchants')
  async merchants(@Req() request: RequestWithContext) { return success(request, await this.admin.merchants()); }

  @Get('audit')
  async audit(@Req() request: RequestWithContext) { return success(request, await this.admin.audit()); }

  @Get('support/cases')
  async supportCaseList(
    @Req() request: RequestWithContext,
    @Query('merchant_id') rawMerchantId?: string,
    @Query('environment') rawEnvironment?: string,
    @Query('status') rawStatus?: string,
    @Query('limit') rawLimit?: string,
  ) {
    const merchantId = rawMerchantId ? z.string().uuid().parse(rawMerchantId) : undefined;
    const environment = rawEnvironment ? z.enum(['test', 'live']).parse(rawEnvironment) : undefined;
    const status = rawStatus ? supportStatusSchema.parse(rawStatus) : undefined;
    const limit = z.coerce.number().int().min(1).max(200).default(100).parse(rawLimit);
    return success(request, await this.supportCases.listForPlatform({ merchantId, environment, status, limit }));
  }

  @Get('support/cases/:caseId')
  async supportCase(@Req() request: RequestWithContext, @Param('caseId') caseId: string) {
    return success(request, await this.supportCases.getForPlatform(z.string().uuid().parse(caseId)));
  }

  @Post('support/cases/:caseId/messages')
  @HttpCode(200)
  async addSupportCaseMessage(
    @Req() request: PlatformRequest,
    @Param('caseId') caseId: string,
    @Body(new ZodPipe(supportMessageSchema)) body: z.infer<typeof supportMessageSchema>,
  ) {
    return success(request, await this.supportCases.addPlatformMessage(request.platformAuth, z.string().uuid().parse(caseId), {
      message: body.message,
      evidenceReference: body.evidence_reference,
      proposedMatch: body.proposed_match,
    }), 'Support update added');
  }

  @Post('support/cases/:caseId/status')
  @HttpCode(200)
  async changeSupportCaseStatus(
    @Req() request: PlatformRequest,
    @Param('caseId') caseId: string,
    @Body(new ZodPipe(changeSupportStatusSchema)) body: z.infer<typeof changeSupportStatusSchema>,
  ) {
    return success(request, await this.supportCases.changeWorkflowStatus(request.platformAuth, z.string().uuid().parse(caseId), body.status, body.reason), 'Support workflow updated; no financial resolution was performed');
  }

  @Get('configuration/changes')
  async configurationChanges(@Req() request: RequestWithContext, @Query('status') status?: 'pending' | 'approved' | 'rejected') {
    return success(request, await this.configuration.list({ status }));
  }

  @Post('configuration/changes')
  @UseGuards(PasswordReauthGuard)
  async proposeConfiguration(@Req() request: PlatformRequest, @Body(new ZodPipe(configurationChangeSchema)) body: z.infer<typeof configurationChangeSchema>) {
    return success(request, await this.configuration.propose(body.scope_type, body.scope_id, body.proposed, request.platformAuth.staffId, body.reason), 'Configuration change submitted for approval');
  }

  @Post('configuration/changes/:changeId/approve')
  @UseGuards(PasswordReauthGuard)
  async approveConfiguration(@Req() request: PlatformRequest, @Param('changeId') changeId: string, @Body(new ZodPipe(cancelTransferSchema)) body: z.infer<typeof cancelTransferSchema>) {
    return success(request, await this.configuration.approve(changeId, request.platformAuth.staffId, body.reason), 'Configuration activated');
  }

  @Post('configuration/changes/:changeId/reject')
  @UseGuards(PasswordReauthGuard)
  async rejectConfiguration(@Req() request: PlatformRequest, @Param('changeId') changeId: string, @Body(new ZodPipe(cancelTransferSchema)) body: z.infer<typeof cancelTransferSchema>) {
    return success(request, await this.configuration.reject(changeId, request.platformAuth.staffId, body.reason), 'Configuration rejected');
  }

  @Post('merchants')
  @UseGuards(PasswordReauthGuard)
  async createMerchant(@Req() request: PlatformRequest, @Body(new ZodPipe(merchantSchema)) body: z.infer<typeof merchantSchema>) {
    return success(request, await this.admin.createMerchant({ slug: body.slug, name: body.name, ownerEmail: body.owner_email, actorId: request.platformAuth.staffId, initialTestBalance: body.initial_test_balance }), 'Merchant and owner invitation created; secrets are shown once');
  }

  @Post('fleet/locations')
  async createLocation(@Req() request: RequestWithContext, @Body(new ZodPipe(locationSchema)) body: z.infer<typeof locationSchema>) {
    return success(request, await this.admin.createLocation(body), 'Location created');
  }

  @Post('fleet/groups')
  async createGroup(@Req() request: RequestWithContext, @Body(new ZodPipe(groupSchema)) body: z.infer<typeof groupSchema>) {
    return success(request, await this.admin.createGroup({ locationId: body.location_id, code: body.code, name: body.name }), 'Group created');
  }

  @Put('fleet/groups/:groupId/merchant-policies/:merchantId')
  @UseGuards(PasswordReauthGuard)
  async upsertMerchantGroupPolicy(@Req() request: PlatformRequest, @Param('groupId') groupId: string, @Param('merchantId') merchantId: string, @Body(new ZodPipe(merchantGroupPolicySchema)) body: z.infer<typeof merchantGroupPolicySchema>) {
    return success(request, await this.admin.upsertMerchantGroupPolicy(z.string().uuid().parse(groupId), z.string().uuid().parse(merchantId), body.dedicated, body.priority, request.platformAuth.staffId, body.reason), 'Merchant fleet policy activated');
  }

  @Delete('fleet/groups/:groupId/merchant-policies/:merchantId')
  @UseGuards(PasswordReauthGuard)
  async removeMerchantGroupPolicy(@Req() request: PlatformRequest, @Param('groupId') groupId: string, @Param('merchantId') merchantId: string, @Body(new ZodPipe(cancelTransferSchema)) body: z.infer<typeof cancelTransferSchema>) {
    return success(request, await this.admin.removeMerchantGroupPolicy(z.string().uuid().parse(groupId), z.string().uuid().parse(merchantId), request.platformAuth.staffId, body.reason), 'Merchant fleet policy removed');
  }

  @Post('fleet/devices')
  async createDevice(@Req() request: PlatformRequest, @Body(new ZodPipe(deviceSchema)) body: z.infer<typeof deviceSchema>) {
    return success(request, await this.admin.createDevice({ groupId: body.group_id, name: body.name, model: body.model, actorId: request.platformAuth.staffId, sims: body.sims.map((sim) => ({ slot: sim.slot, iccid: sim.iccid, phoneNumber: sim.phone_number, accountName: sim.account_name })) }), 'Device created; activation code is shown once');
  }

  @Delete('fleet/devices/:deviceId')
  @UseGuards(PasswordReauthGuard)
  async deleteDevice(@Req() request: PlatformRequest, @Param('deviceId') deviceId: string, @Body(new ZodPipe(deviceRetireSchema)) body: z.infer<typeof deviceRetireSchema>) {
    return success(request, await this.admin.deleteDevice(z.string().uuid().parse(deviceId), body.reason, request.platformAuth.staffId), 'Unqualified phone deleted; its SIM identities can be enrolled again');
  }

  @Post('fleet/devices/:deviceId/activation-code')
  async regenerateActivationCode(@Req() request: PlatformRequest, @Param('deviceId') deviceId: string) {
    return success(request, await this.admin.regenerateActivationCode(z.string().uuid().parse(deviceId), request.platformAuth.staffId), 'New server-generated activation code created');
  }

  @Get('fleet/devices/:deviceId')
  async device(@Req() request: RequestWithContext, @Param('deviceId') deviceId: string) {
    return success(request, await this.admin.device(z.string().uuid().parse(deviceId)));
  }

  @Post('fleet/devices/:deviceId/online')
  @HttpCode(200)
  async setDeviceOnline(
    @Req() request: PlatformRequest,
    @Param('deviceId') deviceId: string,
    @Body(new ZodPipe(deviceOnlineSchema)) body: z.infer<typeof deviceOnlineSchema>,
  ) {
    return success(
      request,
      await this.admin.setDeviceOnline(z.string().uuid().parse(deviceId), body.online, request.platformAuth.staffId),
      body.online ? 'Device is online' : 'Device is offline',
    );
  }

  @Get('fleet/devices/:deviceId/qualification')
  async qualification(@Req() request: RequestWithContext, @Param('deviceId') deviceId: string) {
    return success(request, await this.admin.qualification(z.string().uuid().parse(deviceId)));
  }

  @Post('fleet/devices/:deviceId/qualification-runs')
  async startQualification(@Req() request: PlatformRequest, @Param('deviceId') deviceId: string) {
    return success(request, await this.admin.startQualification(z.string().uuid().parse(deviceId), request.platformAuth.staffId), 'Qualification run started');
  }

  @Post('fleet/qualification-runs/:runId/checks/:checkId')
  async recordQualificationCheck(@Req() request: PlatformRequest, @Param('runId') runId: string, @Param('checkId') checkId: string, @Body(new ZodPipe(qualificationCheckSchema)) body: z.infer<typeof qualificationCheckSchema>) {
    return success(request, await this.admin.recordQualificationCheck(z.string().uuid().parse(runId), z.string().uuid().parse(checkId), { status: body.status, evidenceReference: body.evidence_reference, notes: body.notes }, request.platformAuth.staffId), 'Qualification evidence recorded');
  }

  @Post('fleet/qualification-runs/:runId/approve')
  @UseGuards(PasswordReauthGuard)
  async approveQualification(@Req() request: PlatformRequest, @Param('runId') runId: string, @Body(new ZodPipe(qualificationDecisionSchema)) body: z.infer<typeof qualificationDecisionSchema>) {
    return success(request, await this.admin.approveQualification(z.string().uuid().parse(runId), body.reason, request.platformAuth.staffId), 'Qualification approved; SIM wallets may now receive work');
  }

  @Post('fleet/qualification-runs/:runId/reject')
  @UseGuards(PasswordReauthGuard)
  async rejectQualification(@Req() request: PlatformRequest, @Param('runId') runId: string, @Body(new ZodPipe(qualificationDecisionSchema)) body: z.infer<typeof qualificationDecisionSchema>) {
    return success(request, await this.admin.rejectQualification(z.string().uuid().parse(runId), body.reason, request.platformAuth.staffId), 'Qualification rejected; SIM wallets remain pending');
  }

  @Get('fleet')
  async fleet(@Req() request: RequestWithContext) { return success(request, await this.admin.fleet()); }

  @Post('test/deposits')
  async createTestDeposit(
    @Req() request: PlatformRequest,
    @Body(new ZodPipe(adminTestDepositSchema)) body: z.infer<typeof adminTestDepositSchema>,
  ) {
    const reference = `ADMIN-DEP-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const auth = { merchantId: body.merchant_id, environment: 'live' as const, apiKeyId: `admin-live-test:${request.platformAuth.staffId}` };
    const result = await this.deposits.initialize(auth, {
      amount: body.amount,
      currency: 'ETB',
      tx_ref: reference,
      customer_id: `admin-test-${randomUUID()}`,
      first_name: body.first_name,
      last_name: body.last_name,
      phone_number: body.phone_number,
      metadata: { source: 'admin_live_test_console', actor_id: request.platformAuth.staffId },
    }, reference);
    return success(request, result, 'Test deposit created');
  }

  @Post('test/withdrawals')
  async createTestWithdrawal(
    @Req() request: PlatformRequest,
    @Body(new ZodPipe(adminTestWithdrawalSchema)) body: z.infer<typeof adminTestWithdrawalSchema>,
  ) {
    const reference = `ADMIN-WD-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const auth = { merchantId: body.merchant_id, environment: 'live' as const, apiKeyId: `admin-live-test:${request.platformAuth.staffId}` };
    const result = await this.withdrawals.create(auth, {
      amount: body.amount,
      currency: 'ETB',
      reference,
      customer_id: `admin-test-${randomUUID()}`,
      destination_type: 'registered',
      account_number: body.account_number,
      expected_name: body.expected_name,
      bank_code: '855',
      metadata: { source: 'admin_live_test_console', actor_id: request.platformAuth.staffId },
    }, reference);
    return success(request, result, 'Test withdrawal created');
  }

  @Get('treasury-wallets')
  async treasuryWallets(@Req() request: RequestWithContext) { return success(request, await this.admin.treasuryWallets()); }

  @Post('treasury-wallets')
  @UseGuards(PasswordReauthGuard)
  async createTreasuryWallet(@Req() request: PlatformRequest, @Body(new ZodPipe(treasuryWalletSchema)) body: z.infer<typeof treasuryWalletSchema>) {
    return success(request, await this.admin.createTreasuryWallet({
      merchantId: body.merchant_id,
      environment: body.environment,
      phoneNumber: body.phone_number,
      accountName: body.account_name,
      actorId: request.platformAuth.staffId,
      reason: body.reason,
    }), 'Treasury wallet preapproved');
  }

  @Post('treasury-wallets/:walletId/balance-evidence')
  @UseGuards(PasswordReauthGuard)
  async confirmTreasuryBalance(@Req() request: PlatformRequest, @Param('walletId') walletId: string, @Body(new ZodPipe(treasuryBalanceSchema)) body: z.infer<typeof treasuryBalanceSchema>) {
    return success(request, await this.admin.confirmTreasuryBalance(walletId, body.balance, body.reason, request.platformAuth.staffId), 'Treasury balance evidence recorded');
  }

  @Post('fleet/sims/:simId/balance-query')
  async balance(@Req() request: RequestWithContext, @Param('simId') simId: string) { return success(request, await this.admin.queueBalance(simId), 'Balance query queued'); }

  @Post('fleet/devices/:deviceId/quarantine')
  @UseGuards(PasswordReauthGuard)
  async quarantine(@Req() request: PlatformRequest, @Param('deviceId') deviceId: string, @Body(new ZodPipe(quarantineSchema)) body: z.infer<typeof quarantineSchema>) {
    return success(request, await this.admin.quarantine(deviceId, body.reason, request.platformAuth.staffId), 'Device quarantined');
  }

  @Post('fleet/devices/:deviceId/recover')
  @UseGuards(PasswordReauthGuard)
  async recoverDevice(@Req() request: PlatformRequest, @Param('deviceId') deviceId: string, @Body(new ZodPipe(deviceRecoverySchema)) body: z.infer<typeof deviceRecoverySchema>) {
    return success(request, await this.admin.beginDeviceRecovery({
      deviceId: z.string().uuid().parse(deviceId),
      identities: body.sims.map((sim) => ({ slot: sim.slot, iccid: sim.iccid, phoneNumber: sim.phone_number, accountName: sim.account_name })),
      replacementHardware: body.replacement_hardware,
      reason: body.reason,
      actorId: request.platformAuth.staffId,
    }), 'Credentials revoked; activate the phone with the new code, then switch it online');
  }

  @Post('fleet/devices/:deviceId/retire')
  @UseGuards(PasswordReauthGuard)
  async retireDevice(@Req() request: PlatformRequest, @Param('deviceId') deviceId: string, @Body(new ZodPipe(deviceRetireSchema)) body: z.infer<typeof deviceRetireSchema>) {
    return success(request, await this.admin.retireDevice(z.string().uuid().parse(deviceId), body.reason, request.platformAuth.staffId), 'Device retired; its credentials and SIM assignments are disabled');
  }

  @Get('reconciliation/cases')
  async cases(@Req() request: RequestWithContext, @Query('status') status?: 'open' | 'proposed' | 'resolved' | 'rejected') { return success(request, await this.admin.cases(status)); }

  @Post('merchant-withdrawals')
  @UseGuards(PasswordReauthGuard)
  async merchantWithdrawal(
    @Req() request: PlatformRequest,
    @Body(new ZodPipe(merchantWithdrawalSchema)) body: z.infer<typeof merchantWithdrawalSchema>,
  ) {
    void body;
    throw new ApiException('deprecated_endpoint', 'Use the merchant settlement request and platform approval workflow', HttpStatus.GONE);
  }

  @Post('reconciliation/cases/:caseId/resolve-deposit')
  @UseGuards(PasswordReauthGuard)
  async resolveDeposit(
    @Req() request: PlatformRequest,
    @Param('caseId') caseId: string,
    @Body(new ZodPipe(resolveDepositSchema)) body: z.infer<typeof resolveDepositSchema>,
  ) {
    return success(request, await this.admin.resolveDeposit(caseId, body.deposit_id, body.reason, request.platformAuth.staffId), 'Receipt credited by platform staff');
  }

  @Post('transfers/:transferId/cancel')
  @UseGuards(PasswordReauthGuard)
  async cancelTransfer(
    @Req() request: PlatformRequest,
    @Param('transferId') transferId: string,
    @Body(new ZodPipe(cancelTransferSchema)) body: z.infer<typeof cancelTransferSchema>,
  ) {
    return success(request, await this.withdrawals.cancelBeforeStart(transferId, body.reason, request.platformAuth.staffId), 'Transfer cancelled before device start');
  }

  @Post('transfers/:transferId/retry-name-approved')
  @UseGuards(PasswordReauthGuard)
  async retryApprovedName(
    @Req() request: PlatformRequest,
    @Param('transferId') transferId: string,
    @Body(new ZodPipe(cancelTransferSchema)) body: z.infer<typeof cancelTransferSchema>,
  ) {
    return success(request, await this.withdrawals.approveNameAndRetry(transferId, body.reason, request.platformAuth.staffId), 'Receiver name approved and a new pre-commit attempt queued');
  }

  @Post('transfers/:transferId/resolve')
  @UseGuards(PasswordReauthGuard)
  async resolveTransfer(
    @Req() request: PlatformRequest,
    @Param('transferId') transferId: string,
    @Body(new ZodPipe(resolveTransferSchema)) body: z.infer<typeof resolveTransferSchema>,
  ) {
    const toMinor = (value: string) => BigInt(value.replace('.', ''));
    return success(request, await this.withdrawals.resolveUnknown(transferId, {
      outcome: body.outcome,
      providerTransactionId: body.provider_transaction_id,
      resolvedName: body.resolved_name,
      serviceFeeMinor: toMinor(body.service_fee ?? '0.00'),
      vatMinor: toMinor(body.vat ?? '0.00'),
      currentMainBalanceMinor: body.current_main_balance === undefined ? undefined : toMinor(body.current_main_balance),
      failureEvidenceReference: body.failure_evidence_reference,
      reason: body.reason,
    }, request.platformAuth.staffId), 'Unknown transfer resolved from provider evidence');
  }
}
