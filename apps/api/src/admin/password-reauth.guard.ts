import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { ApiException } from '../common/api-exception';
import { sha256 } from '../common/crypto';
import { PrismaService } from '../infra/prisma.service';
import type { PlatformRequest } from './admin-auth.types';

@Injectable()
export class PasswordReauthGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<PlatformRequest>();
    if (request.platformAuth.kind === 'service') {
      const reason = request.header('x-break-glass-reason')?.trim() ?? '';
      if (reason.length < 10) {
        throw new ApiException('break_glass_reason_required', 'Sensitive service actions require an x-break-glass-reason header', HttpStatus.FORBIDDEN);
      }
      await this.prisma.auditLog.create({
        data: {
          actorType: 'platform_service',
          actorId: request.platformAuth.staffId,
          action: 'break_glass.sensitive_request',
          targetType: 'admin_route',
          targetId: request.originalUrl.slice(0, 128),
          reason: reason.slice(0, 1000),
          metadata: { method: request.method },
        },
      });
      return true;
    }
    const token = request.header('x-reauth-token') ?? '';
    if (!token.startsWith('par_') || !request.platformAuth.sessionId) {
      throw new ApiException('reauthentication_required', 'Password reauthentication is required for this action', HttpStatus.FORBIDDEN);
    }
    const claim = await this.prisma.platformReauthToken.updateMany({
      where: { tokenHash: sha256(token), sessionId: request.platformAuth.sessionId, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });
    if (claim.count !== 1) {
      throw new ApiException('reauthentication_required', 'The password reauthentication token is invalid, expired, or already used', HttpStatus.FORBIDDEN);
    }
    return true;
  }
}
