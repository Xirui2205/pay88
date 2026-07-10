export type ParsedSms = IncomingTransferSms | OutgoingTransferSms | BalanceSms | UnknownSms;

export function isTrustedTelebirrSmsSender(sender: string): boolean {
  return sender.trim() === '127';
}

interface BaseSms {
  type: string;
  raw: string;
}

export interface IncomingTransferSms extends BaseSms {
  type: 'incoming_transfer';
  amountMinor: bigint;
  senderName: string;
  senderPhoneSuffix: string;
  senderPhonePrefix: string;
  providerTransactionId: string;
  providerOccurredAt: Date | null;
  currentMainBalanceMinor: bigint | null;
}

export interface OutgoingTransferSms extends BaseSms {
  type: 'outgoing_transfer';
  amountMinor: bigint;
  receiverName: string;
  receiverPhoneSuffix: string;
  receiverPhonePrefix: string;
  providerTransactionId: string;
  providerOccurredAt: Date | null;
  serviceFeeMinor: bigint;
  vatMinor: bigint;
  currentMainBalanceMinor: bigint | null;
}

export interface BalanceSms extends BaseSms {
  type: 'balance';
  incentiveBalanceMinor: bigint;
  mainBalanceMinor: bigint;
  fuelBalanceMinor: bigint;
  pocketMoneyBalanceMinor: bigint;
}

export interface UnknownSms extends BaseSms {
  type: 'unknown';
  reason: string;
}

function compact(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function parseEtb(value: string): bigint {
  const normalized = value.replace(/,/g, '').trim().replace(/\.$/, '');
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(normalized);
  if (!match) throw new Error(`Invalid ETB amount: ${value}`);
  return BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'));
}

function parseProviderTime(date: string | undefined, time: string | undefined): Date | null {
  if (!date || !time) return null;
  const [day, month, year] = date.split('/').map(Number);
  if (!day || !month || !year) return null;
  const iso = `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day
    .toString()
    .padStart(2, '0')}T${time}+03:00`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.valueOf()) ? null : parsed;
}

function phoneMask(masked: string): { prefix: string; suffix: string } {
  const compact = masked.replace(/\s+/g, '');
  const firstMask = compact.search(/[xX*]/);
  if (firstMask >= 0) {
    const lastMask = Math.max(compact.lastIndexOf('*'), compact.lastIndexOf('x'), compact.lastIndexOf('X'));
    return {
      prefix: compact.slice(0, firstMask).replace(/\D/g, '').slice(-8),
      suffix: compact.slice(lastMask + 1).replace(/\D/g, '').slice(-8),
    };
  }
  const digits = compact.replace(/\D/g, '');
  return { prefix: '', suffix: digits.slice(-4) };
}

export function matchesMaskedEthiopianPhone(phone: string, prefix: string, suffix: string): boolean {
  if (!suffix) return false;
  const digits = phone.replace(/\D/g, '');
  const withoutCountry = digits.startsWith('251') ? digits.slice(3) : digits.replace(/^0/, '');
  const variants = new Set([digits, withoutCountry, `0${withoutCountry}`]);
  return [...variants].some((variant) => variant.endsWith(suffix) && (!prefix || variant.startsWith(prefix)));
}

function optionalBalance(text: string): bigint | null {
  const match = /current\s+E-?Money\s+Account\s+balance\s+is\s*(?::\s*)?ETB\s*([\d,.]+)/i.exec(text);
  return match ? parseEtb(match[1]) : null;
}

export function parseTelebirrSms(raw: string): ParsedSms {
  const text = compact(raw);

  const balance = /Customer\s+Incentive\s+Account\s+Balance\s+is\s*:\s*ETB\s*([\d,.]+).*?Customer\s+E-?Money\s+Account\s+Balance\s+is\s*:\s*ETB\s*([\d,.]+).*?Customer\s+E-?Money\s+Account\s+for\s+fuel\s+payment\s+Balance\s+is\s*:\s*ETB\s*([\d,.]+).*?PocketMoney\s+Account\s+Balance\s+is\s*:\s*ETB\s*([\d,.]+)/i.exec(
    text,
  );
  if (balance) {
    return {
      type: 'balance',
      raw,
      incentiveBalanceMinor: parseEtb(balance[1]),
      mainBalanceMinor: parseEtb(balance[2]),
      fuelBalanceMinor: parseEtb(balance[3]),
      pocketMoneyBalanceMinor: parseEtb(balance[4]),
    };
  }

  const incoming = /received\s+ETB\s*([\d,.]+)\s+from\s+(.+?)\s*\(([^)]+)\)(?:\s+\d+)?\s+on\s+(\d{2}\/\d{2}\/\d{4})\s+(\d{2}:\d{2}:\d{2}).*?transaction\s+number\s+is\s+([A-Z0-9]+)/i.exec(
    text,
  );
  if (incoming) {
    const senderPhone = phoneMask(incoming[3]);
    return {
      type: 'incoming_transfer',
      raw,
      amountMinor: parseEtb(incoming[1]),
      senderName: incoming[2].trim(),
      senderPhoneSuffix: senderPhone.suffix,
      senderPhonePrefix: senderPhone.prefix,
      providerOccurredAt: parseProviderTime(incoming[4], incoming[5]),
      providerTransactionId: incoming[6].toUpperCase(),
      currentMainBalanceMinor: optionalBalance(text),
    };
  }

  const outgoing = /transferred\s+ETB\s*([\d,.]+)\s+to\s+(.+?)\s*\(([^)]+)\)\s+on\s+(\d{2}\/\d{2}\/\d{4})\s+(\d{2}:\d{2}:\d{2}).*?transaction\s+number\s+is\s+([A-Z0-9]+).*?service\s+fee\s+is\s+ETB\s*([\d,.]+).*?VAT\s+on\s+the\s+service\s+fee\s+is\s+ETB\s*([\d,.]+)/i.exec(
    text,
  );
  if (outgoing) {
    const receiverPhone = phoneMask(outgoing[3]);
    return {
      type: 'outgoing_transfer',
      raw,
      amountMinor: parseEtb(outgoing[1]),
      receiverName: outgoing[2].trim(),
      receiverPhoneSuffix: receiverPhone.suffix,
      receiverPhonePrefix: receiverPhone.prefix,
      providerOccurredAt: parseProviderTime(outgoing[4], outgoing[5]),
      providerTransactionId: outgoing[6].toUpperCase(),
      serviceFeeMinor: parseEtb(outgoing[7]),
      vatMinor: parseEtb(outgoing[8]),
      currentMainBalanceMinor: optionalBalance(text),
    };
  }

  return { type: 'unknown', raw, reason: 'no_known_deterministic_pattern' };
}
