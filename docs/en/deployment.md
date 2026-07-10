# Cloud Deployment Runbook

## Environments

Create physically/logically isolated `test`, `staging` and `production` environments. The reference production deployment uses DigitalOcean Frankfurt; application containers and S3/PostgreSQL/Redis/AMQP interfaces remain portable to Alibaba Cloud.

## Provisioning order

1. Create private VPC, restricted management network, load balancer and DNS.
2. Provision managed PostgreSQL with multi-node failover, encryption and point-in-time recovery.
3. Provision managed Redis for cache/rate limiting only; never make it the ledger source of truth.
4. Provision three RabbitMQ nodes using quorum queues and TLS.
5. Create encrypted object storage with versioning and retention policy.
6. Create at least two API/device-gateway VMs in separate failure domains.
7. Create a separate OpenClaw VM/OS identity with private-only ingress.
8. Store secrets in the cloud secret manager; generate device-job and webhook keys offline or in KMS.
9. Apply database migrations once, then deploy immutable containers with health/readiness checks.
10. Issue TLS certificates, expose only public API/checkout, and keep internal/admin/device routes behind their designated controls.

## Required production runtime

Production requires reachable PostgreSQL, Redis and RabbitMQ. Set `REDIS_URL`
and `RABBITMQ_URL`; process-local cache/events are development fallbacks only.
`/health/ready` executes a database probe, Redis `PING` and RabbitMQ exchange
check and returns unavailable if any dependency fails. The public load balancer
must only route a replica after this check succeeds.

Merchant API admission uses a Redis-backed fixed-minute counter shared by every
API replica. `MERCHANT_API_RATE_LIMIT_PER_MINUTE` defaults to `2000` requests
per API key per minute; change it only through a reviewed production setting
and load test. A Redis outage removes readiness instead of silently changing to
per-process enforcement.

## Device mTLS ingress

Device WebSockets use a dedicated TLS path, separate from the public HTTPS
ingress:

1. The DigitalOcean load balancer forwards TCP `:8443` unchanged to HAProxy
   `:3443` on an application host. Set
   `DEVICE_GATEWAY_URL=wss://<api-host>:8443/v1/device/connect`.
2. Render `infra/haproxy/device-mtls.cfg.tmpl` at deployment time with a
   high-entropy `DEVICE_MTLS_PROXY_SECRET`. Keep the rendered file root-readable
   and mount the server certificate/key at `/run/secrets/device-ingress.pem`
   and the approved device-client CA at `/run/secrets/device-client-ca.pem`.
3. Give the same proxy secret only to HAProxy and the API containers. Never put
   it in an image, Terraform state, logs, the public load balancer, or the normal
   public HTTP ingress.
4. HAProxy requires a valid client certificate, rejects non-device paths,
   deletes any client-supplied `x-client-cert-verified`,
   `x-client-cert-sha256`, and `x-device-ingress-secret` headers, then creates
   those headers from the verified TLS session. It forwards only to the loopback
   API listener.
5. Keep `/v1/device/*` off the public route. The ordinary public ingress must
   also strip all three headers and must never set them or know the proxy
   secret. The API additionally requires the ingress secret and verified
   certificate fingerprint, and activation pins the certificate to the enrolled
   device. The proxy secret is a defense-in-depth channel credential, not a
   replacement for mTLS.

## Release

1. Build signed, immutable images and produce an SBOM.
2. Run unit, integration, migration and contract tests.
3. Deploy the inactive blue/green pool and run smoke tests against test keys.
4. For a flow-profile upgrade, publish a new numeric profile version and wait until every qualified phone reports it installed. Never replace signed content at an existing ID/version.
5. Drain legacy leased/started jobs to a terminal or `unknown` state. The scheduler may upgrade only never-delivered `queued` jobs, with a newly allocated fencing token; verify the corresponding audit records before reopening payouts.
6. Drain public requests, webhook workers and device connections in order; never terminate committed jobs without preserving their state.
7. Switch the load balancer, monitor error/queue/ledger metrics and retain the old pool for rollback.
8. Database changes must be backward compatible until the old pool is removed.

## Backups and recovery

- PostgreSQL PITR target RPO: five minutes; exercise restore quarterly.
- Daily encrypted database backup: 30 days; monthly archive: 12 months.
- Structured financial/audit records: seven years by default.
- Raw encrypted SMS/USSD evidence: 180 days by default, then retain parsed/redacted fields.
- Back up webhook configuration, flow-profile signing keys and public certificates separately.
- Never back up Android wallet PINs.

## OpenClaw

Install the official Gateway and DeepSeek provider on its isolated host. Install
the local advisory plugin, enable only declared Telebirr read tools and deny
exec/node/gateway/filesystem mutation. Use two unrelated credentials:

- `OPENCLAW_TOOL_TOKEN` is accepted by this platform's `/internal/ai/*`
  read/propose endpoints and cannot call merchant, platform-admin, device, or
  payment endpoints.
- `OPENCLAW_GATEWAY_TOKEN` is used only for the isolated Gateway's
  `/v1/responses` interface. Current OpenClaw documentation treats that bearer
  as full operator scope, so store it only on the payment-core worker and
  isolated Gateway, restrict network reachability, and never reuse it as the
  tool token.

Rotate both independently and verify the previous value fails.

## Production validation

Check migrations, balanced ledger probe, live RabbitMQ/Redis readiness,
object-storage encryption, webhook signature, the dedicated device mTLS path,
certificate revocation, Telegram alert and a full backup restore before
production traffic.
