# Phone Installation and Qualification Manual

> Production secret rule: never photograph, transmit or write a real Telebirr PIN in a ticket, chat, document or cloud field. PIN entry occurs only on the enrolled phone.

## 1. Before touching the phone

1. In Platform Admin open **Fleet > Add phone**.
2. Select location, fleet group and merchant/shared-wallet policy.
3. Enter the device name, fleet group, model and complete identity of both SIMs. Keep IMEIs, printed serial and exact approved build in the controlled inventory record until those fields are added to Platform Admin.
4. Create the server record, generate its 15-minute text activation code and download the field handbook. The Agent does not scan an activation QR.
5. Prepare two activated Ethio telecom SIMs and record their expected Telebirr numbers and registered account names.
6. Confirm the phone has stable power, Wi-Fi/cellular data and a physically secured location.

## 2. Verify hardware and stock firmware

For the pilot, accept only TECNO CAMON 18 Premier model CH9n with Android 12 and the approved HiOS 8.6 build.

1. Open **Settings > My phone** and compare model, Android, HiOS and build with the admin record.
2. Record IMEI 1 and IMEI 2 from Settings; do not use a photograph containing private messages.
3. Confirm the bootloader is locked and the device is not rooted.
4. If firmware is damaged, quarantine the phone and use TECNO/Carlcare to reinstall the exact signed regional stock firmware. Do not download unofficial images.
5. Factory-reset the phone before Device Owner enrollment.

## 3. Install SIMs and identify slots

1. Power off and place the first registered SIM in slot 1 and the second in slot 2.
2. Power on; disable SIM PIN prompts unless local policy requires them and staff can recover them after reboot.
3. In Android SIM settings assign stable labels such as `TB-S1-<last4>` and `TB-S2-<last4>`.
4. Make a test call/SMS from each slot and confirm the number.
5. Enter the phone number, ICCID, slot and registered Telebirr name into the Add Phone wizard. A slot mismatch is a quarantine condition.

## 4. Enroll AirDroid Business as Device Owner

1. From the factory-reset setup screen use the AirDroid enrollment method/QR issued by the fleet administrator.
2. Confirm the console reports **Fully managed / Device Owner**.
3. Apply the `Telebirr-Pilot` multi-app kiosk policy.
4. Allow only Dialer, Messages, Telebirr Agent, OpenClaw and the MDM components.
5. Enable application auto-update, device health monitoring, remote lock/wipe and audited remote support.
6. Do not enable remote file access to the Telebirr Agent private storage.
7. Test unattended remote view/control. If the TECNO needs an Accessibility add-on, grant it and later prove it can coexist with the Telebirr Accessibility service.

## 5. HiOS reliability configuration

Repeat for Telebirr Agent, OpenClaw and the MDM daemon:

1. **Settings > Apps > Battery**: select unrestricted/no optimization.
2. Enable Auto-start and background activity.
3. Pin/lock required apps in recent tasks where HiOS exposes this option.
4. Disable automatic cleanup, power marathon and deep sleep for required apps.
5. Allow foreground-service notifications and do not silence the Telebirr Agent health channel.
6. Keep automatic date/time/timezone enabled.
7. Configure the screen and charging policy approved for the farm; verify thermal alarms under continuous charging.

## 6. Install and pair OpenClaw

1. Install only the official signed OpenClaw Android APK approved in Admin.
2. Open **Connect**, scan the private Gateway setup code and submit pairing.
3. Platform staff approve the exact device request.
4. Confirm the app maintains its foreground connection and appears online in OpenClaw.
5. Do not grant OpenClaw SMS, Accessibility, shell or financial permissions beyond the approved companion profile.

## 7. Install and activate Telebirr Agent

1. Install the platform-signed APK distributed by MDM; verify version and signing fingerprint displayed in Admin.
2. Grant the runtime permissions requested by this build: SMS receipt, phone state/phone numbers and calls. Allow notifications if Android or MDM presents that control. This build does not request `READ_SMS`.
3. Enable **Telebirr deterministic USSD service** under Accessibility.
4. Exempt the app from battery optimization and permit auto-start.
5. Type the approved Device Gateway `https://` URL and short-lived activation code, then tap **Activate**. Confirm the displayed device ID with Platform Admin; the local screen does not display location or group.
6. The agent receives a revocable per-device token and encrypts it with Android Keystore. Cloud activation must never return a wallet PIN.
7. Only after Steps 6.2-6.4 have completed and the official OpenClaw app is visibly online, open the Telebirr Agent onboarding screen and tap **Confirm OpenClaw is paired** locally. Do not use this control as a substitute for pairing or platform approval.
8. Confirm the next signed heartbeat reports `openclaw_paired=true`. This is qualification evidence only; it does not activate the phone or either SIM.

## 8. Configure wallets and local PINs

For each slot:

1. Compare the detected subscription ID, ICCID and number with the admin record.
2. Run the read-only Telebirr name/account check specified by the qualification workflow.
3. Stop remote viewing. In the Telebirr Agent, enter the wallet ICCID in **SIM ICCID**.
4. Enter the wallet PIN in **Telebirr PIN (local only)**.
5. Enter it again in **Confirm Telebirr PIN (local only)**, then tap **Store local SIM PIN**.
6. Confirm the UI reports **Local PIN stored for SIM ending ####**. The PIN must not be displayed again.
7. If the UI reports **Telebirr PIN and confirmation do not match**, re-enter both fields locally; both PIN fields are cleared after every attempt.
8. Reboot and confirm the agent can unlock its encrypted value only for an authorized signed job.

## 9. Qualification tests

Run every test separately on SIM 1 and SIM 2:

1. Heartbeat and permission test, including signed `openclaw_paired=true` evidence created by the local confirmation after real pairing.
2. Incoming deposit SMS attribution and parsing.
3. `*127#` semantic menu capture without entering a PIN.
4. Full balance query; confirm the SMS from 127 updates main, incentive, fuel and pocket balances separately.
5. Low-value send-money test to the approved qualification number; verify receiver name before PIN.
6. Confirm outgoing SMS transaction ID, fee, VAT and remaining balance.
7. Duplicate-SMS replay; confirm no duplicate credit/journal.
8. Disable data during a test notification, restore it and verify offline spool upload once.
9. Restart the phone and verify all three agents recover, permissions remain, OpenClaw reconnects and heartbeat returns within three minutes.
10. Start remote support and verify it cannot reveal PIN input or private agent storage.

In Platform Admin click **Start / resume run**, use **Record** and **Persist evidence** for every required handset/SIM check, and then have authorized platform staff click **Approve with password**. A changed ICCID, missing permission, unlocked bootloader, unapproved app signature or ambiguous SIM attribution is a quarantine condition.

## 10. Seal and operate

1. Apply the final multi-app kiosk profile and physical asset label.
2. Place the device on approved power, cooling and network.
3. Confirm both SIMs show fresh balances and correct daily-limit timezone.
4. Mark the phone `ACTIVE` in Admin. Do not manually operate Telebirr while it is active.

## Recovery and decommissioning

- **Agent offline:** inspect power/network, then audited MDM remote support; never immediately factory-reset.
- **Permission lost:** quarantine, restore permission locally/remotely, rerun qualification.
- **SIM changed:** quarantine both slot mappings, update inventory and rerun every dual-SIM test.
- **Firmware issue:** drain jobs, revoke certificate, use official stock recovery, factory-reset, re-enroll and enter PIN locally.
- **Lost/stolen:** quarantine, revoke device/OpenClaw/MDM credentials, remote lock/wipe if reachable, reconcile both wallets.
- **Decommission:** drain and sweep balances, verify zero active/unknown jobs, revoke all credentials, wipe via MDM, factory-reset and record disposal evidence.

## Server-controlled enrollment and approval

The admin **Add phone** wizard must be online. It creates the device and one-time activation code through the platform API; operators must never invent or reuse a local code. Regenerating a code invalidates every unused earlier code.

Activation only moves the handset to `qualifying`. The operator must first pair the official OpenClaw app, obtain platform approval, verify it online, and only then tap **Confirm OpenClaw is paired** in the Telebirr Agent. The resulting signed heartbeat may record permission, Accessibility and OpenClaw evidence, but it cannot activate a SIM wallet. For each handset and each SIM, record the mandatory qualification evidence reference in the persisted run. When every check is `passed`, a platform administrator or operator must re-enter their password and approve the latest run. Only this approval changes pending SIM wallets to `active`.

Reject the run if any ICCID, slot, number, registered name, SMS attribution, USSD subscription, balance response or transfer confirmation is uncertain. A rejected, quarantined or disabled SIM must never be enabled by heartbeat alone.
