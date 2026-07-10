<?php

declare(strict_types=1);

use Telebirr\P2P\Client;

require __DIR__ . '/../../sdk/php/vendor/autoload.php';

$baseUrl = getenv('BASE_URL') ?: 'http://localhost:3000';
$secretKey = getenv('SECRET_KEY') ?: 'sk_test_demo.demo_secret_change_before_shared_use_2026';
$stamp = (string) ((int) (microtime(true) * 1000));
$client = new Client($secretKey, $baseUrl);

$txRef = 'php-deposit-' . $stamp;
$deposit = $client->initializePayment([
    'amount' => '500.00',
    'currency' => 'ETB',
    'tx_ref' => $txRef,
    'customer_id' => 'php-customer-' . $stamp,
    'phone_number' => '0912345678',
    'first_name' => 'Test',
    'last_name' => 'Customer',
    'metadata' => ['source' => 'php-sdk'],
    'test_scenario' => 'success',
]);
echo "Deposit initialized\n" . json_encode($deposit, JSON_PRETTY_PRINT | JSON_THROW_ON_ERROR) . "\n";
echo "Deposit verified\n" . json_encode($client->verifyTransaction($txRef), JSON_PRETTY_PRINT | JSON_THROW_ON_ERROR) . "\n";

$topupRef = 'php-topup-' . $stamp;
$topup = $client->initializeTopup([
    'amount' => '10000.00',
    'currency' => 'ETB',
    'tx_ref' => $topupRef,
    'customer_id' => 'php-treasury-' . $stamp,
    'phone_number' => '0911234567',
    'first_name' => 'Merchant',
    'last_name' => 'Treasury',
    'test_scenario' => 'success',
]);
echo "Top-up initialized\n" . json_encode($topup, JSON_PRETTY_PRINT | JSON_THROW_ON_ERROR) . "\n";
echo "Top-up verified\n" . json_encode($client->verifyTransaction($topupRef), JSON_PRETTY_PRINT | JSON_THROW_ON_ERROR) . "\n";

$reference = 'php-transfer-' . $stamp;
$transfer = $client->createTransfer([
    'account_number' => '0912345678',
    'expected_name' => 'Test Receiver',
    'customer_id' => 'php-customer-' . $stamp,
    'destination_type' => 'registered',
    'amount' => '50.00',
    'currency' => 'ETB',
    'reference' => $reference,
    'bank_code' => 855,
    'metadata' => ['source' => 'php-sdk'],
    'test_scenario' => 'success',
]);
echo "Transfer created\n" . json_encode($transfer, JSON_PRETTY_PRINT | JSON_THROW_ON_ERROR) . "\n";
echo "Transfer verified\n" . json_encode($client->verifyTransfer($reference), JSON_PRETTY_PRINT | JSON_THROW_ON_ERROR) . "\n";

$settlementReference = 'php-settlement-' . $stamp;
$settlement = $client->requestSettlement([
    'reference' => $settlementReference,
    'account_number' => '0912345678',
    'expected_name' => 'Merchant Treasury',
    'amount' => '25000.00',
]);
echo "Settlement requested\n" . json_encode($settlement, JSON_PRETTY_PRINT | JSON_THROW_ON_ERROR) . "\n";
echo "Settlement read\n" . json_encode($client->getSettlement($settlementReference), JSON_PRETTY_PRINT | JSON_THROW_ON_ERROR) . "\n";

$sweepGroupId = getenv('SWEEP_GROUP_ID') ?: '';
if ($sweepGroupId !== '') {
    $rule = $client->createSweepRule([
        'group_id' => $sweepGroupId,
        'name' => 'PHP high-water ' . $stamp,
        'destination_type' => 'merchant_owned',
        'destination_phone' => '0912345678',
        'destination_name' => 'Merchant Jumbo Account',
        'high_water_balance' => '75000.00',
        'target_balance' => '50000.00',
        'max_per_run' => '25000.00',
        'minimum_interval_seconds' => 900,
    ]);
    echo "Sweep rule proposed\n" . json_encode($rule, JSON_PRETTY_PRINT | JSON_THROW_ON_ERROR) . "\n";
}
echo "Balances\n" . json_encode($client->getBalances(), JSON_PRETTY_PRINT | JSON_THROW_ON_ERROR) . "\n";

// Verify against the exact raw HTTP request bytes before decoding JSON.
if (getenv('WEBHOOK_RAW_BODY') !== false) {
    $valid = Client::verifyWebhook(
        getenv('WEBHOOK_RAW_BODY') ?: '',
        getenv('WEBHOOK_TIMESTAMP') ?: '',
        getenv('WEBHOOK_SIGNATURE') ?: '',
        getenv('WEBHOOK_SECRET') ?: '',
    );
    echo 'Webhook signature valid: ' . ($valid ? 'yes' : 'no') . "\n";
}
