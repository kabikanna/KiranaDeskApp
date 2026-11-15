import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import type { Logger } from "../src/logger.ts";
import { createJsonFileOrderRepository } from "../src/repositories/orders.ts";
import type { OrderRepository } from "../src/repositories/orders.ts";
import type { OrderExtractor } from "../src/services/ai-order-extractor.ts";
import type { PaymentProofStore } from "../src/services/payment-proofs.ts";
import type { PriceCatalog } from "../src/services/pricing.ts";
import { createWhatsAppService } from "../src/services/whatsapp.ts";
import type { WhatsAppMessage } from "../src/services/whatsapp.ts";

const TWILIO = "whatsapp:+14155238886";
const SELLER = "whatsapp:+919800000001";
const ASHA = "whatsapp:+919800000002";
const RAVI = "whatsapp:+919800000003";
const QR_URL = "https://public.example.com/payments/paytm-qr";

const prices: PriceCatalog = new Map([
  ["rice", { unit: "kg", price: 60 }],
  ["milk", { unit: "l", price: 50 }],
  ["sugar", { unit: "kg", price: 45 }],
]);
const ORDER_TEXT = "Hi, I need:\n- Rice - 1 kg\n- Milk - 1 litre\n- Sugar - 2 kg";

let counter = 0;
const nextSid = () => `SM${String(++counter).padStart(32, "0")}`;

interface Sent { to: string; body: string; mediaUrl?: string | undefined }

async function setup(t: TestContext, options: {
  qr?: boolean; prices?: boolean; sendFails?: boolean; seller?: boolean; orderExtractor?: OrderExtractor;
  paymentProofs?: PaymentProofStore;
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), "kirana-lifecycle-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const storePath = join(dir, "orders.json");
  const orders = createJsonFileOrderRepository(storePath);
  const sent: Sent[] = [];
  const logs: { level: string; message: string; details: Record<string, unknown> }[] = [];
  const logger: Logger = {
    info: (message, details = {}) => { logs.push({ level: "info", message, details }); },
    warn: (message, details = {}) => { logs.push({ level: "warn", message, details }); },
    error: (message, details = {}) => { logs.push({ level: "error", message, details }); },
  };
  const service = createWhatsAppService({
    logger,
    orders,
    twilioNumber: TWILIO,
    sellerNumber: options.seller === false ? undefined : SELLER,
    sender: {
      async send(to, body, mediaUrl) {
        if (options.sendFails) {
          throw new Error("Twilio rejected the message");
        }
        sent.push({ to, body, mediaUrl });
        return { messageSid: `SM${"f".repeat(30)}${String(sent.length).padStart(2, "0")}`, status: "queued" };
      },
    },
    paymentQrUrl: options.qr === false ? undefined : QR_URL,
    priceCatalog: options.prices === false ? undefined : prices,
    orderExtractor: options.orderExtractor,
    paymentProofs: options.paymentProofs,
  });
  const say = (from: string, body: string, extra: Partial<WhatsAppMessage> = {}) =>
    service.processMessage({ from, to: TWILIO, body, messageSid: nextSid(), numMedia: 0, ...extra });
  return { orders, sent, logs, say, storePath, service };
}

async function placeOrder(say: Awaited<ReturnType<typeof setup>>["say"], from = ASHA, text = ORDER_TEXT) {
  const result = await say(from, text);
  return result.reply?.match(/Order ID: (ORD\d+)/)?.[1] ?? assert.fail("no order id in reply");
}

const status = async (orders: OrderRepository, id: string) => (await orders.getOrder(id))?.status;

test("captures an order, prices it and asks the customer to confirm", async (t) => {
  const { say, orders, logs } = await setup(t);
  const result = await say(ASHA, ORDER_TEXT, { profileName: "Asha" });
  assert.equal(result.mediaUrl, undefined);
  assert.equal(result.reply, [
    "Your order has been received!",
    "",
    "Order ID: ORD001",
    "",
    "Order Summary:",
    "1. Rice - 1 kg × ₹60/kg = ₹60",
    "2. Milk - 1 litre × ₹50/litre = ₹50",
    "3. Sugar - 2 kg × ₹45/kg = ₹90",
    "",
    "Total Amount: ₹200",
    "",
    "Can we proceed with your order?",
    "Reply YES to confirm or NO to cancel. If anything is missing above, reply NO and send your order again.",
  ].join("\n"));
  const order = await orders.getOrder("ORD001");
  assert.equal(order?.status, "AWAITING_CONFIRMATION");
  assert.equal(order?.paymentStatus, "PENDING");
  assert.equal(order?.customerNumber, ASHA);
  assert.equal(order?.totalAmount, 200);
  assert.equal(order?.rawMessage, ORDER_TEXT);
  assert.equal(order?.items[0]?.amount, 60);
  const conversation = await orders.listMessages(ASHA);
  assert.deepEqual(conversation.map((m) => [m.direction, m.sender, m.orderId]), [
    ["INBOUND", "CUSTOMER", "ORD001"],
    ["OUTBOUND", "SYSTEM", "ORD001"],
  ]);
  assert.equal(conversation[0]?.body, ORDER_TEXT);
  assert.ok(logs.some((entry) => entry.message === "Order captured"));
});

test("says the total is to be confirmed when items have no catalog price", async (t) => {
  const { say, orders } = await setup(t, { prices: false });
  const result = await say(ASHA, "2 kg rice");
  assert.match(result.reply ?? "", /Total Amount: To be confirmed by the seller/);
  assert.equal((await orders.getOrder("ORD001"))?.totalAmount, undefined);
});

test("answers a repeated order delivery with the same question and one order", async (t) => {
  const { service, orders } = await setup(t);
  const message = { from: ASHA, to: TWILIO, body: ORDER_TEXT, messageSid: nextSid(), numMedia: 0 };
  const first = await service.processMessage(message);
  const retry = await service.processMessage(message);
  assert.equal(retry.reply, first.reply);
  assert.equal((await orders.list()).length, 1);
  assert.equal((await orders.listMessages(ASHA)).length, 2);
});

test("does not re-ask after a retry that arrives once the order is decided", async (t) => {
  const { service, say, orders } = await setup(t);
  const message = { from: ASHA, to: TWILIO, body: ORDER_TEXT, messageSid: nextSid(), numMedia: 0 };
  await service.processMessage(message);
  await say(ASHA, "yes");
  assert.deepEqual(await service.processMessage(message), {});
  assert.equal(await status(orders, "ORD001"), "QR_SENT");
});

test("YES confirms the order and returns the static QR with payment instructions", async (t) => {
  const { say, orders } = await setup(t);
  await placeOrder(say);
  const result = await say(ASHA, "YES");
  assert.equal(result.mediaUrl, QR_URL);
  assert.equal(result.reply, [
    "Your order is confirmed!",
    "",
    "Order ID: ORD001",
    "",
    "Bill:",
    "1. Rice - 1 kg × ₹60/kg = ₹60",
    "2. Milk - 1 litre × ₹50/litre = ₹50",
    "3. Sugar - 2 kg × ₹45/kg = ₹90",
    "",
    "Amount to Pay: ₹200",
    "",
    "Please scan the QR code below and pay ₹200.",
    "",
    "After completing the payment, please share the payment confirmation.",
  ].join("\n"));
  const order = await orders.getOrder("ORD001");
  assert.equal(order?.status, "QR_SENT");
  assert.equal(order?.paymentStatus, "PENDING");
  assert.ok(order?.confirmedAt && order.qrSentAt);
  const conversation = await orders.listMessages(ASHA);
  assert.equal(conversation.length, 4);
  assert.equal(conversation.at(-1)?.mediaUrl, QR_URL);
});

test("YES without a configured QR confirms the order but sends no image", async (t) => {
  const { say, orders } = await setup(t, { qr: false });
  await placeOrder(say);
  const result = await say(ASHA, "yes");
  assert.equal(result.mediaUrl, undefined);
  assert.match(result.reply ?? "", /The seller will share the payment details shortly\./);
  assert.equal(await status(orders, "ORD001"), "CONFIRMED");
});

test("YES is accepted in common forms and with an explicit order ID", async (t) => {
  const { say, orders } = await setup(t);
  await placeOrder(say);
  await placeOrder(say, ASHA, "1 kg rice");
  assert.match((await say(ASHA, "yes")).reply ?? "", /several orders waiting/);
  assert.match((await say(ASHA, " Yes ord002!! ")).reply ?? "", /Order ID: ORD002/);
  assert.equal(await status(orders, "ORD002"), "QR_SENT");
  assert.equal(await status(orders, "ORD001"), "AWAITING_CONFIRMATION");
  assert.match((await say(ASHA, "Okay")).reply ?? "", /Order ID: ORD001/);
});

test("repeating YES re-sends the payment details without changing the order", async (t) => {
  const { say, orders } = await setup(t);
  await placeOrder(say);
  const first = await say(ASHA, "YES");
  const second = await say(ASHA, "YES");
  assert.equal(second.reply, first.reply);
  assert.equal(second.mediaUrl, QR_URL);
  assert.equal(await status(orders, "ORD001"), "QR_SENT");
  assert.equal((await orders.getOrder("ORD001"))?.paymentStatus, "PENDING");
});

test("NO after confirmation is refused and keeps the order confirmed", async (t) => {
  const { say, orders } = await setup(t);
  await placeOrder(say);
  await say(ASHA, "YES");
  const result = await say(ASHA, "NO");
  assert.match(result.reply ?? "", /already confirmed/);
  assert.equal(result.mediaUrl, undefined);
  assert.equal(await status(orders, "ORD001"), "QR_SENT");
});

test("NO cancels the order and confirms the cancellation", async (t) => {
  const { say, orders } = await setup(t);
  await placeOrder(say);
  const result = await say(ASHA, "No");
  assert.equal(result.reply, "Your order ORD001 has been cancelled.\nThank you!");
  assert.equal(result.mediaUrl, undefined);
  const order = await orders.getOrder("ORD001");
  assert.equal(order?.status, "CANCELLED");
  assert.ok(order?.cancelledAt);
  assert.equal(order?.paymentStatus, "PENDING");
});

test("repeating NO or answering YES after cancelling never revives the order", async (t) => {
  const { say, orders } = await setup(t);
  await placeOrder(say);
  await say(ASHA, "NO");
  assert.match((await say(ASHA, "NO")).reply ?? "", /already been cancelled/);
  const yes = await say(ASHA, "YES");
  assert.match(yes.reply ?? "", /was cancelled/);
  assert.equal(yes.mediaUrl, undefined);
  assert.equal(await status(orders, "ORD001"), "CANCELLED");
});

test("concurrent YES and NO decide the order exactly once", async (t) => {
  const { say, orders } = await setup(t);
  await placeOrder(say);
  const [yes, no] = await Promise.all([say(ASHA, "YES"), say(ASHA, "NO")]);
  const final = await status(orders, "ORD001");
  assert.ok(final === "QR_SENT" || final === "CANCELLED");
  const replies = [yes.reply ?? "", no.reply ?? ""].join("\n");
  assert.match(replies, final === "QR_SENT" ? /Your order is confirmed/ : /has been cancelled/);
});

test("one customer's answer cannot confirm or cancel another customer's order", async (t) => {
  const { say, orders } = await setup(t);
  const ashaOrder = await placeOrder(say, ASHA);
  const noOrders = await say(RAVI, "YES");
  assert.match(noOrders.reply ?? "", /could not find an order waiting/);
  const foreignId = await say(RAVI, `YES ${ashaOrder}`);
  assert.match(foreignId.reply ?? "", /could not find order ORD001 for your number/);
  const foreignCancel = await say(RAVI, `NO ${ashaOrder}`);
  assert.match(foreignCancel.reply ?? "", /could not find order ORD001 for your number/);
  assert.equal(foreignId.mediaUrl, undefined);
  assert.equal(await status(orders, ashaOrder), "AWAITING_CONFIRMATION");
  assert.equal((await say(ASHA, "YES")).mediaUrl, QR_URL);
});

test("unknown order IDs change nothing", async (t) => {
  const { say, orders } = await setup(t);
  await placeOrder(say);
  assert.match((await say(ASHA, "YES ORD999")).reply ?? "", /could not find order ORD999/);
  assert.equal(await status(orders, "ORD001"), "AWAITING_CONFIRMATION");
});

test("with several waiting orders a bare answer asks for the order ID", async (t) => {
  const { say, orders } = await setup(t);
  await placeOrder(say);
  await placeOrder(say, ASHA, "3 kg sugar");
  const result = await say(ASHA, "NO");
  assert.match(result.reply ?? "", /ORD001, ORD002/);
  assert.match(result.reply ?? "", /for example: YES ORD001/);
  assert.equal(await status(orders, "ORD001"), "AWAITING_CONFIRMATION");
  assert.equal(await status(orders, "ORD002"), "AWAITING_CONFIRMATION");
  assert.match((await say(ASHA, "no ORD002")).reply ?? "", /ORD002 has been cancelled/);
  assert.equal(await status(orders, "ORD001"), "AWAITING_CONFIRMATION");
});

test("an unrecognised reply to a waiting order gets a YES/NO prompt", async (t) => {
  const { say, orders } = await setup(t);
  await placeOrder(say);
  assert.equal((await say(ASHA, "maybe later")).reply, "Please reply YES to confirm or NO to cancel order ORD001.");
  assert.equal(await status(orders, "ORD001"), "AWAITING_CONFIRMATION");
});

test("chatter with nothing to confirm gets no reply", async (t) => {
  const { say, orders } = await setup(t);
  assert.deepEqual(await say(ASHA, "hello there"), {});
  assert.deepEqual(await say(ASHA, "   "), {});
  assert.deepEqual(await say(ASHA, "", { numMedia: 1 }), {});
  assert.equal((await orders.list()).length, 0);
  assert.equal((await orders.listMessages(ASHA)).length, 3);
});

test("a customer's slash command is never read as an order", async (t) => {
  const { say, orders, sent } = await setup(t);
  const order = await placeOrder(say, ASHA);
  assert.deepEqual(await say(RAVI, `/reply ${order} give me a refund`), {});
  assert.deepEqual(await say(ASHA, "/reply ORD001 hi"), {});
  assert.equal((await orders.list()).length, 1);
  assert.equal(sent.length, 0);
});

test("a media-only message while an order is waiting does not decide it", async (t) => {
  const { say, orders } = await setup(t);
  await placeOrder(say);
  const result = await say(ASHA, "", { numMedia: 1 });
  assert.deepEqual(result, {});
  assert.equal(await status(orders, "ORD001"), "AWAITING_CONFIRMATION");
});

test("the seller's /reply is forwarded to the order's customer and stored", async (t) => {
  const { say, orders, sent } = await setup(t);
  const order = await placeOrder(say, ASHA);
  await placeOrder(say, RAVI, "1 kg rice");
  const result = await say(SELLER, `/reply ${order.toLowerCase()}  Your order is being packed.\nIt will be ready shortly.`);
  assert.equal(result.reply, "Message sent to the customer of ORD001.");
  assert.deepEqual(sent, [{
    to: ASHA,
    body: "Your order is being packed.\nIt will be ready shortly.",
    mediaUrl: undefined,
  }]);
  const conversation = await orders.listMessages(ASHA);
  assert.deepEqual(conversation.slice(-2).map((m) => [m.direction, m.sender, m.from, m.to]), [
    ["INBOUND", "SELLER", SELLER, TWILIO],
    ["OUTBOUND", "SELLER", TWILIO, ASHA],
  ]);
  assert.equal(conversation.at(-1)?.body, "Your order is being packed.\nIt will be ready shortly.");
  assert.equal((await orders.listMessages(RAVI)).every((m) => m.sender !== "SELLER"), true);
  assert.equal(await status(orders, order), "AWAITING_CONFIRMATION");
  assert.equal((await orders.list()).length, 2);
});

test("seller messages are never turned into customer orders", async (t) => {
  const { say, orders, sent } = await setup(t);
  const help = await say(SELLER, "2 kg rice and 1 litre milk");
  assert.match(help.reply ?? "", /\/reply <ORDER_ID> <message>/);
  assert.match((await say(SELLER, "yes")).reply ?? "", /\/reply/);
  assert.match((await say(SELLER, "/reply ORD001")).reply ?? "", /\/reply/);
  assert.equal((await orders.list()).length, 0);
  assert.equal(sent.length, 0);
});

test("the seller gets a clear answer for an unknown order and nothing is sent", async (t) => {
  const { say, sent, orders } = await setup(t);
  assert.equal((await say(SELLER, "/reply ORD404 hello")).reply, "Order ORD404 was not found.");
  assert.equal(sent.length, 0);
  assert.equal((await orders.listMessages(SELLER)).length, 0);
});

test("a retried seller command does not message the customer twice", async (t) => {
  const { service, say, sent } = await setup(t);
  await placeOrder(say);
  const command = { from: SELLER, to: TWILIO, body: "/reply ORD001 On its way", messageSid: nextSid(), numMedia: 0 };
  assert.match((await service.processMessage(command)).reply ?? "", /Message sent/);
  assert.match((await service.processMessage(command)).reply ?? "", /already processed/);
  assert.equal(sent.length, 1);
});

test("a failed forward gives the seller a graceful reply and logs no credentials", async (t) => {
  const { say, logs, orders } = await setup(t, { sendFails: true });
  await placeOrder(say);
  const result = await say(SELLER, "/reply ORD001 hello");
  assert.match(result.reply ?? "", /Could not send the message for ORD001.*24 hours/);
  assert.ok(logs.some((entry) => entry.level === "error" && entry.message.includes("could not be sent")));
  assert.equal((await orders.listMessages(ASHA)).some((m) => m.direction === "OUTBOUND" && m.sender === "SELLER"), false);
});

test("rejects over-long seller messages", async (t) => {
  const { say, sent } = await setup(t);
  await placeOrder(say);
  assert.match((await say(SELLER, `/reply ORD001 ${"x".repeat(1601)}`)).reply ?? "", /too long/);
  assert.equal(sent.length, 0);
});

test("without a seller number /reply is disabled and everyone is treated as a customer", async (t) => {
  const { say, sent, orders } = await setup(t, { seller: false });
  const order = await placeOrder(say);
  assert.deepEqual(await say(SELLER, `/reply ${order} hello`), {});
  assert.equal(sent.length, 0);
  assert.equal((await say(SELLER, "2 kg rice")).reply?.includes("Order ID: ORD002"), true);
  assert.equal((await orders.list()).length, 2);
});

test("ignores messages that are not addressed to the Twilio number", async (t) => {
  const { service, orders, logs } = await setup(t);
  const result = await service.processMessage({
    from: ASHA, to: "whatsapp:+14155230000", body: ORDER_TEXT, messageSid: nextSid(), numMedia: 0,
  });
  assert.deepEqual(result, {});
  assert.equal((await orders.list()).length, 0);
  assert.ok(logs.some((entry) => entry.message.startsWith("Ignored message not addressed")));
});

test("persists orders, customers and messages across repository instances", async (t) => {
  const { say, storePath } = await setup(t);
  await say(ASHA, ORDER_TEXT, { profileName: "Asha" });
  await say(ASHA, "yes");
  const reopened = createJsonFileOrderRepository(storePath);
  assert.equal((await reopened.getOrder("ORD001"))?.status, "QR_SENT");
  assert.equal((await reopened.listMessages(ASHA)).length, 4);
  const saved = JSON.parse(await readFile(storePath, "utf8"));
  assert.equal(saved.customers[0].profileName, "Asha");
});

test("storage failures propagate so Twilio sees an error and retries", async (t) => {
  const { orders } = await setup(t);
  const failing: OrderRepository = { ...orders, createOrder: async () => { throw new Error("disk full"); } };
  const broken = createWhatsAppService({
    logger: { info() {}, warn() {}, error() {} },
    orders: failing,
    twilioNumber: TWILIO,
    sellerNumber: SELLER,
    sender: { send: async () => ({ messageSid: "SM1", status: "queued" }) },
  });
  await assert.rejects(
    broken.processMessage({ from: ASHA, to: TWILIO, body: ORDER_TEXT, messageSid: nextSid(), numMedia: 0 }),
    /disk full/,
  );
});

test("refines a Tamil order with the AI extractor and replies in Tamil", async (t) => {
  const texts: string[] = [];
  const orderExtractor: OrderExtractor = {
    async extract(text) {
      texts.push(text);
      return [
        { name: "rice", tamilName: "அரிசி", quantity: 3, unit: "kg" },
        { name: "sugar", tamilName: "சர்க்கரை", quantity: 0.5, unit: "kg" },
      ];
    },
  };
  const { say, orders } = await setup(t, { orderExtractor });
  const text = "மூன்று கிலோ அரிசி, அரை கிலோ சர்க்கரை";
  const messageSid = nextSid();
  const first = await say(ASHA, text, { messageSid });
  assert.equal(first.reply, [
    "உங்கள் ஆர்டர் பெறப்பட்டது!",
    "",
    "ஆர்டர் எண்: ORD001",
    "",
    "ஆர்டர் விவரம்:",
    "1. அரிசி - 3 கிலோ × ₹60/கிலோ = ₹180",
    "2. சர்க்கரை - 0.5 கிலோ × ₹45/கிலோ = ₹22.50",
    "",
    "மொத்த தொகை: ₹202.50",
    "",
    "உங்கள் ஆர்டரைத் தொடரலாமா?",
    "உறுதிசெய்ய YES அல்லது ரத்துசெய்ய NO என பதிலளிக்கவும். ஏதேனும் தவறாக இருந்தால், NO என பதிலளித்து உங்கள் ஆர்டரை மீண்டும் அனுப்பவும்.",
  ].join("\n"));
  // A Twilio retry reuses the stored order instead of calling the model again.
  assert.equal((await say(ASHA, text, { messageSid })).reply, first.reply);
  assert.deepEqual(texts, [text]);
  const order = await orders.getOrder("ORD001");
  assert.equal(order?.language, "ta");
  assert.equal(order?.rawMessage, text);

  const paid = await say(ASHA, "சரி");
  assert.equal(paid.mediaUrl, QR_URL);
  assert.match(paid.reply ?? "", /^உங்கள் ஆர்டர் உறுதிசெய்யப்பட்டது!\n\nஆர்டர் எண்: ORD001\n\nபில் விவரம்:\n1\. அரிசி - 3 கிலோ × ₹60\/கிலோ = ₹180\n2\. சர்க்கரை - 0\.5 கிலோ × ₹45\/கிலோ = ₹22\.50\n\nசெலுத்த வேண்டிய தொகை: ₹202\.50/u);
  assert.equal(await status(orders, "ORD001"), "QR_SENT");
});

test("answers an English order in English and falls back to the parser when the AI extractor fails", async (t) => {
  const orderExtractor: OrderExtractor = { extract: async () => { throw new Error("HTTP 500"); } };
  const { say, logs } = await setup(t, { orderExtractor });
  const result = await say(ASHA, ORDER_TEXT);
  assert.match(result.reply ?? "", /^Your order has been received![\s\S]*1\. Rice - 1 kg × ₹60\/kg = ₹60\n2\. Milk - 1 litre × ₹50\/litre = ₹50\n3\. Sugar - 2 kg × ₹45\/kg = ₹90/u);
  assert.ok(logs.some((log) => log.level === "warn" && log.message.startsWith("AI order extraction failed")));
});

const SCREENSHOT = { url: "https://api.twilio.com/2010-04-01/Accounts/AC1/Messages/MM1/Media/ME1", contentType: "image/jpeg" };

function proofStore(options: { fails?: boolean } = {}) {
  const saved: string[] = [];
  const store: PaymentProofStore = {
    async save(orderId, messageSid, index, media) {
      if (options.fails) {
        throw new Error("HTTP 404");
      }
      saved.push(`${orderId}:${messageSid}:${index}`);
      return {
        id: `${messageSid}-${index}`, messageSid, path: `proofs/${orderId}-${messageSid}-${index}.jpg`,
        contentType: media.contentType, size: 10, receivedAt: new Date().toISOString(),
      };
    },
  };
  return { store, saved };
}

test("stores a payment screenshot against the customer's confirmed order without marking it paid", async (t) => {
  const { store, saved } = proofStore();
  const { say, orders } = await setup(t, { paymentProofs: store });
  const id = await placeOrder(say);
  await say(ASHA, "YES");
  const messageSid = nextSid();
  const result = await say(ASHA, "", { messageSid, numMedia: 1, media: [SCREENSHOT] });
  assert.equal(result.reply, `Payment screenshot received for order ${id}. The seller will verify it and confirm. Thank you!`);
  // A Twilio retry neither downloads nor attaches the screenshot again.
  assert.equal((await say(ASHA, "", { messageSid, numMedia: 1, media: [SCREENSHOT] })).reply, result.reply);
  assert.deepEqual(saved, [`${id}:${messageSid}:0`]);
  const order = await orders.getOrder(id);
  assert.equal(order?.status, "QR_SENT");
  assert.equal(order?.paymentStatus, "SUBMITTED");
  assert.equal(order?.paymentProofs?.length, 1);
  const inbound = (await orders.listMessages(ASHA)).find((stored) => stored.id === messageSid);
  assert.equal(inbound?.orderId, id);
});

test("does not attach a screenshot to an unconfirmed or another customer's order", async (t) => {
  const { store, saved } = proofStore();
  const { say } = await setup(t, { paymentProofs: store });
  const id = await placeOrder(say, ASHA);
  await say(ASHA, "YES");
  const notFound = "We could not find a confirmed order waiting for payment. " +
    "Please send the screenshot with your order ID, for example: ORD001";
  assert.equal((await say(RAVI, id, { numMedia: 1, media: [SCREENSHOT] })).reply, notFound);
  await placeOrder(say, RAVI);
  assert.equal((await say(RAVI, "", { numMedia: 1, media: [SCREENSHOT] })).reply, notFound);
  assert.deepEqual(saved, []);
});

test("asks the customer to resend when the screenshot cannot be stored", async (t) => {
  const { store } = proofStore({ fails: true });
  const { say, orders, logs } = await setup(t, { paymentProofs: store });
  const id = await placeOrder(say);
  await say(ASHA, "YES");
  const result = await say(ASHA, "", { numMedia: 1, media: [SCREENSHOT] });
  assert.equal(result.reply, "We could not save your payment screenshot. Please send it again.");
  assert.equal((await orders.getOrder(id))?.paymentStatus, "PENDING");
  assert.ok(logs.some((log) => log.level === "error" && log.message === "Payment screenshot could not be stored"));
});
