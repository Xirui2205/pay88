import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { ApiException } from '../common/api-exception';
import type { PlatformRequest } from './admin-auth.types';

@Injectable()
export class PlatformWriteGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<PlatformRequest>();
    if (request.method === 'GET' || request.platformAuth.kind === 'service' || ['admin', 'operator'].includes(request.platformAuth.role)) return true;
    throw new ApiException('forbidden', 'Platform administrator or operator access is required', HttpStatus.FORBIDDEN);
  }
}
