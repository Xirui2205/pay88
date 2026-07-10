# Merchant API Integration

Contract artifacts: [OpenAPI 3.1](../openapi/telebirr-p2p-v1.yaml),
[runnable examples](../examples/README.md), and
[Postman collection](../postman/Telebirr-P2P-V1.postman_collection.json).

## Authentication and environments

Use the live or test secret key only from a server:

```http
Authorization: Bearer sk_test_yourprefix.yoursecret
Content-Type: application/json
Idempotency-Key: merchant-order-123
```

Test and live references, balances, webhooks and data are isolated. Never expose a secret key in browser JavaScript.

The production default is a distributed limit of 2,000 authenticated requests
per API key per minute. An exceeded bucket returns HTTP 429 with
`code=rate_limited`; retry with backoff and the same reference and
`Idempotency-Key`. The operator may publish a different reviewed limit for your
account or environment.

## Initialize a deposit

```http
POST /v1/transaction/initialize

{
  "amount": "500.00",
  "currency": "ETB",
  "tx_ref": "merchant-order-123",
  "customer_id": "player-42",
  "phone_number": "0912345678",
  "first_name": "Abebe",
  "last_name": "Kebede",
  "return_url": "https://merchant.example/deposit/return",
  "callback_url": "https://merchant.example/payment-callback",
  "customization": { "title": "Deposit" },
  "metadata": { "account_id": "wallet-42" }
}
```

Redirect the user to `data.checkout_url`. Do not credit based on the browser redirect. Wait for a signed webhook or verify `tx_ref`.

`callback_url` is accepted for compatibility and stored as advisory request
metadata; V1 does not guarantee a direct request to that URL. Registered signed
webhooks and server-side verification are authoritative.

The URL contains an opaque scoped token. The hosted UI reads
`GET /v1/checkout/{tx_ref}?token=...`; do not expose the merchant secret key to
that browser. Treat the full checkout URL as sensitive and avoid logging it.

## Initialize merchant liquidity top-up

Use `POST /v1/topups/initialize` with the same request shape. It credits merchant
liquidity instead of a customer balance. Verify it using
`GET /v1/transaction/verify/{tx_ref}`. Top-up lifecycle notifications use the
`topup.updated` webhook event type.

## Verify

```http
GET /v1/transaction/verify/merchant-order-123
```

Always validate reference, currency, gross amount, actual received amount and terminal status. `status` is compatible and coarse; use `p2p_status` for operator UX.

## Create and verify a Telebirr withdrawal

```http
POST /v1/transfers

{
  "account_number": "0912345678",
  "expected_name": "Abebe Kebede",
  "amount": "500.00",
  "currency": "ETB",
  "reference": "withdrawal-456",
  "bank_code": 855,
  "customer_id": "player-42",
  "destination_type": "registered"
}
```

`destination_type` defaults to `registered`, meaning the authenticated merchant
asserts this is its customer's registered number. `alternate` is accepted only
after the merchant's alternate-destination setting has platform approval;
otherwise the API returns HTTP 403 `alternate_destination_disabled`.

`queued` means accepted for processing, not sent. Verify with:

```http
GET /v1/transfers/verify/withdrawal-456
```

Never create a replacement for `provider_pending`, `unknown` or `manual_review` until platform reconciliation completes.

The transfer response includes `status_url` for the hosted progress animation and
`status_api_url` for scoped polling. Both contain an opaque browser token and
must not be treated as merchant authentication.

The same token opens a Server-Sent Events stream at
`GET /v1/hosted/transfers/{reference}/events?token=...`. It emits a
`transfer.status` event immediately and then only when status or provider
transaction ID changes. The terminal event is included before the server closes.
The event `data` is the hosted transfer object directly, not the standard API
envelope. It includes `merchant_name`; normal merchant create/verify responses do
not. Browser `EventSource` must not send the merchant secret key.

Current transfer responses include `created_at`, a non-negative `eta_seconds`,
`estimated_completion_at`, `status_url`, and `status_api_url`. ETA is an estimate,
not a terminal-state guarantee.

`GET /v1/banks` returns Telebirr with code `855`. The create request accepts
either numeric `855` or string `"855"`. `GET /v1/balances` returns merchant
available, reserved, pending, and aggregate physical-liquidity indicators; it
never exposes individual fleet wallets. `available` may be negative only when
authoritative post-commit evidence exceeds the reserved provider fee or
contradicts an earlier manual failure resolution; the platform exposes the debt
and reconciliation case instead of hiding the real provider outflow.

## Merchant Telebirr settlements

Create a request for platform review:

```http
POST /v1/settlements
Idempotency-Key: settlement-789

{
  "reference": "settlement-789",
  "account_number": "0912345678",
  "expected_name": "Merchant Treasury",
  "amount": "25000.00",
  "currency": "ETB"
}
```

Creation only records `requested`; it does not move money. Platform staff must
approve or reject it. Approval dispatches a normal fenced Telebirr transfer and
the merchant pays principal, actual provider fee/VAT, and configured gateway
fee. Use `GET /v1/settlements/{reference}` or `GET /v1/settlements`. Possible
states are `requested`, `approved`, `rejected`, `dispatched`, `success`,
`failed`, `unknown`, and `manual_review`. Never request a replacement for
`unknown` before reconciliation. Lifecycle notifications use
`settlement.updated`.

## Approved liquidity-sweep rules

Merchant sweep-rule endpoints are:

- `POST /v1/sweep-rules`
- `GET /v1/sweep-rules`
- `GET /v1/sweep-rules/{id}`
- `PUT /v1/sweep-rules/{id}`
- `DELETE /v1/sweep-rules/{id}` with a JSON `reason`

The platform supplies `group_id` during onboarding. A new or replaced rule is
`pending` until platform approval. Replacement increments `version` and always
requires reapproval. Disabling prevents new executions but does not cancel a
transfer that already crossed its commit boundary.

`target_balance` must be lower than `high_water_balance`. Each execution also
honors reserved liquidity, the group safety balance, daily headroom,
`max_per_run`, and `minimum_interval_seconds`. A `merchant_owned` destination
exits platform custody and debits merchant principal and fees. A
`platform_treasury` destination must match an active wallet preapproved by the
platform. It is an internal custody move: only the provider fee is charged to
the merchant, while the principal is reclassified from fleet Telebirr custody
to treasury custody and added to the treasury wallet's predicted balance.
Destinations must not be enrolled fleet SIMs. Approved rules execute
automatically only in the live environment. Merchants receive
`sweep.updated` events containing the rule and linked transfer references; no
merchant endpoint exposes the source SIM identity.

## Idempotency

The first request fixes the payload for an idempotency key. Repeating the same
payload returns the original resource. Reusing the key/reference with different
content returns HTTP 409 `duplicate_reference_conflict`.

If the header is absent, deposits/top-ups use `tx_ref`, transfers/settlements use
`reference`, sweep creation uses `name`, and sweep update/disable or webhook
delivery replay uses the resource ID. Webhook registration derives a stable key
from its URL. Supply a new explicit key for each intentional later sweep-rule
replacement.

## Webhooks

Register an HTTPS receiver with `POST /v1/webhooks` and an `Idempotency-Key`.
Persist the returned `data.secret` before discarding the response. An exact
idempotent replay of the registration returns the same endpoint and secret;
`GET /v1/webhooks` never returns secrets. Use
`GET /v1/webhooks` to list endpoints and
`POST /v1/webhooks/deliveries/{deliveryId}/replay` with an idempotency key for an
audited manual replay.

Use `PATCH /v1/webhooks/{endpointId}` to disable or re-enable delivery. Use
`POST /v1/webhooks/{endpointId}/rotate-secret` with a mandatory new
`Idempotency-Key` for each intentional rotation. If the response is lost,
retrying with the same key returns the same one-time secret; never retry a
rotation with a different key merely because the first response timed out.

Production receiver URLs must use HTTPS, must not contain URL credentials or a
fragment, and must resolve exclusively to public Internet addresses. Private,
loopback, link-local, carrier-NAT, multicast, documentation and other reserved
IPv4/IPv6 ranges are rejected. DNS is checked again for every attempt and the
outbound socket is pinned to that validated address. Redirect responses are not
followed; register the final receiver URL directly.

Verify before parsing business state:

```text
signed_payload = X-P2P-Timestamp + "." + exact_raw_request_body
X-P2P-Signature = "v1=" + HMAC_SHA256(webhook_secret, signed_payload)
```

Reject timestamps older than five minutes, deduplicate `event_id`, acknowledge
quickly with 2xx and process asynchronously. Delivery is at least once and
ordering is not guaranteed. Failed deliveries retry exponentially for up to 24
hours before becoming manually replayable. Event types are `deposit.updated`,
`topup.updated`, `transfer.updated`, `settlement.updated`, and `sweep.updated`.
Use the relevant verify/read endpoint before applying value.

## Test scenarios

With a test key, set top-level `test_scenario` to one of:

- Deposit: `success`, `wrong_amount`, `late`, `duplicate`, `ambiguous`
- Payout: `success`, `explicit_failure`, `delay`, `unknown`

Test mode never allocates a real phone or moves money.

`delay` leaves the test transfer queued so an integration can exercise its
progress UI. Complete it with a test key only:

```http
POST /v1/test/scenarios/transfers/{reference}/complete

{ "outcome": "success" }
```

`outcome` is `success`, `failed`, or `unknown`. The transfer must still be
`accepted` or `queued` on first use; an exact outcome replay returns the same
terminal result, while a changed outcome returns 409. Live keys receive HTTP
403.

Automatic sweep execution is intentionally live-only; test keys can exercise
rule CRUD and approval-facing integration shapes without dispatching a sweep.

Webhook retry and duplication are delivery-harness behaviors, not accepted
values of the financial request `test_scenario` field. Run the included signed
receiver with `WEBHOOK_RESPONSE_DELAY_MS` and
`WEBHOOK_FAIL_FIRST_ATTEMPTS`; replaying the same event ID verifies consumer
deduplication. See `tools/webhook-receiver/README.md`.

## Standard response and errors

Every response uses `status`, `message`, `code`, `data`, and `request_id`; the
same request ID is returned as `X-Request-Id`. ETB amounts are strings with two
fractional digits. Expected stable error codes include `validation_error`,
`unauthorized`, `forbidden`, `not_found`, `duplicate_reference_conflict`,
`active_intent_exists`, `insufficient_merchant_balance`,
`no_physical_liquidity`, `alternate_destination_disabled`,
`invalid_webhook_url`, `rate_limited`, `invalid_state`, and `internal_error`.
