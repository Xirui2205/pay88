# Telebirr Device Agent

Deterministic Android workload application for the Telebirr P2P Gateway V1. It is
qualified for Android 12 production handsets and keeps a minimum SDK of Android 8
(API 26). It never sends a Telebirr PIN to the cloud: a PIN is entered locally and
is encrypted by a non-exportable Android Keystore key.

## Safety boundaries

- Only signed, unexpired jobs and signed/versioned flow profiles are executable.
- A persistent fencing token rejects stale or duplicated device work.
- There is one process-wide USSD lease for the handset, including dual-SIM phones.
- A withdrawal is persisted as committed immediately before its PIN is submitted.
  It is never automatically retried or reassigned after that point.
- Unknown/ambiguous screens abort before commitment and become `unknown` after it.
- Subscription/ICCID attribution must be unique; SIM changes quarantine that SIM.
- Raw SMS/USSD evidence is encrypted before entering the Room offline spool.

The built-in send-money and balance-query profiles are templates for simulator and
replay tests. Production profile installation goes through `FlowProfileVerifier`,
which accepts only an exact signed payload from a pinned profile-signing key.

## Device protocol V1

Activation uses `POST /v1/device/activate` and the standard
`status/message/code/data/request_id` envelope. Its data supplies the one-time
device bearer token, WSS URL, heartbeat interval, signing key ID/public key and the
two enrolled SIM identities. The token is AES-GCM encrypted by Android Keystore at
rest. Pilot WebSocket setup uses `Authorization: Bearer …` and `X-Device-Id` over
WSS. Production can additionally require mTLS and a trusted-proxy certificate
fingerprint.

Jobs, flow profiles and lease renewals use the exact
`key_id/payload_base64/signature_base64` P-256/SHA-256 envelope. Fencing tokens are
positive monotonic integers. The canonical cross-runtime fixture is
`app/src/test/resources/protocol/device-protocol-v1.json`; both Kotlin and backend
contract tests verify its DER ECDSA signatures byte-for-byte.

## Building

Install JDK 17 and Android SDK 35, then run `gradle :app:testDebugUnitTest` from this
directory. A checked-in Gradle wrapper is intentionally omitted from this
greenfield source package; CI should use its pinned Gradle 8.7 distribution.

Before field use, inject the environment bootstrap trust key, qualify all Telebirr SMS and USSD
transcripts, and confirm AirDroid/Accessibility coexistence on the exact TECNO
build. No sample credential, certificate, or PIN is included.

## TECNO pilot qualification checklist

Use only the stock-signed CH9n Android 12 / HiOS 8.6 image. Factory-reset and
enroll the handset as an AirDroid Business Device Owner; do not root it, install an
unofficial ROM, or leave ADB exposed. Record both ICCIDs, Telebirr numbers, names,
slots, IMEIs, serial, and build fingerprint before activation.
For a controlled pilot, set `DEVICE_MTLS_REQUIRED=false` on the API and use the
revocable device token over HTTPS/WSS. Enable per-device mTLS before production.

For each of the two SIM slots, independently verify SMS subscription attribution,
`*127#` phone-account routing, send-money confirmation, balance-query SMS lease
correlation, local Keystore PIN use, and quarantine after a deliberate SIM swap.
Then verify reboot, app kill, network loss, offline-spool replay, charging and
thermal heartbeats, certificate revocation, profile rollback prevention, and a
post-PIN unknown result with no automatic retry. AirDroid unattended control and
this Accessibility service must coexist for 72 hours without
permission loss. If unattended control conflicts on this build, qualify the stated
ManageEngine Cloud Universal Add-on fallback; never work around it by rooting.
