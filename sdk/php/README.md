# Telebirr P2P PHP SDK

```php
$client = new Telebirr\P2P\Client($_ENV['P2P_SECRET_KEY'], 'https://api.example.com');
$payment = $client->initializePayment([
    'amount' => '50.00',
    'currency' => 'ETB',
    'tx_ref' => 'order-123',
    'customer_id' => 'customer-42',
    'phone_number' => '0912345678',
]);

$settlement = $client->requestSettlement([
    'reference' => 'settlement-123',
    'account_number' => '0912345678',
    'expected_name' => 'Merchant Treasury',
    'amount' => '25000.00',
]);
```

The client also exposes top-ups, settlement listing/read, sweep-rule CRUD,
test-only delayed-transfer completion, idempotent webhook registration/replay,
balances and providers. Always call the relevant verify/read method before
acting on a redirect or webhook notification.
