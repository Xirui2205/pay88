import type { RuntimeEnvironment } from '@telebirr/contracts';
import type { MerchantUserRole } from '@prisma/client';
import type { RequestWithContext } from '../common/request-context';

export interface MerchantAuthContext {
  merchantId: string;
  environment: RuntimeEnvironment;
  apiKeyId: string;
}

export interface MerchantRequest extends RequestWithContext {
  auth: MerchantAuthContext;
}

export interface PortalAuthContext {
  sessionId: string;
  userId: string;
  merchantId: string;
  merchantSlug: string;
  merchantName: string;
  email: string;
  displayName: string;
  role: MerchantUserRole;
}

export interface PortalRequest extends RequestWithContext {
  portalAuth: PortalAuthContext;
}
