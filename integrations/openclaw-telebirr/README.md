# OpenClaw Telebirr advisory tools

This plugin exposes a deliberately narrow surface to the private OpenClaw Gateway. It can read redacted operational summaries and create staff approval proposals. It has no tool for USSD, PIN entry, ledger posting, payout creation, retry or device execution.

## Install

Build and package this workspace, then install the generated package into the private Gateway. Configure:

```text
TELEBIRR_INTERNAL_API_URL=https://internal-api.example
TELEBIRR_OPENCLAW_SERVICE_TOKEN=<read-and-propose-only token>
DEEPSEEK_API_KEY=<DeepSeek key>
```

Select `deepseek/deepseek-v4-flash` as the routine model. Enable only the four tools declared in `openclaw.plugin.json`; keep `telebirr_propose_action` optional and approval-gated.

The service token must be accepted only by `/internal/ai/*`, must not be a merchant or platform administrator key, and must be independently revocable.
