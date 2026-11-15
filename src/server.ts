import Hapi from "@hapi/hapi";
import Boom from "@hapi/boom";
import type { AppConfig } from "./config.ts";
import { logger as defaultLogger } from "./logger.ts";
import type { Logger } from "./logger.ts";
import { registerWhatsAppRoutes } from "./routes/whatsapp.ts";
import { createJsonFileOrderRepository } from "./repositories/orders.ts";
import { registerPaymentRoutes } from "./routes/payments.ts";
import { createAzureOpenAiOrderExtractor } from "./services/ai-order-extractor.ts";
import { createPaymentProofStore } from "./services/payment-proofs.ts";
import type { PaymentQr } from "./services/payment-qr.ts";
import type { PriceCatalog } from "./services/pricing.ts";
import { createWhatsAppReplySender } from "./services/whatsapp-replies.ts";
import type { WhatsAppReplySender } from "./services/whatsapp-replies.ts";
import { createWhatsAppService } from "./services/whatsapp.ts";
import type { WhatsAppMessageProcessor } from "./services/whatsapp.ts";

interface ServerDependencies {
  logger?: Logger;
  whatsappService?: WhatsAppMessageProcessor;
  whatsappReplySender?: WhatsAppReplySender;
  /** A local QR image to serve; a URL-only QR comes from config.paymentQr. */
  paymentQr?: PaymentQr;
  priceCatalog?: PriceCatalog;
}

export function createServer(config: AppConfig, dependencies: ServerDependencies = {}): Hapi.Server {
  const logger = dependencies.logger ?? defaultLogger;
  const server = Hapi.server({ host: config.host, port: config.port });
  server.ext("onPreResponse", (request, h) => {
    const response = request.response;
    if (Boom.isBoom(response)) {
      const details = {
        requestId: request.info.id,
        path: request.path,
        statusCode: response.output.statusCode,
        error: response.data instanceof Error ? response.data.message : response.message,
      };
      if (response.output.statusCode >= 500) {
        logger.error("Request failed", details);
      } else {
        logger.warn("Request rejected", details);
      }
    }
    return h.continue;
  });
  if (!config.manualReplyApiToken) {
    logger.warn("Manual WhatsApp reply API is disabled: WHATSAPP_REPLY_API_TOKEN is not configured");
  }
  const { paymentQr, priceCatalog } = dependencies;
  if (paymentQr) {
    registerPaymentRoutes(server, paymentQr);
  }
  const paymentQrUrl = paymentQr?.url ?? config.paymentQr?.url;
  const replySender = dependencies.whatsappReplySender ?? createWhatsAppReplySender(config.twilio, logger);
  registerWhatsAppRoutes(
    server,
    config.twilio,
    dependencies.whatsappService ?? createWhatsAppService({
      logger,
      orders: createJsonFileOrderRepository(config.orders.storePath),
      twilioNumber: config.twilio.whatsappNumber,
      sellerNumber: config.orders.sellerNumber,
      sender: replySender,
      paymentQrUrl,
      priceCatalog,
      orderExtractor: config.azureOpenAi
        ? createAzureOpenAiOrderExtractor(config.azureOpenAi, {
          productNames: priceCatalog ? [...priceCatalog.keys()] : [],
        })
        : undefined,
      paymentProofs: createPaymentProofStore({
        accountSid: config.twilio.accountSid,
        authToken: config.twilio.authToken,
        directory: config.orders.paymentProofDir,
      }),
    }),
    replySender,
    config.manualReplyApiToken,
    config.twilio.whatsappNumber,
    paymentQrUrl,
  );
  return server;
}
