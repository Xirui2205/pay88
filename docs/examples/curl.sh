#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
SECRET_KEY="${SECRET_KEY:-sk_test_demo.demo_secret_change_before_shared_use_2026}"
WEBHOOK_URL="${WEBHOOK_URL:-}"
STAMP="$(date +%s)"
TX_REF="curl-deposit-${STAMP}"
TOPUP_REF="curl-topup-${STAMP}"
TRANSFER_REF="curl-transfer-${STAMP}"
SETTLEMENT_REF="curl-settlement-${STAMP}"

auth=(-H "Authorization: Bearer ${SECRET_KEY}" -H "Accept: application/json")

echo "Initialize deposit ${TX_REF}"
curl --fail-with-body --silent --show-error \
  "${auth[@]}" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: ${TX_REF}" \
  -X POST "${BASE_URL}/v1/transaction/initialize" \
  --data "{\"amount\":\"500.00\",\"currency\":\"ETB\",\"tx_ref\":\"${TX_REF}\",\"customer_id\":\"curl-customer-${STAMP}\",\"phone_number\":\"0912345678\",\"first_name\":\"Test\",\"last_name\":\"Customer\",\"metadata\":{\"source\":\"curl\"},\"test_scenario\":\"success\"}"
echo

echo "Verify deposit ${TX_REF}"
curl --fail-with-body --silent --show-error "${auth[@]}" \
  "${BASE_URL}/v1/transaction/verify/${TX_REF}"
echo

echo "Initialize merchant top-up ${TOPUP_REF}"
curl --fail-with-body --silent --show-error \
  "${auth[@]}" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: ${TOPUP_REF}" \
  -X POST "${BASE_URL}/v1/topups/initialize" \
  --data "{\"amount\":\"10000.00\",\"currency\":\"ETB\",\"tx_ref\":\"${TOPUP_REF}\",\"customer_id\":\"curl-treasury-${STAMP}\",\"phone_number\":\"+251911234567\",\"first_name\":\"Merchant\",\"last_name\":\"Treasury\",\"test_scenario\":\"success\"}"
echo

echo "Verify merchant top-up ${TOPUP_REF}"
curl --fail-with-body --silent --show-error "${auth[@]}" \
  "${BASE_URL}/v1/transaction/verify/${TOPUP_REF}"
echo

echo "Create transfer ${TRANSFER_REF}"
TRANSFER_RESPONSE="$(curl --fail-with-body --silent --show-error \
  "${auth[@]}" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: ${TRANSFER_REF}" \
  -X POST "${BASE_URL}/v1/transfers" \
  --data "{\"account_number\":\"0912345678\",\"expected_name\":\"Test Receiver\",\"customer_id\":\"curl-customer-${STAMP}\",\"destination_type\":\"registered\",\"amount\":\"50.00\",\"currency\":\"ETB\",\"reference\":\"${TRANSFER_REF}\",\"bank_code\":855,\"metadata\":{\"source\":\"curl\"},\"test_scenario\":\"success\"}")"
echo "${TRANSFER_RESPONSE}"

HOSTED_TOKEN="$(node -e 'const value=JSON.parse(process.argv[1]); process.stdout.write(new URL(value.data.status_api_url).searchParams.get("token") ?? "")' "${TRANSFER_RESPONSE}")"

echo "Read scoped hosted transfer status"
curl --fail-with-body --silent --show-error \
  "${BASE_URL}/v1/hosted/transfers/${TRANSFER_REF}?token=${HOSTED_TOKEN}"
echo

echo "Read terminal Server-Sent Event"
curl --fail-with-body --silent --show-error --no-buffer --max-time 10 \
  -H "Accept: text/event-stream" \
  "${BASE_URL}/v1/hosted/transfers/${TRANSFER_REF}/events?token=${HOSTED_TOKEN}"
echo

echo "Verify transfer ${TRANSFER_REF}"
curl --fail-with-body --silent --show-error "${auth[@]}" \
  "${BASE_URL}/v1/transfers/verify/${TRANSFER_REF}"
echo

echo "Request merchant settlement ${SETTLEMENT_REF} (platform approval is separate)"
curl --fail-with-body --silent --show-error \
  "${auth[@]}" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: ${SETTLEMENT_REF}" \
  -X POST "${BASE_URL}/v1/settlements" \
  --data "{\"reference\":\"${SETTLEMENT_REF}\",\"account_number\":\"0912345678\",\"expected_name\":\"Merchant Treasury\",\"amount\":\"25000.00\",\"currency\":\"ETB\"}"
echo

echo "Read merchant settlement ${SETTLEMENT_REF}"
curl --fail-with-body --silent --show-error "${auth[@]}" \
  "${BASE_URL}/v1/settlements/${SETTLEMENT_REF}"
echo

echo "List providers and merchant balances"
curl --fail-with-body --silent --show-error "${auth[@]}" "${BASE_URL}/v1/banks"
echo
curl --fail-with-body --silent --show-error "${auth[@]}" "${BASE_URL}/v1/balances"
echo

if [[ -n "${WEBHOOK_URL}" ]]; then
  echo "Register webhook endpoint (persist the secret from this idempotent response)"
  curl --fail-with-body --silent --show-error \
    "${auth[@]}" \
    -H "Content-Type: application/json" \
    -H "Idempotency-Key: webhook-register-${STAMP}" \
    -X POST "${BASE_URL}/v1/webhooks" \
    --data "{\"url\":\"${WEBHOOK_URL}\"}"
  echo
else
  echo "Skip webhook registration: set WEBHOOK_URL to a publicly routable receiver to enable it."
fi
