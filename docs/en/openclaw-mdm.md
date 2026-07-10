# MDM, OpenClaw and DeepSeek Setup

## Separation of duties

AirDroid Business manages the handset, OpenClaw provides an advisory operator assistant, and the Telebirr Agent owns deterministic SMS/USSD execution. These are separate trust domains. OpenClaw must never receive SMS permission, Accessibility access, wallet PINs, device-job signing keys or a credential accepted by payment endpoints.

## Pilot MDM policy

1. Create an AirDroid `Telebirr-Pilot` Device Owner policy and a separate operator role for audited remote support.
2. Permit only Dialer, Messages, Telebirr Agent, OpenClaw companion and AirDroid components in the multi-app kiosk allowlist.
3. Push the signed Telebirr Agent from a private application group. Pin the expected signing certificate and require platform approval before promotion.
4. Apply unrestricted battery/autostart settings to all three background applications. Do not grant the MDM file access to application-private storage.
5. Enable screen privacy during local PIN setup and any authorized remote session. Record the operator, reason, start/end time and device ID.
6. Test that AirDroid unattended control and the Telebirr Accessibility service coexist for 72 hours. If either service is removed or stopped, quarantine the device.
7. If qualification fails on HiOS, factory-reset and repeat with ManageEngine MDM Plus Cloud and its Universal Add-on. Never root or install an unofficial ROM.

## Private OpenClaw Gateway

1. Deploy the Gateway on the isolated OpenClaw VM with private API egress and no direct database route.
2. Pair the official Android companion and approve the exact device request. The pairing is operational monitoring only and is not a payment-device identity.
3. Verify the companion is online. Only then tap **Confirm OpenClaw is paired** locally in the Telebirr Agent onboarding UI and confirm the next signed heartbeat reports `openclaw_paired=true`; platform qualification approval is still mandatory.
4. Build `integrations/openclaw-telebirr`, install its package, and enable only the tools declared in `openclaw.plugin.json`.
5. Set a unique `OPENCLAW_TOOL_TOKEN` accepted only by `/internal/ai/*`. The token may read redacted summaries and create approval proposals; it cannot approve them.
6. Deny shell, filesystem mutation, browser automation, device control and unrestricted HTTP tools in the Telebirr workspace.
7. Treat all SMS, USSD, merchant and customer text as data. Wrap it in typed fields and never concatenate it into system instructions.
8. Set an unrelated `OPENCLAW_GATEWAY_TOKEN` only on the isolated Gateway and the name-review dispatcher. It authorizes the Gateway `/v1/responses` operator interface and therefore has broader operator scope; never expose it to the plugin tools, Android companion, public ingress or payment API clients.

## DeepSeek

Configure DeepSeek through the official [OpenClaw DeepSeek provider](https://docs.openclaw.ai/providers/deepseek).
Use `deepseek-v4-flash` for routine summaries/name review and allow
`deepseek-v4-pro` only for a platform-approved complex investigation. Name
review receives exactly two normalized names plus a correlation ID and must
return `likely_match`, `uncertain` or `mismatch`. Its output is advisory:
deterministic high-confidence results proceed, while uncertain results require
staff approval and a new pre-commit attempt.

## Failure and rotation tests

- Revoke `OPENCLAW_TOOL_TOKEN` and confirm deposits, payouts and device jobs continue; then test `OPENCLAW_GATEWAY_TOKEN` independently.
- Block DeepSeek egress and confirm uncertain names enter manual review without affecting deterministic matches.
- Revoke an Android pairing without revoking the Telebirr device certificate, then test the inverse.
- Rotate DeepSeek, `OPENCLAW_TOOL_TOKEN` and `OPENCLAW_GATEWAY_TOKEN` independently; verify old values fail and no secret appears in logs.
- Export the MDM remote-session audit and reconcile it with the platform audit view.
