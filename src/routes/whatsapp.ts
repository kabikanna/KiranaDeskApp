import type { Server } from "@hapi/hapi";
import type { AppConfig } from "../config.ts";
import { createWhatsAppPaymentQrHandler, createWhatsAppReplyHandler } from "../controllers/whatsapp-replies.ts";
import { createWhatsAppHandler } from "../controllers/whatsapp.ts";
import type { WhatsAppReplySender } from "../services/whatsapp-replies.ts";
import type { WhatsAppMessageProcessor } from "../services/whatsapp.ts";

export function registerWhatsAppRoutes(
  server: Server,
  config: AppConfig["twilio"],
  service: WhatsAppMessageProcessor,
  replySender: WhatsAppReplySender,
  replyApiToken: string | undefined,
  senderNumber: string,
  paymentQrUrl: string | undefined,
): void {
  server.route({
    method: "POST",
    // path: "/webhooks/whatsapp",
    path: "/api/whatsapp/incoming",
    options: {
      auth: false,
      payload: {
        parse: true,
        output: "data",
        allow: "application/x-www-form-urlencoded",
        maxBytes: 1024 * 1024,
      },
    },
    handler: createWhatsAppHandler(config, service),
  });
  server.route({
    method: "POST",
    path: "/messages/whatsapp",
    options: {
      auth: false,
      payload: {
        parse: true,
        output: "data",
        allow: "application/json",
        maxBytes: 32 * 1024,
      },
    },
    handler: createWhatsAppReplyHandler(replyApiToken, replySender, senderNumber),
  });
  server.route({
    method: "POST",
    path: "/messages/whatsapp/payment-qr",
    options: {
      auth: false,
      payload: {
        parse: true,
        output: "data",
        allow: "application/json",
        maxBytes: 32 * 1024,
      },
    },
    handler: createWhatsAppPaymentQrHandler(replyApiToken, replySender, senderNumber, paymentQrUrl),
  });
}
