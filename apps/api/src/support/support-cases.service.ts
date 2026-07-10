import { HttpStatus, Injectable } from '@nestjs/common';
import type {
  MerchantSupportCase,
  RuntimeEnvironment,
  SupportCaseCategory,
  SupportCaseStatus,
} from '@prisma/client';
import type { PortalAuthContext } from '../auth/auth.types';
import type { PlatformAuthContext } from '../admin/admin-auth.types';
import { ApiException } from '../common/api-exception';
import { PrismaService } from '../infra/prisma.service';

export interface SupportProposal {
  kind: 'deposit_intent' | 'incoming_receipt' | 'withdrawal' | 'provider_transaction';
  reference: string;
  explanation?: string;
}

export interface SupportMessageInput {
  message: string;
  evidenceReference?: string;
  proposedMatch?: SupportProposal;
}

export interface CreateSupportCaseInput extends SupportMessageInput {
  environment: RuntimeEnvironment;
  category: SupportCaseCategory;
  subject: string;
  reference?: string;
}

const WORKFLOW_TRANSITIONS: Record<SupportCaseStatus, ReadonlySet<SupportCaseStatus>> = {
  open: new Set(['investigating', 'awaiting_merchant', 'resolved', 'closed']),
  investigating: new Set(['open', 'awaiting_merchant', 'resolved', 'closed']),
  awaiting_merchant: new Set(['open', 'investigating', 'resolved', 'closed']),
  resolved: new Set(['investigating', 'closed']),
  closed: new Set(['open']),
};

function cleanText(value: string): string {
  return value
    .normalize('NFC')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim();
}

function cleanMessage(input: SupportMessageInput) {
  const message = cleanText(input.message);
  const evidenceReference = input.evidenceReference ? cleanText(input.evidenceReference) : undefined;
  const proposedMatch = input.proposedMatch
    ? {
        kind: input.proposedMatch.kind,
        reference: cleanText(input.proposedMatch.reference),
        ...(input.proposedMatch.explanation ? { explanation: cleanText(input.proposedMatch.explanation) } : {}),
      }
    : undefined;
  return { message, evidenceReference, proposedMatch };
}

function serializeCase(item: MerchantSupportCase & {
  merchant?: { id: string; slug: string; name: string };
  createdBy?: { id: string; displayName: string } | null;
  assignedStaff?: { id: string; displayName: string } | null;
  messages?: Array<{
    id: string;
    body: string;
    evidenceReference: string | null;
    proposal: unknown;
    createdAt: Date;
    authorMerchantUser: { id: string; displayName: string } | null;
    authorPlatformStaff: { id: string; displayName: string } | null;
  }>;
  _count?: { messages: number };
}) {
  return {
    id: item.id,
    merchant: item.merchant,
    environment: item.environment,
    category: item.category,
    subject: item.subject,
    reference: item.reference,
    status: item.status,
    workflow_note: item.workflowNote,
    created_by: item.createdBy ? { id: item.createdBy.id, display_name: item.createdBy.displayName } : null,
    assigned_to: item.assignedStaff ? { id: item.assignedStaff.id, display_name: item.assignedStaff.displayName } : null,
    message_count: item._count?.messages ?? item.messages?.length ?? 0,
    messages: item.messages?.map((message) => ({
      id: message.id,
      body: message.body,
      evidence_reference: message.evidenceReference,
      proposed_match: message.proposal,
      author: message.authorMerchantUser
        ? { type: 'merchant_user', id: message.authorMerchantUser.id, display_name: message.authorMerchantUser.displayName }
        : message.authorPlatformStaff
          ? { type: 'platform_staff', id: message.authorPlatformStaff.id, display_name: message.authorPlatformStaff.displayName }
          : { type: 'former_user', id: null, display_name: 'Former user' },
      created_at: message.createdAt.toISOString(),
    })),
    created_at: item.createdAt.toISOString(),
    updated_at: item.updatedAt.toISOString(),
    resolved_at: item.resolvedAt?.toISOString() ?? null,
    financial_resolution_performed: false,
  };
}

@Injectable()
export class SupportCasesService {
  constructor(private readonly prisma: PrismaService) {}

  async listForMerchant(auth: PortalAuthContext, filter: { environment?: RuntimeEnvironment; status?: SupportCaseStatus; limit: number }) {
    const cases = await this.prisma.merchantSupportCase.findMany({
      where: { merchantId: auth.merchantId, ...(filter.environment ? { environment: filter.environment } : {}), ...(filter.status ? { status: filter.status } : {}) },
      include: {
        createdBy: { select: { id: true, displayName: true } },
        assignedStaff: { select: { id: true, displayName: true } },
        _count: { select: { messages: true } },
      },
      orderBy: { updatedAt: 'desc' },
      take: filter.limit,
    });
    return cases.map(serializeCase);
  }

  async getForMerchant(auth: PortalAuthContext, caseId: string) {
    const item = await this.prisma.merchantSupportCase.findFirst({
      where: { id: caseId, merchantId: auth.merchantId },
      include: {
        createdBy: { select: { id: true, displayName: true } },
        assignedStaff: { select: { id: true, displayName: true } },
        messages: {
          include: {
            authorMerchantUser: { select: { id: true, displayName: true } },
            authorPlatformStaff: { select: { id: true, displayName: true } },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!item) throw new ApiException('support_case_not_found', 'Support case was not found', HttpStatus.NOT_FOUND);
    return serializeCase(item);
  }

  async createForMerchant(auth: PortalAuthContext, rawInput: CreateSupportCaseInput) {
    const input = cleanMessage(rawInput);
    const created = await this.prisma.$transaction(async (transaction) => {
      const supportCase = await transaction.merchantSupportCase.create({
        data: {
          merchantId: auth.merchantId,
          environment: rawInput.environment,
          category: rawInput.category,
          subject: cleanText(rawInput.subject),
          reference: rawInput.reference ? cleanText(rawInput.reference) : undefined,
          createdByUserId: auth.userId,
        },
      });
      await transaction.supportCaseMessage.create({
        data: {
          caseId: supportCase.id,
          authorMerchantUserId: auth.userId,
          body: input.message,
          evidenceReference: input.evidenceReference,
          proposal: input.proposedMatch,
        },
      });
      await transaction.auditLog.create({
        data: {
          merchantId: auth.merchantId,
          actorType: 'merchant_user',
          actorId: auth.userId,
          action: 'support_case.created',
          targetType: 'merchant_support_case',
          targetId: supportCase.id,
          metadata: { environment: rawInput.environment, category: rawInput.category, has_evidence: Boolean(input.evidenceReference), has_proposal: Boolean(input.proposedMatch) },
        },
      });
      return supportCase;
    });
    return this.getForMerchant(auth, created.id);
  }

  async addMerchantMessage(auth: PortalAuthContext, caseId: string, rawInput: SupportMessageInput) {
    const supportCase = await this.prisma.merchantSupportCase.findFirst({ where: { id: caseId, merchantId: auth.merchantId }, select: { id: true, status: true } });
    if (!supportCase) throw new ApiException('support_case_not_found', 'Support case was not found', HttpStatus.NOT_FOUND);
    if (supportCase.status === 'closed') throw new ApiException('support_case_closed', 'Closed support cases must be reopened by platform support', HttpStatus.CONFLICT);
    const input = cleanMessage(rawInput);
    await this.prisma.$transaction(async (transaction) => {
      const claim = await transaction.merchantSupportCase.updateMany({
        where: { id: caseId, merchantId: auth.merchantId, status: { not: 'closed' } },
        data: { updatedAt: new Date() },
      });
      if (claim.count !== 1) throw new ApiException('support_case_closed', 'Closed support cases must be reopened by platform support', HttpStatus.CONFLICT);
      const message = await transaction.supportCaseMessage.create({
        data: { caseId, authorMerchantUserId: auth.userId, body: input.message, evidenceReference: input.evidenceReference, proposal: input.proposedMatch },
      });
      await transaction.auditLog.create({
        data: {
          merchantId: auth.merchantId,
          actorType: 'merchant_user',
          actorId: auth.userId,
          action: 'support_case.message_added',
          targetType: 'support_case_message',
          targetId: message.id,
          metadata: { case_id: caseId, has_evidence: Boolean(input.evidenceReference), has_proposal: Boolean(input.proposedMatch) },
        },
      });
    });
    return this.getForMerchant(auth, caseId);
  }

  async listForPlatform(filter: { merchantId?: string; environment?: RuntimeEnvironment; status?: SupportCaseStatus; limit: number }) {
    const cases = await this.prisma.merchantSupportCase.findMany({
      where: { ...(filter.merchantId ? { merchantId: filter.merchantId } : {}), ...(filter.environment ? { environment: filter.environment } : {}), ...(filter.status ? { status: filter.status } : {}) },
      include: {
        merchant: { select: { id: true, slug: true, name: true } },
        createdBy: { select: { id: true, displayName: true } },
        assignedStaff: { select: { id: true, displayName: true } },
        _count: { select: { messages: true } },
      },
      orderBy: { updatedAt: 'desc' },
      take: filter.limit,
    });
    return cases.map(serializeCase);
  }

  async getForPlatform(caseId: string) {
    const item = await this.prisma.merchantSupportCase.findUnique({
      where: { id: caseId },
      include: {
        merchant: { select: { id: true, slug: true, name: true } },
        createdBy: { select: { id: true, displayName: true } },
        assignedStaff: { select: { id: true, displayName: true } },
        messages: {
          include: {
            authorMerchantUser: { select: { id: true, displayName: true } },
            authorPlatformStaff: { select: { id: true, displayName: true } },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!item) throw new ApiException('support_case_not_found', 'Support case was not found', HttpStatus.NOT_FOUND);
    return serializeCase(item);
  }

  async addPlatformMessage(auth: PlatformAuthContext, caseId: string, rawInput: SupportMessageInput) {
    const supportCase = await this.prisma.merchantSupportCase.findUnique({ where: { id: caseId }, select: { id: true, merchantId: true, status: true } });
    if (!supportCase) throw new ApiException('support_case_not_found', 'Support case was not found', HttpStatus.NOT_FOUND);
    if (supportCase.status === 'closed') throw new ApiException('support_case_closed', 'Reopen the case before adding another message', HttpStatus.CONFLICT);
    const input = cleanMessage(rawInput);
    await this.prisma.$transaction(async (transaction) => {
      const claim = await transaction.merchantSupportCase.updateMany({
        where: { id: caseId, status: { not: 'closed' } },
        data: { updatedAt: new Date(), assignedStaffId: auth.staffId },
      });
      if (claim.count !== 1) throw new ApiException('support_case_closed', 'Reopen the case before adding another message', HttpStatus.CONFLICT);
      const message = await transaction.supportCaseMessage.create({
        data: { caseId, authorPlatformStaffId: auth.staffId, body: input.message, evidenceReference: input.evidenceReference, proposal: input.proposedMatch },
      });
      await transaction.auditLog.create({
        data: {
          merchantId: supportCase.merchantId,
          actorType: 'platform_staff',
          actorId: auth.staffId,
          action: 'support_case.platform_message_added',
          targetType: 'support_case_message',
          targetId: message.id,
          metadata: { case_id: caseId, has_evidence: Boolean(input.evidenceReference), has_proposal: Boolean(input.proposedMatch) },
        },
      });
    });
    return this.getForPlatform(caseId);
  }

  async changeWorkflowStatus(auth: PlatformAuthContext, caseId: string, status: SupportCaseStatus, reason: string) {
    const supportCase = await this.prisma.merchantSupportCase.findUnique({ where: { id: caseId } });
    if (!supportCase) throw new ApiException('support_case_not_found', 'Support case was not found', HttpStatus.NOT_FOUND);
    if (supportCase.status !== status && !WORKFLOW_TRANSITIONS[supportCase.status].has(status)) {
      throw new ApiException('invalid_support_case_transition', `Cannot move a support case from ${supportCase.status} to ${status}`, HttpStatus.CONFLICT);
    }
    await this.prisma.$transaction(async (transaction) => {
      const claim = await transaction.merchantSupportCase.updateMany({
        where: { id: caseId, status: supportCase.status },
        data: {
          status,
          workflowNote: cleanText(reason),
          assignedStaffId: auth.staffId,
          resolvedAt: status === 'resolved' || status === 'closed' ? new Date() : null,
        },
      });
      if (claim.count !== 1) throw new ApiException('support_case_changed', 'Support case changed while this update was being applied', HttpStatus.CONFLICT);
      await transaction.auditLog.create({
        data: {
          merchantId: supportCase.merchantId,
          actorType: 'platform_staff',
          actorId: auth.staffId,
          action: 'support_case.workflow_status_changed',
          targetType: 'merchant_support_case',
          targetId: caseId,
          reason: cleanText(reason),
          metadata: { from: supportCase.status, to: status, financial_resolution_performed: false },
        },
      });
    });
    return this.getForPlatform(caseId);
  }
}
