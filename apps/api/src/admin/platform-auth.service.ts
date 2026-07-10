import { HttpStatus, Injectable } from '@nestjs/common';
import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import { ApiException } from '../common/api-exception';
import { sha256 } from '../common/crypto';
import { PrismaService } from '../infra/prisma.service';
import { CacheService } from '../infra/cache.service';
import type { PlatformAuthContext } from './admin-auth.types';

@Injectable()
export class PlatformAuthService {
  constructor(private readonly prisma: PrismaService, private readonly cache: CacheService) {}

  async login(input: { email: string; password: string }, requestInfo: { ip?: string; userAgent?: string }) {
    const email = input.email.trim().toLocaleLowerCase('en-US');
    const throttleKey = `auth:platform:${sha256(`${requestInfo.ip ?? 'unknown'}:${email}`).slice(0, 32)}`;
    if (await this.cache.increment(throttleKey, 600) > 8) {
      throw new ApiException('too_many_attempts', 'Too many sign-in attempts. Try again later', HttpStatus.TOO_MANY_REQUESTS);
    }
    const staff = await this.prisma.platformStaff.findUnique({ where: { email } });
    if (!staff || staff.status !== 'active' || !(await argon2.verify(staff.passwordHash, input.password))) {
      throw new ApiException('invalid_credentials', 'Email or password is invalid', HttpStatus.UNAUTHORIZED);
    }
    const token = `pas_${randomBytes(32).toString('base64url')}`;
    const expiresAt = new Date(Date.now() + 12 * 60 * 60_000);
    const session = await this.prisma.$transaction(async (transaction) => {
      const created = await transaction.platformSession.create({ data: { staffId: staff.id, tokenHash: sha256(token), expiresAt, ipAddress: requestInfo.ip?.slice(0, 64), userAgent: requestInfo.userAgent?.slice(0, 500) } });
      await transaction.platformStaff.update({ where: { id: staff.id }, data: { lastLoginAt: new Date() } });
      await transaction.auditLog.create({ data: { actorType: 'platform_staff', actorId: staff.id, action: 'admin.login', targetType: 'platform_session', targetId: created.id } });
      return created;
    });
    await this.cache.delete(throttleKey);
    return { session_token: token, expires_at: session.expiresAt.toISOString(), staff: { id: staff.id, email: staff.email, display_name: staff.displayName, role: staff.role } };
  }

  me(auth: PlatformAuthContext) {
    return { id: auth.staffId, email: auth.email, display_name: auth.displayName, role: auth.role, auth_kind: auth.kind };
  }

  async logout(auth: PlatformAuthContext) {
    if (auth.kind === 'session' && auth.sessionId) {
      await this.prisma.platformSession.updateMany({ where: { id: auth.sessionId, revokedAt: null }, data: { revokedAt: new Date() } });
    }
    return { logged_out: true };
  }

  async reauthenticate(auth: PlatformAuthContext, password: string) {
    if (auth.kind !== 'session' || !auth.sessionId) {
      throw new ApiException('reauth_not_applicable', 'Service authentication does not issue password reauthentication tokens', HttpStatus.CONFLICT);
    }
    const throttleKey = `auth:reauth:${auth.staffId}`;
    if (await this.cache.increment(throttleKey, 600) > 8) {
      throw new ApiException('too_many_attempts', 'Too many password attempts. Try again later', HttpStatus.TOO_MANY_REQUESTS);
    }
    const staff = await this.prisma.platformStaff.findUnique({ where: { id: auth.staffId } });
    if (!staff || staff.status !== 'active' || !(await argon2.verify(staff.passwordHash, password))) {
      throw new ApiException('invalid_credentials', 'Password is invalid', HttpStatus.UNAUTHORIZED);
    }
    const token = `par_${randomBytes(32).toString('base64url')}`;
    const expiresAt = new Date(Date.now() + 5 * 60_000);
    const created = await this.prisma.platformReauthToken.create({ data: { sessionId: auth.sessionId, tokenHash: sha256(token), expiresAt } });
    await this.cache.delete(throttleKey);
    return { reauth_token: token, expires_at: created.expiresAt.toISOString(), single_use: true };
  }
}
