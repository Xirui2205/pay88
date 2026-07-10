import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { ApiException } from '../common/api-exception';
import { constantTimeEqual } from '../common/crypto';

type HeaderReader = (name: string) => string | undefined;

export function deviceMtlsRequired(): boolean {
  return process.env.NODE_ENV === 'production' && process.env.DEVICE_MTLS_REQUIRED !== 'false';
}

export function assertTrustedDeviceIngress(header: HeaderReader): void {
  if (!deviceMtlsRequired()) return;
  const expected = process.env.DEVICE_MTLS_PROXY_SECRET ?? '';
  const provided = header('x-device-ingress-secret') ?? '';
  const fingerprint = (header('x-client-cert-sha256') ?? '').toLowerCase();
  if (!expected || !provided || !constantTimeEqual(provided, expected)) {
    throw new ApiException('unauthorized', 'The trusted device ingress is required', HttpStatus.UNAUTHORIZED);
  }
  if (header('x-client-cert-verified') !== 'SUCCESS' || !/^[a-f0-9]{64}$/.test(fingerprint)) {
    throw new ApiException('unauthorized', 'A verified mTLS client certificate is required', HttpStatus.UNAUTHORIZED);
  }
}

@Injectable()
export class DeviceIngressGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ header(name: string): string | undefined }>();
    assertTrustedDeviceIngress((name) => request.header(name));
    return true;
  }
}
