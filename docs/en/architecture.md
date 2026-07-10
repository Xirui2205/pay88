# Telebirr P2P Gateway V1 Architecture

## Purpose

The platform exposes a familiar asynchronous payment API while moving money through a controlled fleet of private Telebirr wallets. PostgreSQL journals are the financial source of truth; physical wallet balances are continuously reconciled evidence. The system accepts bursts independently from the slower, handset-serialized USSD execution rate.

## Trust boundaries

| Boundary | Permitted | Never permitted |
|---|---|---|
| Merchant API | Create/verify own intents and transfers; view aggregate ledger | Device identities, raw SMS, PINs, other merchants |
| Payment core | Reserve/post ledger, choose eligible wallet, issue signed jobs | Reading a PIN or directly driving Android UI |
| Telebirr Agent | Read attributed SMS, deterministic USSD, local PIN entry | Merchant authentication, ledger overrides, AI decisions |
| OpenClaw/DeepSeek | Redacted summaries, name-review advice, approval proposals | USSD, payout creation, retry, PIN, ledger posting |
| Platform staff | Role-scoped operations and audited manual resolution | Rewriting immutable journals or bypassing commit rules |

All phone connections are outbound. The device certificate, API key, webhook
secret, OpenClaw read/propose tool token, and broader Gateway operator token are
separate credentials with independent rotation and revocation. Device traffic
enters only through dedicated mTLS TCP ingress; the proxy strips client-supplied
certificate headers and recreates them from the verified TLS session.

## Financial invariants

1. Every journal balances to zero and is append-only. Corrections use compensating journals.
2. A provider transaction ID can create at most one receipt and one merchant credit.
3. A withdrawal has at most one committed attempt. `PIN_SUBMITTED` is the irreversible commit point.
4. Committed, provider-pending and unknown attempts are never automatically retried.
5. Physical balance cannot be used for payout assignment when stale, reserved or above its safe daily-limit utilization.
6. A new reservation is rejected when merchant available balance is
   insufficient. An authoritative provider-fee overrun or contradictory late
   success may create a visible negative balance; it opens reconciliation and
   blocks further value-moving requests until funded or resolved.
7. Money uses PostgreSQL `numeric` and public two-decimal strings, never floating point.
8. Browser redirects and callbacks are not proof of payment. Verification and signed webhook events are authoritative.

## Core components

- **Public API:** Chapa-near deposits, top-ups, transfers, provider discovery,
  aggregate balances, merchant settlements, approved sweep-rule management and
  signed webhook administration.
- **Payment core:** deposit/withdrawal state machines, idempotency, merchant policy and double-entry ledger.
- **Matching:** normalized SMS parsing, transaction-ID deduplication and deterministic intent selection.
- **Fleet scheduler:** eligibility, physical reservations, handset mutex, durable leases and fencing tokens.
- **Device gateway:** dedicated mTLS/WebSocket ingress, certificate-pinned activation, commands, heartbeat and offline spool acknowledgements.
- **Webhook dispatcher:** outbox-backed HMAC events with at-least-once delivery and replay.
- **Configuration control:** persisted, versioned platform/merchant/group
  proposals whose approved values drive runtime policy.
- **Alert engine:** durable deduplicated incidents and fenced Telegram delivery
  retries; the bot token remains outside the database.
- **Operator portals:** Element Plus platform administration, merchant portal and hosted checkout.
- **Android agent:** deterministic SMS/USSD execution, Keystore PINs and signed flow profiles.
- **Advisory gateway:** isolated OpenClaw with DeepSeek and read/propose-only tools.

## Deposit state machine

```text
awaiting_payment
  -> detected -> matching -> success
  -> late_grace -> detected -> matching -> success
  -> manual_review -> success | failed
  -> expired
```

- Customer instructions expire after 10 minutes.
- A unique receipt can auto-match for an additional 30 minutes.
- Ambiguous, late or policy-exception receipts move to suspense/manual review.
- `status` is coarse (`pending|success|failed`); `p2p_status` exposes the precise state.

Strong automatic matching requires the receiving SIM, unique transaction ID, acceptable amount/time and exactly one eligible intent. Sender suffix/name strengthen the match and prevent collisions. A score never overrides ambiguity.

## Withdrawal state machine

```text
accepted -> queued -> device_assigned -> device_started
-> pin_submitted -> provider_pending
-> success | failed | unknown | manual_review
```

An explicit pre-commit failure may release its device lease and requeue. After commit, a missing SMS becomes `unknown`; human reconciliation is mandatory. One withdrawal is sent from one SIM and is never split.

## Balance and limit model

Each SIM wallet stores queried and predicted values for:

- Main E-Money balance (spendable)
- Incentive, fuel and pocket balances (reported but restricted)
- Principal sent today
- Provider fees/VAT sent today
- Active payout/sweep reservations
- Wallet ceiling, daily limit and safety headroom

Transaction confirmations update predicted balance immediately. A low-priority `*127# -> NEXT -> MY_ACCOUNT -> QUERY_BALANCE` job obtains a full asynchronous SMS snapshot. A stale snapshot blocks payouts, retains its last value and schedules a refresh; it is never replaced by zero.

An approved platform-treasury sweep is not a custody exit. Its principal moves
from fleet Telebirr custody to the active preapproved treasury wallet and is
posted from `telebirr_custody` to `treasury_custody`; only the provider fee is
charged to the merchant. The administration dashboard compares fleet custody,
treasury custody and total custody against confirmed physical evidence and
shows drift separately.

## Delivery guarantees

- Public mutation: merchant reference plus optional `Idempotency-Key`.
- Database/event publication: transactional outbox.
- Queue consumers: idempotent inbox records.
- Device commands: lease, expiry, attempt and monotonically increasing fencing token.
- SMS: at-least-once upload, multipart assembly and raw-message hash.
- Webhooks: unique `event_id`, HMAC timestamp, at-least-once retry and dashboard replay.

## Capacity

API target is 1,000 deposit plus 1,000 withdrawal admissions per minute; load testing uses five times that rate. Actual payout rate is constrained by one USSD session per handset:

```text
safe transfers/minute = online qualified phones * 60 / measured p95 seconds * safety factor
```

The scheduler exposes queue ETA and rejects new withdrawals with a stable liquidity/capacity error when policy thresholds are exceeded.
