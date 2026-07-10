# Security policy

## Reporting

Report suspected vulnerabilities privately to the designated platform security owner. Do not open a public issue containing phone numbers, wallet identities, SMS bodies, API keys, device certificates or reproduction steps against a live wallet.

## Secrets that must never enter source control

- Telebirr wallet PINs or SIM unlock PINs
- Merchant live/test secret keys
- Device private keys or activation codes
- Webhook signing secrets
- `OPENCLAW_TOOL_TOKEN` and the distinct full-operator-scope `OPENCLAW_GATEWAY_TOKEN`
- DeepSeek, MDM, Telegram or cloud-provider credentials
- Unredacted production SMS and receipt-link tokens

The Android Telebirr PIN is entered locally and encrypted with Android Keystore. It is never retrievable through the platform API, MDM, OpenClaw or backup.

## Financial safety invariants

- `PIN_SUBMITTED` is the irreversible withdrawal commit point.
- A committed, provider-pending or unknown withdrawal is never automatically retried.
- Provider transaction IDs and merchant references are merchant/environment scoped and idempotent.
- Historical ledger entries are immutable; manual correction uses balanced compensating journals.
- OpenClaw and DeepSeek have read/propose-only tools and no device, PIN, ledger or money-movement credential.

## Production hardening checklist

- Use private networking, TLS everywhere and mTLS for device connections.
- Terminate device mTLS only on the dedicated ingress. Strip client-supplied
  certificate/ingress headers before setting verified values, and never give
  `DEVICE_MTLS_PROXY_SECRET` to the public HTTP ingress.
- Store server secrets in a managed secret store/KMS and rotate them independently.
- Keep `OPENCLAW_TOOL_TOKEN` limited to read/propose tools; isolate and separately
  rotate the broader Gateway token accepted by `/v1/responses`.
- Restrict platform administration and MDM to the operations VPN/identity proxy.
- Keep Android bootloaders locked and use only approved stock firmware and signed APKs.
- Remove debug builds, developer mode, wireless ADB and USB debugging after qualification.
- Audit sensitive operator actions, remote sessions, profile releases and key rotations.
- Exercise backup restoration, certificate revocation and unknown-payment response before launch.

## 安全规则摘要

真实钱包 PIN、API Key、设备私钥、Webhook/OpenClaw/DeepSeek/MDM/云密钥、生产短信禁止进入代码库。Android PIN 只能在手机本机输入并由 Keystore 加密。提交 PIN 后的提现禁止自动重试；历史账本禁止修改，只能做平衡冲正；OpenClaw/DeepSeek 只能读取脱敏信息和创建待人工审批建议。`OPENCLAW_TOOL_TOKEN` 与权限更大的 `OPENCLAW_GATEWAY_TOKEN` 必须分离。设备 mTLS 入口必须删除客户端伪造的证书 Header 后再写入验证结果，公网入口不得取得 `DEVICE_MTLS_PROXY_SECRET`。
