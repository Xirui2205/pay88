import { HttpStatus, Injectable } from '@nestjs/common';
import type { Prisma, SettlementRequest, Transfer } from '@prisma/client';
import { amountToMinor, minorToAmount, type CreateSettlementInput, type CreateTransferInput } from '@telebirr/contracts';
import type { MerchantAuthContext } from '../auth/auth.types';
import { ApiException } from '../common/api-exception';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { PrismaService } from '../infra/prisma.service';
import { WithdrawalsService } from '../withdrawals/withdrawals.service';

type SettlementWithTransfer = SettlementRequest & { transfer: Transfer | null };

@Injectable()
export class SettlementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly idempotency: IdempotencyService,
    private readonly withdrawals: WithdrawalsService,
  ) {}

  async request(auth: MerchantAuthContext, input: CreateSettlementInput, idempotencyKey: string) {
    return (
      await this.idempotency.execute({
        auth,
        operation: 'settlements.create',
        key: idempotencyKey,
        referenceKey: input.reference,
        payload: input,
        execute: async (transaction) => {
          const settlement = await transaction.settlementRequest.create({
            data: {
              merchantId: auth.merchantId,
              environment: auth.environment,
              reference: input.reference,
              destinationPhone: input.account_number,
              expectedName: input.expected_name,
              amountMinor: amountToMinor(input.amount),
              requestedBy: auth.apiKeyId,
            },
            include: { transfer: true },
          });
          await transaction.outboxEvent.create({
            data: {
              aggregateType: 'settlement',
              aggregateId: settlement.id,
              eventType: 'settlement.updated',
              payload: { reference: settlement.reference, status: 'pending', p2p_status: 'requested' },
            },
          });
          await transaction.auditLog.create({
            data: {
              merchantId: auth.merchantId,
              actorType: 'merchant_api_key',
              actorId: auth.apiKeyId,
              action: 'settlement.request',
              targetType: 'settlement',
              targetId: settlement.id,
              metadata: {
                requested_by: auth.apiKeyId,
                request_metadata: JSON.parse(JSON.stringify(input.metadata ?? {})) as Prisma.InputJsonValue,
              },
            },
          });
          return this.view(settlement);
        },
      })
    ).result;
  }

  async get(auth: MerchantAuthContext, reference: string) {
    const settlement = await this.prisma.settlementRequest.findUnique({
      where: { merchantId_environment_reference: { merchantId: auth.merchantId, environment: auth.environment, reference } },
      include: { transfer: true },
    });
    if (!settlement) throw new ApiException('not_found', 'Settlement request was not found', HttpStatus.NOT_FOUND);
    return this.view(settlement);
  }

  async list(auth: MerchantAuthContext) {
    const settlements = await this.prisma.settlementRequest.findMany({
      where: { merchantId: auth.merchantId, environment: auth.environment },
      include: { transfer: true },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return settlements.map((settlement) => this.view(settlement));
  }

  async listForAdmin(status?: string) {
    const allowed = ['requested', 'approved', 'rejected', 'dispatched', 'success', 'failed', 'unknown', 'manual_review'];
    if (status && !allowed.includes(status)) throw new ApiException('validation_error', 'Invalid settlement status', HttpStatus.BAD_REQUEST);
    const settlements = await this.prisma.settlementRequest.findMany({
      where: status ? { status: status as SettlementRequest['status'] } : undefined,
      include: { transfer: true, merchant: { select: { name: true, slug: true } } },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    return settlements.map((settlement) => ({
      ...this.view(settlement),
      merchant: settlement.merchant,
    }));
  }

  async approve(id: string, reason: string, reviewer = 'platform-admin') {
    return this.prisma.$transaction(
      async (transaction) => {
        await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`settlement:${id}`}))`;
        const settlement = await transaction.settlementRequest.findUnique({ where: { id }, include: { transfer: true } });
        if (!settlement) throw new ApiException('not_found', 'Settlement request was not found', HttpStatus.NOT_FOUND);
        if (settlement.transfer && ['approved', 'dispatched', 'success', 'failed', 'unknown', 'manual_review'].includes(settlement.status)) {
          return this.view(settlement);
        }
        if (!canReviewSettlement(settlement.status)) {
          throw new ApiException('invalid_state', 'Settlement has already been reviewed', HttpStatus.CONFLICT);
        }
        await transaction.settlementRequest.update({
          where: { id },
          data: { status: 'approved', reviewedBy: reviewer, reviewReason: reason, reviewedAt: new Date() },
        });
        const transferInput: CreateTransferInput = {
          // Public settlement references may use all 128 allowed characters.
          // Use the immutable UUID internally so the SET: prefix cannot
          // overflow the transfer reference column.
          reference: settlementTransferReference(settlement.id),
          account_number: settlement.destinationPhone,
          expected_name: settlement.expectedName,
          customer_id: 'merchant-settlement',
          destination_type: 'registered',
          amount: minorToAmount(settlement.amountMinor),
          currency: 'ETB',
          bank_code: '855',
          metadata: { intent_type: 'merchant_settlement', settlement_id: settlement.id },
        };
        const transfer = await this.withdrawals.queueTransfer(
          transaction,
          { merchantId: settlement.merchantId, environment: settlement.environment },
          transferInput,
          { operationKind: 'merchant_settlement', financialMode: 'merchant_debit', priority: 300 },
        );
        const status = transfer.status === 'success' ? 'success' : transfer.status === 'failed' ? 'failed' : transfer.status === 'unknown' ? 'unknown' : 'dispatched';
        const updated = await transaction.settlementRequest.update({
          where: { id },
          data: { transferId: transfer.id, status },
          include: { transfer: true },
        });
        await transaction.auditLog.create({
          data: { merchantId: settlement.merchantId, actorType: 'platform_admin', actorId: reviewer, action: 'settlement.approve', targetType: 'settlement', targetId: id, reason },
        });
        await transaction.outboxEvent.create({
          data: { aggregateType: 'settlement', aggregateId: id, eventType: 'settlement.updated', payload: { reference: settlement.reference, status: status === 'failed' ? 'failed' : status === 'success' ? 'success' : 'pending', p2p_status: status } },
        });
        return this.view(updated);
      },
      { isolationLevel: 'Serializable', timeout: 15_000 },
    );
  }

  async reject(id: string, reason: string, reviewer = 'platform-admin') {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`settlement:${id}`}))`;
      const settlement = await transaction.settlementRequest.findUnique({ where: { id } });
      if (!settlement) throw new ApiException('not_found', 'Settlement request was not found', HttpStatus.NOT_FOUND);
      if (settlement.status === 'rejected') {
        return this.view({ ...settlement, transfer: null });
      }
      if (!canReviewSettlement(settlement.status)) throw new ApiException('invalid_state', 'Settlement has already been reviewed', HttpStatus.CONFLICT);
      const updated = await transaction.settlementRequest.update({
        where: { id },
        data: { status: 'rejected', reviewedBy: reviewer, reviewReason: reason, reviewedAt: new Date() },
        include: { transfer: true },
      });
      await transaction.auditLog.create({
        data: { merchantId: settlement.merchantId, actorType: 'platform_admin', actorId: reviewer, action: 'settlement.reject', targetType: 'settlement', targetId: id, reason },
      });
      await transaction.outboxEvent.create({
        data: { aggregateType: 'settlement', aggregateId: id, eventType: 'settlement.updated', payload: { reference: settlement.reference, status: 'failed', p2p_status: 'rejected' } },
      });
      return this.view(updated);
    });
  }

  private view(settlement: SettlementWithTransfer) {
    return {
      id: settlement.id,
      reference: settlement.reference,
      amount: minorToAmount(settlement.amountMinor),
      currency: 'ETB',
      destination_phone_masked: `${settlement.destinationPhone.slice(0, 7)}****${settlement.destinationPhone.slice(-2)}`,
      expected_name: settlement.expectedName,
      status: settlement.transfer ? transferSettlementStatus(settlement.transfer.status) : settlement.status,
      transfer_reference: settlement.transfer?.reference ?? null,
      review_reason: settlement.reviewReason,
      requested_at: settlement.createdAt.toISOString(),
      reviewed_at: settlement.reviewedAt?.toISOString() ?? null,
    };
  }
}

export function canReviewSettlement(status: string): boolean {
  return status === 'requested';
}

function transferSettlementStatus(status: string): string {
  if (status === 'success' || status === 'failed' || status === 'unknown' || status === 'manual_review') return status;
  return 'dispatched';
}

export function settlementTransferReference(settlementId: string): string {
  return `SET:${settlementId}`;
}
