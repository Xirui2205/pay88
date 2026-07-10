import { describe, expect, it } from 'vitest';
import { comparePersonNames } from './name-normalizer';
import { isTrustedTelebirrSmsSender, matchesMaskedEthiopianPhone, parseTelebirrSms } from './sms-parser';
import { parseUssdScreen, selectSemanticAction } from './ussd-parser';

describe('Telebirr SMS parser', () => {
  it('accepts only the enrolled Telebirr shortcode as authoritative', () => {
    expect(isTrustedTelebirrSmsSender('127')).toBe(true);
    expect(isTrustedTelebirrSmsSender(' 127 ')).toBe(true);
    expect(isTrustedTelebirrSmsSender('+127')).toBe(false);
    expect(isTrustedTelebirrSmsSender('Telebirr127')).toBe(false);
    expect(isTrustedTelebirrSmsSender('+251127')).toBe(false);
    expect(isTrustedTelebirrSmsSender('0912345678')).toBe(false);
  });
  it('parses an incoming transfer and balance', () => {
    const parsed = parseTelebirrSms(`Dear wang
You have received ETB 50.00 from Ji Da(2519****8988) 100305 on 08/07/2026 14:30:35.
Your transaction number is DG87NGWM1D. Your current E-Money Account balance is ETB 47,697.08.`);
    expect(parsed).toMatchObject({
      type: 'incoming_transfer',
      amountMinor: 5000n,
      senderName: 'Ji Da',
      senderPhoneSuffix: '8988',
      providerTransactionId: 'DG87NGWM1D',
      currentMainBalanceMinor: 4769708n,
    });
  });

  it('parses an outgoing transfer with provider fee and VAT', () => {
    const parsed = parseTelebirrSms(`Dear Bekalu
You have transferred ETB 20.00 to Abayine Fucha (2519****4697) on 08/07/2026 12:56:35.
Your transaction number is DG80NDBZ9Y. The service fee is ETB 0.87 and 15% VAT on the service fee is ETB 0.13.
Your current E-Money Account balance is ETB 253.17.`);
    expect(parsed).toMatchObject({
      type: 'outgoing_transfer',
      amountMinor: 2000n,
      receiverName: 'Abayine Fucha',
      receiverPhoneSuffix: '4697',
      providerTransactionId: 'DG80NDBZ9Y',
      serviceFeeMinor: 87n,
      vatMinor: 13n,
      currentMainBalanceMinor: 25317n,
    });
  });

  it('preserves asymmetric visible phone segments from real Telebirr masks', () => {
    const parsed = parseTelebirrSms(`Dear Bekalu
You have transferred ETB 20.00 to Abayine Fucha (9928****7) on 08/07/2026 12:59:30.
Your transaction number is DG87NDFU4H. The service fee is ETB 0.87 and 15% VAT on the service fee is ETB 0.13.`);
    expect(parsed).toMatchObject({ type: 'outgoing_transfer', receiverPhonePrefix: '9928', receiverPhoneSuffix: '7' });
    expect(matchesMaskedEthiopianPhone('+251992844697', '9928', '7')).toBe(true);
    expect(matchesMaskedEthiopianPhone('+251912344697', '9928', '7')).toBe(false);
  });

  it('parses all balance buckets independently', () => {
    const parsed = parseTelebirrSms(`Dear
Your telebirr Customer Incentive Account Balance is : ETB 10.00
Customer E-Money Account Balance is : ETB 844.35
Customer E-Money Account for fuel payment Balance is : ETB 0.00
PocketMoney Account Balance is : ETB 0.00`);
    expect(parsed).toMatchObject({
      type: 'balance',
      incentiveBalanceMinor: 1000n,
      mainBalanceMinor: 84435n,
      fuelBalanceMinor: 0n,
      pocketMoneyBalanceMinor: 0n,
    });
  });
});

describe('semantic USSD parser', () => {
  it('finds NEXT without depending on 99', () => {
    const screen = parseUssdScreen(`Welcome to telebirr
0.Change PIN
1.Financial Services
2.Send Money
3.Airtime/Package
99.Next`);
    expect(screen.prompt).toBe('MENU');
    expect(selectSemanticAction(screen, 'NEXT')).toBe('99');
    expect(selectSemanticAction(screen, 'SEND_MONEY')).toBe('2');
  });

  it('finds balance navigation semantics', () => {
    const screen = parseUssdScreen(`My Account
1.Change PIN
2.Query Balance
3.Change Language
97.Back
00.Main Menu`);
    expect(selectSemanticAction(screen, 'QUERY_BALANCE')).toBe('2');
    expect(selectSemanticAction(screen, 'BACK')).toBe('97');
  });

  it('fails closed for an unknown or duplicate semantic option', () => {
    expect(() => selectSemanticAction(parseUssdScreen('1. Mystery\n2. Other'), 'SEND_MONEY')).toThrow(
      'semantic_action_not_found',
    );
  });
});

describe('deterministic name checker', () => {
  it('accepts reordered tokens and small spelling variations', () => {
    expect(comparePersonNames('Abayine Fucha', 'Fucha Abayine').decision).toBe('match');
    expect(comparePersonNames('Mohammed Ali', 'Mohamed Ali').decision).not.toBe('mismatch');
  });

  it('does not approve a materially different name', () => {
    expect(comparePersonNames('Abayine Fucha', 'Bekalu Tadesse').decision).toBe('mismatch');
  });
});
