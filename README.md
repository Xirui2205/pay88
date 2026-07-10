# Telebirr P2P Gateway V1

Greenfield implementation of a multi-merchant ETB gateway backed by a managed fleet of dual-SIM Android phones. The repository contains the payment API, immutable ledger, deterministic SMS/USSD engine, device control plane, operator and merchant portals, hosted checkout, Android agent, test simulator, SDKs, infrastructure and bilingual runbooks.

## Safety boundary

- The Android Telebirr Agent is the only component allowed to read financial SMS, navigate USSD or enter a locally encrypted PIN.
- OpenClaw and DeepSeek are advisory and cannot initiate, approve or retry money movement.
- A withdrawal becomes committed when the PIN is submitted. A committed or unknown attempt is never automatically retried.
- Provider transaction IDs, idempotency records and balanced journals prevent duplicate credits and transfers.
- Never put real wallet PINs, API keys or unredacted production SMS in this repository.

## Repository

- `apps/api` — NestJS API, ledger, matching, scheduling, device gateway and webhook workers.
- `apps/admin` — Element Plus platform administration.
- `apps/merchant` — restricted merchant portal.
- `apps/checkout` — hosted deposit countdown and withdrawal progress.
- `apps/device-agent` — Kotlin Android agent with dual-SIM SMS and deterministic USSD state machine.
- `packages/contracts` — shared public types and schemas.
- `integrations/openclaw-telebirr` — restricted OpenClaw/DeepSeek tools.
- `sdk` — first-party Node/TypeScript and PHP clients.
- `infra` — local Docker and reference cloud deployment.
- `docs` — English and Simplified Chinese specifications and runbooks.

## Local development

Requirements: Node.js 22+, npm 10+, Docker with Compose. Android builds additionally require JDK 17 and an Android SDK.

```bash
npm install
docker compose -f infra/docker-compose.yml up -d postgres valkey rabbitmq object-storage
npm run prisma:generate
npm run prisma:migrate
npm run dev:api
```

Run all available verification:

```bash
npm run typecheck
npm test
npm run build
```

The test environment uses test keys and deterministic carrier scenarios. It never requires a phone or moves real money.

## Documentation

Start with [the documentation index](docs/README.md), [the English implementation guide](docs/en/architecture.md) or [中文实施指南](docs/zh-CN/architecture.md). Give nontechnical installers the click-by-click [English simple setup guide](output/pdf/telebirr-field-phone-installation-en.pdf) or [简体中文简单安装指南](output/pdf/telebirr-field-phone-installation-zh-CN.pdf). The [English operator manual](output/pdf/telebirr-phone-installation-en.pdf) and [简体中文运维手册](output/pdf/telebirr-phone-installation-zh-CN.pdf) remain technical references for supervisors.
