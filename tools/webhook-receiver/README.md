# Local signed webhook receiver

```bash
WEBHOOK_SECRET=development-webhook-secret npm -w @telebirr/webhook-receiver start
```

Configure a test merchant endpoint as `http://host.docker.internal:8787/webhooks/telebirr`. The receiver verifies timestamped HMAC over the exact raw body and records whether an `event_id` is a duplicate. It is an integration fixture, not a production webhook consumer.

Deterministic delivery-failure scenarios:

```bash
# Delay every response by 2.5 seconds and return 503 for the first two
# deliveries of each event ID. The third succeeds; later replays are logged as
# duplicates while still returning 200.
WEBHOOK_RESPONSE_DELAY_MS=2500 \
WEBHOOK_FAIL_FIRST_ATTEMPTS=2 \
WEBHOOK_SECRET=development-webhook-secret \
npm -w @telebirr/webhook-receiver start
```

Use the gateway's webhook replay operation or resend the exact signed event to
exercise duplicate delivery. Keep the same `event_id`; receivers must apply it
only once.
