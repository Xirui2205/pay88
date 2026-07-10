import { Injectable } from '@nestjs/common';
import type { DeviceJobType } from '@prisma/client';
import { DeviceSigningService } from './device-signing.service';
import { CURRENT_DEVICE_PROFILE_VERSION } from './device-profile-version';

@Injectable()
export class DeviceProfilesService {
  constructor(private readonly signing: DeviceSigningService) {}

  allSignedProfiles() {
    const operations: Array<{ jobType: DeviceJobType; operation: string }> = [
      { jobType: 'customer_withdrawal', operation: 'withdrawal' },
      { jobType: 'merchant_settlement', operation: 'merchant_settlement' },
      { jobType: 'automatic_sweep', operation: 'automatic_sweep' },
      { jobType: 'emergency_liquidity_move', operation: 'emergency_liquidity_move' },
    ];
    return [
      ...operations.map(({ jobType, operation }) => this.signing.signJson(this.moneyProfile(jobType, operation))),
      this.signing.signJson(this.balanceProfile()),
    ];
  }

  profileId(type: DeviceJobType): string {
    if (type === 'balance_query') return 'telebirr.balance-query.v1';
    if (type === 'customer_withdrawal') return 'telebirr.send-money.v1';
    return `telebirr.${type.replaceAll('_', '-')}.v1`;
  }

  private moneyProfile(type: DeviceJobType, operation: string): Record<string, unknown> {
    return {
      profile_id: this.profileId(type),
      // Version 2 adds deterministic phone/amount/name verification on the
      // final confirmation screen and safe dismissal of processing dialogs.
      // Never mutate already-installed v1 profile content in place.
      version: CURRENT_DEVICE_PROFILE_VERSION,
      operation,
      initial_step_id: 'main-send-menu',
      label_aliases: { confirm: aliases.confirm, send_money: aliases.send_money },
      recipient_name_patterns: [
        "(?iu)\\bto\\s+[+0-9*() -]{8,24}\\s+([\\p{L}][\\p{L}\\p{M} .'\\-]{1,80}?)(?=\\s*(?:\\n|confirm|[10][.)]|$))",
        "(?iu)\\bfor\\s+[+0-9*() -]{8,24}\\s+([\\p{L}][\\p{L}\\p{M} .'\\-]{1,80}?)(?=\\s*(?:\\n|[10][.)]|confirm|$))",
        "(?iu)\\bto\\s+([\\p{L}][\\p{L}\\p{M} .'\\-]{1,80}?)(?:\\s*\\(|\\n|,|$)",
        "(?iu)receiver(?: name)?\\s*[:=\\-]\\s*([\\p{L}][\\p{L}\\p{M} .'\\-]{1,80}?)(?:\\n|,|$)",
      ],
      terminal_markers: terminals,
      steps: [
        step('main-send-menu', ['SEND', 'TRANSFER'], response('select_menu', 'send_money'), 'send-submenu'),
        step('send-submenu', ['SEND MONEY', 'TRANSFER MONEY'], response('select_menu', 'send_money'), 'destination'),
        step('destination', ['MOBILE NUMBER', 'RECEIVER', 'PHONE NUMBER'], response('enter_value', undefined, 'destination_phone'), 'verify-recipient'),
        step('verify-recipient', ['CONFIRM', 'RECEIVER', 'NAME'], response('verify_recipient_and_select', 'confirm'), 'amount'),
        step('amount', ['ENTER AMOUNT', 'AMOUNT'], response('enter_value', undefined, 'amount_etb'), 'comment'),
        step('comment', ['COMMENT', 'REMARK', 'REFERENCE'], response('enter_value', undefined, 'empty_text'), 'final-confirm'),
        step('final-confirm', ['CONFIRM', 'TRANSFER', 'SEND'], response('verify_transfer_and_select', 'confirm'), 'pin'),
        step('pin', ['ENTER PIN', 'PIN'], response('submit_local_pin', undefined, undefined, true), 'provider-result'),
        step('provider-result', ['PROCESS', 'WAIT', 'REQUEST'], response('dismiss_and_wait_for_provider')),
      ],
    };
  }

  private balanceProfile(): Record<string, unknown> {
    return {
      profile_id: this.profileId('balance_query'),
      version: CURRENT_DEVICE_PROFILE_VERSION,
      operation: 'balance_query',
      initial_step_id: 'next',
      label_aliases: aliases,
      recipient_name_patterns: [],
      terminal_markers: terminals,
      steps: [
        step('next', ['NEXT', 'MORE'], response('select_menu', 'next'), 'my-account'),
        step('my-account', ['MY ACCOUNT', 'ACCOUNT'], response('select_menu', 'my_account'), 'query-balance'),
        step('query-balance', ['BALANCE'], response('select_menu', 'query_balance'), 'pin'),
        step('pin', ['ENTER PIN', 'PIN'], response('submit_local_pin'), 'processing'),
        step('processing', ['PROCESS', 'SMS', 'REQUEST'], response('dismiss_and_wait_for_provider')),
      ],
    };
  }
}

const aliases = {
  next: ['NEXT', 'MORE'],
  send_money: ['SEND MONEY', 'TRANSFER MONEY'],
  my_account: ['MY ACCOUNT', 'ACCOUNT'],
  query_balance: ['QUERY BALANCE', 'CHECK BALANCE', 'BALANCE'],
  confirm: ['CONFIRM', 'YES', 'OK'],
  cancel: ['CANCEL', 'NO', 'BACK'],
};

const terminals = {
  success_any: ['SUCCESSFUL', 'COMPLETED'],
  failure_any: ['FAILED', 'DECLINED', 'INSUFFICIENT', 'INVALID PIN'],
};

function response(type: string, selectAction?: string, inputValue?: string, financialCommit = false) {
  return {
    type,
    ...(selectAction ? { select_action: selectAction } : {}),
    ...(inputValue ? { input_value: inputValue } : {}),
    financial_commit: financialCommit,
  };
}

function step(id: string, requiredAny: string[], flowResponse: Record<string, unknown>, nextStepId?: string) {
  return {
    id,
    expectation: { required_any: requiredAny, forbidden_any: [] },
    response: flowResponse,
    ...(nextStepId ? { next_step_id: nextStepId } : {}),
  };
}
