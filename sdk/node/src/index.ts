import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export type Money = string;
export type Mode = "test" | "live";
export type PublicStatus = "pending" | "success" | "failed";

export interface InitializePaymentInput {
  amount: Money;
  currency?: "ETB";
  tx_ref: string;
  customer_id: string;
  phone_number: string;
  first_name: string;
  last_name?: string;
  email?: string;
  callback_url?: string;
  return_url?: string;
  customization?: { title?: string; description?: string; logo?: string };
  metadata?: Record<string, unknown>;
  test_scenario?: "success" | "wrong_amount" | "late" | "duplicate" | "ambiguous";
}

export interface CreateTransferInput {
  account_number: string;
  expected_name: string;
  amount: Money;
  currency?: "ETB";
  reference: string;
  bank_code?: 855 | "855";
  customer_id: string;
  /** Defaults to the authenticated merchant assertion for its registered customer number. */
  destination_type?: "registered" | "alternate";
  callback_url?: string;
  metadata?: Record<string, unknown>;
  test_scenario?: "success" | "explicit_failure" | "delay" | "unknown";
}

export interface CreateSettlementInput {
  reference: string;
  account_number: string;
  expected_name: string;
  amount: Money;
  currency?: "ETB";
  metadata?: Record<string, unknown>;
}

export interface SweepRuleInput {
  group_id: string;
  name: string;
  destination_type: "platform_treasury" | "merchant_owned";
  destination_phone: string;
  destination_name: string;
  high_water_balance: Money;
  target_balance: Money;
  max_per_run: Money;
  minimum_interval_seconds?: number;
}

export interface TransferView {
  reference: string;
  amount: Money;
  provider_fee: Money | null;
  provider_vat: Money | null;
  gateway_fee: Money;
  currency: "ETB";
  status: PublicStatus;
  p2p_status: string;
  account_number_masked: string;
  expected_name: string;
  provider_transaction_id: string | null;
  created_at: string;
  eta_seconds: number;
  estimated_completion_at: string | null;
  status_url: string;
  status_api_url: string;
}

export interface ApiEnvelope<T> {
  status: "success" | "error";
  message: string;
  code: string;
  request_id: string;
  data: T;
}

export class TelebirrApiError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code?: string,
    readonly requestId?: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = "TelebirrApiError";
  }
}

export interface ClientOptions {
  secretKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class TelebirrP2PClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ClientOptions) {
    if (!options.secretKey) throw new Error("secretKey is required");
    this.baseUrl = (options.baseUrl ?? "https://api.example.invalid").replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetchImpl = options.fetch ?? fetch;
  }

  initializePayment<T = unknown>(input: InitializePaymentInput, idempotencyKey?: string) {
    return this.request<ApiEnvelope<T>>("/v1/transaction/initialize", {
      method: "POST",
      body: JSON.stringify({ currency: "ETB", ...input }),
      idempotencyKey: idempotencyKey ?? input.tx_ref
    });
  }

  initializeTopup<T = unknown>(input: InitializePaymentInput, idempotencyKey?: string) {
    return this.request<ApiEnvelope<T>>("/v1/topups/initialize", {
      method: "POST",
      body: JSON.stringify({ currency: "ETB", ...input }),
      idempotencyKey: idempotencyKey ?? input.tx_ref
    });
  }

  verifyTransaction<T = unknown>(txRef: string) {
    return this.request<ApiEnvelope<T>>(`/v1/transaction/verify/${encodeURIComponent(txRef)}`);
  }

  createTransfer<T = unknown>(input: CreateTransferInput, idempotencyKey?: string) {
    return this.request<ApiEnvelope<T>>("/v1/transfers", {
      method: "POST",
      body: JSON.stringify({ currency: "ETB", bank_code: 855, ...input }),
      idempotencyKey: idempotencyKey ?? input.reference
    });
  }

  verifyTransfer<T = unknown>(reference: string) {
    return this.request<ApiEnvelope<T>>(`/v1/transfers/verify/${encodeURIComponent(reference)}`);
  }

  completeDelayedTestTransfer<T = unknown>(reference: string, outcome: "success" | "failed" | "unknown") {
    return this.request<ApiEnvelope<T>>(`/v1/test/scenarios/transfers/${encodeURIComponent(reference)}/complete`, {
      method: "POST",
      body: JSON.stringify({ outcome })
    });
  }

  requestSettlement<T = unknown>(input: CreateSettlementInput, idempotencyKey?: string) {
    return this.request<ApiEnvelope<T>>("/v1/settlements", {
      method: "POST",
      body: JSON.stringify({ currency: "ETB", ...input }),
      idempotencyKey: idempotencyKey ?? input.reference
    });
  }

  listSettlements<T = unknown>() {
    return this.request<ApiEnvelope<T>>("/v1/settlements");
  }

  getSettlement<T = unknown>(reference: string) {
    return this.request<ApiEnvelope<T>>(`/v1/settlements/${encodeURIComponent(reference)}`);
  }

  createSweepRule<T = unknown>(input: SweepRuleInput, idempotencyKey?: string) {
    return this.request<ApiEnvelope<T>>("/v1/sweep-rules", {
      method: "POST",
      body: JSON.stringify(input),
      idempotencyKey: idempotencyKey ?? input.name
    });
  }

  listSweepRules<T = unknown>() {
    return this.request<ApiEnvelope<T>>("/v1/sweep-rules");
  }

  getSweepRule<T = unknown>(id: string) {
    return this.request<ApiEnvelope<T>>(`/v1/sweep-rules/${encodeURIComponent(id)}`);
  }

  updateSweepRule<T = unknown>(id: string, input: SweepRuleInput, idempotencyKey?: string) {
    return this.request<ApiEnvelope<T>>(`/v1/sweep-rules/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(input),
      idempotencyKey: idempotencyKey ?? id
    });
  }

  disableSweepRule<T = unknown>(id: string, reason: string, idempotencyKey?: string) {
    return this.request<ApiEnvelope<T>>(`/v1/sweep-rules/${encodeURIComponent(id)}`, {
      method: "DELETE",
      body: JSON.stringify({ reason }),
      idempotencyKey: idempotencyKey ?? id
    });
  }

  getBanks<T = unknown>() {
    return this.request<ApiEnvelope<T>>("/v1/banks");
  }

  getBalances<T = unknown>() {
    return this.request<ApiEnvelope<T>>("/v1/balances");
  }

  listWebhooks<T = unknown>() {
    return this.request<ApiEnvelope<T>>("/v1/webhooks");
  }

  registerWebhook<T = unknown>(url: string, idempotencyKey?: string) {
    return this.request<ApiEnvelope<T>>("/v1/webhooks", {
      method: "POST",
      body: JSON.stringify({ url }),
      idempotencyKey: idempotencyKey ?? `webhook:${createHash("sha256").update(url).digest("hex").slice(0, 32)}`
    });
  }

  replayWebhook<T = unknown>(deliveryId: string, idempotencyKey?: string) {
    return this.request<ApiEnvelope<T>>(`/v1/webhooks/deliveries/${encodeURIComponent(deliveryId)}/replay`, {
      method: "POST",
      idempotencyKey: idempotencyKey ?? deliveryId
    });
  }

  private async request<T>(
    path: string,
    options: { method?: string; body?: string; idempotencyKey?: string } = {}
  ): Promise<T> {
    const init: RequestInit = {
      method: options.method ?? "GET",
      headers: {
        authorization: `Bearer ${this.options.secretKey}`,
        accept: "application/json",
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...(options.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : {})
      },
      signal: AbortSignal.timeout(this.timeoutMs)
    };
    if (options.body !== undefined) {
      init.body = options.body;
    }

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, init);

    const body = await response.json().catch(() => undefined) as Partial<ApiEnvelope<unknown>> | undefined;
    if (!response.ok) {
      throw new TelebirrApiError(
        body?.message ?? `HTTP ${response.status}`,
        response.status,
        body?.code,
        body?.request_id,
        body?.data
      );
    }
    return body as T;
  }
}

export function hostedTransferEventsUrl(statusApiUrl: string): string {
  const url = new URL(statusApiUrl);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/events`;
  return url.toString();
}

export function verifyWebhookSignature(input: {
  rawBody: string | Uint8Array;
  timestamp: string;
  signature: string;
  secret: string;
  toleranceSeconds?: number;
  nowMs?: number;
}): boolean {
  const timestampMs = Number(input.timestamp) * 1000;
  const toleranceMs = (input.toleranceSeconds ?? 300) * 1000;
  if (!Number.isFinite(timestampMs) || Math.abs((input.nowMs ?? Date.now()) - timestampMs) > toleranceMs) {
    return false;
  }

  const raw = typeof input.rawBody === "string" ? input.rawBody : Buffer.from(input.rawBody).toString("utf8");
  const expected = `v1=${createHmac("sha256", input.secret).update(`${input.timestamp}.${raw}`).digest("hex")}`;
  const actualBytes = Buffer.from(input.signature);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}
