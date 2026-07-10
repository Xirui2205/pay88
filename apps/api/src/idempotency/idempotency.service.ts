import { HttpStatus, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { ApiException } from '../common/api-exception';
import { sha256, stableJson } from '../common/crypto';
import { PrismaService } from '../infra/prisma.service';
import type { MerchantAuthContext } from '../auth/auth.types';

interface IdempotencyOptions<T> {
  auth: MerchantAuthContext;
  operation: string;
  key: string;
  referenceKey?: string;
  referenceOperation?: string;
  payload: unknown;
  execute: (transaction: Prisma.TransactionClient) => Promise<T>;
  storeResult?: (result: T) => Prisma.InputJsonValue;
  replayResult?: (stored: Prisma.JsonValue, transaction: Prisma.TransactionClient) => Promise<T>;
}

export function financialReferenceRetentionEnd(): Date {
  return new Date('9999-12-31T23:59:59.999Z');
}

@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  async execute<T>(options: IdempotencyOptions<T>): Promise<{ replayed: boolean; result: T }> {
    const requestHash = sha256(stableJson(options.payload));
    if (options.key.startsWith('__reference__:')) {
      throw new ApiException('validation_error', 'This idempotency-key prefix is reserved', HttpStatus.UNPROCESSABLE_ENTITY);
    }
    const recordIdentities = [
      { operation: options.operation, key: options.key },
      ...(options.referenceKey ? [{ operation: options.referenceOperation ?? options.operation, key: `__reference__:${options.referenceKey}` }] : []),
    ].filter((item, index, all) => all.findIndex((candidate) => candidate.operation === item.operation && candidate.key === item.key) === index);

    return this.prisma.$transaction(
      async (transaction) => {
        for (const identity of [...recordIdentities].sort((left, right) => `${left.operation}:${left.key}`.localeCompare(`${right.operation}:${right.key}`))) {
          const lockKey = `${options.auth.merchantId}:${options.auth.environment}:${identity.operation}:${identity.key}`;
          await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
        }
        const existing = await transaction.idempotencyRecord.findFirst({
          where: {
            merchantId: options.auth.merchantId,
            environment: options.auth.environment,
            OR: recordIdentities.map((identity) => ({ operation: identity.operation, key: identity.key })),
          },
          orderBy: { createdAt: 'asc' },
        });
        if (existing) {
          if (existing.requestHash !== requestHash) {
            throw new ApiException(
              'duplicate_reference_conflict',
              'This idempotency key was already used with a different payload',
              HttpStatus.CONFLICT,
            );
          }
          await transaction.idempotencyRecord.createMany({
            data: recordIdentities.filter((identity) => identity.operation !== existing.operation || identity.key !== existing.key).map((identity) => ({
              merchantId: options.auth.merchantId,
              environment: options.auth.environment,
              operation: identity.operation,
              key: identity.key,
              requestHash,
              responseCode: existing.responseCode,
              responseBody: existing.responseBody as Prisma.InputJsonValue,
              expiresAt: financialReferenceRetentionEnd(),
            })),
            skipDuplicates: true,
          });
          return {
            replayed: true,
            result: options.replayResult
              ? await options.replayResult(existing.responseBody, transaction)
              : existing.responseBody as T,
          };
        }

        const result = await options.execute(transaction);
        const responseBody = options.storeResult ? options.storeResult(result) : result as Prisma.InputJsonValue;
        await transaction.idempotencyRecord.createMany({
          data: recordIdentities.map((identity) => ({
            merchantId: options.auth.merchantId,
            environment: options.auth.environment,
            operation: identity.operation,
            key: identity.key,
            requestHash,
            responseCode: 200,
            responseBody,
            // Financial references are replayable for the lifetime of the
            // resource. A far-future timestamp preserves the existing schema
            // while preventing a later duplicate reference from degrading to a
            // database uniqueness error.
            expiresAt: financialReferenceRetentionEnd(),
          })),
        });
        return { replayed: false, result };
      },
      { isolationLevel: 'Serializable', timeout: 15_000 },
    );
  }
}
