import { EventEmitter } from 'node:events';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import amqp, { ChannelModel, ConfirmChannel, ConsumeMessage } from 'amqplib';
import { PrismaService } from './prisma.service';
import { sha256 } from '../common/crypto';
import { stringifyJsonSafe } from '../common/json-serialization';

@Injectable()
export class MessageBusService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MessageBusService.name);
  private readonly local = new EventEmitter();
  private connection?: ChannelModel;
  private channel?: ConfirmChannel;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    const url = process.env.RABBITMQ_URL ?? process.env.AMQP_URL;
    if (!url) {
      if (process.env.NODE_ENV === 'production') throw new Error('RABBITMQ_URL is required in production');
      return;
    }
    try {
      this.connection = await amqp.connect(url);
      this.channel = await this.connection.createConfirmChannel();
      await this.channel.assertExchange('telebirr.events', 'topic', { durable: true });
      await this.channel.assertQueue('telebirr.api.inbox', { durable: true, arguments: { 'x-queue-type': 'quorum' } });
      await this.channel.bindQueue('telebirr.api.inbox', 'telebirr.events', '#');
      await this.channel.prefetch(50);
      await this.channel.consume('telebirr.api.inbox', (message) => { void this.consume(message); }, { noAck: false });
    } catch (error) {
      await this.connection?.close().catch(() => undefined);
      this.connection = undefined;
      this.channel = undefined;
      if (process.env.NODE_ENV === 'production') throw new Error(`RabbitMQ is unavailable: ${(error as Error).message}`);
      this.logger.warn(`RabbitMQ unavailable; using process-local fallback: ${(error as Error).message}`);
    }
  }

  async publish(topic: string, payload: unknown): Promise<void> {
    const serializedText = stringifyJsonSafe(payload);
    const serialized = Buffer.from(serializedText);
    if (this.channel) {
      this.channel.publish('telebirr.events', topic, serialized, {
        persistent: true,
        contentType: 'application/json',
        messageId: typeof payload === 'object' && payload && 'id' in payload ? String(payload.id) : undefined,
      });
      await this.channel.waitForConfirms();
      return;
    }
    // Match the RabbitMQ JSON round-trip in local fallback mode so tests and
    // development never observe native BigInts that production cannot carry.
    const normalizedPayload = JSON.parse(serializedText) as unknown;
    queueMicrotask(() => this.local.emit(topic, normalizedPayload));
  }

  subscribeLocal(topic: string, handler: (payload: unknown) => void): () => void {
    this.local.on(topic, handler);
    return () => this.local.off(topic, handler);
  }

  async isReady(): Promise<boolean> {
    if (!this.channel) return process.env.NODE_ENV !== 'production';
    try {
      await this.channel.checkExchange('telebirr.events');
      await this.channel.checkQueue('telebirr.api.inbox');
      return true;
    } catch { return false; }
  }

  private async consume(message: ConsumeMessage | null): Promise<void> {
    if (!message || !this.channel) return;
    const raw = message.content.toString('utf8');
    const externalId = message.properties.messageId || sha256(`${message.fields.routingKey}:${raw}`);
    try {
      const inserted = await this.prisma.inboxEvent.createMany({
        data: [{ source: 'rabbitmq', externalId, payloadHash: sha256(raw) }],
        skipDuplicates: true,
      });
      if (inserted.count === 1) {
        const payload = JSON.parse(raw) as unknown;
        this.local.emit(message.fields.routingKey, payload);
      }
      this.channel.ack(message);
    } catch (error) {
      this.logger.error(`RabbitMQ inbox processing failed: ${(error as Error).message}`);
      this.channel.nack(message, false, true);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.channel?.close().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
  }
}
