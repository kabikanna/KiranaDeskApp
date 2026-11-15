import Boom from "@hapi/boom";
import type { Lifecycle } from "@hapi/hapi";
import twilio from "twilio";
import type { AppConfig } from "../config.ts";
import { isTwilioMediaUrl } from "../services/payment-proofs.ts";
import type { InboundMedia } from "../services/payment-proofs.ts";
import type { WhatsAppMessage, WhatsAppMessageProcessor } from "../services/whatsapp.ts";

function isFormPayload(payload: unknown): payload is Record<string, string> {
  return typeof payload === "object" && payload !== null && !Array.isArray(payload) &&
    Object.values(payload).every((value) => typeof value === "string");
}

function parseMessage(payload: Record<string, string>): WhatsAppMessage {
  const {
    From: from, To: to, Body: body = "", MessageSid: messageSid, NumMedia: media, ProfileName: profileName,
  } = payload;
  if (
    !from || !/^whatsapp:\+\d{7,15}$/.test(from) ||
    !to || !/^whatsapp:\+\d{7,15}$/.test(to) ||
    !messageSid || !/^(SM|MM)[0-9a-f]{32}$/i.test(messageSid) ||
    !media || !/^\d+$/.test(media) || !Number.isSafeInteger(Number(media))
  ) {
    throw Boom.badRequest("Invalid WhatsApp message payload");
  }
  const name = profileName?.trim().slice(0, 100);
  const attachments: InboundMedia[] = [];
  // WhatsApp allows at most 10 attachments per message.
  for (let index = 0; index < Math.min(Number(media), 10); index++) {
    const url = payload[`MediaUrl${index}`];
    const contentType = payload[`MediaContentType${index}`]?.split(";")[0]?.trim().toLowerCase();
    if (url && contentType && isTwilioMediaUrl(url)) {
      attachments.push({ url, contentType });
    }
  }
  return {
    from, to, body, messageSid, numMedia: Number(media),
    ...(name ? { profileName: name } : {}),
    ...(attachments.length > 0 ? { media: attachments } : {}),
  };
}

export function createWhatsAppHandler(
  config: AppConfig["twilio"],
  service: WhatsAppMessageProcessor,
): Lifecycle.Method {
  return async (request, h) => {
    const signature: unknown = request.headers["x-twilio-signature"];
    if (typeof signature !== "string" || !signature) {
      throw Boom.forbidden("Missing Twilio signature");
    }
    if (!isFormPayload(request.payload)) {
      throw Boom.badRequest("Expected form fields with string values");
    }
    // Validate all original form fields before applying defaults or extracting message fields.
    if (!twilio.validateRequest(config.authToken, signature, config.webhookUrl, request.payload)) {
      throw Boom.forbidden("Invalid Twilio signature");
    }
    const message = parseMessage(request.payload);
    let result;
    try {
      result = await service.processMessage(message);
    } catch (error) {
      throw Boom.internal("WhatsApp message processing failed", error);
    }
    const twiml = new twilio.twiml.MessagingResponse();
    if (result.reply && result.mediaUrl) {
      const reply = twiml.message({}, "");
      reply.body(result.reply);
      reply.media(result.mediaUrl);
    } else if (result.reply) {
      twiml.message(result.reply);
    }
    return h.response(twiml.toString()).type("text/xml").code(200);
  };
}
