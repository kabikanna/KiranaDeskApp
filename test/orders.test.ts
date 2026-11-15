import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { createJsonFileOrderRepository } from "../src/repositories/orders.ts";
import type { NewOrder } from "../src/repositories/orders.ts";
import { parseOrder } from "../src/services/order-parser.ts";
import { loadPriceCatalog, priceItems } from "../src/services/pricing.ts";

const customer = "whatsapp:+919800000002";

async function tempDir(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "kirana-orders-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const newOrder = (n: number, overrides: Partial<NewOrder> = {}): NewOrder => ({
  messageSid: `SM${String(n).padStart(32, "0")}`,
  customerNumber: customer,
  items: [{ name: "rice", quantity: n, unit: "kg" }],
  unparsedLines: [],
  rawMessage: `${n} kg rice`,
  numMedia: 0,
  ...overrides,
});

test("parses common order formats into a net item list", () => {
  assert.deepEqual(parseOrder("Hi, please send 2kg rice, 1 litre milk and 3 bread\nRice 1 kg\n- Eggs x12\n2. Toor dal: 500 gms"), {
    items: [
      { name: "rice", quantity: 3, unit: "kg" },
      { name: "milk", quantity: 1, unit: "l" },
      { name: "bread", quantity: 3, unit: "pcs" },
      { name: "eggs", quantity: 12, unit: "pcs" },
      { name: "toor dal", quantity: 500, unit: "g" },
    ],
    unparsedLines: ["Hi"],
  });
  assert.deepEqual(parseOrder("5 gulab jamun\n2 kg of atta\nMaggi 2 packets\n1.5 kg sugar").items, [
    { name: "gulab jamun", quantity: 5, unit: "pcs" },
    { name: "atta", quantity: 2, unit: "kg" },
    { name: "maggi", quantity: 2, unit: "pack" },
    { name: "sugar", quantity: 1.5, unit: "kg" },
  ]);
});

test("does not treat greetings, empty text or phone numbers as items", () => {
  assert.deepEqual(parseOrder(""), { items: [], unparsedLines: [] });
  assert.deepEqual(parseOrder("hello").items, []);
  assert.deepEqual(parseOrder("call me 9876543210").items, []);
});

test("creates sequential order IDs in RECEIVED status with pending payment", async (t) => {
  const orders = createJsonFileOrderRepository(join(await tempDir(t), "nested", "orders.json"));
  const first = await orders.createOrder(newOrder(1));
  const second = await orders.createOrder(newOrder(2));
  assert.equal(first.created, true);
  assert.deepEqual([first.order.id, second.order.id], ["ORD001", "ORD002"]);
  assert.equal(first.order.status, "RECEIVED");
  assert.equal(first.order.paymentStatus, "PENDING");
  assert.equal(first.order.receivedAt, first.order.updatedAt);
  assert.deepEqual((await orders.getOrder("ORD002"))?.items, [{ name: "rice", quantity: 2, unit: "kg" }]);
  assert.equal(await orders.getOrder("ORD999"), undefined);
});

test("returns the existing order for a redelivered MessageSid", async (t) => {
  const orders = createJsonFileOrderRepository(join(await tempDir(t), "orders.json"));
  const first = await orders.createOrder(newOrder(1));
  const again = await orders.createOrder(newOrder(1));
  assert.equal(again.created, false);
  assert.equal(again.order.id, first.order.id);
  assert.equal((await orders.list()).length, 1);
});

test("keeps concurrent orders without losing writes or reusing IDs", async (t) => {
  const orders = createJsonFileOrderRepository(join(await tempDir(t), "orders.json"));
  await Promise.all(Array.from({ length: 10 }, (_, i) => orders.createOrder(newOrder(i + 1))));
  const ids = (await orders.list()).map((order) => order.id);
  assert.equal(new Set(ids).size, 10);
  assert.equal(ids.at(-1), "ORD010");
});

test("transitions an order only from the expected status", async (t) => {
  const orders = createJsonFileOrderRepository(join(await tempDir(t), "orders.json"));
  const { order } = await orders.createOrder(newOrder(1));
  const waiting = await orders.transitionOrder(order.id, ["RECEIVED"], { status: "AWAITING_CONFIRMATION" });
  assert.equal(waiting?.status, "AWAITING_CONFIRMATION");
  assert.equal(await orders.transitionOrder(order.id, ["RECEIVED"], { status: "CANCELLED" }), undefined);
  assert.equal(await orders.transitionOrder("ORD999", ["RECEIVED"], { status: "CANCELLED" }), undefined);
  const confirmed = await orders.transitionOrder(order.id, ["AWAITING_CONFIRMATION"], {
    status: "CONFIRMED", confirmedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(confirmed?.confirmedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(confirmed?.paymentStatus, "PENDING");
});

test("lists a customer's orders newest first and never another customer's", async (t) => {
  const orders = createJsonFileOrderRepository(join(await tempDir(t), "orders.json"));
  await orders.createOrder(newOrder(1));
  await orders.createOrder(newOrder(2, { customerNumber: "whatsapp:+919800000003" }));
  await orders.createOrder(newOrder(3));
  assert.deepEqual((await orders.listCustomerOrders(customer)).map((order) => order.id), ["ORD003", "ORD001"]);
});

test("stores each message once, keeps customers and orders its conversation", async (t) => {
  const filePath = join(await tempDir(t), "orders.json");
  const orders = createJsonFileOrderRepository(filePath);
  const message = {
    id: `SM${"1".repeat(32)}`,
    customerNumber: customer,
    customerName: "Asha",
    direction: "INBOUND" as const,
    sender: "CUSTOMER" as const,
    from: customer,
    to: "whatsapp:+14155238886",
    body: "2 kg rice",
  };
  assert.equal(await orders.recordMessage(message), true);
  assert.equal(await orders.recordMessage(message), false);
  assert.equal(await orders.recordMessage({
    ...message, id: `${message.id}:reply`, direction: "OUTBOUND", sender: "SYSTEM", from: message.to, to: customer,
  }), true);
  const stored = await orders.listMessages(customer);
  assert.deepEqual(stored.map((m) => m.direction), ["INBOUND", "OUTBOUND"]);
  assert.ok(stored.every((m) => !Number.isNaN(Date.parse(m.createdAt))));
  const { customers } = JSON.parse(await readFile(filePath, "utf8"));
  assert.equal(customers.length, 1);
  assert.equal(customers[0].whatsappNumber, customer);
  assert.equal(customers[0].profileName, "Asha");
});

test("migrates the version 1 order file, keeping a backup", async (t) => {
  const dir = await tempDir(t);
  const filePath = join(dir, "orders.json");
  const legacy = [{
    id: "3811f56d-3432-4121-b5a1-65fa83285365",
    messageSid: `SM${"a".repeat(32)}`,
    customerNumber: customer,
    sellerNumber: "whatsapp:+14155238886",
    items: [{ name: "rice", quantity: 2, unit: "kg" }],
    unparsedLines: [],
    rawMessage: "2 kg rice",
    numMedia: 0,
    status: "received",
    receivedAt: "2026-11-14T14:12:00.928Z",
  }];
  await writeFile(filePath, JSON.stringify(legacy));
  const orders = createJsonFileOrderRepository(filePath);

  const [migrated] = await orders.list();
  assert.equal(migrated?.id, "ORD001");
  assert.equal(migrated?.status, "RECEIVED");
  assert.equal(migrated?.paymentStatus, "PENDING");
  assert.equal((await orders.listMessages(customer))[0]?.body, "2 kg rice");

  const { order } = await orders.createOrder(newOrder(2));
  assert.equal(order.id, "ORD002");
  const saved = JSON.parse(await readFile(filePath, "utf8"));
  assert.equal(saved.version, 2);
  assert.equal(saved.customers[0].whatsappNumber, customer);
  assert.deepEqual(JSON.parse(await readFile(`${filePath}.v1.bak`, "utf8")), legacy);
});

test("rejects an order file in an unknown format instead of overwriting it", async (t) => {
  const filePath = join(await tempDir(t), "orders.json");
  await writeFile(filePath, JSON.stringify({ version: 3 }));
  await assert.rejects(createJsonFileOrderRepository(filePath).createOrder(newOrder(1)), /unsupported format/);
});

test("prices items from the catalog, converting weights and volumes", () => {
  const catalog = new Map([
    ["rice", { unit: "kg", price: 60 }],
    ["milk", { unit: "l", price: 50 }],
    ["eggs", { unit: "pcs", price: 7 }],
  ]);
  assert.deepEqual(priceItems([
    { name: "rice", quantity: 2.5, unit: "kg" },
    { name: "milk", quantity: 500, unit: "ml" },
    { name: "eggs", quantity: 12, unit: "pcs" },
  ], catalog), {
    items: [
      { name: "rice", quantity: 2.5, unit: "kg", unitPrice: 60, priceUnit: "kg", amount: 150 },
      { name: "milk", quantity: 500, unit: "ml", unitPrice: 50, priceUnit: "l", amount: 25 },
      { name: "eggs", quantity: 12, unit: "pcs", unitPrice: 7, priceUnit: "pcs", amount: 84 },
    ],
    totalAmount: 259,
  });
});

test("leaves the total unset when any item cannot be priced", () => {
  const catalog = new Map([["rice", { unit: "kg", price: 60 }]]);
  const priced = priceItems([
    { name: "rice", quantity: 1, unit: "kg" },
    { name: "saffron", quantity: 1, unit: "g" },
    { name: "rice", quantity: 1, unit: "pcs" },
  ], catalog);
  assert.equal(priced.totalAmount, undefined);
  assert.equal(priced.items[0]?.amount, 60);
  assert.equal(priced.items[1]?.amount, undefined);
  assert.equal(priced.items[2]?.amount, undefined);
  assert.equal(priceItems([{ name: "rice", quantity: 1, unit: "kg" }], undefined).totalAmount, undefined);
});

test("prices a product listed in several units using the matching or a convertible unit", () => {
  const catalog = new Map([["milk", [{ unit: "l", price: 56 }, { unit: "pack", price: 28 }]]]);
  assert.deepEqual(priceItems([
    { name: "milk", quantity: 2, unit: "pack" },
    { name: "milk", quantity: 500, unit: "ml" },
  ], catalog), {
    items: [
      { name: "milk", quantity: 2, unit: "pack", unitPrice: 28, priceUnit: "pack", amount: 56 },
      { name: "milk", quantity: 500, unit: "ml", unitPrice: 56, priceUnit: "l", amount: 28 },
    ],
    totalAmount: 84,
  });
});

test("loads and validates the price catalog file", async (t) => {
  const dir = await tempDir(t);
  const good = join(dir, "prices.json");
  await writeFile(good, JSON.stringify({ rice: { unit: "kilo", price: 60 }, "toor dal": { unit: "kg", price: 140.5 } }));
  const catalog = await loadPriceCatalog(good);
  assert.deepEqual(catalog.get("rice"), { unit: "kg", price: 60 });
  assert.equal(catalog.size, 2);
  for (const [name, content] of [
    ["array.json", "[]"],
    ["upper.json", JSON.stringify({ Rice: { unit: "kg", price: 60 } })],
    ["unit.json", JSON.stringify({ rice: { unit: "bushel", price: 60 } })],
    ["price.json", JSON.stringify({ rice: { unit: "kg", price: 0 } })],
    ["syntax.json", "{"],
  ] as const) {
    const path = join(dir, name);
    await writeFile(path, content);
    await assert.rejects(loadPriceCatalog(path), /PRODUCT_PRICES_PATH/, name);
  }
  await assert.rejects(loadPriceCatalog(join(dir, "missing.json")), /Cannot read PRODUCT_PRICES_PATH/);
});
