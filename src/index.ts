import { loadConfig } from "./config.ts";
import { logger } from "./logger.ts";
import { createServer } from "./server.ts";
import { loadPaymentQr } from "./services/payment-qr.ts";
import { loadPriceCatalog } from "./services/pricing.ts";

try {
  const config = loadConfig();
  const paymentQr = config.paymentQr?.path
    ? await loadPaymentQr(config.paymentQr.path, config.paymentQr.url)
    : undefined;
  const priceCatalog = config.orders.pricesPath ? await loadPriceCatalog(config.orders.pricesPath) : undefined;
  const server = createServer(config, {
    ...(paymentQr ? { paymentQr } : {}),
    ...(priceCatalog ? { priceCatalog } : {}),
  });
  await server.start();
  logger.info("Server started", { uri: server.info.uri });
  if (config.paymentQr) {
    logger.info("Static payment QR enabled", { url: config.paymentQr.url });
  } else {
    logger.warn("No static payment QR configured; YES confirmations will not include a QR image");
  }
  if (!config.orders.sellerNumber) {
    logger.info("Seller /reply commands are disabled: SELLER_WHATSAPP_NUMBER is not configured");
  }
  if (config.azureOpenAi) {
    logger.info("AI order extraction enabled", { deployment: config.azureOpenAi.deployment });
  } else {
    logger.info("AI order extraction is disabled: AZURE_OPENAI_ENDPOINT is not configured");
  }
  if (priceCatalog) {
    logger.info("Product price catalog loaded", { products: priceCatalog.size });
  }
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      server.stop({ timeout: 10000 }).catch((error: unknown) => {
        logger.error("Server shutdown failed", { error: error instanceof Error ? error.message : String(error) });
        process.exitCode = 1;
      });
    });
  }
} catch (error) {
  logger.error("Server startup failed", { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}
