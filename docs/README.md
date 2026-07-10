# Documentation index / 文档目录

## English

- [Simple phone setup — click-by-click](en/field-phone-installation.md)
- [Portal access and human authentication](en/portal-access.md)

- [Architecture and financial invariants](en/architecture.md)
- [Merchant API integration](en/api-integration.md)
- [Phone installation and qualification](en/phone-installation.md)
- [Operations and reconciliation](en/operations.md)
- [Cloud deployment](en/deployment.md)
- [USSD and SMS profile fixtures](en/ussd-profiles.md)

## 简体中文

- [简单手机安装指南 — 逐步点击](zh-CN/field-phone-installation.md)
- [门户访问与人员身份验证](zh-CN/portal-access.md)

- [架构与财务不变量](zh-CN/architecture.md)
- [商户 API 接入](zh-CN/api-integration.md)
- [手机安装与验收](zh-CN/phone-installation.md)
- [运营与对账](zh-CN/operations.md)
- [云端部署与升级](zh-CN/deployment.md)
- [USSD 与短信样本](zh-CN/ussd-profiles.md)

## Downloadable controlled copies / 可下载受控版本

- [Simple phone setup guide - English](../output/pdf/telebirr-field-phone-installation-en.pdf)
- [简单手机安装指南 - 简体中文](../output/pdf/telebirr-field-phone-installation-zh-CN.pdf)
- [Phone manual - English](../output/pdf/telebirr-phone-installation-en.pdf)
- [手机手册 - 简体中文](../output/pdf/telebirr-phone-installation-zh-CN.pdf)
- [Operations runbook - English](../output/pdf/telebirr-operations-runbook-en.pdf)
- [运营对账手册 - 简体中文](../output/pdf/telebirr-operations-runbook-zh-CN.pdf)
- [开发者部署手册 - 简体中文](../output/pdf/telebirr-deployment-guide-zh-CN.pdf)

## Additional guides / 补充指南

- [MDM, OpenClaw and DeepSeek setup](en/openclaw-mdm.md) / [中文](zh-CN/openclaw-mdm.md)
- [Backup, restore and disaster recovery](en/disaster-recovery.md) / [中文](zh-CN/disaster-recovery.md)
- [Migration notes for Chapa integrators](en/chapa-migration.md) / [中文](zh-CN/chapa-migration.md)

The PDF files are generated from the Markdown sources with `tools/generate_manual_pdfs.py`; edit the Markdown first, regenerate, render to PNG and visually verify before releasing.

## API contract and examples / API 契约与示例

- [OpenAPI 3.1 specification](openapi/telebirr-p2p-v1.yaml)
- [Runnable curl, Node/TypeScript SDK, PHP SDK, and Python examples](examples/README.md)
- [Postman collection](postman/Telebirr-P2P-V1.postman_collection.json)

The merchant contract covers customer deposits, merchant liquidity top-ups,
Telebirr withdrawals, scoped hosted polling/SSE, platform-approved merchant
settlements, approved sweep-rule CRUD, aggregate balances, delayed test-scenario
completion, and idempotent signed webhooks. Human portal/configuration, alert and
treasury controls remain an internal operator surface documented in the portal
and operations manuals, except that the tenant-scoped merchant/platform support
case exchange is included in OpenAPI with separate portal-session schemes.

商户契约包括客户入金、商户流动性充值、Telebirr 提现、受限 Token 的托管轮询/SSE、
需平台审批的商户结算、经审批的 Sweep 规则 CRUD、汇总余额以及幂等签名 Webhook；
还包括延迟测试场景的完成控制。人员门户、配置审批、告警和 treasury 控制仍属于内部
运营端，并记录在门户与运营手册中；唯一例外是租户隔离的商户/平台支持工单交换，
该部分使用独立门户会话认证并已包含在 OpenAPI 中。

The OpenAPI file is the checked-in public contract. The generated Swagger route
is useful for development, but integrations should pin a reviewed version of the
checked-in specification. / OpenAPI 文件是版本化的公开契约；集成方应固定使用已审核的版本。
