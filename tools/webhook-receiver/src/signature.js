import { createHmac, timingSafeEqual } from "node:crypto";

export function expectedSignature(secret, timestamp, rawBody) {
  return `v1=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
}

export function verifySignature(secret, timestamp, rawBody, signature, nowMs = Date.now(), toleranceSeconds = 300) {
  if (!/^\d+$/.test(timestamp) || Math.abs(nowMs - Number(timestamp) * 1000) > toleranceSeconds * 1000) return false;
  const expected = Buffer.from(expectedSignature(secret, timestamp, rawBody));
  const actual = Buffer.from(signature || "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
