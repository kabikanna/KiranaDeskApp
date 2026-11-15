# WhatsApp order workflow (Twilio Sandbox)

Node.js + TypeScript + Hapi.js backend using the official Twilio SDK. Customers
send an order on WhatsApp, the backend captures and prices it, asks for a
YES/NO confirmation, sends the seller's static payment QR after YES, and lets
the seller send custom replies to a customer with `/reply`.

## Business flow

```
Customer: "Hi, I need: - Rice - 1 kg - Milk - 1 litre - Sugar - 2 kg"
   -> order stored (ORD001, RECEIVED -> AWAITING_CONFIRMATION)
Backend : "Your order has been received! ... Total Amount: ₹200 ... Reply YES to confirm or NO to cancel."
Customer: "YES"  -> CONFIRMED -> QR_SENT, static payment QR + amount + instructions
Customer: "NO"   -> CANCELLED, cancellation message
Seller  : "/reply ORD001 Your order is being packed."  -> forwarded to the order's customer
```

### Order and payment status

```
RECEIVED -> AWAITING_CONFIRMATION --YES--> CONFIRMED --QR attached--> QR_SENT
                                  \--NO---> CANCELLED
```

`paymentStatus` is separate (`PENDING`, `SUBMITTED`, `PAID`, `FAILED`) and starts as `PENDING`; a payment screenshot moves it to `SUBMITTED` for the seller to verify.
Nothing sets it to `PAID`: sending the QR does not mean the customer paid, and
automatic payment verification is not implemented. `QR_SENT` means the QR was
included in the reply returned to Twilio, not that WhatsApp delivered it.

Safety rules:

- Only the sender's own orders are ever looked up, so one customer cannot confirm
  or cancel another customer's order, even by guessing an order ID.
- A bare `YES`/`NO` applies to the customer's single waiting order. With several
  waiting orders the customer is asked to include the ID (`YES ORD002`).
- Decisions use a compare-and-set on the order status, so concurrent or repeated
  answers decide an order exactly once. A repeated `YES` re-sends the payment
  details; `NO` after confirmation, or `YES` after cancellation, is refused.
- Twilio retries reuse the `MessageSid`, so a retried order never creates a second
  order, and a retried seller command never messages the customer twice.
- Unknown order IDs, unrecognised answers and empty or media-only messages are
  answered safely and never change an order.
- Seller messages (from `SELLER_WHATSAPP_NUMBER`) are commands and are never parsed
  as customer orders. A customer's message starting with `/` is never parsed as an
  order either.

## Install and configure

Requires Node.js 22.18+ and npm.

```sh
npm ci
cp .env.example .env
```

Set these values in `.env` (never commit it):

| Variable | Value |
| --- | --- |
| `TWILIO_ACCOUNT_SID` | Your account's `AC...` SID from Twilio Console |
| `TWILIO_AUTH_TOKEN` | That account's Auth Token, not an API key |
| `TWILIO_WEBHOOK_URL` | Exact public URL configured in Twilio, e.g. `https://example.ngrok-free.app/api/whatsapp/incoming` |
| `TWILIO_WHATSAPP_NUMBER` | The Twilio WhatsApp number customers message and replies are sent from. Use the Sandbox number (`whatsapp:+14155238886`) while testing |
| `SELLER_WHATSAPP_NUMBER` | Optional. The seller's **own** WhatsApp number, e.g. `whatsapp:+919800000001`. Must differ from `TWILIO_WHATSAPP_NUMBER` and must be a different phone from the customers'. Messages from it are `/reply` commands; leave empty to disable them |
| `STATIC_PAYMENT_QR_URL` | Optional public HTTPS URL of the static payment QR image |
| `PAYTM_QR_PATH` | Optional local PNG/JPEG QR (maximum 5 MB), e.g. `assets/paytm-qr.png`. Use this **or** `STATIC_PAYMENT_QR_URL`, not both |
| `PRODUCT_PRICES_PATH` | Optional JSON price list used to calculate totals (see below) |
| `AZURE_OPENAI_ENDPOINT` / `AZURE_OPENAI_API_KEY` | Optional. Enable AI order refinement (see below); set both or neither |
| `AZURE_OPENAI_DEPLOYMENT` / `AZURE_OPENAI_API_VERSION` | Optional; default to `gpt-4.1-mini` and `2024-10-21` |
| `PAYMENT_PROOF_DIR` | Optional directory for payment screenshots; defaults to `data/payment-proofs` (git-ignored) |
| `ORDER_STORE_PATH` | Optional JSON file for orders, customers and messages; defaults to `data/orders.json` (git-ignored) |
| `WHATSAPP_REPLY_API_TOKEN` | Optional separate bearer token for manual replies. Leave empty to disable that API |
| `WHATSAPP_REPLY_TO` | Fixed customer WhatsApp address for terminal replies, e.g. `whatsapp:+15551234567` |
| `HOST` | Optional bind address; defaults to `127.0.0.1` |
| `PORT` | Optional port; defaults to `3000` |

`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WEBHOOK_URL` and
`TWILIO_WHATSAPP_NUMBER` are required at startup in every environment. Credentials are only read from the environment and are never
logged or returned by an API. Signature verification uses the Auth Token and the
public webhook URL **verbatim** (including any query string); it is never rebuilt
from Host or forwarded headers. Use HTTPS. There is no signature-validation bypass.

> **Upgrading from the earlier version:** `SELLER_WHATSAPP_NUMBER` used to hold the
> Sandbox number. Move that value to `TWILIO_WHATSAPP_NUMBER` and put the seller's
> own phone number in `SELLER_WHATSAPP_NUMBER` (or leave it empty). The seller phone
> must be a different phone from the customer's: a message from the seller number is
> always treated as a command, so that phone cannot place orders.

```sh
npm run dev
# Or compile and run:
npm run build
npm start
```

### Price list (optional)

`PRODUCT_PRICES_PATH` points to a JSON file with lowercase item names:

```json
{
  "rice": { "unit": "kg", "price": 60 },
  "milk": { "unit": "l", "price": 50 },
  "sugar": { "unit": "kg", "price": 45 }
}
```

`price` is rupees per `unit`. Weights (`g`/`kg`) and volumes (`ml`/`l`) are
converted, so `500 ml` milk costs ₹25. A product sold in several units can list
each price, e.g. `"milk": [{ "unit": "l", "price": 56 }, { "unit": "pack", "price": 28 }]`.
The project ships a starter [`products.json`](products.json) with sample prices; edit it
to your shop's rates and restart the server.

The confirmation and the payment (QR) message show an itemised bill, e.g.
`1. Rice - 0.5 kg × ₹60/kg = ₹30`, followed by the total / amount to pay. When AI
order refinement is on, the price-list names are given to the model so that
synonyms (chakkarai, cheeni, சர்க்கரை) map to the priced product (`sugar`). The total is only calculated when **every**
item is priced; otherwise the confirmation says *Total Amount: To be confirmed by
the seller* and the payment message asks the customer to wait for the amount.

### AI order refinement (optional)

When `AZURE_OPENAI_ENDPOINT` and `AZURE_OPENAI_API_KEY` are set, every customer order message
(Tamil, Tanglish or English, possibly with spelling or speech mistakes) is first sent to the Azure
OpenAI chat-completions deployment, which returns clean items with Tamil and English names,
quantities and units. The refined items are stored on the order, priced, and sent back in the
confirmation before the YES/NO step continues as usual.

- Messages in Tamil script get the confirmation, payment and cancellation replies in Tamil with
  Tamil item names; English and Tanglish messages get English replies. Customers can also answer
  `சரி`/`ஆம்` (YES) or `இல்லை`/`வேண்டாம்` (NO).
- Pricing uses the English name, so price-list keys stay lowercase English (`rice`, `sugar`).
- If the call fails or times out (8 seconds), the rule-based parser is used and a warning is logged.
- A Twilio retry of an already-stored order does not call the model again.

### Static payment QR

Set `STATIC_PAYMENT_QR_URL` to a public HTTPS image URL, or set `PAYTM_QR_PATH` to
a local file that this server publishes at `<TWILIO_WEBHOOK_URL origin>/payments/paytm-qr`
(update that URL and restart when the ngrok hostname changes). Twilio fetches the
image from that public, unauthenticated URL, so only use a QR intended for
customers. This is a fixed image: no dynamic QR is generated and the customer must
enter the amount in their payment app. Without either setting, `YES` still confirms
the order, but the customer is told the seller will share payment details.

### Payment screenshots

After the QR is sent, the customer can send a payment screenshot (JPEG, PNG, WebP or PDF, up to
10 MB) to the same WhatsApp chat:

1. The webhook keeps only Twilio-hosted attachments (`https://api.twilio.com/...`), so the account
   credentials are never sent anywhere else.
2. The screenshot is attached to that customer's newest `CONFIRMED`/`QR_SENT` order that is not
   `PAID`. To choose another order, send the order ID as the caption, e.g. `ORD007`.
3. The backend downloads it with the Twilio Account SID and Auth Token, saves it as
   `data/payment-proofs/<orderId>-<MessageSid>-<n>.<ext>` (file mode 600), adds it to the order's
   `paymentProofs`, and moves `paymentStatus` from `PENDING` to `SUBMITTED`.
4. The customer gets "Payment screenshot received for order ORD007. The seller will verify it and
   confirm." (in Tamil for Tamil orders). If storing fails they are asked to resend.

`SUBMITTED` only means a screenshot was received; the seller still verifies the payment, and
nothing marks an order `PAID` automatically. A Twilio retry does not download the screenshot twice.

## Request flow

Customer or seller (WhatsApp) -> Twilio -> `POST /api/whatsapp/incoming`
-> controller (signature + payload validation) -> `WhatsAppService` (router)
-> **customer handler** or **seller handler** -> order repository (JSON file)
-> TwiML reply to the sender.

| Code | Responsibility |
| --- | --- |
| `src/controllers/whatsapp.ts` | Validates `X-Twilio-Signature` against all form fields and the configured URL, parses `From`, `To`, `Body`, `MessageSid`, `NumMedia`, `ProfileName`, builds TwiML |
| `src/services/whatsapp.ts` | Logs every message, ignores messages not addressed to `TWILIO_WHATSAPP_NUMBER`, routes by sender |
| `src/services/customer-orders.ts` | Order capture, confirmation question, YES/NO lifecycle, payment QR |
| `src/services/seller-commands.ts` | `/reply ORDERID message` forwarding |
| `src/services/order-messages.ts` | All customer-facing message texts |
| `src/services/order-parser.ts`, `src/services/pricing.ts` | Item parsing and optional pricing |
| `src/repositories/orders.ts` | Orders, customers and conversation storage |

Customer replies are returned as TwiML in the webhook response, so a Twilio
retry of the same message gets the same answer without sending anything twice.
Seller `/reply` messages are sent through the Twilio Messages API. Success is
HTTP 200; invalid signatures 403; malformed payloads 400; unsupported content
types 415; oversized payloads 413; processing failures 500 (logged without
exposing internals, so Twilio can retry).

### Seller `/reply`

From `SELLER_WHATSAPP_NUMBER` to the Twilio number:

```
/reply ORD001 Your order is being packed. It will be ready shortly.
```

The backend finds the order's customer, sends the text to them from the Twilio
number, stores the seller message and the forwarded message in that customer's
conversation, and answers the seller *Message sent to the customer of ORD001.*
An unknown order ID, a missing message or a message over 1,600 characters is
rejected with an explanation. Any other seller text receives the usage help.

## Data model

One JSON document (`{ "version": 2, "orders": [], "customers": [], "messages": [] }`)
in `ORDER_STORE_PATH`; writes are serialised and atomic (temp file + rename).

- **orders**: `id` (`ORD001`...), `messageSid`, `customerNumber`, `items`
  (name, quantity, unit, optional `unitPrice`/`amount`), `unparsedLines`,
  `rawMessage`, `numMedia`, optional `totalAmount`, `status`, `paymentStatus`,
  `receivedAt`, `updatedAt`, and optional `confirmedAt`, `cancelledAt`, `qrSentAt`.
- **customers**: `whatsappNumber`, optional `profileName`, `firstSeenAt`, `lastMessageAt`.
- **messages**: `id` (Twilio SID, or `<MessageSid>:reply` for the TwiML reply),
  optional `orderId`, `customerNumber`, `direction` (`INBOUND`/`OUTBOUND`),
  `sender` (`CUSTOMER`/`SELLER`/`SYSTEM`), `from`, `to`, `body`, optional
  `numMedia`/`mediaUrl`, `createdAt`.

An order file from the earlier version (a plain array) is migrated automatically:
its orders get IDs `ORD001`... in receipt order and status `RECEIVED`, and the old
file is kept as `<file>.v1.bak`. Migrated orders cannot be answered with YES/NO.
A file with an unknown version is rejected instead of overwritten. The file
holds customer numbers and message text, so restrict access to it. It suits one
server process; swap the `OrderRepository` implementation for a database before
running several instances. Dynamic QR generation and payment verification can be
added later by setting `paymentStatus` through `OrderRepository.transitionOrder`
and replacing `paymentMessage`/the QR URL in `customer-orders.ts`.

## Sample payloads

Incoming order (Twilio -> `POST /api/whatsapp/incoming`, form-encoded, signed):

```
From=whatsapp:+919800000002
To=whatsapp:+14155238886
Body=Hi, I need:\n- Rice - 1 kg\n- Milk - 1 litre\n- Sugar - 2 kg
MessageSid=SM0123456789abcdef0123456789abcdef
NumMedia=0
ProfileName=Asha
```

Webhook response (confirmation question, delivered by Twilio to the customer):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response><Message>Your order has been received!

Order ID: ORD001

Order Summary:
1. Rice - 1 kg
2. Milk - 1 litre
3. Sugar - 2 kg

Total Amount: ₹200

Can we proceed with your order?
Reply YES to confirm or NO to cancel. If anything is missing above, reply NO and send your order again.</Message></Response>
```

Customer answers `YES` -> response with the static QR image:

```xml
<Response><Message><Body>Your order is confirmed!

Order ID: ORD001
Amount to Pay: ₹200

Please scan the QR code below and pay ₹200.

After completing the payment, please share the payment confirmation.</Body><Media>https://example.ngrok-free.app/payments/paytm-qr</Media></Message></Response>
```

Customer answers `NO` -> `Your order ORD001 has been cancelled.\nThank you!`

Seller command (`From` is `SELLER_WHATSAPP_NUMBER`): `Body=/reply ORD001 Your order is being packed.`
-> Twilio Messages API call from the backend:

```
POST /2010-04-01/Accounts/AC.../Messages.json
From=whatsapp:+14155238886
To=whatsapp:+919800000002
Body=Your order is being packed.
```

Empty `<Response/>` is returned when no reply is needed.

## Twilio Sandbox limitations

- **Buttons:** custom message templates cannot be used in the Sandbox, and
  interactive quick-reply buttons need a Content Template. WhatsApp polls are not
  supported. This project therefore uses a **text YES/NO fallback**. If you later
  use a registered sender with a quick-reply template whose buttons are titled
  `YES` and `NO`, the button reply arrives as the message `Body`, so the same
  handler works unchanged.
- **24-hour window:** free-form messages (including seller `/reply` messages) are only
  allowed within 24 hours of the customer's last message. Twilio/WhatsApp enforces
  this and an accepted message can still fail later; the backend does not track it.
  The seller is told when a forward fails.
- **Joining:** every phone that talks to the Sandbox, including the seller's phone
  for `/reply`, must first send `join <sandbox code>`. Membership expires after
  72 hours and must be renewed. Trial accounts may also restrict recipients.
- **Rate limit:** the Sandbox allows about one message per 3 seconds.
- The Sandbox is for testing only; production needs an approved WhatsApp sender.

## WhatsApp Sandbox setup and end-to-end testing

1. [Create a Twilio account](https://www.twilio.com/try-twilio) and complete the
   required verification steps. Copy its Account SID and Auth Token into `.env`.
2. Open the [WhatsApp Sandbox in the legacy Console](https://www.twilio.com/console/sms/whatsapp/sandbox)
   (usually **Messaging > Try it out > Send a WhatsApp message**) and activate it.
3. From the customer's phone, send `join <your sandbox code>` to the Sandbox
   number and wait for Twilio's confirmation. Do the same from the seller's phone.
4. Install [ngrok](https://ngrok.com/download), add its auth token, and run
   `ngrok http 3000`.
5. Set `TWILIO_WEBHOOK_URL` to `<ngrok HTTPS URL>/api/whatsapp/incoming`, set the
   other variables above, and (re)start `npm run dev`.
6. In Twilio's **Sandbox settings**, set **When a message comes in** to that exact
   URL with method **POST**, and save. Do not use it as a status callback. Update
   both places and restart when the ngrok hostname changes.
7. Optional: set `PRODUCT_PRICES_PATH` and a QR (`STATIC_PAYMENT_QR_URL` or
   `PAYTM_QR_PATH`), then restart. The log shows `Product price catalog loaded`
   and `Static payment QR enabled`.
8. From the customer's phone send an order, e.g. `Rice - 1 kg`, `Milk - 1 litre`
   (one per line). Expect the *Your order has been received!* message and the log
   `Order captured`.
9. Reply `YES`: expect the confirmation with the QR image. Send another order and
   reply `NO` to see the cancellation.
10. From the seller's phone send `/reply ORD001 Your order is being packed.` The
    customer receives the text and the seller gets *Message sent to the customer
    of ORD001.*
11. Inspect ngrok at `http://127.0.0.1:4040` and `data/orders.json` to see the
    requests, orders, statuses and conversation messages.

An unsigned request must be rejected:

```sh
curl -i http://127.0.0.1:3000/api/whatsapp/incoming \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'Body=Hello'
# Expected: 403 Forbidden
```

For 403 errors from Twilio, check the Auth Token and that the configured URL
matches exactly (scheme, hostname, path, query string). Do not disable validation.

## Manual replies (optional)

`POST /messages/whatsapp` and `npm run reply` let an operator send a message or the
payment QR to a customer outside the order flow. Messages are sent from
`TWILIO_WHATSAPP_NUMBER` and callers cannot override it.

1. Generate a separate token with `openssl rand -hex 32`, set it as
   `WHATSAPP_REPLY_API_TOKEN` (32-256 URL-safe characters, not the Twilio Auth
   Token) and restart. Without it the API returns 503.
2. Call it from a trusted terminal:

   ```sh
   read -r -s -p "Reply API token: " REPLY_TOKEN; printf '\n'
   printf 'header = "Authorization: Bearer %s"\n' "$REPLY_TOKEN" |
     curl --config - -sS -X POST http://127.0.0.1:3000/messages/whatsapp \
       -H 'Content-Type: application/json' \
       -d '{"to":"whatsapp:+15551234567","body":"Your order is ready."}'
   unset REPLY_TOKEN
   ```

   `POST /messages/whatsapp/payment-qr` with `{"to": "...", "amount": "250"}` sends
   the configured QR (HTTP 503 if none is configured).
3. For `npm run reply`, set `WHATSAPP_REPLY_TO` in `.env` to the customer's number
   (not the Sandbox number), keep `npm run dev` running and run `npm run reply` in
   another terminal. Type a message and press Enter; `/qr <amount>` sends the QR;
   `/quit` exits.

`to` must be a WhatsApp E.164 address other than the Twilio number; `body` must be
non-empty and at most 1,600 characters. HTTP 202 means Twilio accepted the request,
not that WhatsApp delivered it; 400/401/502 mean invalid input, a bad token, or a
Twilio failure whose outcome may be unknown (check Twilio's message history before
retrying). Keep the token private; it can send to any number and may incur charges.

## Automated checks

```sh
npm test
npm run typecheck
npm run build
```

Tests use Node's built-in runner, Hapi's in-process injection, temporary JSON
stores, mock senders and loggers, and the SDK's local signature functions. They
make no Twilio network calls and need no account or `.env`. They cover webhook
validation, configuration, parsing, pricing, storage (deduplication, concurrency,
migration), the full order lifecycle (create, YES, NO, repeats, concurrent answers,
cross-customer isolation, unknown IDs, empty and media-only messages), seller
`/reply` forwarding and failures, and the manual reply and QR APIs.

## Production considerations

Keep signature validation and HTTPS, manage credentials securely, and configure
the exact deployed webhook URL. The logger intentionally includes message text and
phone numbers: restrict log access and define redaction and retention before
handling real customer data. Do not log Auth Tokens or full webhook headers. Move
the JSON store to a database, and add rate limiting, before production use.
To receive orders on the seller's real number, register it as a WhatsApp sender
on a paid Twilio account (WhatsApp Self Sign-up); messages to a personal or
WhatsApp Business app number cannot be read by this backend.

See the [Twilio Sandbox documentation](https://www.twilio.com/docs/whatsapp/sandbox),
[webhook security](https://www.twilio.com/docs/usage/security), the
[Messages API](https://www.twilio.com/docs/messaging/api/message-resource) and the
[WhatsApp key concepts](https://www.twilio.com/docs/whatsapp/key-concepts).
