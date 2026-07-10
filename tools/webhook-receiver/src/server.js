import { createServer } from "node:http";
import { verifySignature } from "./signature.js";
import { boundedScenarioInteger, shouldFailWebhookAttempt } from "./scenario.js";

const port = Number(process.env.PORT || 8787);
const secret = process.env.WEBHOOK_SECRET || "development-webhook-secret";
const processed = new Set();
const attempts = new Map();
const failFirstAttempts = boundedScenarioInteger(process.env.WEBHOOK_FAIL_FIRST_ATTEMPTS, 100);
const responseDelayMs = boundedScenarioInteger(process.env.WEBHOOK_RESPONSE_DELAY_MS, 60_000);

const server = createServer((request, response) => {
  if (request.method !== "POST" || request.url !== "/webhooks/telebirr") {
    response.writeHead(404).end();
    return;
  }

  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const rawBody = Buffer.concat(chunks).toString("utf8");
    const timestamp = String(request.headers["x-p2p-timestamp"] || "");
    const signature = String(request.headers["x-p2p-signature"] || "");
    if (!verifySignature(secret, timestamp, rawBody, signature)) {
      response.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ ok: false }));
      return;
    }

    let event;
    try {
      event = JSON.parse(rawBody);
    } catch {
      response.writeHead(400).end();
      return;
    }
    if (!event.event_id) {
      response.writeHead(422).end();
      return;
    }

    const attempt = (attempts.get(event.event_id) || 0) + 1;
    attempts.set(event.event_id, attempt);
    const complete = () => {
      if (shouldFailWebhookAttempt(attempt, failFirstAttempts)) {
        process.stdout.write(`${JSON.stringify({ received: event.event_id, attempt, simulated_failure: true, type: event.event })}\n`);
        response.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, simulated_failure: true, attempt }));
        return;
      }
      const duplicate = processed.has(event.event_id);
      processed.add(event.event_id);
      process.stdout.write(`${JSON.stringify({ received: event.event_id, attempt, duplicate, type: event.event })}\n`);
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, duplicate, attempt }));
    };
    if (responseDelayMs > 0) setTimeout(complete, responseDelayMs);
    else complete();
  });
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`Webhook receiver listening on http://127.0.0.1:${port}/webhooks/telebirr\n`);
});
