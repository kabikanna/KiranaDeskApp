import type { AzureOpenAiConfig } from "./services/ai-order-extractor.ts";
import { PAYMENT_QR_ROUTE } from "./services/payment-qr.ts";

export interface AppConfig {
  host: string;
  port: number;
  twilio: {
    accountSid: string;
    authToken: string;
    webhookUrl: string;
    /** Twilio WhatsApp number (the Sandbox number while testing) that customers and the seller message. */
    whatsappNumber: string;
  };
  orders: {
    /** The seller's own WhatsApp number, from which /reply commands are accepted; /reply is disabled without it. */
    sellerNumber?: string;
    storePath: string;
    /** Directory for customers' payment screenshots. */
    paymentProofDir: string;
    /** Optional JSON price catalog used to total orders. */
    pricesPath?: string;
  };
  manualReplyApiToken?: string;
  terminalReplyTo?: string;
  paymentQr?: {
    /** Local image served from this app; absent when STATIC_PAYMENT_QR_URL points at an existing public image. */
    path?: string;
    url: string;
  };
  /** Refines incoming orders with Azure OpenAI; the rule-based parser alone is used when absent. */
  azureOpenAi?: AzureOpenAiConfig;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value?.trim()) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const accountSid = required(env, "TWILIO_ACCOUNT_SID");
  if (!/^AC[0-9a-f]{32}$/i.test(accountSid)) {
    throw new Error("TWILIO_ACCOUNT_SID must be a valid Account SID");
  }
  const authToken = required(env, "TWILIO_AUTH_TOKEN");
  const webhookUrl = required(env, "TWILIO_WEBHOOK_URL");
  let url: URL;
  try {
    url = new URL(webhookUrl);
  } catch {
    throw new Error("TWILIO_WEBHOOK_URL must be an absolute HTTP(S) URL");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    // url.pathname !== "/webhooks/whatsapp" ||
    url.pathname !== "/api/whatsapp/incoming" ||
    url.hash || url.username || url.password ||
    webhookUrl !== webhookUrl.trim()
  ) {
    throw new Error(
      "TWILIO_WEBHOOK_URL must be an HTTP(S) URL ending in /api/whatsapp/incoming, optionally with a query string, without credentials or a fragment",
    );
  }
  const portValue = env.PORT ?? "3000";
  const port = Number(portValue);
  if (!/^\d+$/.test(portValue) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  const whatsappNumber = required(env, "TWILIO_WHATSAPP_NUMBER");
  if (!/^whatsapp:\+\d{7,15}$/.test(whatsappNumber)) {
    throw new Error("TWILIO_WHATSAPP_NUMBER must look like whatsapp:+<country code><number>");
  }
  const sellerNumber = env.SELLER_WHATSAPP_NUMBER?.trim();
  if (sellerNumber && !/^whatsapp:\+\d{7,15}$/.test(sellerNumber)) {
    throw new Error("SELLER_WHATSAPP_NUMBER must look like whatsapp:+<country code><number>");
  }
  if (sellerNumber === whatsappNumber) {
    throw new Error(
      "SELLER_WHATSAPP_NUMBER must be the seller's own WhatsApp number, not the Twilio number in TWILIO_WHATSAPP_NUMBER",
    );
  }
  const manualReplyApiToken = env.WHATSAPP_REPLY_API_TOKEN;
  if (
    manualReplyApiToken &&
    !/^[A-Za-z0-9._~-]{32,256}$/.test(manualReplyApiToken)
  ) {
    throw new Error("WHATSAPP_REPLY_API_TOKEN must contain 32-256 URL-safe characters");
  }
  const terminalReplyTo = env.WHATSAPP_REPLY_TO;
  if (terminalReplyTo && !/^whatsapp:\+[1-9]\d{6,14}$/.test(terminalReplyTo)) {
    throw new Error("WHATSAPP_REPLY_TO must look like whatsapp:+<country code><number>");
  }
  const paymentQrPath = env.PAYTM_QR_PATH?.trim();
  const paymentQrUrl = env.STATIC_PAYMENT_QR_URL?.trim();
  if (paymentQrPath && paymentQrUrl) {
    throw new Error("Set only one of PAYTM_QR_PATH and STATIC_PAYMENT_QR_URL");
  }
  if (paymentQrUrl) {
    let qrUrl: URL | undefined;
    try {
      qrUrl = new URL(paymentQrUrl);
    } catch {
      // Rejected below with the same message.
    }
    if (!qrUrl || qrUrl.protocol !== "https:" || qrUrl.username || qrUrl.password || qrUrl.hash) {
      throw new Error("STATIC_PAYMENT_QR_URL must be a public HTTPS URL without credentials or a fragment");
    }
  }
  const pricesPath = env.PRODUCT_PRICES_PATH?.trim();
  const aiEndpoint = env.AZURE_OPENAI_ENDPOINT?.trim();
  const aiKey = env.AZURE_OPENAI_API_KEY?.trim();
  if (Boolean(aiEndpoint) !== Boolean(aiKey)) {
    throw new Error("Set both AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY, or neither");
  }
  let azureOpenAi: AzureOpenAiConfig | undefined;
  if (aiEndpoint && aiKey) {
    let endpoint: URL | undefined;
    try {
      endpoint = new URL(aiEndpoint);
    } catch {
      // Rejected below with the same message.
    }
    if (!endpoint || endpoint.protocol !== "https:" || endpoint.username || endpoint.password) {
      throw new Error("AZURE_OPENAI_ENDPOINT must be an HTTPS URL such as https://<resource>.openai.azure.com");
    }
    azureOpenAi = {
      endpoint: endpoint.origin,
      apiKey: aiKey,
      deployment: env.AZURE_OPENAI_DEPLOYMENT?.trim() || "gpt-4.1-mini",
      apiVersion: env.AZURE_OPENAI_API_VERSION?.trim() || "2024-10-21",
    };
  }
  return {
    host: env.HOST ?? "127.0.0.1",
    port,
    twilio: { accountSid, authToken, webhookUrl, whatsappNumber },
    orders: {
      ...(sellerNumber ? { sellerNumber } : {}),
      storePath: env.ORDER_STORE_PATH?.trim() || "data/orders.json",
      paymentProofDir: env.PAYMENT_PROOF_DIR?.trim() || "data/payment-proofs",
      ...(pricesPath ? { pricesPath } : {}),
    },
    ...(manualReplyApiToken ? { manualReplyApiToken } : {}),
    ...(terminalReplyTo ? { terminalReplyTo } : {}),
    // A local image is served from the same public origin used for the webhook so Twilio can fetch it.
    ...(paymentQrPath
      ? { paymentQr: { path: paymentQrPath, url: new URL(PAYMENT_QR_ROUTE, url).toString() } }
      : paymentQrUrl ? { paymentQr: { url: paymentQrUrl } } : {}),
    ...(azureOpenAi ? { azureOpenAi } : {}),
  };
}
