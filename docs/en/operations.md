# Operations and Reconciliation Runbook

## Unknown withdrawal

1. Freeze the withdrawal and its SIM reservation; never retry.
2. Confirm the job reached `PIN_SUBMITTED` and preserve the signed step log.
3. Search the attributed SMS inbox, including multipart recovery and messages received while offline.
4. Run a low-priority balance query only after the USSD session is closed.
5. Compare predicted balance, queried main balance, principal, expected fee/VAT and later transactions.
6. If an outgoing provider transaction ID is found, attach evidence and mark success through an audited compensating workflow.
7. If explicit provider failure is proven, mark failed and release the merchant reservation.
8. If evidence remains inconclusive, keep manual review; do not send replacement money.

## Unmatched deposit

1. Deduplicate provider transaction ID and place receipt value in suspense once.
2. Search intents on the receiving SIM by amount/time, then sender suffix and normalized name.
3. Auto-match only if exactly one candidate satisfies policy; otherwise preserve evidence for support.
4. Merchant support may propose an intent; platform staff verify the sender/amount/time and approve.
5. Post a single balanced journal from suspense to merchant/customer credit and emit a new unique webhook event.

## Device offline

- At 90 seconds: stop new assignment. If a money-moving job was already delivered/leased to the handset, expiry becomes `unknown` and every financial reservation remains held because local PIN entry may have occurred before the cloud received the next status event.
- At three minutes: mark offline and alert dashboard/Telegram.
- Check power, network and MDM before remote intervention.
- Only a queued job that was never delivered, or an explicit signed device failure proven before PIN entry, may be requeued with a higher fencing token. Any delivered/leased money job that loses its lease becomes `unknown`; it must not be retried or reassigned until reconciliation proves the outcome. A committed attempt remains bound to the original device.
- After recovery, replay the local SMS/job spool, reconcile SIM identity and run a fresh balance query before payouts resume.

## SIM swap or attribution uncertainty

Quarantine the SIM and phone, stop all USSD, record current ICCIDs/subscription IDs, reconcile both wallets, update inventory only with platform approval, then repeat the complete dual-SIM qualification.

### Audited recovery, credential rotation and retirement

1. Resolve or expire every deposit assignment and reconcile every pending/unknown payout on both SIMs. Recovery and retirement are blocked while financial work remains.
2. In Fleet, choose **Recover / re-enroll**, reauthenticate, enter the full physical ICCID, Telebirr number and registered account name for every SIM, and record an audited reason.
3. The recovery action atomically revokes the old device token and certificate, invalidates activation codes, makes all balances stale, creates a new qualification run and displays one short-lived activation code.
4. Activate the signed agent, verify both subscription mappings, run fresh balance queries, repeat reboot/permission/SMS/USSD/transfer checks, and obtain a new platform approval. Heartbeats cannot reactivate the device by themselves.
5. For permanent removal, choose **Retire**. Retirement disables the device credentials and SIM assignments. Reusing those SIMs on replacement hardware must use the same audited recovery flow with **replacement handset** selected; never create duplicate inventory or edit the database directly.

## High/low liquidity

- High water schedules a low-priority sweep leaving the configured target plus maximum fee.
- Low payout liquidity stops new withdrawals with `no_physical_liquidity`; do not overdraw against merchant ledger alone.
- Sweeps and settlements count against the SIM daily limit and use the same commit/unknown rules as withdrawals.
- A `platform_treasury` sweep requires an active preapproved treasury wallet with matching number/name. On confirmed success, increase its predicted balance and reclassify principal from fleet custody to treasury custody.
- Staff balance confirmation for a treasury wallet requires password reauthentication, a reason and an evidence reference. Investigate fleet, treasury and total custody drift separately.

## Manual financial actions

Require platform role, password reauthentication, reason, linked evidence and immutable audit event. Never update or delete an existing journal; post a compensating journal.

The reconciliation screen uses joined case, transfer, attempt, device, SIM and receipt records. It exposes only state-safe actions:

- Cancel only `accepted`, `queued` or `device_assigned` transfers whose job has not been leased.
- For a receiver-name case cancelled before commit, type the exact provider-observed name and create one new fenced attempt after password reauthentication.
- Resolve an unknown success only with provider transaction ID, service fee and VAT evidence.
- Resolve an unknown failure after commit only with a conclusive provider failure evidence reference.

Every action consumes a single-use reauthentication token and refreshes the case from the server. Never infer success or failure from the UI countdown.

## Configuration activation

Configuration changes are immutable proposals with `pending`, `approved`, or `rejected` status. Review the scope, full proposed value, version, proposer and reason before approval. Platform defaults use `scope_id=platform`; merchant and device-group proposals must reference an existing UUID. Approved platform and group limits are read by the scheduler, balance-staleness checks and capacity calculation. Do not edit database rows or treat a pending proposal as active.

## Durable alerts and Telegram delivery

Operational alerts are persisted with `open -> acknowledged -> resolved` lifecycle and immutable audit actions. Telegram delivery is a separate durable record with `pending|processing|delivered|failed`, a 30-second fenced lease and exponential retries (15 seconds up to one hour) for deliveries created within the prior 24 hours. A repeated alert with the same redacted metadata is deduplicated during the configured window.

The database stores only Telegram `chat_id`, enabled alert types and version. Keep `TELEGRAM_BOT_TOKEN` in the deployment secret environment. If delivery fails, inspect the saved attempt/error in `GET /v1/admin/alerts`; do not paste the bot token into the reason, metadata or UI. Acknowledge records ownership of an active incident; resolve only after the underlying condition and any financial reconciliation are complete.
