# Runnable API examples

These examples target the local test environment by default. Start the API and
seed the database first, then export a different `BASE_URL` and `SECRET_KEY` if
needed. The checked-in default key is for local development only and must never
be deployed.

```bash
npm install
npm run prisma:generate
npm -w @telebirr/api run prisma:migrate
npm -w @telebirr/api run prisma:seed
npm run dev:api
```

Run an example from the repository root:

```bash
bash docs/examples/curl.sh

npm -w @telebirr/p2p-sdk run build
node --experimental-strip-types docs/examples/node-typescript-sdk.ts

composer install --working-dir=sdk/php
php docs/examples/php-sdk.php

python docs/examples/python.py
```

Environment variables:

- `BASE_URL` defaults to `http://localhost:3000`.
- `SECRET_KEY` defaults to the local seeded test key.
- `WEBHOOK_URL` is optional. When set, the curl example registers that endpoint;
  it must resolve only to public addresses (localhost/private receivers are
  rejected). Registration is skipped when it is unset.
- `SWEEP_GROUP_ID` is optional. When set to a UUID assigned during platform
  onboarding, the Node, PHP, and Python examples also propose a pending sweep
  rule. Test-mode rules never dispatch automatic sweeps.

All mutating financial examples generate timestamped references. Browser
redirects and hosted status pages are intentionally not used as proof of payment;
each example calls a server-side verify endpoint.

The curl and Python examples also read the scoped hosted transfer resource and
its terminal Server-Sent Event without sending a merchant key. Settlement
examples create a request only; platform approval remains a separate staff
workflow.

The Postman collection additionally contains the merchant/platform support-case
exchange. Set its `portal_session` and `platform_session` variables to
individual human sessions before running that folder; neither value is
interchangeable with `SECRET_KEY`.
