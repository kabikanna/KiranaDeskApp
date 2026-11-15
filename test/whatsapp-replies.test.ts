import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import type { AppConfig } from "../src/config.ts";
import type { Logger } from "../src/logger.ts";
import { createServer } from "../src/server.ts";
import { createWhatsAppReplySender } from "../src/services/whatsapp-replies.ts";

const token = "test-only-reply-api-token-1234567890";
const config: AppConfig = {
  host: "127.0.0.1",
  port: 3000,
  twilio: {
    accountSid: `AC${"1".repeat(32)}`,
    authToken: "test-only-auth-token",
    webhookUrl: "https://public.example.com/api/whatsapp/incoming",
    whatsappNumber: "whatsapp:+14155238886",
  },
  orders: { sellerNumber: "whatsapp:+919800000001", storePath: "unused.json", paymentProofDir: "unused-proofs" },
  manualReplyApiToken: token,
};
const recipient = "whatsapp:+15551234567";
const messageSid = `SM${"3".repeat(32)}`;
const paymentQrUrl = "https://public.example.com/payments/paytm-qr";

function setup(t: TestContext, options: { disabled?: boolean; fail?: boolean; paymentQr?: boolean } = {}) {
  const sent: { to: string; body: string; mediaUrl?: string }[] = [];
  const logs: { level: string; message: string; details?: Record<string, unknown> }[] = [];
  const logger: Logger = {
    info: (message, details = {}) => { logs.push({ level: "info", message, details }); },
    warn: (message, details = {}) => { logs.push({ level: "warn", message, details }); },
    error: (message, details = {}) => { logs.push({ level: "error", message, details }); },
  };
  const { manualReplyApiToken: _token, ...disabledConfig } = config;
  const server = createServer(options.disabled ? disabledConfig : config, {
    logger,
    ...(options.paymentQr
      ? { paymentQr: { image: Buffer.from([0xff, 0xd8, 0xff]), contentType: "image/jpeg" as const, url: paymentQrUrl } }
      : {}),
    whatsappReplySender: {
      async send(to, body, mediaUrl) {
        sent.push({ to, body, ...(mediaUrl ? { mediaUrl } : {}) });
        if (options.fail) {
          throw new Error("Twilio upstream failure details");
        }
        return { messageSid, status: "queued" };
      },
    },
  });
  t.after(() => server.stop());
  function send(payload: unknown, authorization: string | undefined = `Bearer ${token}`, url = "/messages/whatsapp") {
    return server.inject({
      method: "POST",
      url,
      headers: {
        "content-type": "application/json",
        ...(authorization === undefined ? {} : { authorization }),
      },
      payload: JSON.stringify(payload),
    });
  }
  return { server, send, sent, logs };
}

test("sends an authenticated manual reply and returns Twilio's accepted status", async (t) => {
  const { send, sent } = setup(t);
  const response = await send({ to: recipient, body: "Your order is ready." });
  assert.equal(response.statusCode, 202);
  assert.deepEqual(response.result, { messageSid, status: "queued" });
  assert.deepEqual(sent, [{ to: recipient, body: "Your order is ready." }]);
});

test("uses the configured Twilio WhatsApp number as the sender in the Twilio SDK request", async () => {
  const calls: { from: string; to: string; body: string; mediaUrl?: string[] }[] = [];
  const logger: Logger = { info() {}, warn() {}, error() {} };
  const sender = createWhatsAppReplySender(config.twilio, logger, {
    messages: {
      async create(message) {
        calls.push(message);
        return { sid: messageSid, status: "queued" };
      },
    },
  });

  assert.deepEqual(await sender.send(recipient, "Your order is ready."), {
    messageSid, status: "queued",
  });
  assert.deepEqual(await sender.send(recipient, "Please pay.", paymentQrUrl), {
    messageSid, status: "queued",
  });
  assert.deepEqual(calls, [{
    from: config.twilio.whatsappNumber,
    to: recipient,
    body: "Your order is ready.",
  }, {
    from: config.twilio.whatsappNumber,
    to: recipient,
    body: "Please pay.",
    mediaUrl: [paymentQrUrl],
  }]);
});

test("rejects missing and invalid credentials without sending", async (t) => {
  const { server, send, sent } = setup(t);
  const missing = await server.inject({
    method: "POST",
    url: "/messages/whatsapp",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ to: recipient, body: "Hello" }),
  });
  assert.equal(missing.statusCode, 401);
  assert.equal((await send({ to: recipient, body: "Hello" }, "Bearer wrong-token")).statusCode, 401);
  assert.equal((await send({ to: recipient, body: "Hello" }, token)).statusCode, 401);
  assert.deepEqual(sent, []);
});

test("disables manual replies when no API token is configured", async (t) => {
  const { send, sent, logs } = setup(t, { disabled: true });
  const response = await send({ to: recipient, body: "Hello" });
  assert.equal(response.statusCode, 503);
  assert.deepEqual(sent, []);
  assert.ok(logs.some((entry) => entry.level === "warn" && entry.message.includes("disabled")));
});

test("rejects invalid recipients and message content without sending", async (t) => {
  const { send, sent } = setup(t);
  for (const payload of [
    null,
    [],
    {},
    { to: "+15551234567", body: "Hello" },
    { to: "whatsapp:+0123456789", body: "Hello" },
    { to: recipient, body: "" },
    { to: recipient, body: " \n " },
    { to: recipient, body: "a".repeat(1601) },
    { to: recipient, body: "Hello", from: "whatsapp:+15550000000" },
  ]) {
    assert.equal((await send(payload)).statusCode, 400, JSON.stringify(payload));
  }
  assert.deepEqual(sent, []);
});

test("rejects the Twilio sender number as the reply recipient", async (t) => {
  const { send, sent } = setup(t);
  const response = await send({ to: config.twilio.whatsappNumber, body: "Hello" });
  assert.equal(response.statusCode, 400);
  assert.match(response.payload, /customer's WhatsApp number/);
  assert.deepEqual(sent, []);
});

test("accepts a message at the 1600-character limit", async (t) => {
  const { send, sent } = setup(t);
  const body = "😀".repeat(1600);
  assert.equal((await send({ to: recipient, body })).statusCode, 202);
  assert.equal(sent[0]?.body, body);
  assert.equal((await send({ to: recipient, body: `${body}😀` })).statusCode, 400);
  assert.equal(sent.length, 1);
});

test("rejects unsupported content types and oversized payloads", async (t) => {
  const { server, send, sent } = setup(t);
  const textResponse = await server.inject({
    method: "POST",
    url: "/messages/whatsapp",
    headers: { authorization: `Bearer ${token}`, "content-type": "text/plain" },
    payload: "Hello",
  });
  assert.equal(textResponse.statusCode, 415);
  assert.equal((await send({ to: recipient, body: "a".repeat(33 * 1024) })).statusCode, 413);
  assert.deepEqual(sent, []);
});

test("returns a safe error when Twilio cannot accept the message", async (t) => {
  const { send, logs } = setup(t, { fail: true });
  const response = await send({ to: recipient, body: "Hello" });
  assert.equal(response.statusCode, 502);
  assert.doesNotMatch(response.payload, /Twilio upstream failure details/);
  assert.ok(logs.some((entry) => entry.level === "error" &&
    entry.details?.error === "Twilio upstream failure details"));
});
