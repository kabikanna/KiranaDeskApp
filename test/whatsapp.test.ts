import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import twilio from "twilio";
import type { AppConfig } from "../src/config.ts";
import type { Logger } from "../src/logger.ts";
import { createServer } from "../src/server.ts";
import type { WhatsAppMessage, WhatsAppProcessingResult } from "../src/services/whatsapp.ts";

const config: AppConfig = {
  host: "127.0.0.1",
  port: 3000,
  twilio: {
    accountSid: `AC${"1".repeat(32)}`,
    authToken: "test-only-auth-token",
    webhookUrl: "https://public.example.com/api/whatsapp/incoming?source=sandbox",
    whatsappNumber: "whatsapp:+14155238886",
  },
  orders: { sellerNumber: "whatsapp:+919800000001", storePath: "unused.json", paymentProofDir: "unused-proofs" },
  manualReplyApiToken: "test-only-reply-token-1234567890",
};

const basePayload = {
  From: "whatsapp:+15551234567",
  To: "whatsapp:+14155238886",
  Body: "Hello + नमस्ते & welcome",
  MessageSid: `SM${"2".repeat(32)}`,
  NumMedia: "0",
  AccountSid: config.twilio.accountSid,
};

function setup(t: TestContext, failProcessing = false, result: WhatsAppProcessingResult = {}) {
  const messages: WhatsAppMessage[] = [];
  const logs: { level: string; message: string; details?: Record<string, unknown> }[] = [];
  const logger: Logger = {
    info: (message, details = {}) => { logs.push({ level: "info", message, details }); },
    warn: (message, details = {}) => { logs.push({ level: "warn", message, details }); },
    error: (message, details = {}) => { logs.push({ level: "error", message, details }); },
  };
  const server = createServer(config, {
    logger,
    whatsappService: {
      async processMessage(message) {
        if (failProcessing) {
          throw new Error("processor unavailable");
        }
        messages.push(message);
        return result;
      },
    },
  });
  t.after(() => server.stop());
  function send(
    payload: Record<string, string>,
    signature = twilio.getExpectedTwilioSignature(
      config.twilio.authToken, config.twilio.webhookUrl, payload,
    ),
  ) {
    return server.inject({
      method: "POST",
      url: "/api/whatsapp/incoming?source=sandbox",
      headers: {
        host: "internal.local:3000",
        "x-forwarded-host": "untrusted.example.com",
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "x-twilio-signature": signature,
      },
      payload: new URLSearchParams(payload).toString(),
    });
  }
  return { server, send, messages, logs, logger };
}

test("processes a signed form using the exact public URL, not proxy headers", async (t) => {
  const { send, messages } = setup(t);
  const response = await send(basePayload);
  assert.equal(response.statusCode, 200);
  assert.match(String(response.headers["content-type"]), /^text\/xml/);
  assert.equal(response.payload, '<?xml version="1.0" encoding="UTF-8"?><Response/>');
  assert.deepEqual(messages, [{
    from: basePayload.From,
    to: basePayload.To,
    body: basePayload.Body,
    messageSid: basePayload.MessageSid,
    numMedia: 0,
  }]);
});

test("stores a signed order and returns the YES/NO confirmation question on the configured route", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "kirana-webhook-"));
  const storePath = join(dir, "orders.json");
  const server = createServer(
    { ...config, orders: { ...config.orders, storePath } },
    { logger: { info() {}, warn() {}, error() {} } },
  );
  t.after(async () => {
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  });
  const payload = { ...basePayload, Body: "2 kg rice" };
  const response = await server.inject({
    method: "POST",
    url: "/api/whatsapp/incoming?source=sandbox",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": twilio.getExpectedTwilioSignature(
        config.twilio.authToken, config.twilio.webhookUrl, payload,
      ),
    },
    payload: new URLSearchParams(payload).toString(),
  });
  assert.equal(response.statusCode, 200);
  assert.match(response.payload, /Your order has been received!\n\nOrder ID: ORD001\n/);
  assert.match(response.payload, /Reply YES to confirm or NO to cancel\./);
  const { orders, messages } = JSON.parse(await readFile(storePath, "utf8"));
  assert.equal(orders.length, 1);
  assert.equal(orders[0].id, "ORD001");
  assert.equal(orders[0].status, "AWAITING_CONFIRMATION");
  assert.equal(orders[0].messageSid, payload.MessageSid);
  assert.deepEqual(orders[0].items, [{ name: "rice", quantity: 2, unit: "kg" }]);
  assert.deepEqual(messages.map((m: { direction: string }) => m.direction), ["INBOUND", "OUTBOUND"]);
});

test("accepts a missing Body as empty text", async (t) => {
  const { send, messages } = setup(t);
  const { Body: _body, ...payload } = basePayload;
  assert.equal((await send(payload)).statusCode, 200);
  assert.equal(messages[0]?.body, "");
});

test("accepts an explicitly empty message", async (t) => {
  const { send, messages } = setup(t);
  assert.equal((await send({ ...basePayload, Body: "" })).statusCode, 200);
  assert.equal(messages[0]?.body, "");
});

test("accepts media-only messages without downloading attachments", async (t) => {
  const { send, messages } = setup(t);
  const { Body: _body, ...payload } = basePayload;
  assert.equal((await send({
    ...payload, NumMedia: "1", MediaUrl0: "https://example.com/image.jpg",
    MediaContentType0: "image/jpeg",
  })).statusCode, 200);
  assert.equal(messages[0]?.body, "");
  assert.equal(messages[0]?.numMedia, 1);
});

test("passes Twilio-hosted attachments to the service and drops other media URLs", async (t) => {
  const { send, messages } = setup(t);
  const twilioUrl = "https://api.twilio.com/2010-04-01/Accounts/AC123/Messages/MM123/Media/ME123";
  assert.equal((await send({
    ...basePayload, NumMedia: "2",
    MediaUrl0: twilioUrl, MediaContentType0: "image/JPEG",
    MediaUrl1: "https://attacker.example.com/x.png", MediaContentType1: "image/png",
  })).statusCode, 200);
  assert.deepEqual(messages[0]?.media, [{ url: twilioUrl, contentType: "image/jpeg" }]);
});

test("rejects invalid and missing signatures without processing", async (t) => {
  const { send, server, messages, logs } = setup(t);
  assert.equal((await send(basePayload, "invalid")).statusCode, 403);
  const response = await server.inject({
    method: "POST",
    url: "/api/whatsapp/incoming",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams(basePayload).toString(),
  });
  assert.equal(response.statusCode, 403);
  assert.equal(messages.length, 0);
  assert.equal(logs.filter((entry) => entry.level === "warn").length, 2);
});

test("rejects a signature generated for a different URL or changed field", async (t) => {
  const { send, messages } = setup(t);
  const wrongUrlSignature = twilio.getExpectedTwilioSignature(
    config.twilio.authToken, "http://internal.local:3000/api/whatsapp/incoming", basePayload,
  );
  assert.equal((await send(basePayload, wrongUrlSignature)).statusCode, 403);
  const originalSignature = twilio.getExpectedTwilioSignature(
    config.twilio.authToken, config.twilio.webhookUrl, basePayload,
  );
  assert.equal((await send({ ...basePayload, AccountSid: "changed" }, originalSignature)).statusCode, 403);
  assert.equal(messages.length, 0);
});

test("rejects signed payloads missing mandatory fields or invalid media counts", async (t) => {
  const { send, messages } = setup(t);
  for (const field of ["From", "To", "MessageSid", "NumMedia"]) {
    const payload: Record<string, string> = { ...basePayload };
    delete payload[field];
    assert.equal((await send(payload)).statusCode, 400, field);
  }
  for (const numMedia of ["-1", "1.5", "NaN", "9007199254740992", ""]) {
    assert.equal((await send({ ...basePayload, NumMedia: numMedia })).statusCode, 400, numMedia);
  }
  assert.equal((await send({ ...basePayload, From: "not-whatsapp" })).statusCode, 400);
  assert.equal((await send({ ...basePayload, MessageSid: "invalid" })).statusCode, 400);
  assert.equal((await send({})).statusCode, 400);
  assert.equal(messages.length, 0);
});

test("rejects unsupported content types and repeated form fields", async (t) => {
  const { server, messages } = setup(t);
  const jsonResponse = await server.inject({
    method: "POST",
    url: "/api/whatsapp/incoming",
    headers: { "content-type": "application/json", "x-twilio-signature": "invalid" },
    payload: JSON.stringify(basePayload),
  });
  assert.equal(jsonResponse.statusCode, 415);
  const duplicateResponse = await server.inject({
    method: "POST",
    url: "/api/whatsapp/incoming",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": "invalid" },
    payload: `${new URLSearchParams(basePayload)}&From=duplicate`,
  });
  assert.equal(duplicateResponse.statusCode, 400);
  assert.equal(messages.length, 0);
});

test("returns 500 and logs processing errors without exposing them", async (t) => {
  const { send, logs } = setup(t, true);
  const response = await send(basePayload);
  assert.equal(response.statusCode, 500);
  assert.doesNotMatch(response.payload, /processor unavailable/);
  assert.equal(logs[0]?.level, "error");
  assert.match(String(logs[0]?.details?.error), /processor unavailable/);
});

test("returns the processor's reply as a TwiML message", async (t) => {
  const { send } = setup(t, false, { reply: "Your order has been taken to the seller." });
  const response = await send(basePayload);
  assert.equal(response.statusCode, 200);
  assert.equal(
    response.payload,
    '<?xml version="1.0" encoding="UTF-8"?><Response><Message>Your order has been taken to the seller.</Message></Response>',
  );
});

test("returns the processor's media reply as TwiML body and media", async (t) => {
  const { send } = setup(t, false, {
    reply: "Pay using this Paytm QR.",
    mediaUrl: "https://public.example.com/payments/paytm-qr",
  });
  const response = await send(basePayload);
  assert.equal(response.statusCode, 200);
  assert.equal(
    response.payload,
    '<?xml version="1.0" encoding="UTF-8"?><Response><Message><Body>Pay using this Paytm QR.</Body>' +
      "<Media>https://public.example.com/payments/paytm-qr</Media></Message></Response>",
  );
});

test("serves the loaded Paytm QR image only when configured", async (t) => {
  const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const logger: Logger = { info() {}, warn() {}, error() {} };
  const server = createServer(config, {
    logger,
    paymentQr: { image, contentType: "image/png", url: "https://public.example.com/payments/paytm-qr" },
  });
  const disabledServer = createServer(config, { logger });
  t.after(async () => {
    await server.stop();
    await disabledServer.stop();
  });

  const response = await server.inject("/payments/paytm-qr");
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["content-type"], "image/png");
  assert.deepEqual(response.rawPayload, image);
  assert.equal((await disabledServer.inject("/payments/paytm-qr")).statusCode, 404);
});
