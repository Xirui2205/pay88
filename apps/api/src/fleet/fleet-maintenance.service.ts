import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../infra/prisma.service';
import { AlertsService } from '../alerts/alerts.service';
import { loadPlatformPolicy } from '../configuration/platform-policy';
import { CURRENT_DEVICE_PROFILE_VERSION_TEXT } from '../devices/device-profile-version';

@Injectable()
export class FleetMaintenanceService {
  constructor(private readonly prisma: PrismaService, private readonly alerts: AlertsService) {}

  @Cron(CronExpression.EVERY_30_SECONDS)
  async updateHealth(): Promise<void> {
    const now = Date.now();
    const policy = await loadPlatformPolicy(this.prisma);
    const offline = await this.prisma.device.updateMany({
      where: { status: { in: ['online', 'degraded'] }, lastHeartbeatAt: { lt: new Date(now - 3 * 60_000) } },
      data: { status: 'offline' },
    });
    const stale = await this.prisma.simWallet.updateMany({
      where: { status: 'active', OR: [{ lastBalanceAt: null }, { lastBalanceAt: { lt: new Date(now - policy.balanceStaleSeconds * 1000) } }] },
      data: { status: 'payout_stale' },
    });
    if (offline.count) await this.alerts.notify('device_offline', `${offline.count} device(s) crossed the three-minute offline threshold`, { count: offline.count });
    if (stale.count) await this.alerts.notify('stale_balance', `${stale.count} SIM balance snapshot(s) became stale`, { count: stale.count });
    await this.evaluateLiquidityRisk();
    await this.transitionDeposits(
      { status: 'awaiting_payment', expiresAt: { lte: new Date(now) }, lateGraceEndsAt: { gt: new Date(now) } },
      'late_grace',
    );
    await this.transitionDeposits(
      { status: { in: ['awaiting_payment', 'late_grace'] }, lateGraceEndsAt: { lte: new Date(now) } },
      'expired',
    );
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async queueStaleBalanceQueries(): Promise<void> {
    const sims = await this.prisma.simWallet.findMany({
      where: {
        status: { in: ['pending', 'payout_stale'] },
        device: { status: 'online', lastPermissionsOk: true, lastAccessibilityOk: true },
        jobs: { none: { type: 'balance_query', state: { in: ['queued', 'leased', 'device_started', 'committed', 'provider_pending'] } } },
      },
      include: { device: true },
      orderBy: { lastBalanceAt: 'asc' },
      take: Number(process.env.BALANCE_QUERY_RATE_PER_MINUTE ?? 10),
    });
    for (const [index, sim] of sims.entries()) {
      await this.prisma.$transaction(async (transaction) => {
        const fenced = await transaction.simWallet.update({ where: { id: sim.id }, data: { nextFencingToken: { increment: 1n } } });
        await transaction.deviceJob.create({
          data: {
            type: 'balance_query',
            priority: 100,
            deviceId: sim.deviceId,
            simWalletId: sim.id,
            profileVersion: CURRENT_DEVICE_PROFILE_VERSION_TEXT,
            payload: { sim_iccid: sim.iccid, not_before: new Date(Date.now() + index * 1000).toISOString() },
            fencingToken: fenced.nextFencingToken,
            expiresAt: new Date(Date.now() + 15 * 60_000),
          },
        });
      });
    }
  }

  private async transitionDeposits(where: Prisma.DepositIntentWhereInput, status: 'late_grace' | 'expired') {
    const deposits = await this.prisma.depositIntent.findMany({ where, select: { id: true, txRef: true, metadata: true }, take: 500 });
    for (const deposit of deposits) {
      await this.prisma.$transaction(async (transaction) => {
        const updated = await transaction.depositIntent.updateMany({
          where: { id: deposit.id, status: status === 'late_grace' ? 'awaiting_payment' : { in: ['awaiting_payment', 'late_grace'] } },
          data: { status },
        });
        if (!updated.count) return;
        const topup = Boolean(deposit.metadata && typeof deposit.metadata === 'object' && !Array.isArray(deposit.metadata) && (deposit.metadata as Record<string, unknown>)._p2p_intent_kind === 'merchant_topup');
        await transaction.outboxEvent.create({
          data: {
            aggregateType: 'deposit',
            aggregateId: deposit.id,
            eventType: topup ? 'topup.updated' : 'deposit.updated',
            payload: { tx_ref: deposit.txRef, status: status === 'expired' ? 'failed' : 'pending', p2p_status: status },
          },
        });
      });
    }
  }

  private async evaluateLiquidityRisk(): Promise<void> {
    const sims = await this.prisma.simWallet.findMany({
      where: { status: { in: ['active', 'payout_stale'] } },
      include: { device: { select: { group: { select: { id: true, walletCeilingMinor: true, safetyBalanceMinor: true, dailyLimitMinor: true } } } } },
      take: 2_000,
    });
    for (const sim of sims) {
      const group = sim.device.group;
      const available = sim.mainBalanceMinor - sim.reservedBalanceMinor;
      const stableMetadata = { sim_id: sim.id, group_id: group.id };
      if (sim.mainBalanceMinor >= group.walletCeilingMinor) {
        await this.alerts.notify('wallet_high_water', 'A SIM wallet reached its configured ceiling and may require a sweep', stableMetadata);
      }
      if (available <= group.safetyBalanceMinor) {
        await this.alerts.notify('low_liquidity', 'A SIM wallet reached its configured safety-balance threshold', stableMetadata);
      }
      if (sim.sentTodayMinor * 10n >= group.dailyLimitMinor * 9n) {
        await this.alerts.notify('daily_limit_risk', 'A SIM wallet consumed at least 90% of its daily transfer cap', stableMetadata);
      }
    }
  }
}
