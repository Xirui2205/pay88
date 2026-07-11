import type { ActivationRequest } from '@telebirr/contracts';
import { describe, expect, it, vi } from 'vitest';
import { DeviceJobsService } from '../src/devices/device-jobs.service';

const activationRequest: ActivationRequest = {
  activation_code: 'fresh-pilot-code',
  installation_id: 'same-phone-installation',
  hardware_serial: 'same-phone-installation',
  certificate_alias: '',
  protocol_version: '1',
  manufacturer: 'TECNO',
  model: 'CAMON 18 Premier',
  android_release: '12',
  android_sdk: 31,
  app_version: '1.1.2',
  build_fingerprint: 'TECNO/test/release-keys',
};

describe('device activation hardware identity', () => {
  it('returns a conflict without consuming the code when the handset belongs to another record', async () => {
    const transaction = {
      deviceActivationCode: {
        findFirst: vi.fn().mockResolvedValue({ id: 'code-1', deviceId: 'new-device' }),
        updateMany: vi.fn(),
      },
      device: {
        findFirst: vi.fn().mockResolvedValue({ id: 'old-device' }),
        update: vi.fn(),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof transaction) => unknown) => callback(transaction)),
    };
    const service = new DeviceJobsService(prisma as never, {} as never, {} as never, {} as never);

    await expect(service.activate(activationRequest)).rejects.toMatchObject({
      code: 'hardware_already_enrolled',
      status: 409,
    });
    expect(transaction.deviceActivationCode.updateMany).not.toHaveBeenCalled();
    expect(transaction.device.update).not.toHaveBeenCalled();
  });
});
