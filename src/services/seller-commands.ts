import type { Logger } from "../logger.ts";
import type { OrderRepository } from "../repositories/orders.ts";
import type { WhatsAppReplySender } from "./whatsapp-replies.ts";
import type { MessageHandler } from "./whatsapp.ts";

interface SellerCommandOptions {
  logger: Logger;
  orders: OrderRepository;
  sender: WhatsAppReplySender;
  twilioNumber: string;
}

export const SELLER_HELP =
  "To message a customer, send: /reply <ORDER_ID> <message>\nExample: /reply ORD001 Your order is being packed.";

const REPLY_COMMAND = /^\/reply\s+#?(\S+)(?:\s+([\s\S]+))?$/i;
const MAX_REPLY_LENGTH = 1600;

/** Handles messages from the configured seller number; they are commands, never customer orders. */
export function createSellerCommandHandler({ logger, orders, sender, twilioNumber }: SellerCommandOptions): MessageHandler {
  return {
    async handle(message) {
      const command = REPLY_COMMAND.exec(message.body.trim());
      const body = command?.[2]?.trim();
      if (!command || !body) {
        return { reply: SELLER_HELP };
      }
      if (Array.from(body).length > MAX_REPLY_LENGTH) {
        return { reply: `The message is too long; the limit is ${MAX_REPLY_LENGTH} characters.` };
      }
      const orderId = (command[1] ?? "").toUpperCase();
      const order = await orders.getOrder(orderId);
      if (!order) {
        return { reply: `Order ${orderId} was not found.` };
      }
      // Twilio retries reuse the MessageSid, so a retried command must not message the customer twice.
      const first = await orders.recordMessage({
        id: message.messageSid,
        orderId,
        customerNumber: order.customerNumber,
        direction: "INBOUND",
        sender: "SELLER",
        from: message.from,
        to: message.to,
        body: message.body,
      });
      if (!first) {
        logger.info("Duplicate seller command ignored", { messageSid: message.messageSid, orderId });
        return { reply: `That /reply for ${orderId} was already processed.` };
      }
      let sent;
      try {
        sent = await sender.send(order.customerNumber, body);
      } catch (error) {
        logger.error("Seller reply could not be sent to the customer", {
          orderId, error: error instanceof Error ? error.message : String(error),
        });
        return {
          reply: `Could not send the message for ${orderId}. WhatsApp only allows free-form messages ` +
            "within 24 hours of the customer's last message. Please try again.",
        };
      }
      await orders.recordMessage({
        id: sent.messageSid,
        orderId,
        customerNumber: order.customerNumber,
        direction: "OUTBOUND",
        sender: "SELLER",
        from: twilioNumber,
        to: order.customerNumber,
        body,
      });
      logger.info("Seller reply forwarded to customer", { orderId, messageSid: sent.messageSid, status: sent.status });
      return { reply: `Message sent to the customer of ${orderId}.` };
    },
  };
}
