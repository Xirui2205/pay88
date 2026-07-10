export type UssdSemanticAction =
  | 'NEXT'
  | 'MAIN_MENU'
  | 'BACK'
  | 'SEND_MONEY'
  | 'TRANSFER_TO_BANK'
  | 'TRANSFER_TO_WALLET'
  | 'MY_ACCOUNT'
  | 'QUERY_BALANCE'
  | 'CONFIRM'
  | 'CANCEL';

export type UssdPrompt =
  | 'MENU'
  | 'ENTER_RECEIVER_NUMBER'
  | 'CONFIRM_RECEIVER'
  | 'ENTER_AMOUNT'
  | 'ENTER_COMMENT'
  | 'CONFIRM_TRANSFER'
  | 'ENTER_PIN'
  | 'PROCESSING'
  | 'UNKNOWN';

export interface UssdMenuOption {
  value: string;
  label: string;
  normalizedLabel: string;
  semantic: UssdSemanticAction | null;
}

export interface ParsedUssdScreen {
  raw: string;
  normalized: string;
  prompt: UssdPrompt;
  options: UssdMenuOption[];
}

const aliases: Record<UssdSemanticAction, RegExp[]> = {
  NEXT: [/^next$/i, /^more$/i],
  MAIN_MENU: [/^main\s*menu$/i],
  BACK: [/^back$/i],
  SEND_MONEY: [/^send\s*money$/i],
  TRANSFER_TO_BANK: [/^transfer\s*to\s*bank$/i],
  TRANSFER_TO_WALLET: [/^transfer\s*to\s*wallet$/i],
  MY_ACCOUNT: [/^my\s*account$/i],
  QUERY_BALANCE: [/^(?:query|check|view)\s*(?:account\s*)?balance$/i],
  CONFIRM: [/^(?:ok|confirm|yes)$/i],
  CANCEL: [/^(?:cancel|no)$/i],
};

function normalize(value: string): string {
  return value.normalize('NFKC').replace(/[\s.:_-]+/g, ' ').trim();
}

function semanticFor(label: string): UssdSemanticAction | null {
  const normalized = normalize(label);
  for (const [semantic, patterns] of Object.entries(aliases) as Array<[UssdSemanticAction, RegExp[]]>) {
    if (patterns.some((pattern) => pattern.test(normalized))) return semantic;
  }
  return null;
}

function promptFor(normalized: string, options: UssdMenuOption[]): UssdPrompt {
  if (/request\s+is\s+being\s+processed|wait\s+for\s+the\s+confirmation/i.test(normalized)) return 'PROCESSING';
  if (/enter\s+pin/i.test(normalized)) return 'ENTER_PIN';
  if (/you\s+are\s+sending/i.test(normalized)) return 'CONFIRM_TRANSFER';
  if (/enter\s+comment/i.test(normalized)) return 'ENTER_COMMENT';
  if (/enter\s+amount/i.test(normalized)) return 'ENTER_AMOUNT';
  if (/^to\s+\d+.+confirm/i.test(normalized)) return 'CONFIRM_RECEIVER';
  if (/enter\s+(?:the\s+)?receiver\s+(?:mobile\s+)?number/i.test(normalized)) return 'ENTER_RECEIVER_NUMBER';
  return options.length ? 'MENU' : 'UNKNOWN';
}

export function parseUssdScreen(raw: string): ParsedUssdScreen {
  const normalized = normalize(raw);
  const options: UssdMenuOption[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const match = /^\s*(\d{1,2})\s*[.)-]?\s*(.+?)\s*$/.exec(line);
    if (!match) continue;
    const normalizedLabel = normalize(match[2]);
    options.push({
      value: match[1],
      label: match[2].trim(),
      normalizedLabel,
      semantic: semanticFor(normalizedLabel),
    });
  }
  return { raw, normalized, options, prompt: promptFor(normalized, options) };
}

export function selectSemanticAction(screen: ParsedUssdScreen, action: UssdSemanticAction): string {
  const matches = screen.options.filter((option) => option.semantic === action);
  if (matches.length !== 1) {
    throw new Error(matches.length === 0 ? `semantic_action_not_found:${action}` : `semantic_action_ambiguous:${action}`);
  }
  return matches[0].value;
}

export interface UssdFlowStep {
  expectedPrompt: UssdPrompt;
  action?: UssdSemanticAction;
  sensitive?: boolean;
}

export interface UssdFlowProfile {
  provider: 'telebirr';
  version: string;
  dialCode: '*127#';
  flows: Record<'balance_query' | 'customer_withdrawal', UssdFlowStep[]>;
}

export const TELEBIRR_PROFILE_V1: UssdFlowProfile = {
  provider: 'telebirr',
  version: '2026-07-10.1',
  dialCode: '*127#',
  flows: {
    balance_query: [
      { expectedPrompt: 'MENU', action: 'NEXT' },
      { expectedPrompt: 'MENU', action: 'MY_ACCOUNT' },
      { expectedPrompt: 'MENU', action: 'QUERY_BALANCE' },
      { expectedPrompt: 'ENTER_PIN', sensitive: true },
      { expectedPrompt: 'PROCESSING' },
    ],
    customer_withdrawal: [
      { expectedPrompt: 'MENU', action: 'SEND_MONEY' },
      { expectedPrompt: 'MENU', action: 'SEND_MONEY' },
      { expectedPrompt: 'ENTER_RECEIVER_NUMBER' },
      { expectedPrompt: 'CONFIRM_RECEIVER', action: 'CONFIRM' },
      { expectedPrompt: 'ENTER_AMOUNT' },
      { expectedPrompt: 'ENTER_COMMENT' },
      { expectedPrompt: 'CONFIRM_TRANSFER', action: 'CONFIRM' },
      { expectedPrompt: 'ENTER_PIN', sensitive: true },
      { expectedPrompt: 'PROCESSING' },
    ],
  },
};

