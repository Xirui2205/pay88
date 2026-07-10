# API load test

The two constant-arrival scenarios each generate 84 requests/second: approximately 5,000 deposit and 5,000 withdrawal admissions per minute, five times the stated peak.

```bash
k6 run \
  -e BASE_URL=https://staging-api.example.com \
  -e TEST_SECRET_KEY=P2PSK_TEST_... \
  -e DURATION=10m \
  tools/load-test/k6.js
```

Run only with a test key. The API must keep test mode isolated from the phone scheduler and real ledgers. Passing latency alone is insufficient: after the run verify idempotency, journal balance, outbox/inbox uniqueness and zero device jobs in the test environment.
