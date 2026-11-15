import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadPaymentQr } from "../src/services/payment-qr.ts";

const url = "https://public.example.com/payments/paytm-qr";

test("loads PNG and JPEG QR images and rejects unsupported files", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "kirana-qr-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const files = {
    png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]),
    jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    text: Buffer.from("not an image"),
    empty: Buffer.alloc(0),
    large: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(5 * 1024 * 1024)]),
  };
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content);
  }

  assert.deepEqual(await loadPaymentQr(join(dir, "png"), url), { image: files.png, contentType: "image/png", url });
  assert.equal((await loadPaymentQr(join(dir, "jpeg"), url)).contentType, "image/jpeg");
  await assert.rejects(loadPaymentQr(join(dir, "text"), url), /PNG or JPEG/);
  await assert.rejects(loadPaymentQr(join(dir, "empty"), url), /PNG or JPEG/);
  await assert.rejects(loadPaymentQr(join(dir, "large"), url), /at most 5 MB/);
  await assert.rejects(loadPaymentQr(join(dir, "missing.png"), url), /Cannot read PAYTM_QR_PATH/);
});
