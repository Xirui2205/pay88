# Backup, Restore and Disaster Recovery

## Recovery objectives and ownership

Production targets are RPO at most five minutes and RTO at most one hour. The incident commander authorizes failover; the database operator restores PostgreSQL; the payments lead verifies journals, unknown payouts and physical-wallet drift before traffic resumes. Android PINs are intentionally unrecoverable from cloud backups.

## Backup set

- Managed PostgreSQL continuous WAL/PITR plus encrypted daily and monthly snapshots.
- Versioned encrypted object storage for evidence and exported audit artifacts.
- Terraform state in a separately encrypted, locked backend with version history.
- Encrypted copies of public certificates, webhook configuration and signed USSD profiles.
- Secret-manager metadata and rotation procedures, not plaintext secrets in the backup archive.

RabbitMQ and Redis are rebuildable delivery/cache systems. Restore authoritative rows and outbox state from PostgreSQL, recreate queues, and allow idempotent consumers to replay.

## Quarterly restore exercise

1. Freeze a production recovery timestamp and create an isolated recovery VPC.
2. Restore PostgreSQL to that timestamp and restore the matching object-storage version set.
3. Deploy the same immutable release and run migrations only if the documented release requires them.
4. Verify every sampled journal balances to zero; compare account totals with the predeclared control totals.
5. Recreate RabbitMQ quorum queues and replay unpublished outbox records. Confirm inbox deduplication.
6. Keep device egress and merchant webhooks disabled while verifying committed, pending and unknown attempts.
7. Rotate recovery-environment credentials, revoke the test device certificates, and destroy the isolated environment after evidence is signed off.

## Regional outage failover

1. Stop public mutation or place it in maintenance mode; do not accept payouts against an uncertain primary database.
2. Establish the latest confirmed recovery point and promote only one PostgreSQL primary.
3. Deploy API/device gateways, RabbitMQ, Redis and object-storage routing in the recovery region.
4. Change DNS/load-balancer routing and reissue internal endpoints. Devices reconnect outbound and must reauthenticate with existing or rotated certificates.
5. Reconcile all jobs at or beyond `PIN_SUBMITTED` before releasing any replacement. Mark ambiguous cases `unknown`.
6. Run ledger, webhook backlog, SIM balance-age and queue-fencing checks before reopening deposits, then payouts.

## Credential compromise

Revoke the narrow credential first: merchant key, webhook secret, device certificate,
profile-signing key, `OPENCLAW_TOOL_TOKEN`, or the separately scoped
`OPENCLAW_GATEWAY_TOKEN`. A device-job signing-key compromise requires pausing
new device assignments, rotating the key, distributing the new public key
through a signed application/profile release, and invalidating all outstanding
jobs. Never bypass a device quarantine to meet RTO.
