import { describe, expect, it } from 'vitest';
import { amountToMinor, minorToAmount, normalizeEthiopianPhone } from './money';

describe('money and phone contracts', () => {
  it('round-trips ETB minor units without floating point arithmetic', () => {
    expect(amountToMinor('1500.05')).toBe(150005n);
    expect(minorToAmount(150005n)).toBe('1500.05');
  });

  it.each([
    ['0912345678', '+251912345678'],
    ['912345678', '+251912345678'],
    ['251912345678', '+251912345678'],
    ['+251 912 345 678', '+251912345678'],
  ])('normalizes %s', (input, output) => {
    expect(normalizeEthiopianPhone(input)).toBe(output);
  });
});
