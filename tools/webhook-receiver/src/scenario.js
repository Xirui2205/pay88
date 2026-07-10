export function boundedScenarioInteger(value, maximum) {
  const parsed = Number.parseInt(String(value ?? "0"), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.min(parsed, maximum);
}

export function shouldFailWebhookAttempt(attempt, failFirstAttempts) {
  return attempt > 0 && attempt <= failFirstAttempts;
}
