import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { Prisma } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../infra/prisma.service';

export type AlertType =
  | 'device_offline'
  | 'stale_balance'
  | 'wallet_high_water'
  | 'low_liquidity'
  | 'daily_limit_risk'
  | 'unknown_payout'
  | 'unmatched_receipt'
  | 'reconciliation_drift'
  | 'webhook_backlog'
  | 'openclaw_failure';

const allAlertTypes: AlertType[] = [
  'device_offline', 'stale_balance', 'wallet_high_water', 'low_liquidity', 'daily_limit_risk',
  'unknown_payout', 'unmatched_receipt', 'reconciliation_drift', 'webhook_backlog', 'openclaw_failure',
];

interface TelegramConfiguration {
  chat_id: string;
  enabled_types: string[];
}

@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async notify(type: AlertType, message: string, metadata: Record<string, string | number | boolean | null> = {}): Promise<void> {
    const safeMetadata = redactMetadata(metadata);
    const dedupeKey = createHash('sha256').update(`${type}:${JSON.stringify(safeMetadata)}`).digest('hex');
    const configuration = await this.configuration();
    const alert = await this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`alert:${dedupeKey}`}))`;
      const existing = await transaction.operationalAlert.findFirst({
        where: { dedupeKey, status: { in: ['open', 'acknowledged'] } },
        orderBy: { createdAt: 'desc' },
      });
      if (existing) return null;
      const created = await transaction.operationalAlert.create({
        data: {
          type,
          severity: ['unknown_payout', 'reconciliation_drift'].includes(type) ? 'critical' : 'warning',
          message: message.slice(0, 1000),
          dedupeKey,
          metadata: safeMetadata as Prisma.InputJsonValue,
        },
      });
      await transaction.auditLog.create({
        data: {
          actorType: 'system',
          actorId: 'alert-engine',
          action: `alert.${type}`,
          targetType: 'operational_alert',
          targetId: created.id,
          reason: created.message,
          metadata: safeMetadata as Prisma.InputJsonValue,
        },
      });
      const enabled = configuration.enabled_types.includes('*') || configuration.enabled_types.includes(type);
      if (enabled && process.env.TELEGRAM_BOT_TOKEN && configuration.chat_id) {
        await transaction.alertDelivery.create({
          data: { alertId: created.id, channel: 'telegram', destination: configuration.chat_id },
        });
      }
      return created;
    });
    if (alert) void this.dispatchPending(1).catch((error) => this.logger.error(`Alert dispatch failed: ${(error as Error).message}`));
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async retryPending(): Promise<void> {
    await this.dispatchPending(100);
  }

  async dispatchPending(limit = 100): Promise<number> {
    const cutoff = new Date(Date.now() - 24 * 60 * 60_000);
    const candidates = await this.prisma.alertDelivery.findMany({
      where: {
        createdAt: { gte: cutoff },
        OR: [
          { status: { in: ['pending', 'failed'] }, nextAttemptAt: { lte: new Date() } },
          { status: 'processing', leaseExpiresAt: { lt: new Date() } },
        ],
      },
      orderBy: { nextAttemptAt: 'asc' },
      take: limit,
      select: { id: true },
    });
    let claimed = 0;
    for (const candidate of candidates) {
      const leaseToken = randomBytes(24).toString('hex');
      const leaseExpiresAt = new Date(Date.now() + 30_000);
      const claim = await this.prisma.alertDelivery.updateMany({
        where: {
          id: candidate.id,
          OR: [
            { status: { in: ['pending', 'failed'] }, nextAttemptAt: { lte: new Date() } },
            { status: 'processing', leaseExpiresAt: { lt: new Date() } },
          ],
        },
        data: { status: 'processing', leaseToken, leaseExpiresAt, attempt: { increment: 1 } },
      });
      if (claim.count !== 1) continue;
      claimed += 1;
      await this.deliver(candidate.id, leaseToken);
    }
    return claimed;
  }

  async configureTelegram(input: TelegramConfiguration, actorId: string, reason: string) {
    const normalized = {
      chat_id: input.chat_id.trim(),
      enabled_types: [...new Set(input.enabled_types)].filter((type) => type === '*' || allAlertTypes.includes(type as AlertType)),
    };
    const current = await this.prisma.platformSetting.findUnique({ where: { key: 'alerts.telegram' } });
    const setting = await this.prisma.$transaction(async (transaction) => {
      const updated = await transaction.platformSetting.upsert({
        where: { key: 'alerts.telegram' },
        update: { value: normalized, version: { increment: 1 }, updatedBy: actorId },
        create: { key: 'alerts.telegram', value: normalized, updatedBy: actorId },
      });
      await transaction.auditLog.create({
        data: {
          actorType: 'platform_staff', actorId, action: 'alerts.configuration_updated', targetType: 'platform_setting',
          targetId: 'alerts.telegram', reason, metadata: { previous_version: current?.version ?? 0, version: updated.version, enabled_types: normalized.enabled_types },
        },
      });
      return updated;
    });
    return { ...normalized, version: setting.version, bot_token_configured: Boolean(process.env.TELEGRAM_BOT_TOKEN) };
  }

  async acknowledge(id: string, actorId: string, reason: string) {
    return this.transition(id, 'acknowledged', actorId, reason);
  }

  async resolve(id: string, actorId: string, reason: string) {
    return this.transition(id, 'resolved', actorId, reason);
  }

  async recent() {
    const [rows, configuration] = await Promise.all([
      this.prisma.operationalAlert.findMany({ include: { deliveries: { orderBy: { createdAt: 'desc' } } }, orderBy: { createdAt: 'desc' }, take: 100 }),
      this.configuration(),
    ]);
    return {
      telegram_configured: Boolean(process.env.TELEGRAM_BOT_TOKEN && configuration.chat_id),
      chat_id: configuration.chat_id,
      enabled_types: configuration.enabled_types,
      alerts: rows.map((row) => ({
        id: row.id, type: row.type, severity: row.severity, status: row.status, message: row.message, metadata: row.metadata,
        created_at: row.createdAt.toISOString(), acknowledged_at: row.acknowledgedAt?.toISOString() ?? null, resolved_at: row.resolvedAt?.toISOString() ?? null,
        deliveries: row.deliveries.map((delivery) => ({ channel: delivery.channel, status: delivery.status, attempt: delivery.attempt, last_error: delivery.lastError, delivered_at: delivery.deliveredAt?.toISOString() ?? null })),
      })),
    };
  }

  private async configuration(): Promise<TelegramConfiguration> {
    const stored = await this.prisma.platformSetting.findUnique({ where: { key: 'alerts.telegram' } });
    const value = stored?.value && typeof stored.value === 'object' && !Array.isArray(stored.value)
      ? stored.value as Record<string, unknown>
      : {};
    return {
      chat_id: typeof value.chat_id === 'string' ? value.chat_id : (process.env.TELEGRAM_CHAT_ID ?? ''),
      enabled_types: Array.isArray(value.enabled_types)
        ? value.enabled_types.filter((item): item is string => typeof item === 'string')
        : (process.env.TELEGRAM_ALERT_TYPES ?? '*').split(',').map((item) => item.trim()),
    };
  }

  private async deliver(id: string, leaseToken: string): Promise<void> {
    const delivery = await this.prisma.alertDelivery.findFirst({ where: { id, leaseToken, status: 'processing' }, include: { alert: true } });
    if (!delivery) return;
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      await this.failDelivery(delivery.id, leaseToken, delivery.attempt, 'Telegram bot token is not configured');
      return;
    }
    const details = Object.entries(delivery.alert.metadata as Record<string, unknown>).map(([key, value]) => `${key}=${String(value)}`).join(' ');
    const text = `[${delivery.alert.type.toUpperCase()}] ${delivery.alert.message}${details ? `\n${details}` : ''}`.slice(0, 3900);
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: delivery.destination, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Telegram returned HTTP ${response.status}`);
      await this.prisma.alertDelivery.updateMany({
        where: { id, leaseToken, status: 'processing' },
        data: { status: 'delivered', deliveredAt: new Date(), leaseToken: null, leaseExpiresAt: null, lastError: null },
      });
    } catch (error) {
      await this.failDelivery(delivery.id, leaseToken, delivery.attempt, (error as Error).message);
    }
  }

  private async failDelivery(id: string, leaseToken: string, attempt: number, error: string): Promise<void> {
    const delaySeconds = Math.min(3600, 15 * 2 ** Math.min(attempt, 8));
    await this.prisma.alertDelivery.updateMany({
      where: { id, leaseToken, status: 'processing' },
      data: { status: 'failed', nextAttemptAt: new Date(Date.now() + delaySeconds * 1000), leaseToken: null, leaseExpiresAt: null, lastError: error.slice(0, 1000) },
    });
  }

  private async transition(id: string, status: 'acknowledged' | 'resolved', actorId: string, reason: string) {
    const existing = await this.prisma.operationalAlert.findUnique({ where: { id } });
    if (!existing) return null;
    const now = new Date();
    const updated = await this.prisma.operationalAlert.update({
      where: { id },
      data: status === 'acknowledged'
        ? { status, acknowledgedBy: actorId, acknowledgedAt: now }
        : { status, resolvedBy: actorId, resolvedAt: now },
    });
    await this.prisma.auditLog.create({
      data: { actorType: 'platform_staff', actorId, action: `alert.${status}`, targetType: 'operational_alert', targetId: id, reason },
    });
    return { id: updated.id, status: updated.status };
  }
}

export function redactMetadata(metadata: Record<string, string | number | boolean | null>): Record<string, string | number | boolean | null> {
  return Object.fromEntries(Object.entries(metadata).map(([key, value]) => {
    if (/pin|secret|token|raw|body/i.test(key)) return [key, '[REDACTED]'];
    if (/phone|number/i.test(key) && typeof value === 'string') return [key, `${value.slice(0, 3)}***${value.slice(-2)}`];
    return [key, value];
  }));
}
