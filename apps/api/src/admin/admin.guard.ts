import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { ApiException } from '../common/api-exception';
import { constantTimeEqual, sha256 } from '../common/crypto';
import { PrismaService } from '../infra/prisma.service';
import type { PlatformRequest } from './admin-auth.types';

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<PlatformRequest>();
    const provided = request.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    const expected = process.env.ADMIN_API_TOKEN ?? '';
    if (expected && constantTimeEqual(provided, expected)) {
      request.platformAuth = { kind: 'service', sessionId: null, staffId: 'break-glass-service', email: null, displayName: 'Break-glass service', role: 'admin' };
      return true;
    }
    if (provided.startsWith('pas_')) {
      const session = await this.prisma.platformSession.findUnique({ where: { tokenHash: sha256(provided) }, include: { staff: true } });
      if (session && !session.revokedAt && session.expiresAt > new Date() && session.staff.status === 'active') {
        request.platformAuth = { kind: 'session', sessionId: session.id, staffId: session.staff.id, email: session.staff.email, displayName: session.staff.displayName, role: session.staff.role };
        if (Date.now() - session.lastSeenAt.valueOf() > 60_000) void this.prisma.platformSession.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } }).catch(() => undefined);
        return true;
      }
    }
    throw new ApiException('unauthorized', 'A valid platform staff session is required', HttpStatus.UNAUTHORIZED);
  }
}
