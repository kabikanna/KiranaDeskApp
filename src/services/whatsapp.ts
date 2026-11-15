import type { Logger } from "../logger.ts";
import type { OrderExtractor } from "./ai-order-extractor.ts";
import type { InboundMedia, PaymentProofStore } from "./payment-proofs.ts";
import type { OrderRepository } from "../repositories/orders.ts";
import { createCustomerOrderHandler } from "./customer-orders.ts";
import type { PriceCatalog } from "./pricing.ts";
import { createSellerCommandHandler } from "./seller-commands.ts";
import type { WhatsAppReplySender } from "./whatsapp-replies.ts";

export interface WhatsAppMessage {
  from: string;
  to: string;
  body: string;
  messageSid: string;
  numMedia: number;
  /** Twilio-hosted attachments (MediaUrlN/MediaContentTypeN); other URLs are dropped by the webhook. */
  media?: InboundMedia[];
  /** The sender's WhatsApp profile name, when Twilio provides it. */
  profileName?: string;
}

export interface WhatsAppProcessingResult {
  /** Text sent back to the sender in the TwiML response; omitted when no reply is needed. */
  reply?: string;
  /** Public image URL attached to the reply. */
  mediaUrl?: string;
}

export interface WhatsAppMessageProcessor {
  processMessage(message: WhatsAppMessage): Promise<WhatsAppProcessingResult>;
}

export interface MessageHandler {
  handle(message: WhatsAppMessage): Promise<WhatsAppProcessingResult>;
}

interface WhatsAppServiceOptions {
  logger: Logger;
  orders: OrderRepository;
  /** Twilio WhatsApp number that customers and the seller message. */
  twilioNumber: string;
  /** The seller's own WhatsApp number; its messages are commands, not orders. Seller commands are off when unset. */
  sellerNumber?: string | undefined;
  sender: WhatsAppReplySender;
  paymentQrUrl?: string | undefined;
  priceCatalog?: PriceCatalog | undefined;
  orderExtractor?: OrderExtractor | undefined;
  paymentProofs?: PaymentProofStore | undefined;
}

export function createWhatsAppService({
  logger, orders, twilioNumber, sellerNumber, sender, paymentQrUrl, priceCatalog, orderExtractor, paymentProofs,
}: WhatsAppServiceOptions): WhatsAppMessageProcessor {
  const customerHandler = createCustomerOrderHandler({
    logger, orders, paymentQrUrl, priceCatalog, orderExtractor, paymentProofs,
  });
  const sellerHandler = createSellerCommandHandler({ logger, orders, sender, twilioNumber });
  return {
    async processMessage(message) {
      logger.info("Received WhatsApp message", { ...message });
      if (message.to !== twilioNumber) {
        logger.info("Ignored message not addressed to the Twilio WhatsApp number", {
          messageSid: message.messageSid, to: message.to,
        });
        return {};
      }
      // From is covered by the validated Twilio signature, so it reliably identifies the seller.
      return sellerNumber && message.from === sellerNumber
        ? sellerHandler.handle(message)
        : customerHandler.handle(message);
    },
  };
}
