import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPaymentProofStore } from "../src/services/payment-proofs.ts";

const MEDIA_URL = "https://api.twilio.com/2010-04-01/Accounts/AC1/Messages/MM1/Media/ME1";

test("downloads Twilio media with account credentials and stores it privately", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "kirana-proofs-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let authorization: string | undefined;
  const store = createPaymentProofStore({ accountSid: "AC1", authToken: "secret", directory }, {
    fetchImpl: async (_url, init) => {
      authorization = (init?.headers as Record<string, string>).Authorization;
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
    },
  });
  const proof = await store.save("ORD001", "MM1", 0, { url: MEDIA_URL, contentType: "image/png" });
  assert.equal(authorization, `Basic ${Buffer.from("AC1:secret").toString("base64")}`);
  assert.equal(proof.path, join(directory, "ORD001-MM1-0.png"));
  assert.equal(proof.size, 3);
  assert.deepEqual([...await readFile(proof.path)], [1, 2, 3]);
  assert.equal((await stat(proof.path)).mode & 0o777, 0o600);
});

test("refuses non-Twilio URLs, unsupported types and failed downloads", async () => {
  let calls = 0;
  const store = createPaymentProofStore({ accountSid: "AC1", authToken: "secret", directory: "unused" }, {
    fetchImpl: async () => { calls++; return new Response("missing", { status: 404 }); },
  });
  await assert.rejects(store.save("ORD001", "MM1", 0, { url: "https://evil.example/x.png", contentType: "image/png" }));
  await assert.rejects(store.save("ORD001", "MM1", 0, { url: MEDIA_URL, contentType: "video/mp4" }));
  assert.equal(calls, 0);
  await assert.rejects(store.save("ORD001", "MM1", 0, { url: MEDIA_URL, contentType: "image/png" }), /HTTP 404/);
});
