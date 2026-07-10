import {
  TelebirrP2PClient,
  hostedTransferEventsUrl,
  verifyWebhookSignature,
  type InitializePaymentInput,
  type TransferView,
} from "../../sdk/node/dist/index.js";

const baseUrl = process.env.BASE_URL ?? "http://localhost:3000";
const secretKey =
  process.env.SECRET_KEY ??
  "sk_test_demo.demo_secret_change_before_shared_use_2026";
const stamp = Date.now().toString();

const client = new TelebirrP2PClient({ baseUrl, secretKey });

const depositInput = {
  amount: "500.00",
  currency: "ETB",
  tx_ref: `node-deposit-${stamp}`,
  customer_id: `node-customer-${stamp}`,
  phone_number: "0912345678",
  first_name: "Test",
  last_name: "Customer",
  metadata: { source: "node-typescript-sdk" },
  test_scenario: "success",
} satisfies InitializePaymentInput & { test_scenario: "success" };

const initialized = await client.initializePayment(depositInput);
console.log("deposit initialized", initialized);
console.log(
  "deposit verified",
  await client.verifyTransaction(depositInput.tx_ref),
);

const topupInput = {
  ...depositInput,
  amount: "10000.00",
  tx_ref: `node-topup-${stamp}`,
  customer_id: `node-treasury-${stamp}`,
};
console.log("top-up initialized", await client.initializeTopup(topupInput));
console.log("top-up verified", await client.verifyTransaction(topupInput.tx_ref));

const reference = `node-transfer-${stamp}`;
const transfer = await client.createTransfer<TransferView>({
  account_number: "0912345678",
  expected_name: "Test Receiver",
  customer_id: depositInput.customer_id,
  destination_type: "registered",
  amount: "50.00",
  currency: "ETB",
  reference,
  bank_code: "855",
  metadata: { source: "node-typescript-sdk" },
});
console.log("transfer created", transfer);
console.log("transfer verified", await client.verifyTransfer(reference));
console.log("hosted status", await (await fetch(transfer.data.status_api_url)).json());
console.log("hosted SSE URL", hostedTransferEventsUrl(transfer.data.status_api_url));

const settlementReference = `node-settlement-${stamp}`;
console.log("settlement requested", await client.requestSettlement({
  reference: settlementReference,
  account_number: "0912345678",
  expected_name: "Merchant Treasury",
  amount: "25000.00",
}));
console.log("settlement read", await client.getSettlement(settlementReference));

if (process.env.SWEEP_GROUP_ID) {
  console.log("sweep rule proposed", await client.createSweepRule({
    group_id: process.env.SWEEP_GROUP_ID,
    name: `Node high-water ${stamp}`,
    destination_type: "merchant_owned",
    destination_phone: "0912345678",
    destination_name: "Merchant Jumbo Account",
    high_water_balance: "75000.00",
    target_balance: "50000.00",
    max_per_run: "25000.00",
    minimum_interval_seconds: 900,
  }));
}
console.log("banks", await client.getBanks());
console.log("balances", await client.getBalances());

// A webhook framework must pass the exact raw body, before JSON parsing.
if (
  process.env.WEBHOOK_RAW_BODY &&
  process.env.WEBHOOK_TIMESTAMP &&
  process.env.WEBHOOK_SIGNATURE &&
  process.env.WEBHOOK_SECRET
) {
  const valid = verifyWebhookSignature({
    rawBody: process.env.WEBHOOK_RAW_BODY,
    timestamp: process.env.WEBHOOK_TIMESTAMP,
    signature: process.env.WEBHOOK_SIGNATURE,
    secret: process.env.WEBHOOK_SECRET,
  });
  console.log("webhook signature valid", valid);
}
