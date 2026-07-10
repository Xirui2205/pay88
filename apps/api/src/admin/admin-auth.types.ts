import type { PlatformStaffRole } from '@prisma/client';
import type { RequestWithContext } from '../common/request-context';

export interface PlatformAuthContext {
  kind: 'session' | 'service';
  sessionId: string | null;
  staffId: string;
  email: string | null;
  displayName: string;
  role: PlatformStaffRole;
}

export interface PlatformRequest extends RequestWithContext {
  platformAuth: PlatformAuthContext;
}
