import http from "k6/http";
import { check } from "k6";
import exec from "k6/execution";

const baseUrl = __ENV.BASE_URL || "http://localhost:3000";
const secretKey = __ENV.TEST_SECRET_KEY || "P2PSK_TEST_local-development";

export const options = {
  scenarios: {
    deposits_5x_peak: {
      executor: "constant-arrival-rate",
      exec: "deposit",
      rate: 84,
      timeUnit: "1s",
      duration: __ENV.DURATION || "2m",
      preAllocatedVUs: 100,
      maxVUs: 500,
      tags: { operation: "deposit_initialize" },
    },
    withdrawals_5x_peak: {
      executor: "constant-arrival-rate",
      exec: "withdrawal",
      rate: 84,
      timeUnit: "1s",
      duration: __ENV.DURATION || "2m",
      preAllocatedVUs: 100,
      maxVUs: 500,
      tags: { operation: "transfer_create" },
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<500", "p(99)<1000"],
  },
};

function headers(reference) {
  return {
    Authorization: `Bearer ${secretKey}`,
    "Content-Type": "application/json",
    "Idempotency-Key": reference,
  };
}

function unique(prefix) {
  return `${prefix}-${exec.scenario.iterationInTest}-${exec.vu.idInTest}`;
}

export function deposit() {
  const reference = unique("load-deposit");
  const response = http.post(`${baseUrl}/v1/transaction/initialize`, JSON.stringify({
    amount: "500.00",
    currency: "ETB",
    tx_ref: reference,
    customer_id: `customer-${exec.vu.idInTest}`,
    first_name: "Load",
    last_name: "Tester",
    phone_number: "0912345678",
    metadata: { source: "k6" },
    test_scenario: "success",
  }), { headers: headers(reference) });
  check(response, { "deposit accepted": (r) => r.status === 200 || r.status === 201 });
}

export function withdrawal() {
  const reference = unique("load-withdrawal");
  const response = http.post(`${baseUrl}/v1/transfers`, JSON.stringify({
    account_number: "0912345678",
    expected_name: "Test Receiver",
    amount: "500.00",
    currency: "ETB",
    reference,
    bank_code: 855,
    customer_id: `customer-${exec.vu.idInTest}`,
    destination_type: "registered",
    metadata: { source: "k6" },
    test_scenario: "success",
  }), { headers: headers(reference) });
  check(response, { "withdrawal accepted": (r) => r.status === 200 || r.status === 201 });
}
