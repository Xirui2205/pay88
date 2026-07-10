import { describe, expect, it } from 'vitest';
import { normalizeConfiguration } from './configuration.service';

describe('configuration approval payloads', () => {
  it('normalizes a complete platform policy without activating it', () => {
    expect(normalizeConfiguration('platform_defaults', {
      daily_transfer_cap: '150000.00', wallet_ceiling: '75000.00', safety_balance: '5000.00', safety_headroom: '1000.00',
      balance_stale_seconds: 1800, capacity_safety_factor: 0.7, default_deposit_countdown_seconds: 600, default_deposit_late_grace_seconds: 1800,
    })).toMatchObject({ daily_transfer_cap: '150000.00', balance_stale_seconds: 1800, capacity_safety_factor: 0.7 });
  });

  it('rejects a zero daily cap and out-of-range stale policy', () => {
    expect(() => normalizeConfiguration('platform_defaults', {
      daily_transfer_cap: '0.00', wallet_ceiling: '75000.00', safety_balance: '0.00', safety_headroom: '0.00',
      balance_stale_seconds: 10, capacity_safety_factor: 0.7, default_deposit_countdown_seconds: 600, default_deposit_late_grace_seconds: 1800,
    })).toThrow();
  });

  it('rejects unsafe cross-field limits', () => {
    expect(() => normalizeConfiguration('device_group', {
      daily_transfer_cap: '150000.00', wallet_ceiling: '5000.00', safety_balance: '4000.00', safety_headroom: '1000.00',
    })).toThrow('Wallet ceiling');
    expect(() => normalizeConfiguration('merchant', {
      allow_alternate_withdrawal_phone: false, deposit_minimum: '500.00', deposit_maximum: '100.00',
      wrong_amount_tolerance: '5.00', reserve_provider_fee: '25.00', gateway_fee_flat: '0.00',
      deposit_countdown_seconds: 600, deposit_late_grace_seconds: 1800,
      technical_difficulty_message: 'Please try again later.',
    })).toThrow('minimum');
  });
});
