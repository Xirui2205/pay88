import { describe, expect, it } from 'vitest';
import { createSettlementSchema, settlementStatusSchema, sweepExecutionStatusSchema, sweepRuleInputSchema } from './operations';

describe('financial operation contracts', () => {
  it('normalizes settlement destinations', () => {
    expect(createSettlementSchema.parse({
      reference: 'SET-1',
      account_number: '0911223344',
      expected_name: 'Jane Smith',
      amount: '100.00',
      currency: 'ETB',
    }).account_number).toBe('+251911223344');
  });

  it('rejects sweep targets at or above the high-water mark', () => {
    expect(() => sweepRuleInputSchema.parse({
      group_id: '11111111-1111-4111-8111-111111111111',
      name: 'invalid',
      destination_type: 'platform_treasury',
      destination_phone: '0911223344',
      destination_name: 'Treasury',
      high_water_balance: '1000.00',
      target_balance: '1000.00',
      max_per_run: '500.00',
    })).toThrow();
  });

  it('exposes settlement and sweep execution states for signed webhook contracts', () => {
    expect(settlementStatusSchema.parse('dispatched')).toBe('dispatched');
    expect(sweepExecutionStatusSchema.parse('provider_pending')).toBe('provider_pending');
  });
});
