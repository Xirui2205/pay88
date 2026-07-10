import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import argon2 from 'argon2';
import { ApiException } from '../common/api-exception';
import { PrismaService } from '../infra/prisma.service';
import type { RequestWithContext } from '../common/request-context';
import { constantTimeEqual } from '../common/crypto';
import { assertTrustedDeviceIngress } from './device-ingress.guard';

export interface DeviceRequest extends RequestWithContext {
  device: { id: string };
}

@Injectable()
export class DeviceAuthGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<DeviceRequest>();
    assertTrustedDeviceIngress((name) => request.header(name));
    const deviceId = request.header('x-device-id');
    const token = request.header('x-device-token') ?? request.header('authorization')?.replace(/^Bearer\s+/i, '');
    if (!deviceId || !token) {
      throw new ApiException('unauthorized', 'Device credentials are required', HttpStatus.UNAUTHORIZED);
    }
    const device = await this.prisma.device.findUnique({ where: { id: deviceId } });
    if (!device?.authTokenHash || !(await argon2.verify(device.authTokenHash, token))) {
      throw new ApiException('unauthorized', 'Invalid device credentials', HttpStatus.UNAUTHORIZED);
    }
    const observed = request.header('x-client-cert-sha256')?.toLowerCase() ?? '';
    if (process.env.NODE_ENV === 'production') {
      if (request.header('x-client-cert-verified') !== 'SUCCESS' || !/^[a-f0-9]{64}$/.test(observed)) {
        throw new ApiException('unauthorized', 'A verified mTLS client certificate is required', HttpStatus.UNAUTHORIZED);
      }
      if (!device.certificateFingerprint) {
        await this.prisma.device.updateMany({ where: { id: device.id, certificateFingerprint: null }, data: { certificateFingerprint: observed } });
        const pinned = await this.prisma.device.findUnique({ where: { id: device.id }, select: { certificateFingerprint: true } });
        if (!pinned?.certificateFingerprint || !constantTimeEqual(observed, pinned.certificateFingerprint.toLowerCase())) {
          throw new ApiException('unauthorized', 'The mTLS client certificate does not match this device', HttpStatus.UNAUTHORIZED);
        }
      }
    }
    if (device.certificateFingerprint) {
      if (!observed || !constantTimeEqual(observed, device.certificateFingerprint.toLowerCase())) {
        throw new ApiException('unauthorized', 'The mTLS client certificate does not match this device', HttpStatus.UNAUTHORIZED);
      }
    }
    if (device.status === 'quarantined' || device.status === 'retired') {
      throw new ApiException('forbidden', 'This device cannot receive work', HttpStatus.FORBIDDEN);
    }
    request.device = { id: device.id };
    return true;
  }
}
