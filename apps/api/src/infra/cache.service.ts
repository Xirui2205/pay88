import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';

interface LocalValue {
  value: string;
  expiresAt?: number;
}

@Injectable()
export class CacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CacheService.name);
  private readonly local = new Map<string, LocalValue>();
  private redis?: Redis;

  async onModuleInit(): Promise<void> {
    if (!process.env.REDIS_URL) {
      if (process.env.NODE_ENV === 'production') throw new Error('REDIS_URL is required in production');
      return;
    }
    const redis = new Redis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
    try {
      await redis.connect();
      this.redis = redis;
    } catch (error) {
      redis.disconnect();
      if (process.env.NODE_ENV === 'production') throw new Error(`Redis is unavailable: ${(error as Error).message}`);
      this.logger.warn(`Redis unavailable; using process-local fallback: ${(error as Error).message}`);
    }
  }

  async get(key: string): Promise<string | null> {
    if (this.redis) return this.redis.get(key);
    const found = this.local.get(key);
    if (!found) return null;
    if (found.expiresAt && found.expiresAt <= Date.now()) {
      this.local.delete(key);
      return null;
    }
    return found.value;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (this.redis) {
      if (ttlSeconds) await this.redis.set(key, value, 'EX', ttlSeconds);
      else await this.redis.set(key, value);
      return;
    }
    this.local.set(key, { value, expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined });
  }

  async delete(key: string): Promise<void> {
    if (this.redis) await this.redis.del(key);
    else this.local.delete(key);
  }

  async increment(key: string, ttlSeconds: number): Promise<number> {
    if (this.redis) {
      const value = await this.redis.incr(key);
      if (value === 1) await this.redis.expire(key, ttlSeconds);
      return value;
    }
    const found = this.local.get(key);
    const current = found && (!found.expiresAt || found.expiresAt > Date.now()) ? Number(found.value) : 0;
    const next = current + 1;
    this.local.set(key, { value: String(next), expiresAt: Date.now() + ttlSeconds * 1000 });
    return next;
  }

  async isReady(): Promise<boolean> {
    if (!this.redis) return process.env.NODE_ENV !== 'production';
    try { return await this.redis.ping() === 'PONG'; } catch { return false; }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.redis) await this.redis.quit();
  }
}
