# Portal access and human authentication

Merchant and platform portals use individual human accounts. Merchant secret API keys, device certificates, webhook secrets, and portal session tokens are separate credentials and are not interchangeable.

## Bootstrap

Set `BOOTSTRAP_PLATFORM_ADMIN_EMAIL`, `BOOTSTRAP_PLATFORM_ADMIN_NAME`, and a non-placeholder 20+ character `BOOTSTRAP_PLATFORM_ADMIN_PASSWORD` only before the first production seed in a new controlled environment. Production bootstrap is create-once and refuses to run when any platform staff already exists; it never resets or reactivates an account. Remove the password from the deployment environment immediately after creation. Later recovery must use the separately audited break-glass workflow.

Creating a merchant at `POST /v1/admin/merchants` requires `owner_email`. The response contains an owner invitation token once. Deliver it through an approved private channel; the owner accepts it through `POST /v1/portal/auth/invitations/accept` and chooses a password of at least 12 characters.

## Sessions and roles

- Merchant roles: `owner`, `admin`, and `support`. Owners and administrators can manage integration keys. Only owners can invite another owner.
- Platform roles: `admin`, `operator`, `support`, and `auditor`. Support and auditor sessions are read-only for platform administration.
- Human sessions expire after 12 hours and can be revoked immediately. Browser applications keep the opaque session token in session storage, so closing the tab removes it.
- Login attempts are rate limited by normalized email and source address. Redis provides the shared production counter.

## Sensitive platform actions

Before a sensitive override, call `POST /v1/admin/auth/reauthenticate` with the staff password. Send the returned five-minute, single-use token as `X-Reauth-Token` on exactly one sensitive request.

`ADMIN_API_TOKEN` is not a staff login. It is reserved for service automation and emergency break-glass use. Sensitive calls made with it must include `X-Break-Glass-Reason` (at least 10 characters); the request is written to the immutable audit log. Rotate the token after emergency use.

## Versioned settings and approvals

Settings are not read-only. Merchant owners and administrators can submit a
merchant-scoped proposal at `POST /v1/portal/settings/changes` and view their
history at `GET /v1/portal/settings/changes`. The Settings UI obtains the active
approved or baseline policy from `GET /v1/portal/settings/current`; merchant
support users cannot submit changes. The request contains a complete `proposed`
object and an audited `reason`. Supported merchant values cover alternate withdrawal numbers,
deposit minimum/maximum and wrong-amount tolerance, provider/gateway fee
reserves, countdown/late-grace periods, and the hosted technical-difficulty
message.

Platform staff use these reviewed endpoints:

- `GET /v1/admin/configuration/changes?status=pending|approved|rejected`
- `POST /v1/admin/configuration/changes` for platform-default, merchant, or
  device-group proposals
- `POST /v1/admin/configuration/changes/{changeId}/approve`
- `POST /v1/admin/configuration/changes/{changeId}/reject`

Proposal, approval and rejection require a reason; platform writes require an
authorized write role and the proposal/review operations require password
reauthentication. Approval persists a new version atomically. Runtime balance
staleness, capacity safety factor, default deposit timings, wallet ceilings,
daily limits and safety headroom are read from the approved policy. Pending or
rejected values never affect scheduling or money movement.

## Treasury wallets and alerts

Platform-only treasury controls are `GET/POST /v1/admin/treasury-wallets` and
`POST /v1/admin/treasury-wallets/{walletId}/balance-evidence`. Creating or
updating the preapproved destination and recording confirmed balance evidence
require password reauthentication and an audited reason. A treasury number
cannot also be an enrolled fleet SIM. The balance-evidence action updates both
confirmed and predicted balance; it is evidence-backed reconciliation, not an
unlogged adjustment.

`GET /v1/admin/alerts` returns durable operational alerts together with their
Telegram delivery attempts. `POST /v1/admin/alerts/configuration` stores the
chat destination and enabled alert types after password reauthentication;
an empty `enabled_types` array disables all Telegram routing. The
`TELEGRAM_BOT_TOKEN` remains a deployment secret and is never returned or
stored in this setting. Staff can test routing, acknowledge an alert, and
resolve it through the corresponding `/v1/admin/alerts/...` actions. Resolution
requires password reauthentication.

## Merchant support cases

Every authenticated merchant user can open and follow a tenant-scoped case at
`/v1/portal/support/cases`. A case records its `test` or `live` environment,
category, subject, optional transaction reference, discussion, controlled
evidence references and an optional proposed match. The supported categories
are transaction matching, withdrawal outcome, top-up, settlement, webhook,
API, and other. A closed case rejects further merchant messages until platform
staff reopen it.

All platform roles can use `GET /v1/admin/support/cases` to search across
merchants. Platform administrators and operators may add a reply and move the
communication workflow through `open`, `investigating`,
`awaiting_merchant`, `resolved`, or `closed`. Status changes require a reason
and follow the allowed transition graph; support and auditor roles remain
read-only. Merchant and platform responses are
documented in the OpenAPI contract with their distinct session credentials.

Support evidence and proposed matches are advisory. Creating a proposal,
replying, or marking a support case resolved never posts a journal, matches a
receipt, resolves a reconciliation case, or retries a payout. The response
therefore reports `financial_resolution_performed: false`; any financial action
must use the separately authorized, reauthenticated and audited reconciliation
workflow.

These human-session and platform-control routes are intentionally separate from
the external merchant-secret OpenAPI contract.

Set `VITE_DEMO_MODE=false` for deployed portals. Demo data is loaded only when the flag is explicitly `true`.
