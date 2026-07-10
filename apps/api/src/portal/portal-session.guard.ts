import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { ApiException } from '../common/api-exception';
import { sha256 } from '../common/crypto';
import { PrismaService } from '../infra/prisma.service';
import type { PortalRequest } from '../auth/auth.types';

@Injectable()
export class PortalSessionGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<PortalRequest>();
    const token = request.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    if (!token.startsWith('mps_')) {
      throw new ApiException('unauthorized', 'A merchant portal session is required', HttpStatus.UNAUTHORIZED);
    }
    const session = await this.prisma.merchantSession.findUnique({
      where: { tokenHash: sha256(token) },
      include: { user: { include: { merchant: true } } },
    });
    if (
      !session ||
      session.revokedAt ||
      session.expiresAt <= new Date() ||
      session.user.status !== 'active' ||
      session.user.merchant.status !== 'active'
    ) {
      throw new ApiException('unauthorized', 'The merchant portal session is invalid or expired', HttpStatus.UNAUTHORIZED);
    }
    request.portalAuth = {
      sessionId: session.id,
      userId: session.user.id,
      merchantId: session.user.merchantId,
      merchantSlug: session.user.merchant.slug,
      merchantName: session.user.merchant.name,
      email: session.user.email,
      displayName: session.user.displayName,
      role: session.user.role,
    };
    if (Date.now() - session.lastSeenAt.valueOf() > 60_000) {
      void this.prisma.merchantSession.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } }).catch(() => undefined);
    }
    return true;
  }
}
