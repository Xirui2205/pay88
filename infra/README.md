# Infrastructure and immutable releases

This directory contains two deliberately separate environments:

- `docker-compose.yml` is a localhost-only development dependency stack.
- `terraform/digitalocean` is the DigitalOcean Frankfurt infrastructure baseline.

Neither one contains production secrets. Production secrets belong in the deployment secret manager and are injected into containers at runtime.

## Local dependencies

```bash
docker compose -f infra/docker-compose.yml up -d
docker compose -f infra/docker-compose.yml ps
docker compose -f infra/docker-compose.yml down
```

The ports bind to `127.0.0.1`, not the workstation LAN:

| Dependency | Local endpoint |
|---|---|
| PostgreSQL 16 | `localhost:5432` |
| Valkey 8 | `localhost:6379` |
| RabbitMQ AMQP / UI | `localhost:5672` / `localhost:15672` |
| S3-compatible evidence store | `localhost:9000` |
| Mailpit SMTP / UI | `localhost:1025` / `localhost:8025` |

The S3 development service is SeaweedFS `mini`, pinned to a maintained release. Its host endpoint remains port 9000 to match `.env.example`; the container endpoint is port 8333. It pre-creates `telebirr-evidence` unless `OBJECT_STORAGE_BUCKET` overrides it. It is a simulator, not the production object store.

To replace development credentials without editing a tracked file:

```bash
POSTGRES_PASSWORD=... RABBITMQ_PASSWORD=... \
OBJECT_STORAGE_ACCESS_KEY=... OBJECT_STORAGE_SECRET_KEY=... \
docker compose -f infra/docker-compose.yml up -d
```

## Container targets

All builds use the repository root as context and require the committed `package-lock.json`.

```bash
docker build -f apps/api/Dockerfile --target runtime -t telebirr-api:dev .
docker build -f apps/api/Dockerfile --target migration -t telebirr-api-migration:dev .
docker build -f infra/docker/web.Dockerfile --build-arg APP=admin -t telebirr-admin:dev .
docker build -f infra/docker/web.Dockerfile --build-arg APP=merchant -t telebirr-merchant:dev .
docker build -f infra/docker/web.Dockerfile --build-arg APP=checkout -t telebirr-checkout:dev .
```

The API runtime is non-root and contains production dependencies only. The migration target is a one-shot image that includes the pinned Prisma CLI. Never run the migration image as a network service.

## Image publication

`.github/workflows/release-images.yml` publishes immutable GHCR images for semver tags and manual releases. Each image receives:

- semver and Git SHA tags;
- OCI metadata;
- BuildKit provenance;
- an SBOM.

Set the GitHub Actions repository variable `PUBLIC_API_BASE_URL` to the browser-visible HTTPS API base (for example, `https://api.example.com/v1`) before publishing portals on separate origins. If it is unset, portal builds use `/v1` and the edge proxy must route that path to the API. The API CORS allowlist and portal routing must be qualified together.

Deploy by digest, not a mutable tag. Record the API, migration and portal digests in the release ticket.

## Production release order

1. Verify database PITR, the latest restore drill and RabbitMQ quorum health.
2. Verify the exact image digests and vulnerability/signature policy.
3. Stop if an unknown payout or ledger drift incident is active.
4. Run the matching `api-migration` image once with `DATABASE_URL` from the secret manager.
5. Confirm migration exit code zero and run API smoke tests against the old pool.
6. Start the green API pool with the new digest and wait for `/health/ready` on every replica.
7. Run server-to-server API, webhook, device lease and simulator smoke tests against green.
8. Move load-balancer traffic to green gradually. Monitor 5xx, queue lag, database locks and ledger invariants.
9. Publish the three portal digests after the API contract is healthy.
10. Keep blue stopped but intact for the defined observation window, then remove it.

Application rollback is permitted only when the migrated schema remains backward compatible. Never reverse a financial schema migration ad hoc. If it is not backward compatible, keep the new API and execute the reviewed forward-fix procedure.

## Production gates outside Terraform

The Terraform module creates infrastructure; configuration management or the release orchestrator must still provide:

- host-level container runtime configuration and digest-pinned service definitions;
- RabbitMQ node discovery, a shared Erlang cookie, TLS, quorum queues, definitions and monitoring;
- device-gateway end-to-end mTLS termination and certificate revocation;
- API and OpenClaw runtime secrets;
- DNS records and certificate coverage for both public load balancers;
- TLS hosting/routing for all three portals, plus either same-origin `/v1` proxying or an explicit API CORS allowlist;
- a bucket-scoped application Spaces key distinct from Terraform credentials;
- monitoring exporters, centralized logs, alerts and restore automation.

Do not call a deployment production-ready until these gates and the pilot acceptance tests are signed off.

## Dedicated device ingress

The Terraform baseline exposes TCP `8443` and passes it through to host port
`3443`. Run HAProxy there using `haproxy/device-mtls.cfg.tmpl`; the ordinary
public HTTPS ingress must not proxy `/v1/device/*` and must strip any supplied
`x-client-cert-verified`, `x-client-cert-sha256`, and
`x-device-ingress-secret` headers without replacing them.

At deployment time, obtain `DEVICE_MTLS_PROXY_SECRET` from the secret manager,
substitute the template placeholder without logging the value, and write the
rendered configuration to a root-readable runtime path. Mount a combined server
certificate/private-key PEM as `/run/secrets/device-ingress.pem` and the
approved device-client CA as `/run/secrets/device-client-ca.pem`. Inject the
same secret into the API service, but never give it to the public load balancer,
the public HTTP proxy, Terraform, a container image, or an Android device.

Set the API-visible enrollment endpoint to:

```text
DEVICE_GATEWAY_URL=wss://<api-host>:8443/v1/device/connect
```

HAProxy terminates verified client mTLS, strips all incoming certificate and
ingress-secret headers, and then sets trusted values for the loopback API
backend. The API requires the ingress secret as well as the verified client
fingerprint, and device activation pins that certificate. Test a valid device,
an untrusted certificate, no certificate, a spoofed-header request on public
HTTPS, and certificate revocation before release.

## Production dependency readiness

`REDIS_URL` and `RABBITMQ_URL` are mandatory in production. `/health/ready`
actively probes PostgreSQL, Redis, and the durable RabbitMQ exchange; no replica
may receive traffic when any probe fails. Process-local fallbacks exist only for
development. Merchant API admission is distributed through Redis and defaults
to 2,000 requests per API key per minute through
`MERCHANT_API_RATE_LIMIT_PER_MINUTE`.
