import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { StoredPaymentProof } from "../services/payment-proofs.ts";
import type { PricedOrderItem } from "../services/pricing.ts";

export type OrderStatus = "RECEIVED" | "AWAITING_CONFIRMATION" | "CONFIRMED" | "QR_SENT" | "CANCELLED";
/**
 * Tracked separately from the order status; nothing marks an order PAID automatically.
 * SUBMITTED means the customer sent a payment screenshot that the seller still has to verify.
 */
export type PaymentStatus = "PENDING" | "SUBMITTED" | "PAID" | "FAILED";
/** Language the customer ordered in; replies about the order use it. */
export type OrderLanguage = "en" | "ta";

export interface Order {
  /** Human-friendly sequential ID such as ORD001. */
  id: string;
  /** Twilio MessageSid of the customer's order message, used to de-duplicate webhook retries. */
  messageSid: string;
  customerNumber: string;
  items: PricedOrderItem[];
  unparsedLines: string[];
  rawMessage: string;
  numMedia: number;
  /** Absent on orders stored before language support; treated as English. */
  language?: OrderLanguage;
  /** Rupees; present only when every item was priced from the catalog. */
  totalAmount?: number;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  receivedAt: string;
  updatedAt: string;
  confirmedAt?: string;
  cancelledAt?: string;
  qrSentAt?: string;
  /** Payment screenshots sent by the customer, stored locally for the seller to verify. */
  paymentProofs?: StoredPaymentProof[];
  paymentSubmittedAt?: string;
}

export interface Customer {
  whatsappNumber: string;
  profileName?: string;
  firstSeenAt: string;
  lastMessageAt: string;
}

export interface ConversationMessage {
  /** Twilio MessageSid, or `<inbound MessageSid>:reply` for the TwiML reply to that message. */
  id: string;
  orderId?: string;
  /** The customer this conversation belongs to, whichever side sent the message. */
  customerNumber: string;
  direction: "INBOUND" | "OUTBOUND";
  sender: "CUSTOMER" | "SELLER" | "SYSTEM";
  from: string;
  to: string;
  body: string;
  numMedia?: number;
  mediaUrl?: string;
  createdAt: string;
}

export type NewOrder = Pick<
  Order,
  "messageSid" | "customerNumber" | "items" | "unparsedLines" | "rawMessage" | "numMedia" | "totalAmount" | "language"
>;
export type NewMessage = Omit<ConversationMessage, "createdAt"> & { customerName?: string };
export type OrderUpdate = Partial<Pick<Order, "status" | "paymentStatus" | "confirmedAt" | "cancelledAt" | "qrSentAt">>;

export interface OrderRepository {
  /** Creates a RECEIVED order, or returns the existing one if this MessageSid was already stored. */
  createOrder(order: NewOrder): Promise<{ order: Order; created: boolean }>;
  getOrder(orderId: string): Promise<Order | undefined>;
  /** The customer's orders, newest first. */
  listCustomerOrders(customerNumber: string): Promise<Order[]>;
  /** Applies the update only if the order currently has one of the `from` statuses; otherwise returns undefined. */
  transitionOrder(orderId: string, from: readonly OrderStatus[], update: OrderUpdate): Promise<Order | undefined>;
  /** Stores a message and its customer; returns false if a message with the same id was already stored. */
  recordMessage(message: NewMessage): Promise<boolean>;
  /** A customer's conversation, oldest first. */
  listMessages(customerNumber: string): Promise<ConversationMessage[]>;
  /**
   * Attaches payment screenshots (ignoring ones already stored) and moves a PENDING or FAILED payment to SUBMITTED.
   * Returns undefined if the order does not exist.
   */
  addPaymentProofs(orderId: string, proofs: readonly StoredPaymentProof[]): Promise<Order | undefined>;
  list(): Promise<Order[]>;
}

interface Database {
  version: 2;
  orders: Order[];
  customers: Customer[];
  messages: ConversationMessage[];
}

/** Version 1 was a bare array of UUID-keyed orders without customers or messages. */
interface LegacyOrder {
  messageSid: string;
  customerNumber: string;
  sellerNumber: string;
  items: PricedOrderItem[];
  unparsedLines: string[];
  rawMessage: string;
  numMedia: number;
  receivedAt: string;
}

function emptyDatabase(): Database {
  return { version: 2, orders: [], customers: [], messages: [] };
}

function nextOrderId(orders: readonly Order[]): string {
  const highest = Math.max(0, ...orders.map((order) => Number(order.id.slice(3))));
  return `ORD${String(highest + 1).padStart(3, "0")}`;
}

function touchCustomer(db: Database, whatsappNumber: string, at: string, profileName?: string): void {
  let customer = db.customers.find((candidate) => candidate.whatsappNumber === whatsappNumber);
  if (!customer) {
    customer = { whatsappNumber, firstSeenAt: at, lastMessageAt: at };
    db.customers.push(customer);
  } else if (at > customer.lastMessageAt) {
    customer.lastMessageAt = at;
  }
  if (profileName) {
    customer.profileName = profileName;
  }
}

function migrateLegacy(legacy: LegacyOrder[]): Database {
  const db = emptyDatabase();
  for (const old of [...legacy].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))) {
    const order: Order = {
      id: nextOrderId(db.orders),
      messageSid: old.messageSid,
      customerNumber: old.customerNumber,
      items: old.items,
      unparsedLines: old.unparsedLines,
      rawMessage: old.rawMessage,
      numMedia: old.numMedia,
      // They were acknowledged but never asked for confirmation, so they must not be answerable with YES/NO.
      status: "RECEIVED",
      paymentStatus: "PENDING",
      receivedAt: old.receivedAt,
      updatedAt: old.receivedAt,
    };
    db.orders.push(order);
    touchCustomer(db, order.customerNumber, order.receivedAt);
    db.messages.push({
      id: old.messageSid,
      orderId: order.id,
      customerNumber: order.customerNumber,
      direction: "INBOUND",
      sender: "CUSTOMER",
      from: old.customerNumber,
      to: old.sellerNumber,
      body: old.rawMessage,
      numMedia: old.numMedia,
      createdAt: old.receivedAt,
    });
  }
  return db;
}

export function createJsonFileOrderRepository(filePath: string): OrderRepository {
  // Serializes read-modify-write cycles so concurrent webhooks cannot overwrite each other.
  let queue: Promise<unknown> = Promise.resolve();
  function exclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = queue.then(task, task);
    queue = result.catch(() => undefined);
    return result;
  }

  async function read(): Promise<Database> {
    let data: unknown;
    try {
      data = JSON.parse(await readFile(filePath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return emptyDatabase();
      }
      throw error;
    }
    if (Array.isArray(data)) {
      // Keep the original until the first write replaces the file with the migrated data.
      await copyFile(filePath, `${filePath}.v1.bak`);
      return migrateLegacy(data as LegacyOrder[]);
    }
    const db = data as Partial<Database> | null;
    if (!db || db.version !== 2 || !Array.isArray(db.orders) || !Array.isArray(db.customers) || !Array.isArray(db.messages)) {
      throw new Error("Order store has an unsupported format");
    }
    return db as Database;
  }

  async function write(db: Database): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(db, null, 2)}\n`, { mode: 0o600 });
    await rename(tempPath, filePath);
  }

  function update<T>(change: (db: Database) => { result: T; changed: boolean }): Promise<T> {
    return exclusive(async () => {
      const db = await read();
      const { result, changed } = change(db);
      if (changed) {
        await write(db);
      }
      return result;
    });
  }

  return {
    createOrder: (newOrder) => update<{ order: Order; created: boolean }>((db) => {
      const existing = db.orders.find((order) => order.messageSid === newOrder.messageSid);
      if (existing) {
        return { result: { order: existing, created: false }, changed: false };
      }
      const now = new Date().toISOString();
      const order: Order = {
        ...newOrder,
        id: nextOrderId(db.orders),
        status: "RECEIVED",
        paymentStatus: "PENDING",
        receivedAt: now,
        updatedAt: now,
      };
      db.orders.push(order);
      touchCustomer(db, order.customerNumber, now);
      return { result: { order, created: true }, changed: true };
    }),
    getOrder: (orderId) => exclusive(async () => (await read()).orders.find((order) => order.id === orderId)),
    listCustomerOrders: (customerNumber) => exclusive(async () => (await read()).orders
      .filter((order) => order.customerNumber === customerNumber)
      .reverse()),
    transitionOrder: (orderId, from, change) => update<Order | undefined>((db) => {
      const order = db.orders.find((candidate) => candidate.id === orderId);
      if (!order || !from.includes(order.status)) {
        return { result: undefined, changed: false };
      }
      Object.assign(order, change, { updatedAt: new Date().toISOString() });
      return { result: order, changed: true };
    }),
    recordMessage: ({ customerName, ...message }) => update<boolean>((db) => {
      if (db.messages.some((stored) => stored.id === message.id)) {
        return { result: false, changed: false };
      }
      const createdAt = new Date().toISOString();
      db.messages.push({ ...message, createdAt });
      touchCustomer(db, message.customerNumber, createdAt, customerName);
      return { result: true, changed: true };
    }),
    listMessages: (customerNumber) => exclusive(async () => (await read()).messages
      .filter((message) => message.customerNumber === customerNumber)),
    addPaymentProofs: (orderId, proofs) => update<Order | undefined>((db) => {
      const order = db.orders.find((candidate) => candidate.id === orderId);
      if (!order) {
        return { result: undefined, changed: false };
      }
      const stored = order.paymentProofs ?? [];
      const added = proofs.filter((proof) => !stored.some((existing) => existing.id === proof.id));
      if (added.length === 0) {
        return { result: order, changed: false };
      }
      const now = new Date().toISOString();
      order.paymentProofs = [...stored, ...added];
      if (order.paymentStatus === "PENDING" || order.paymentStatus === "FAILED") {
        order.paymentStatus = "SUBMITTED";
        order.paymentSubmittedAt = now;
      }
      order.updatedAt = now;
      return { result: order, changed: true };
    }),
    list: () => exclusive(async () => (await read()).orders),
  };
}
