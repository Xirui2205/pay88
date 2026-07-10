import { Body, Controller, Get, HttpStatus, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { RequestWithContext } from '../common/request-context';
import { success } from '../common/envelope';
import { ZodPipe } from '../common/zod.pipe';
import { PrismaService } from '../infra/prisma.service';
import { comparePersonNames } from '../parsers/name-normalizer';
import { OpenClawGuard } from './openclaw.guard';
import { ApiException } from '../common/api-exception';

const namesSchema = z.object({ expectedName: z.string().min(1).max(160), observedName: z.string().min(1).max(160) });
const proposalSchema = z.object({
  caseId: z.string().uuid(),
  proposalType: z.enum(['approve_name_match', 'request_balance_refresh', 'quarantine_device', 'request_manual_reconciliation']),
  rationale: z.string().min(10).max(2000),
});

@Controller('internal/ai')
@UseGuards(OpenClawGuard)
export class AdvisoryController {
  constructor(private readonly prisma: PrismaService) {}

  @Post('name-review')
  nameCheck(@Req() request: RequestWithContext, @Body(new ZodPipe(namesSchema)) body: z.infer<typeof namesSchema>) {
    return success(request, comparePersonNames(body.expectedName, body.observedName), 'Deterministic name comparison completed');
  }

  @Get('fleet-summary')
  async fleetSummary(
    @Req() request: RequestWithContext,
    @Query('merchantId') merchantId?: string,
    @Query('groupId') groupId?: string,
  ) {
    const deviceWhere = {
      ...(groupId ? { groupId } : {}),
      ...(merchantId ? { group: { merchants: { some: { merchantId } } } } : {}),
    };
    const simWhere = { device: deviceWhere };
    const [devices, sims] = await Promise.all([
      this.prisma.device.groupBy({ by: ['status'], where: deviceWhere, _count: true }),
      this.prisma.simWallet.aggregate({ where: simWhere, _count: true, _sum: { mainBalanceMinor: true, reservedBalanceMinor: true } }),
    ]);
    return success(request, {
      devices: Object.fromEntries(devices.map((item) => [item.status, item._count])),
      sim_count: sims._count,
      main_balance_minor: (sims._sum.mainBalanceMinor ?? 0n).toString(),
      reserved_minor: (sims._sum.reservedBalanceMinor ?? 0n).toString(),
    });
  }

  @Get('cases/:caseId')
  async caseDetail(@Req() request: RequestWithContext, @Param('caseId') caseId: string) {
    const item = await this.prisma.reconciliationCase.findUnique({
      where: { id: caseId },
      select: { id: true, type: true, status: true, referenceType: true, referenceId: true, evidence: true, proposal: true, resolution: true, createdAt: true, updatedAt: true },
    });
    if (!item) throw new ApiException('not_found', 'Case was not found', HttpStatus.NOT_FOUND);
    return success(request, {
      ...item,
      evidence: redactAdvisoryValue(item.evidence),
      proposal: redactAdvisoryValue(item.proposal),
      resolution: redactAdvisoryValue(item.resolution),
    }, 'Case retrieved');
  }

  @Post('proposals')
  async propose(
    @Req() request: RequestWithContext,
    @Body(new ZodPipe(proposalSchema)) body: z.infer<typeof proposalSchema>,
  ) {
    const updated = await this.prisma.$transaction(async (transaction) => {
      const item = await transaction.reconciliationCase.findUnique({ where: { id: body.caseId } });
      if (!item) throw new ApiException('not_found', 'Case was not found', HttpStatus.NOT_FOUND);
      if (item.status !== 'open') throw new ApiException('invalid_state', 'Only an open case can receive an advisory proposal', HttpStatus.CONFLICT);
      const result = await transaction.reconciliationCase.update({
        where: { id: body.caseId },
        data: {
          status: 'proposed',
          proposal: { proposal_type: body.proposalType, rationale: body.rationale, source: 'openclaw_deepseek', execution_allowed: false },
        },
      });
      await transaction.auditLog.create({
        data: {
          actorType: 'openclaw_service',
          actorId: 'openclaw-advisory',
          action: 'advisory.proposal_created',
          targetType: 'reconciliation_case',
          targetId: result.id,
          reason: body.rationale,
          metadata: { proposal_type: body.proposalType, execution_allowed: false },
        },
      });
      return result;
    });
    return success(request, { id: updated.id, status: updated.status, proposal: updated.proposal }, 'Proposal recorded for staff approval');
  }
}

const SENSITIVE_EVIDENCE_KEY = /(body|screen|pin|secret|token|phone|name|url|link)/i;

export function redactAdvisoryValue(value: unknown, key = ''): unknown {
  if (SENSITIVE_EVIDENCE_KEY.test(key)) return '[redacted]';
  if (Array.isArray(value)) return value.map((item) => redactAdvisoryValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [entryKey, redactAdvisoryValue(entryValue, entryKey)]));
  }
  if (typeof value === 'string') {
    return value.replace(/(?:\+?251|0)?9\d{8}\b/g, (phone) => `${phone.slice(0, 3)}***${phone.slice(-3)}`);
  }
  return value;
}
