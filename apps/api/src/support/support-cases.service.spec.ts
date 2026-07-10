import { describe, expect, it, vi } from 'vitest';
import type { PortalAuthContext } from '../auth/auth.types';
import type { PlatformAuthContext } from '../admin/admin-auth.types';
import { SupportCasesService } from './support-cases.service';

const merchantAuth: PortalAuthContext = {
  sessionId: '00000000-0000-4000-8000-000000000001',
  userId: '00000000-0000-4000-8000-000000000002',
  merchantId: '00000000-0000-4000-8000-000000000003',
  merchantSlug: 'merchant-a',
  merchantName: 'Merchant A',
  email: 'support@merchant.example',
  displayName: 'Merchant Support',
  role: 'support',
};

const platformAuth: PlatformAuthContext = {
  kind: 'session',
  sessionId: '00000000-0000-4000-8000-000000000004',
  staffId: '00000000-0000-4000-8000-000000000005',
  email: 'operator@platform.example',
  displayName: 'Platform Operator',
  role: 'operator',
};

const now = new Date('2026-07-10T10:00:00.000Z');
const baseCase = {
  id: '00000000-0000-4000-8000-000000000006',
  merchantId: merchantAuth.merchantId,
  environment: 'live' as const,
  category: 'withdrawal_outcome' as const,
  status: 'open' as const,
  subject: 'Unknown withdrawal outcome',
  reference: 'WD-100',
  createdByUserId: merchantAuth.userId,
  assignedStaffId: null,
  workflowNote: null,
  createdAt: now,
  updatedAt: now,
  resolvedAt: null,
};

describe('SupportCasesService', () => {
  it('always tenant-scopes merchant reads and returns not-found across tenant boundaries', async () => {
    const findFirst = vi.fn(async () => null);
    const service = new SupportCasesService({ merchantSupportCase: { findFirst } } as never);
    await expect(service.getForMerchant(merchantAuth, baseCase.id)).rejects.toMatchObject({ code: 'support_case_not_found' });
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: baseCase.id, merchantId: merchantAuth.merchantId },
    }));
  });

  it('lets merchant support attach evidence and a proposal without changing financial state', async () => {
    const messageCreate = vi.fn(async ({ data }) => ({ id: 'message-id', ...data }));
    const auditCreate = vi.fn(async () => ({}));
    const transaction = {
      merchantSupportCase: { create: vi.fn(async () => baseCase) },
      supportCaseMessage: { create: messageCreate },
      auditLog: { create: auditCreate },
    };
    const prisma = {
      $transaction: vi.fn(async (callback) => callback(transaction)),
      merchantSupportCase: {
        findFirst: vi.fn(async () => ({ ...baseCase, createdBy: { id: merchantAuth.userId, displayName: merchantAuth.displayName }, assignedStaff: null, messages: [] })),
      },
    };
    const service = new SupportCasesService(prisma as never);
    const result = await service.createForMerchant(merchantAuth, {
      environment: 'live',
      category: 'withdrawal_outcome',
      subject: ' Unknown withdrawal outcome ',
      reference: ' WD-100 ',
      message: ' Customer supplied a receipt. ',
      evidenceReference: ' evidence://merchant/receipt-1 ',
      proposedMatch: { kind: 'provider_transaction', reference: ' TX-700 ', explanation: ' Same amount and timestamp. ' },
    });

    expect(messageCreate).toHaveBeenCalledWith({ data: expect.objectContaining({
      body: 'Customer supplied a receipt.',
      evidenceReference: 'evidence://merchant/receipt-1',
      proposal: { kind: 'provider_transaction', reference: 'TX-700', explanation: 'Same amount and timestamp.' },
    }) });
    expect(auditCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'support_case.created', merchantId: merchantAuth.merchantId }) });
    expect(result.financial_resolution_performed).toBe(false);
  });

  it('audits platform workflow resolution explicitly as non-financial', async () => {
    const auditCreate = vi.fn(async () => ({}));
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const transaction = { merchantSupportCase: { updateMany }, auditLog: { create: auditCreate } };
    const prisma = {
      merchantSupportCase: {
        findUnique: vi.fn()
          .mockResolvedValueOnce({ ...baseCase, status: 'investigating' })
          .mockResolvedValueOnce({
            ...baseCase,
            status: 'resolved',
            workflowNote: 'Provider evidence reviewed.',
            resolvedAt: now,
            merchant: { id: merchantAuth.merchantId, slug: 'merchant-a', name: 'Merchant A' },
            createdBy: null,
            assignedStaff: { id: platformAuth.staffId, displayName: platformAuth.displayName },
            messages: [],
          }),
      },
      $transaction: vi.fn(async (callback) => callback(transaction)),
    };
    const service = new SupportCasesService(prisma as never);
    const result = await service.changeWorkflowStatus(platformAuth, baseCase.id, 'resolved', 'Provider evidence reviewed.');

    expect(updateMany).toHaveBeenCalledWith({ where: { id: baseCase.id, status: 'investigating' }, data: expect.objectContaining({ status: 'resolved', assignedStaffId: platformAuth.staffId }) });
    expect(auditCreate).toHaveBeenCalledWith({ data: expect.objectContaining({
      action: 'support_case.workflow_status_changed',
      metadata: { from: 'investigating', to: 'resolved', financial_resolution_performed: false },
    }) });
    expect(result.financial_resolution_performed).toBe(false);
  });

  it('rejects unbounded workflow transitions', async () => {
    const service = new SupportCasesService({ merchantSupportCase: { findUnique: vi.fn(async () => ({ ...baseCase, status: 'closed' })) } } as never);
    await expect(service.changeWorkflowStatus(platformAuth, baseCase.id, 'resolved', 'Attempting invalid closed transition.')).rejects.toMatchObject({ code: 'invalid_support_case_transition' });
  });
});
