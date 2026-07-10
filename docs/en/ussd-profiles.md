# Telebirr V1 USSD and SMS Fixtures

Profiles select labels semantically; option numbers below are observed fixtures, not durable logic.

## Send money

| State | Expected text/meaning | Reply |
|---|---|---|
| Root | `2. Send Money` | semantic `SEND_MONEY` (observed `2`) |
| Send menu | `1. Send Money` | semantic `SEND_MONEY` (observed `1`) |
| Receiver | `Please Enter the receiver mobile number` | normalized destination digits |
| Receiver check | `To <number> <name> / 1. OK / 0. Cancel` | compare parsed name, then `CONFIRM` |
| Amount | `Enter Amount` | two-decimal ETB amount |
| Comment | `Enter comment to Customer` | blank/default safe continuation |
| Final review | `You are sending: ETB <amount> for <number> <name>` | exact field validation, then `CONFIRM` |
| PIN | `Enter PIN` | locally decrypted PIN; marks commit on submit |
| Terminal | `Your request is being processed... confirmation short message from 127` | close session, await attributed SMS |

Outgoing confirmation must parse principal, receiver name/masked number, provider transaction number, fee, VAT, current main balance and receipt link if present. The transaction number is the deduplication and reconciliation identifier.

## Query balance

| State | Expected text/meaning | Reply |
|---|---|---|
| Root | `99. Next` | semantic `NEXT` |
| Page 2 | `5. My Account` | semantic `MY_ACCOUNT` |
| Account | `2. Query Balance` | semantic `QUERY_BALANCE` |
| PIN | `Enter PIN` | locally decrypted PIN |
| Terminal | wait for confirmation SMS from `127` | close session and retain query lease |

Balance SMS fields:

- `Customer Incentive Account Balance`
- `Customer E-Money Account Balance` (main/spendable)
- `Customer E-Money Account for fuel payment Balance`
- `PocketMoneyAccount Balance`

## Receive money

Incoming confirmation includes recipient greeting, received amount, sender name and masked number, provider transaction number, timestamp and current main balance. The parser tolerates line wrapping, punctuation and whitespace changes but rejects a missing provider transaction number.

## Fail-closed behavior

- No semantic option or more than one equally strong option: abort before PIN and upload a redacted capture.
- Receiver number, name or amount differs at final review: cancel and create a case.
- Timeout before PIN: safe pre-commit failure.
- Any ambiguity after PIN submission: `unknown`; never retry automatically.
- A new profile learned from capture remains a proposal until replay fixtures and platform signature approval pass.
