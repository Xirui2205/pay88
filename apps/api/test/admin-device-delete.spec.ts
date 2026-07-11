import { describe, expect, it, vi } from 'vitest';
import { AdminService } from '../src/admin/admin.service';

function transactionMock(status: 'pending' | 'qualifying' | 'online', activityCount = 0) {
  const count = vi.fn().mockResolvedValue(activityCount);
  return {
    $executeRaw: vi.fn().mockResolvedValue(undefined),
    device: {
      findUnique: vi.fn().mockResolvedValue({
        id: '11111111-1111-4111-8111-111111111111',
        groupId: '22222222-2222-4222-8222-222222222222',
        name: 'Pilot phone',
        status,
        activeUssdJobId: null,
        sims: [{ id: '33333333-3333-4333-8333-333333333333' }],
      }),
      delete: vi.fn().mockResolvedValue({}),
    },
    deviceJob: { count },
    ussdEvidence: { count },
    unattributedSmsEvidence: { count },
    balanceSnapshot: { count },
    depositIntent: { count },
    smsReceipt: { count },
    transfer: { count },
    sweepExecution: { count },
    deviceQualificationCheck: { count },
    deviceActivationCode: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
}

function serviceWith(transaction: ReturnType<typeof transactionMock>) {
  const prisma = {
    $transaction: vi.fn(async (callback: (client: typeof transaction) => unknown) => callback(transaction)),
  };
  return { service: new AdminService(prisma as never, {} as never), transaction };
}

describe('AdminService.deleteDevice', () => {
  it.each(['pending', 'qualifying'] as const)('deletes an unused %s enrollment and releases its SIM', async (status) => {
    const { service, transaction } = serviceWith(transactionMock(status));

    await expect(service.deleteDevice('11111111-1111-4111-8111-111111111111', 'Pilot setup failed', 'staff-1')).resolves.toEqual({
      device_id: '11111111-1111-4111-8111-111111111111',
      deleted: true,
      released_sim_count: 1,
    });
    expect(transaction.deviceActivationCode.deleteMany).toHaveBeenCalledWith({ where: { deviceId: '11111111-1111-4111-8111-111111111111' } });
    expect(transaction.device.delete).toHaveBeenCalled();
    expect(transaction.auditLog.create).toHaveBeenCalled();
  });

  it('refuses to delete an operational phone', async () => {
    const { service, transaction } = serviceWith(transactionMock('online'));

    await expect(service.deleteDevice('11111111-1111-4111-8111-111111111111', 'Start enrollment again', 'staff-1')).rejects.toMatchObject({ code: 'invalid_state' });
    expect(transaction.device.delete).not.toHaveBeenCalled();
  });

  it('refuses to erase operational history from an unqualified phone', async () => {
    const { service, transaction } = serviceWith(transactionMock('qualifying', 1));

    await expect(service.deleteDevice('11111111-1111-4111-8111-111111111111', 'Start enrollment again', 'staff-1')).rejects.toMatchObject({ code: 'device_has_operational_history' });
    expect(transaction.device.delete).not.toHaveBeenCalled();
  });
});
