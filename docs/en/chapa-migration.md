# Migration Notes for Chapa Integrators

The API deliberately follows Chapa's initialize/verify/transfer vocabulary, but it is not a drop-in URL replacement. Treat the migration as a provider adapter change and keep server-side verification.

| Existing concept | V1 mapping | Required change |
|---|---|---|
| Secret/test key | `sk_live_<prefix>.<secret>` / `sk_test_<prefix>.<secret>` | Store separate keys and never expose them in a browser. |
| Initialize | `POST /v1/transaction/initialize` | ETB decimal strings; include a stable `customer_id`. |
| Checkout URL | `data.checkout_url` | Display a timed phone-payment instruction page. |
| Verify | `GET /v1/transaction/verify/{tx_ref}` | Read both coarse `status` and `p2p_status`; unknown only is 404. |
| Transfer | `POST /v1/transfers` | Use `bank_code=855`, phone as `account_number`, expected registered name, and `destination_type=registered` unless alternate destinations have platform approval. |
| Transfer verify | `/v1/transfers/verify/{reference}` | Handle queued, committed, provider-pending, unknown and manual review. |
| Callback/return URL | Compatibility/advisory fields | `return_url` is browser navigation. V1 does not guarantee direct `callback_url` delivery; use signed webhooks and verify. |
| Webhook | Raw-body HMAC | Verify `X-P2P-Timestamp` plus `X-P2P-Signature`, deduplicate `event_id`. |
| Merchant top-up | `POST /v1/topups/initialize` | Uses the initialize shape and verifies through the transaction endpoint. |
| Merchant settlement | `POST /v1/settlements` | Separate approval lifecycle; creation itself never proves dispatch. |

Every mutation is idempotent. Reusing a reference with a changed payload returns `409 duplicate_reference_conflict`; it never silently mutates the original resource. Webhooks are at least once and may arrive out of order, so persist event IDs and verify the resource after each terminal event.

Before live cutover, replay all deterministic test scenarios, compare old/new adapters in shadow mode without moving money, and prove that `unknown` payouts cannot create an automatic replacement.
