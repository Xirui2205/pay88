<?php

declare(strict_types=1);

namespace Telebirr\P2P;

use RuntimeException;

final class Client
{
    public function __construct(
        private readonly string $secretKey,
        private readonly string $baseUrl,
        private readonly int $timeoutSeconds = 15,
    ) {
        if ($secretKey === '') {
            throw new RuntimeException('secretKey is required');
        }
    }

    public function initializePayment(array $payload, ?string $idempotencyKey = null): array
    {
        return $this->request('POST', '/v1/transaction/initialize', $payload, $idempotencyKey ?? $payload['tx_ref']);
    }

    public function initializeTopup(array $payload, ?string $idempotencyKey = null): array
    {
        return $this->request('POST', '/v1/topups/initialize', $payload, $idempotencyKey ?? $payload['tx_ref']);
    }

    public function verifyTransaction(string $txRef): array
    {
        return $this->request('GET', '/v1/transaction/verify/' . rawurlencode($txRef));
    }

    public function createTransfer(array $payload, ?string $idempotencyKey = null): array
    {
        $payload = ['currency' => 'ETB', 'bank_code' => 855] + $payload;
        return $this->request('POST', '/v1/transfers', $payload, $idempotencyKey ?? $payload['reference']);
    }

    public function verifyTransfer(string $reference): array
    {
        return $this->request('GET', '/v1/transfers/verify/' . rawurlencode($reference));
    }

    public function completeDelayedTestTransfer(string $reference, string $outcome): array
    {
        if (!in_array($outcome, ['success', 'failed', 'unknown'], true)) {
            throw new RuntimeException('outcome must be success, failed, or unknown');
        }
        return $this->request(
            'POST',
            '/v1/test/scenarios/transfers/' . rawurlencode($reference) . '/complete',
            ['outcome' => $outcome],
        );
    }

    public function requestSettlement(array $payload, ?string $idempotencyKey = null): array
    {
        $payload = ['currency' => 'ETB'] + $payload;
        return $this->request('POST', '/v1/settlements', $payload, $idempotencyKey ?? $payload['reference']);
    }

    public function listSettlements(): array
    {
        return $this->request('GET', '/v1/settlements');
    }

    public function getSettlement(string $reference): array
    {
        return $this->request('GET', '/v1/settlements/' . rawurlencode($reference));
    }

    public function createSweepRule(array $payload, ?string $idempotencyKey = null): array
    {
        return $this->request('POST', '/v1/sweep-rules', $payload, $idempotencyKey ?? $payload['name']);
    }

    public function listSweepRules(): array
    {
        return $this->request('GET', '/v1/sweep-rules');
    }

    public function getSweepRule(string $id): array
    {
        return $this->request('GET', '/v1/sweep-rules/' . rawurlencode($id));
    }

    public function updateSweepRule(string $id, array $payload, ?string $idempotencyKey = null): array
    {
        return $this->request('PUT', '/v1/sweep-rules/' . rawurlencode($id), $payload, $idempotencyKey ?? $id);
    }

    public function disableSweepRule(string $id, string $reason, ?string $idempotencyKey = null): array
    {
        return $this->request('DELETE', '/v1/sweep-rules/' . rawurlencode($id), ['reason' => $reason], $idempotencyKey ?? $id);
    }

    public function getBalances(): array
    {
        return $this->request('GET', '/v1/balances');
    }

    public function getBanks(): array
    {
        return $this->request('GET', '/v1/banks');
    }

    public function listWebhooks(): array
    {
        return $this->request('GET', '/v1/webhooks');
    }

    public function registerWebhook(string $url, ?string $idempotencyKey = null): array
    {
        $key = $idempotencyKey ?? 'webhook:' . substr(hash('sha256', $url), 0, 32);
        return $this->request('POST', '/v1/webhooks', ['url' => $url], $key);
    }

    public function replayWebhook(string $deliveryId, ?string $idempotencyKey = null): array
    {
        return $this->request(
            'POST',
            '/v1/webhooks/deliveries/' . rawurlencode($deliveryId) . '/replay',
            null,
            $idempotencyKey ?? $deliveryId,
        );
    }

    public static function verifyWebhook(
        string $rawBody,
        string $timestamp,
        string $signature,
        string $secret,
        int $toleranceSeconds = 300,
    ): bool {
        if (abs(time() - (int) $timestamp) > $toleranceSeconds) {
            return false;
        }
        $expected = 'v1=' . hash_hmac('sha256', $timestamp . '.' . $rawBody, $secret);
        return hash_equals($expected, $signature);
    }

    private function request(string $method, string $path, ?array $payload = null, ?string $idempotencyKey = null): array
    {
        $curl = curl_init(rtrim($this->baseUrl, '/') . $path);
        $headers = [
            'Accept: application/json',
            'Authorization: Bearer ' . $this->secretKey,
        ];
        if ($idempotencyKey !== null) {
            $headers[] = 'Idempotency-Key: ' . $idempotencyKey;
        }
        if ($payload !== null) {
            $headers[] = 'Content-Type: application/json';
            curl_setopt($curl, CURLOPT_POSTFIELDS, json_encode($payload, JSON_THROW_ON_ERROR));
        }
        curl_setopt_array($curl, [
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => $this->timeoutSeconds,
        ]);
        $raw = curl_exec($curl);
        $status = (int) curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
        if ($raw === false) {
            throw new RuntimeException('Gateway request failed: ' . curl_error($curl));
        }
        $body = json_decode($raw, true, flags: JSON_THROW_ON_ERROR);
        if ($status < 200 || $status >= 300) {
            throw new RuntimeException(sprintf('%s (%s)', $body['message'] ?? 'Gateway request failed', $body['code'] ?? $status));
        }
        return $body;
    }
}
