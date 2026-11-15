import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { createServer as createAppServer } from "../src/server.ts";

const recipient = "whatsapp:+15551234567";
const token = "test-only-reply-api-token-1234567890";
const messageSid = `SM${"3".repeat(32)}`;

async function setupApi(t: TestContext, statusCode = 202) {
  const requests: { method: string | undefined; url: string | undefined; authorization: string | undefined; body: unknown }[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        body: JSON.parse(body),
      });
      response.writeHead(statusCode, { "content-type": "application/json" });
      response.end(JSON.stringify(
        statusCode === 202 ? { messageSid, status: "queued" } : { message: "Twilio did not confirm the submission" },
      ));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { port: address.port, requests };
}

async function runTerminal(port: number, input: string, overrides: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, ["src/terminal-reply.ts"], {
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      TWILIO_ACCOUNT_SID: `AC${"1".repeat(32)}`,
      TWILIO_AUTH_TOKEN: "test-only-auth-token",
      TWILIO_WEBHOOK_URL: "https://public.example.com/api/whatsapp/incoming",
      TWILIO_WHATSAPP_NUMBER: "whatsapp:+14155238886",
      SELLER_WHATSAPP_NUMBER: "whatsapp:+919800000001",
      WHATSAPP_REPLY_API_TOKEN: token,
      WHATSAPP_REPLY_TO: recipient,
      ...overrides,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  child.stdin.end(input);
  const [code] = await once(child, "close");
  return { code, stdout, stderr };
}

test("sends terminal lines to the fixed recipient through the authenticated API", async (t) => {
  const { port, requests } = await setupApi(t);
  const result = await runTerminal(port, " \nYour order is ready.\nSee you soon.\n/quit\n");
  assert.equal(result.code, 0);
  assert.match(result.stderr, /Message cannot be empty/);
  assert.match(result.stdout, /Accepted by Twilio/);
  assert.match(result.stdout, /delivery is not yet confirmed/);
  assert.doesNotMatch(result.stdout, new RegExp(token));
  assert.deepEqual(requests, [
    { method: "POST", url: "/messages/whatsapp", authorization: `Bearer ${token}`, body: { to: recipient, body: "Your order is ready." } },
    { method: "POST", url: "/messages/whatsapp", authorization: `Bearer ${token}`, body: { to: recipient, body: "See you soon." } },
  ]);
});

test("reports API failures instead of claiming a reply was sent", async (t) => {
  const { port, requests } = await setupApi(t, 502);
  const result = await runTerminal(port, "Hello\n/quit\n");
  assert.equal(result.code, 1);
  assert.match(result.stderr, /HTTP 502/);
  assert.match(result.stderr, /Check backend logs and Twilio/);
  assert.match(result.stderr, /outcome may be unknown/);
  assert.doesNotMatch(result.stdout, /Accepted by Twilio/);
  assert.equal(requests.length, 1);
});

test("requires a fixed recipient before reading messages", async (t) => {
  const { port, requests } = await setupApi(t);
  const result = await runTerminal(port, "Hello\n/quit\n", { WHATSAPP_REPLY_TO: "" });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Set WHATSAPP_REPLY_TO/);
  assert.deepEqual(requests, []);
});

test("rejects the sender as the terminal recipient before sending", async (t) => {
  const { port, requests } = await setupApi(t);
  const result = await runTerminal(port, "Hello\n/quit\n", {
    WHATSAPP_REPLY_TO: "whatsapp:+14155238886",
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /WHATSAPP_REPLY_TO must be the customer's WhatsApp number/);
  assert.match(result.stderr, /TWILIO_WHATSAPP_NUMBER/);
  assert.deepEqual(requests, []);
});

test("sends a terminal message through the actual reply route", async (t) => {
  const sent: { to: string; body: string }[] = [];
  const server = createAppServer({
    host: "127.0.0.1",
    port: 0,
    twilio: {
      accountSid: `AC${"1".repeat(32)}`,
      authToken: "test-only-auth-token",
      webhookUrl: "https://public.example.com/api/whatsapp/incoming",
      whatsappNumber: "whatsapp:+14155238886",
    },
    orders: { sellerNumber: "whatsapp:+919800000001", storePath: "unused.json", paymentProofDir: "unused-proofs" },
    manualReplyApiToken: token,
  }, {
    logger: { info() {}, warn() {}, error() {} },
    whatsappReplySender: {
      async send(to, body) {
        sent.push({ to, body });
        return { messageSid, status: "queued" };
      },
    },
  });
  await server.start();
  t.after(() => server.stop());

  const port = server.info.port;
  assert.ok(typeof port === "number");
  const result = await runTerminal(port, "Your order is ready.\n/quit\n");
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Accepted by Twilio/);
  assert.deepEqual(sent, [{ to: recipient, body: "Your order is ready." }]);
});

test("sends /qr amounts to the Paytm QR API and does not send invalid commands", async (t) => {
  const { port, requests } = await setupApi(t);
  const result = await runTerminal(port, "/qr\n/unknown\n/qr 250\n/quit\n");
  assert.equal(result.code, 0);
  assert.match(result.stderr, /Usage: \/qr <amount>/);
  assert.match(result.stderr, /Unknown command/);
  assert.match(result.stdout, /Accepted by Twilio/);
  assert.deepEqual(requests, [{
    method: "POST",
    url: "/messages/whatsapp/payment-qr",
    authorization: `Bearer ${token}`,
    body: { to: recipient, amount: "250" },
  }]);
});
