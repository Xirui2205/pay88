import { describe, expect, it, vi } from 'vitest';
import { AdminController } from './admin.controller';

function setup() {
  const deposits = { initialize: vi.fn().mockResolvedValue({ tx_ref: 'ADMIN-DEP', p2p_status: 'awaiting_payment' }) };
  const withdrawals = { create: vi.fn().mockResolvedValue({ reference: 'ADMIN-WD', p2p_status: 'queued' }) };
  const controller = new AdminController({} as never, deposits as never, withdrawals as never, {} as never, {} as never);
  const request = {
    requestId: 'request-1',
    platformAuth: { staffId: 'staff-1' },
  } as never;
  return { controller, deposits, withdrawals, request };
}

describe('AdminController live payment test console', () => {
  it('creates a real live deposit intent without a simulator scenario', async () => {
    const { controller, deposits, request } = setup();
    await controller.createTestDeposit(request, {
      merchant_id: '11111111-1111-4111-8111-111111111111',
      amount: '10.00',
      first_name: 'Test',
      last_name: 'Customer',
      phone_number: '+251911111111',
    });

    expect(deposits.initialize).toHaveBeenCalledOnce();
    expect(deposits.initialize.mock.calls[0]?.[0]).toMatchObject({ environment: 'live' });
    expect(deposits.initialize.mock.calls[0]?.[1]).not.toHaveProperty('test_scenario');
  });

  it('queues a real live withdrawal without a simulator scenario', async () => {
    const { controller, withdrawals, request } = setup();
    await controller.createTestWithdrawal(request, {
      merchant_id: '11111111-1111-4111-8111-111111111111',
      amount: '10.00',
      account_number: '+251922222222',
      expected_name: 'Test Receiver',
    });

    expect(withdrawals.create).toHaveBeenCalledOnce();
    expect(withdrawals.create.mock.calls[0]?.[0]).toMatchObject({ environment: 'live' });
    expect(withdrawals.create.mock.calls[0]?.[1]).not.toHaveProperty('test_scenario');
  });
});
