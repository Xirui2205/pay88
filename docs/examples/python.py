#!/usr/bin/env python3
"""Dependency-free Telebirr P2P API and webhook verification example."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

BASE_URL = os.environ.get("BASE_URL", "http://localhost:3000").rstrip("/")
SECRET_KEY = os.environ.get(
    "SECRET_KEY", "sk_test_demo.demo_secret_change_before_shared_use_2026"
)


def api(
    method: str,
    path: str,
    payload: dict[str, Any] | None = None,
    idempotency_key: str | None = None,
) -> dict[str, Any]:
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    headers = {
        "Accept": "application/json",
        "Authorization": f"Bearer {SECRET_KEY}",
    }
    if body is not None:
        headers["Content-Type"] = "application/json"
    if idempotency_key:
        headers["Idempotency-Key"] = idempotency_key
    request = urllib.request.Request(
        f"{BASE_URL}{path}", data=body, headers=headers, method=method
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as error:
        message = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Gateway returned HTTP {error.code}: {message}") from error


def verify_webhook(
    raw_body: bytes,
    timestamp: str,
    signature: str,
    secret: str,
    tolerance_seconds: int = 300,
) -> bool:
    try:
        if abs(time.time() - int(timestamp)) > tolerance_seconds:
            return False
    except ValueError:
        return False
    signed = timestamp.encode("ascii") + b"." + raw_body
    expected = "v1=" + hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)


def public_read(url: str, accept: str = "application/json") -> bytes:
    request = urllib.request.Request(url, headers={"Accept": accept}, method="GET")
    with urllib.request.urlopen(request, timeout=15) as response:
        return response.read()


def main() -> None:
    stamp = str(time.time_ns())
    tx_ref = f"python-deposit-{stamp}"
    customer_id = f"python-customer-{stamp}"
    deposit = api(
        "POST",
        "/v1/transaction/initialize",
        {
            "amount": "500.00",
            "currency": "ETB",
            "tx_ref": tx_ref,
            "customer_id": customer_id,
            "phone_number": "0912345678",
            "first_name": "Test",
            "last_name": "Customer",
            "metadata": {"source": "python"},
            "test_scenario": "success",
        },
        tx_ref,
    )
    print("deposit initialized", json.dumps(deposit, indent=2))
    print(
        "deposit verified",
        json.dumps(
            api("GET", f"/v1/transaction/verify/{urllib.parse.quote(tx_ref)}"),
            indent=2,
        ),
    )

    topup_ref = f"python-topup-{stamp}"
    print(
        "top-up initialized",
        json.dumps(
            api(
                "POST",
                "/v1/topups/initialize",
                {
                    "amount": "10000.00",
                    "currency": "ETB",
                    "tx_ref": topup_ref,
                    "customer_id": f"python-treasury-{stamp}",
                    "phone_number": "0911234567",
                    "first_name": "Merchant",
                    "last_name": "Treasury",
                    "test_scenario": "success",
                },
                topup_ref,
            ),
            indent=2,
        ),
    )
    print("top-up verified", json.dumps(api("GET", f"/v1/transaction/verify/{urllib.parse.quote(topup_ref)}"), indent=2))

    reference = f"python-transfer-{stamp}"
    transfer = api(
        "POST",
        "/v1/transfers",
        {
            "account_number": "0912345678",
            "expected_name": "Test Receiver",
            "customer_id": customer_id,
            "destination_type": "registered",
            "amount": "50.00",
            "currency": "ETB",
            "reference": reference,
            "bank_code": "855",
            "metadata": {"source": "python"},
            "test_scenario": "success",
        },
        reference,
    )
    print("transfer created", json.dumps(transfer, indent=2))
    print(
        "transfer verified",
        json.dumps(
            api("GET", f"/v1/transfers/verify/{urllib.parse.quote(reference)}"),
            indent=2,
        ),
    )

    status_api_url = transfer["data"]["status_api_url"]
    print("hosted transfer status", public_read(status_api_url).decode("utf-8"))
    parsed_status_url = urllib.parse.urlsplit(status_api_url)
    events_url = urllib.parse.urlunsplit(
        parsed_status_url._replace(path=parsed_status_url.path.rstrip("/") + "/events")
    )
    print("terminal transfer SSE", public_read(events_url, "text/event-stream").decode("utf-8"))

    settlement_ref = f"python-settlement-{stamp}"
    print(
        "settlement requested",
        json.dumps(
            api(
                "POST",
                "/v1/settlements",
                {
                    "reference": settlement_ref,
                    "account_number": "0912345678",
                    "expected_name": "Merchant Treasury",
                    "amount": "25000.00",
                    "currency": "ETB",
                },
                settlement_ref,
            ),
            indent=2,
        ),
    )
    print("settlement read", json.dumps(api("GET", f"/v1/settlements/{urllib.parse.quote(settlement_ref)}"), indent=2))

    sweep_group_id = os.environ.get("SWEEP_GROUP_ID")
    if sweep_group_id:
        sweep_name = f"Python high-water {stamp}"
        print(
            "sweep rule proposed",
            json.dumps(
                api(
                    "POST",
                    "/v1/sweep-rules",
                    {
                        "group_id": sweep_group_id,
                        "name": sweep_name,
                        "destination_type": "merchant_owned",
                        "destination_phone": "0912345678",
                        "destination_name": "Merchant Jumbo Account",
                        "high_water_balance": "75000.00",
                        "target_balance": "50000.00",
                        "max_per_run": "25000.00",
                        "minimum_interval_seconds": 900,
                    },
                    f"python-sweep-{stamp}",
                ),
                indent=2,
            ),
        )
    print("banks", json.dumps(api("GET", "/v1/banks"), indent=2))
    print("balances", json.dumps(api("GET", "/v1/balances"), indent=2))


if __name__ == "__main__":
    main()
