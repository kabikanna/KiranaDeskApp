import twilio from "twilio";
import type { AppConfig } from "../config.ts";
import type { Logger } from "../logger.ts";

export interface WhatsAppReplySender {
  send(to: string, body: string, mediaUrl?: string): Promise<{ messageSid: string; status: string }>;
}

interface WhatsAppMessageClient {
  messages: {
    create(message: {
      from: string;
      to: string;
      body: string;
      mediaUrl?: string[];
    }): Promise<{ sid: string; status: string }>;
  };
}

export function createWhatsAppReplySender(
  config: AppConfig["twilio"],
  logger: Logger,
  client: WhatsAppMessageClient = twilio(config.accountSid, config.authToken),
): WhatsAppReplySender {
  return {
    async send(to, body, mediaUrl) {
      const message = await client.messages.create({
        from: config.whatsappNumber,
        to,
        body,
        ...(mediaUrl ? { mediaUrl: [mediaUrl] } : {}),
      });
      const result = { messageSid: message.sid, status: message.status };
      logger.info("Manual WhatsApp reply accepted by Twilio", { ...result, mediaAttached: Boolean(mediaUrl) });
      return result;
    },
  };
}
