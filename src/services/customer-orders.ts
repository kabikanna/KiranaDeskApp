import type { Logger } from "../logger.ts";
import type { Order, OrderRepository } from "../repositories/orders.ts";
import type { OrderExtractor } from "./ai-order-extractor.ts";
import { parseOrder } from "./order-parser.ts";
import type { ParsedOrder } from "./order-parser.ts";
import {
  alreadyCancelledMessage, cancellationMessage, cannotCancelConfirmedMessage, cannotConfirmCancelledMessage,
  detectLanguage, noPayableOrderMessage, notAwaitingMessage, paymentProofFailedMessage, paymentProofReceivedMessage, orderConfirmationMessage, orderNotFoundMessage, paymentMessage, pendingOrdersPrompt,
} from "./order-messages.ts";
import { PAYMENT_PROOF_TYPES } from "./payment-proofs.ts";
import type { PaymentProofStore, StoredPaymentProof } from "./payment-proofs.ts";
import { priceItems } from "./pricing.ts";
import type { PriceCatalog } from "./pricing.ts";
import type { MessageHandler, WhatsAppMessage, WhatsAppProcessingResult } from "./whatsapp.ts";

interface CustomerOrderOptions {
  logger: Logger;
  orders: OrderRepository;
  paymentQrUrl?: string | undefined;
  priceCatalog?: PriceCatalog | undefined;
  /** Refines free-text orders (Tamil, Tanglish, English); the rule-based parser is used without it or if it fails. */
  orderExtractor?: OrderExtractor | undefined;
  /** Stores payment screenshots; attachments are not downloaded without it. */
  paymentProofs?: PaymentProofStore | undefined;
}

type Answer = "YES" | "NO";

// The whole message must be the answer, optionally followed by an order ID: "yes", "No.", "yes ord002", "சரி".
const ANSWER = /^(?:(yes|y|yep|yeah|ok|okay|confirm|ஆம்|ஆமா|சரி)|(no|n|nope|cancel|இல்லை|வேண்டாம்))(?:\s+#?(ord\d+))?[\s.!]*$/iu;

function parseAnswer(text: string): { answer: Answer; orderId?: string } | undefined {
  const match = ANSWER.exec(text);
  if (!match) {
    return undefined;
  }
  return { answer: match[1] ? "YES" : "NO", ...(match[3] ? { orderId: match[3].toUpperCase() } : {}) };
}

export function createCustomerOrderHandler(
  { logger, orders, paymentQrUrl, priceCatalog, orderExtractor, paymentProofs }: CustomerOrderOptions,
): MessageHandler {
  async function extractItems(message: WhatsAppMessage, text: string): Promise<ParsedOrder> {
    const parsed = parseOrder(text);
    if (!orderExtractor) {
      return parsed;
    }
    try {
      const items = await orderExtractor.extract(text);
      if (items.length > 0) {
        logger.info("Order refined by AI extractor", { messageSid: message.messageSid, items });
        return { items, unparsedLines: [] };
      }
    } catch (error) {
      logger.warn("AI order extraction failed; using the rule-based parser", {
        messageSid: message.messageSid,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return parsed;
  }

  async function recordInbound(message: WhatsAppMessage, orderId?: string): Promise<void> {
    await orders.recordMessage({
      id: message.messageSid,
      ...(orderId ? { orderId } : {}),
      customerNumber: message.from,
      ...(message.profileName ? { customerName: message.profileName } : {}),
      direction: "INBOUND",
      sender: "CUSTOMER",
      from: message.from,
      to: message.to,
      body: message.body,
      numMedia: message.numMedia,
    });
  }

  async function respond(
    message: WhatsAppMessage,
    body: string,
    orderId?: string,
    mediaUrl?: string,
  ): Promise<WhatsAppProcessingResult> {
    // Keyed by the inbound MessageSid so a Twilio retry does not store the reply twice.
    await orders.recordMessage({
      id: `${message.messageSid}:reply`,
      ...(orderId ? { orderId } : {}),
      customerNumber: message.from,
      direction: "OUTBOUND",
      sender: "SYSTEM",
      from: message.to,
      to: message.from,
      body,
      ...(mediaUrl ? { mediaUrl } : {}),
    });
    return mediaUrl ? { reply: body, mediaUrl } : { reply: body };
  }

  async function sendPayment(message: WhatsAppMessage, order: Order): Promise<WhatsAppProcessingResult> {
    if (paymentQrUrl && order.status === "CONFIRMED") {
      // QR_SENT means the QR is part of the reply returned to Twilio; payment stays PENDING.
      await orders.transitionOrder(order.id, ["CONFIRMED"], { status: "QR_SENT", qrSentAt: new Date().toISOString() });
    }
    return respond(message, paymentMessage(order, Boolean(paymentQrUrl)), order.id, paymentQrUrl);
  }

  async function applyAnswer(message: WhatsAppMessage, order: Order, answer: Answer): Promise<WhatsAppProcessingResult> {
    switch (order.status) {
      case "AWAITING_CONFIRMATION": {
        const decided = await orders.transitionOrder(order.id, ["AWAITING_CONFIRMATION"], answer === "YES"
          ? { status: "CONFIRMED", confirmedAt: new Date().toISOString() }
          : { status: "CANCELLED", cancelledAt: new Date().toISOString() });
        if (decided) {
          logger.info(answer === "YES" ? "Order confirmed" : "Order cancelled", {
            orderId: order.id, customerNumber: order.customerNumber,
          });
          return answer === "YES"
            ? sendPayment(message, decided)
            : respond(message, cancellationMessage(order.id, order.language), order.id);
        }
        // A concurrent answer decided the order first; respond according to its new state.
        const current = await orders.getOrder(order.id);
        return current && current.status !== "AWAITING_CONFIRMATION"
          ? applyAnswer(message, current, answer)
          : respond(message, notAwaitingMessage(order.id, order.language), order.id);
      }
      case "CONFIRMED":
      case "QR_SENT":
        // A repeated YES (or a Twilio retry) safely re-sends the payment details without changing the order.
        return answer === "YES"
          ? sendPayment(message, order)
          : respond(message, cannotCancelConfirmedMessage(order.id, order.language), order.id);
      case "CANCELLED":
        return respond(
          message,
          answer === "NO"
            ? alreadyCancelledMessage(order.id, order.language)
            : cannotConfirmCancelledMessage(order.id, order.language),
          order.id,
        );
      default:
        return respond(message, notAwaitingMessage(order.id, order.language), order.id);
    }
  }

  async function handleAnswer(
    message: WhatsAppMessage,
    { answer, orderId }: { answer: Answer; orderId?: string },
  ): Promise<WhatsAppProcessingResult> {
    // Only this customer's orders are candidates, so one customer can never answer for another.
    const customerOrders = await orders.listCustomerOrders(message.from);
    let target: Order | undefined;
    if (orderId) {
      target = customerOrders.find((order) => order.id === orderId);
    } else {
      const waiting = customerOrders.filter((order) => order.status === "AWAITING_CONFIRMATION");
      if (waiting.length > 1) {
        await recordInbound(message);
        return respond(message, pendingOrdersPrompt(waiting));
      }
      target = waiting[0] ??
        customerOrders.find((order) => ["CONFIRMED", "QR_SENT", "CANCELLED"].includes(order.status));
    }
    await recordInbound(message, target?.id);
    if (!target) {
      logger.info("WhatsApp answer matched no order", { messageSid: message.messageSid, orderId });
      return respond(
        message,
        orderNotFoundMessage(orderId, customerOrders[0]?.language ?? detectLanguage(message.body)),
      );
    }
    return applyAnswer(message, target, answer);
  }

  /** Returns undefined when the attachment is not a payment proof, so the message is handled normally. */
  async function handlePaymentProof(message: WhatsAppMessage): Promise<WhatsAppProcessingResult | undefined> {
    const attachments = (message.media ?? [])
      .map((media, index) => ({ media, index }))
      .filter(({ media }) => Object.hasOwn(PAYMENT_PROOF_TYPES, media.contentType));
    if (!paymentProofs || attachments.length === 0) {
      return undefined;
    }
    const customerOrders = await orders.listCustomerOrders(message.from);
    const lang = customerOrders[0]?.language ?? detectLanguage(message.body);
    const orderId = /\bord\d+\b/iu.exec(message.body)?.[0].toUpperCase();
    // Newest first, and only this customer's orders, so a screenshot can never be attached to someone else's order.
    const order = customerOrders.find((candidate) =>
      (!orderId || candidate.id === orderId) &&
      ["CONFIRMED", "QR_SENT"].includes(candidate.status) &&
      candidate.paymentStatus !== "PAID");
    if (!order) {
      if (message.body.trim() && !orderId) {
        return undefined;
      }
      await recordInbound(message);
      logger.info("Payment screenshot matched no order awaiting payment", { messageSid: message.messageSid, orderId });
      return respond(message, noPayableOrderMessage(lang));
    }
    await recordInbound(message, order.id);
    const already = new Set((order.paymentProofs ?? []).map((proof) => proof.id));
    const stored: StoredPaymentProof[] = [];
    let failed = 0;
    for (const { media, index } of attachments) {
      // A Twilio retry finds the proof already attached and does not download it again.
      if (already.has(`${message.messageSid}-${index}`)) {
        continue;
      }
      try {
        stored.push(await paymentProofs.save(order.id, message.messageSid, index, media));
      } catch (error) {
        failed++;
        logger.error("Payment screenshot could not be stored", {
          orderId: order.id,
          messageSid: message.messageSid,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (stored.length === 0 && failed > 0) {
      return respond(message, paymentProofFailedMessage(order.language), order.id);
    }
    const updated = stored.length > 0 ? await orders.addPaymentProofs(order.id, stored) : order;
    logger.info("Payment screenshot stored", {
      orderId: order.id,
      customerNumber: order.customerNumber,
      paymentStatus: updated?.paymentStatus,
      files: stored.map((proof) => proof.path),
    });
    return respond(message, paymentProofReceivedMessage(order.id, order.language), order.id);
  }

  async function handleOther(message: WhatsAppMessage): Promise<WhatsAppProcessingResult> {
    await recordInbound(message);
    logger.info("Message contains no order items", { messageSid: message.messageSid, numMedia: message.numMedia });
    if (!message.body.trim() || message.body.trim().startsWith("/")) {
      return {};
    }
    const waiting = (await orders.listCustomerOrders(message.from))
      .filter((order) => order.status === "AWAITING_CONFIRMATION");
    return waiting.length > 0
      ? respond(message, pendingOrdersPrompt(waiting), waiting.length === 1 ? waiting[0]?.id : undefined)
      : {};
  }

  return {
    async handle(message) {
      const proofResult = await handlePaymentProof(message);
      if (proofResult) {
        return proofResult;
      }
      const text = message.body.trim();
      const answer = parseAnswer(text);
      if (answer) {
        return handleAnswer(message, answer);
      }
      // Slash commands belong to the seller; a customer's are never treated as orders.
      if (!text || text.startsWith("/")) {
        return handleOther(message);
      }
      // A Twilio retry of an order already stored skips the (slow, non-deterministic) extraction.
      const retried = (await orders.listCustomerOrders(message.from))
        .find((order) => order.messageSid === message.messageSid);
      const { items, unparsedLines } = retried ?? await extractItems(message, text);
      if (items.length === 0) {
        return handleOther(message);
      }
      const priced = priceItems(items, priceCatalog);
      const { order, created } = await orders.createOrder({
        messageSid: message.messageSid,
        customerNumber: message.from,
        items: priced.items,
        unparsedLines,
        rawMessage: message.body,
        numMedia: message.numMedia,
        language: detectLanguage(text),
        ...(priced.totalAmount === undefined ? {} : { totalAmount: priced.totalAmount }),
      });
      await recordInbound(message, order.id);
      logger.info(created ? "Order captured" : "Duplicate order delivery ignored", {
        orderId: order.id,
        messageSid: order.messageSid,
        customerNumber: order.customerNumber,
        items: order.items,
        totalAmount: order.totalAmount,
      });
      // A retried delivery of this order reaches the same state, so it gets the same confirmation question again.
      const waiting = order.status === "RECEIVED"
        ? await orders.transitionOrder(order.id, ["RECEIVED"], { status: "AWAITING_CONFIRMATION" }) ??
          await orders.getOrder(order.id)
        : order;
      return waiting?.status === "AWAITING_CONFIRMATION"
        ? respond(message, orderConfirmationMessage(waiting), waiting.id)
        : {};
    },
  };
}
