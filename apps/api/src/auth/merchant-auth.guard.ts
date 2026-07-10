import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import argon2 from 'argon2';
import { ApiException } from '../common/api-exception';
import { PrismaService } from '../infra/prisma.service';
import type { MerchantRequest } from './auth.types';
import { CacheService } from '../infra/cache.service';
import { sha256 } from '../common/crypto';

@Injectable()
export class MerchantAuthGuard implements CanActivate {
  private readonly activeVerifications = new Map<string, Promise<boolean>>();

  constructor(private readonly prisma: PrismaService, private readonly cache: CacheService) {}

  private verifyOnce(cacheKey: string, secretHash: string, rawKey: string): Promise<boolean> {
    const active = this.activeVerifications.get(cacheKey);
    if (active) return active;

    const verification = argon2.verify(secretHash, rawKey).finally(() => {
      this.activeVerifications.delete(cacheKey);
    });
    this.activeVerifications.set(cacheKey, verification);
    return verification;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<MerchantRequest>();
    const authorization = request.header('authorization');
    if (!authorization?.startsWith('Bearer ')) {
      throw new ApiException('unauthorized', 'A bearer API key is required', HttpStatus.UNAUTHORIZED);
    }

    const rawKey = authorization.slice(7).trim();
    const [prefix] = rawKey.split('.', 1);
    const environment = prefix.startsWith('sk_test_') ? 'test' : prefix.startsWith('sk_live_') ? 'live' : null;
    if (!environment || !rawKey.includes('.')) {
      throw new ApiException('unauthorized', 'The API key format is invalid', HttpStatus.UNAUTHORIZED);
    }

    const key = await this.prisma.apiKey.findUnique({
      where: { prefix },
      include: { merchant: true },
    });
    if (
      !key ||
      key.revokedAt ||
      key.environment !== environment ||
      key.merchant.status !== 'active'
    ) {
      throw new ApiException('unauthorized', 'The API key is invalid or revoked', HttpStatus.UNAUTHORIZED);
    }

    // Argon2 is deliberately expensive. Cache only a successful verification while
    // still loading the key above on every request so revocation and merchant status
    // changes remain immediate. Unknown/revoked prefixes never reach Argon2.
    const rawKeyFingerprint = sha256(rawKey);
    const verificationCacheKey = `merchant-api-auth-ok:${key.id}:${rawKeyFingerprint}`;
    const expectedCacheStamp = sha256(key.secretHash);
    if ((await this.cache.get(verificationCacheKey)) !== expectedCacheStamp) {
      const verificationKey = `${key.id}:${rawKeyFingerprint}`;
      const activeVerification = this.activeVerifications.get(verificationKey);
      let verified: boolean;
      if (activeVerification) {
        // A cold-cache burst for the same credential shares one expensive hash.
        verified = await activeVerification;
      } else {
        const attemptLimit = Math.max(1, Number.parseInt(process.env.MERCHANT_API_AUTH_ATTEMPTS_PER_MINUTE ?? '60', 10) || 60);
        const bucket = Math.floor(Date.now() / 60_000);
        const sourceIp = request.ip || request.socket?.remoteAddress || 'unknown';
        const sourceAndPrefix = sha256(`${sourceIp}\0${prefix}`).slice(0, 32);
        if (await this.cache.increment(`merchant-api-auth-attempt:${sourceAndPrefix}:${bucket}`, 120) > attemptLimit) {
          throw new ApiException('rate_limited', 'API key authentication rate limit exceeded', HttpStatus.TOO_MANY_REQUESTS);
        }
        verified = await this.verifyOnce(verificationKey, key.secretHash, rawKey);
      }
      if (!verified) {
        throw new ApiException('unauthorized', 'The API key is invalid or revoked', HttpStatus.UNAUTHORIZED);
      }
      const cacheSeconds = Math.max(1, Number.parseInt(process.env.MERCHANT_API_AUTH_CACHE_SECONDS ?? '300', 10) || 300);
      await this.cache.set(verificationCacheKey, expectedCacheStamp, cacheSeconds);
    }

    request.auth = { merchantId: key.merchantId, environment, apiKeyId: key.id };
    const limit = Math.max(1, Number.parseInt(process.env.MERCHANT_API_RATE_LIMIT_PER_MINUTE ?? '2000', 10) || 2000);
    const bucket = Math.floor(Date.now() / 60_000);
    if (await this.cache.increment(`merchant-api-rate:${key.id}:${bucket}`, 120) > limit) {
      throw new ApiException('rate_limited', 'Merchant API rate limit exceeded', HttpStatus.TOO_MANY_REQUESTS);
    }
    void this.prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } });
    return true;
  }
}
