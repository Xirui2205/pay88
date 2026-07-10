import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { ApiException } from '../common/api-exception';
import { constantTimeEqual } from '../common/crypto';

@Injectable()
export class OpenClawGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ headers: Record<string, string | undefined> }>();
    const provided = request.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
    const expected = process.env.OPENCLAW_TOOL_TOKEN ?? '';
    if (!expected || !constantTimeEqual(provided, expected)) {
      throw new ApiException('unauthorized', 'Invalid OpenClaw tool token', HttpStatus.UNAUTHORIZED);
    }
    return true;
  }
}
