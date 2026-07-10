import test from "node:test";
import assert from "node:assert/strict";
import { expectedSignature, verifySignature } from "./signature.js";
import { boundedScenarioInteger, shouldFailWebhookAttempt } from "./scenario.js";

test("signature verifies exact raw bytes and rejects replay outside tolerance", () => {
  const now = 1_750_000_000_000;
  const timestamp = String(now / 1000);
  const raw = '{"event_id":"evt_1"}';
  const signature = expectedSignature("secret", timestamp, raw);
  assert.equal(verifySignature("secret", timestamp, raw, signature, now), true);
  assert.equal(verifySignature("secret", timestamp, `${raw} `, signature, now), false);
  assert.equal(verifySignature("secret", timestamp, raw, signature, now + 301_000), false);
});

test("webhook harness deterministically delays retries before accepting duplicates", () => {
  assert.equal(boundedScenarioInteger("2500", 60_000), 2500);
  assert.equal(boundedScenarioInteger("invalid", 60_000), 0);
  assert.equal(boundedScenarioInteger("999999", 60_000), 60_000);
  assert.equal(shouldFailWebhookAttempt(1, 2), true);
  assert.equal(shouldFailWebhookAttempt(2, 2), true);
  assert.equal(shouldFailWebhookAttempt(3, 2), false);
});
