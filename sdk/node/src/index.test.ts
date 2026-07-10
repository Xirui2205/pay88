import { describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { hostedTransferEventsUrl, TelebirrP2PClient, verifyWebhookSignature } from "./index.js";

describe("TelebirrP2PClient", () => {
  it("uses the merchant reference as an idempotency fallback", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => new Response(JSON.stringify({
      status: "success", message: "created", request_id: "req_1", data: { checkout_url: "https://checkout" }
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const client = new TelebirrP2PClient({ secretKey: "test", fetch: fetchMock as typeof fetch });
    await client.initializePayment({
      amount: "50.00", tx_ref: "order-1", customer_id: "customer-1", phone_number: "0912345678", first_name: "Test"
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect((fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>)["idempotency-key"]).toBe("order-1");
  });

  it("sends the canonical Telebirr transfer fields", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({
      status: "success", message: "accepted", code: "ok", request_id: "req_2", data: { p2p_status: "queued" }
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = new TelebirrP2PClient({ secretKey: "test", fetch: fetchMock as typeof fetch });

    await client.createTransfer({
      account_number: "0912345678",
      expected_name: "Test Receiver",
      customer_id: "customer-1",
      amount: "25.00",
      reference: "withdrawal-1"
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({ bank_code: 855, expected_name: "Test Receiver", customer_id: "customer-1" });
    expect(body).not.toHaveProperty("account_name");
  });

  it("supports top-ups and idempotent webhook registration", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({
      status: "success", message: "ok", code: "ok", request_id: "req_3", data: {}
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = new TelebirrP2PClient({ secretKey: "test", fetch: fetchMock as typeof fetch });

    await client.initializeTopup({
      amount: "100.00", tx_ref: "topup-1", customer_id: "treasury", phone_number: "0912345678", first_name: "Treasury",
      test_scenario: "success"
    });
    await client.registerWebhook("https://merchant.example/webhooks");

    expect(fetchMock.mock.calls[0]?.[0]).toContain("/v1/topups/initialize");
    const headers = fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>;
    expect(fetchMock.mock.calls[1]?.[0]).toContain("/v1/webhooks");
    expect(headers["idempotency-key"]).toMatch(/^webhook:[0-9a-f]{32}$/);
  });

  it("exposes settlement and sweep-rule merchant surfaces", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({
      status: "success", message: "ok", code: "ok", request_id: "req_4", data: {}
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = new TelebirrP2PClient({ secretKey: "test", fetch: fetchMock as typeof fetch });

    await client.requestSettlement({ reference: "settlement-1", account_number: "0912345678", expected_name: "Treasury", amount: "50.00" });
    await client.createSweepRule({
      group_id: "11111111-1111-4111-8111-111111111111",
      name: "High-water rule",
      destination_type: "merchant_owned",
      destination_phone: "0912345678",
      destination_name: "Treasury",
      high_water_balance: "1000.00",
      target_balance: "500.00",
      max_per_run: "250.00"
    });

    expect(fetchMock.mock.calls[0]?.[0]).toContain("/v1/settlements");
    expect((fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>)["idempotency-key"]).toBe("settlement-1");
    expect(fetchMock.mock.calls[1]?.[0]).toContain("/v1/sweep-rules");
    expect((fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>)["idempotency-key"]).toBe("High-water rule");
  });

  it("derives the SSE endpoint without changing the scoped token", () => {
    expect(hostedTransferEventsUrl("https://api.example/v1/hosted/transfers/ref-1?token=opaque"))
      .toBe("https://api.example/v1/hosted/transfers/ref-1/events?token=opaque");
  });

  it("completes a delayed transfer through the test-only simulator control", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({
      status: "success", message: "completed", code: "ok", request_id: "req_5", data: { p2p_status: "success" }
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = new TelebirrP2PClient({ secretKey: "test", fetch: fetchMock as typeof fetch });

    await client.completeDelayedTestTransfer("delayed-1", "success");

    expect(fetchMock.mock.calls[0]?.[0]).toContain("/v1/test/scenarios/transfers/delayed-1/complete");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ outcome: "success" });
  });
});

describe("verifyWebhookSignature", () => {
  it("verifies the exact timestamp and raw body", () => {
    const nowMs = 1_750_000_000_000;
    const timestamp = String(nowMs / 1000);
    const body = JSON.stringify({ event_id: "evt_1", status: "success" });
    const signature = `v1=${createHmac("sha256", "secret").update(`${timestamp}.${body}`).digest("hex")}`;
    expect(verifyWebhookSignature({ rawBody: body, timestamp, signature, secret: "secret", nowMs })).toBe(true);
    expect(verifyWebhookSignature({ rawBody: `${body} `, timestamp, signature, secret: "secret", nowMs })).toBe(false);
  });
});
