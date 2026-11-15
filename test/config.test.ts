import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";

const env = {
  TWILIO_ACCOUNT_SID: `AC${"1".repeat(32)}`,
  TWILIO_AUTH_TOKEN: "test-only-token",
  TWILIO_WEBHOOK_URL: "https://public.example.com/api/whatsapp/incoming?source=sandbox",
  TWILIO_WHATSAPP_NUMBER: "whatsapp:+14155238886",
  SELLER_WHATSAPP_NUMBER: "whatsapp:+919876543210",
};

test("preserves the exact public webhook URL including its query string", () => {
  assert.equal(loadConfig(env).twilio.webhookUrl, env.TWILIO_WEBHOOK_URL);
});

test("requires credentials and a valid webhook URL in every environment", () => {
  for (const name of Object.keys(env).filter((key) => key !== "SELLER_WHATSAPP_NUMBER")) {
    assert.throws(() => loadConfig({ ...env, [name]: "", NODE_ENV: "production" }), /required/);
  }
  assert.throws(() => loadConfig({ ...env, TWILIO_ACCOUNT_SID: "invalid" }), /Account SID/);
  assert.throws(() => loadConfig({ ...env, SELLER_WHATSAPP_NUMBER: "+919876543210" }), /SELLER_WHATSAPP_NUMBER/);
  assert.throws(() => loadConfig({ ...env, TWILIO_WHATSAPP_NUMBER: "+14155238886" }), /TWILIO_WHATSAPP_NUMBER/);
  for (const url of [
    "not-a-url", "ftp://example.com/api/whatsapp/incoming",
    "https://example.com/wrong-path", "https://example.com/api/whatsapp/incoming#fragment",
    "https://user:password@example.com/api/whatsapp/incoming",
  ]) {
    assert.throws(() => loadConfig({ ...env, TWILIO_WEBHOOK_URL: url }), /TWILIO_WEBHOOK_URL/);
  }
});

test("rejects invalid server ports", () => {
  for (const port of ["", "0", "65536", "3.5", "invalid"]) {
    assert.throws(() => loadConfig({ ...env, PORT: port }), /PORT/);
  }
});

test("manual reply API is disabled without a valid configured token", () => {
  assert.equal(loadConfig(env).manualReplyApiToken, undefined);
  assert.equal(loadConfig({ ...env, WHATSAPP_REPLY_API_TOKEN: "" }).manualReplyApiToken, undefined);
  assert.equal(loadConfig({ ...env, WHATSAPP_REPLY_API_TOKEN: "a".repeat(32) }).manualReplyApiToken, "a".repeat(32));
  for (const token of ["short", "a".repeat(31), `${"a".repeat(32)} `, "a".repeat(257)]) {
    assert.throws(() => loadConfig({ ...env, WHATSAPP_REPLY_API_TOKEN: token }), /WHATSAPP_REPLY_API_TOKEN/);
  }
});

test("validates the optional fixed terminal reply recipient", () => {
  assert.equal(loadConfig(env).terminalReplyTo, undefined);
  assert.equal(loadConfig({ ...env, WHATSAPP_REPLY_TO: "" }).terminalReplyTo, undefined);
  assert.equal(
    loadConfig({ ...env, WHATSAPP_REPLY_TO: "whatsapp:+15551234567" }).terminalReplyTo,
    "whatsapp:+15551234567",
  );
  assert.throws(() => loadConfig({ ...env, WHATSAPP_REPLY_TO: "+15551234567" }), /WHATSAPP_REPLY_TO/);
});

test("derives the public Paytm QR URL from the webhook origin", () => {
  assert.equal(loadConfig(env).paymentQr, undefined);
  assert.equal(loadConfig({ ...env, PAYTM_QR_PATH: " " }).paymentQr, undefined);
  assert.deepEqual(loadConfig({ ...env, PAYTM_QR_PATH: " assets/paytm-qr.png " }).paymentQr, {
    path: "assets/paytm-qr.png",
    url: "https://public.example.com/payments/paytm-qr",
  });
});

test("separates the Twilio number from the seller's own number", () => {
  const config = loadConfig(env);
  assert.equal(config.twilio.whatsappNumber, env.TWILIO_WHATSAPP_NUMBER);
  assert.equal(config.orders.sellerNumber, env.SELLER_WHATSAPP_NUMBER);
  assert.throws(
    () => loadConfig({ ...env, SELLER_WHATSAPP_NUMBER: env.TWILIO_WHATSAPP_NUMBER }),
    /not the Twilio number/,
  );
  for (const blank of ["", "  "]) {
    assert.equal(loadConfig({ ...env, SELLER_WHATSAPP_NUMBER: blank }).orders.sellerNumber, undefined);
  }
});

test("accepts a static payment QR URL instead of a local file", () => {
  assert.deepEqual(loadConfig({ ...env, STATIC_PAYMENT_QR_URL: " https://cdn.example.com/qr.png " }).paymentQr, {
    url: "https://cdn.example.com/qr.png",
  });
  for (const url of ["not-a-url", "http://cdn.example.com/qr.png", "https://user:pass@cdn.example.com/qr.png"]) {
    assert.throws(() => loadConfig({ ...env, STATIC_PAYMENT_QR_URL: url }), /STATIC_PAYMENT_QR_URL/);
  }
  assert.throws(
    () => loadConfig({ ...env, PAYTM_QR_PATH: "qr.png", STATIC_PAYMENT_QR_URL: "https://cdn.example.com/qr.png" }),
    /only one/,
  );
});

test("reads the optional product price catalog path", () => {
  assert.equal(loadConfig(env).orders.pricesPath, undefined);
  assert.equal(loadConfig({ ...env, PRODUCT_PRICES_PATH: " data/prices.json " }).orders.pricesPath, "data/prices.json");
});
