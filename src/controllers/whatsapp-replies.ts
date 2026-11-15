import { createHash, timingSafeEqual } from "node:crypto";
import Boom from "@hapi/boom";
import type { Lifecycle, Request, ResponseToolkit } from "@hapi/hapi";
import { parsePaymentAmount, paymentRequestMessage } from "../services/payment-qr.ts";
import type { WhatsAppReplySender } from "../services/whatsapp-replies.ts";

function createAuthenticator(apiToken: string | undefined): (request: Request) => void {
  const expectedHash = apiToken ? createHash("sha256").update(apiToken).digest() : undefined;
  return (request) => {
    if (!expectedHash) {
      throw Boom.serverUnavailable("Manual WhatsApp replies are not configured");
    }
    const authorization: unknown = request.headers.authorization;
    const token = typeof authorization === "string"
      ? /^Bearer\s+(\S+)$/i.exec(authorization)?.[1]
      : undefined;
    if (!token || !timingSafeEqual(expectedHash, createHash("sha256").update(token).digest())) {
      throw Boom.unauthorized("Invalid or missing reply API token", "Bearer");
    }
  };
}

function parseFields(payload: unknown, fields: readonly string[]): Record<string, unknown> {
  const names = fields.join(" and ");
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw Boom.badRequest(`Expected a JSON object with ${names}`);
  }
  if (Object.keys(payload).some((key) => !fields.includes(key))) {
    throw Boom.badRequest(`Only ${names} are allowed`);
  }
  return payload as Record<string, unknown>;
}

function parseRecipient(to: unknown, senderNumber: string): string {
  if (typeof to !== "string" || !/^whatsapp:\+[1-9]\d{6,14}$/.test(to)) {
    throw Boom.badRequest("to must be a WhatsApp number in the format whatsapp:+<country code><number>");
  }
  if (to === senderNumber) {
    throw Boom.badRequest("to must be the customer's WhatsApp number, not the Twilio sender number");
  }
  return to;
}

async function submit(
  h: ResponseToolkit,
  send: () => ReturnType<WhatsAppReplySender["send"]>,
): Promise<Lifecycle.ReturnValue> {
  try {
    return h.response(await send()).code(202);
  } catch (error) {
    const failure = Boom.badGateway("Twilio did not confirm the WhatsApp message submission");
    failure.data = error instanceof Error ? error : new Error(String(error));
    throw failure;
  }
}

export function createWhatsAppReplyHandler(
  apiToken: string | undefined,
  sender: WhatsAppReplySender,
  senderNumber: string,
): Lifecycle.Method {
  const authenticate = createAuthenticator(apiToken);
  return async (request, h) => {
    authenticate(request);
    const payload = parseFields(request.payload, ["to", "body"]);
    const to = parseRecipient(payload.to, senderNumber);
    const { body } = payload;
    if (typeof body !== "string" || !body.trim() || Array.from(body).length > 1600) {
      throw Boom.badRequest("body must be non-empty text of at most 1600 characters");
    }
    return submit(h, () => sender.send(to, body));
  };
}

export function createWhatsAppPaymentQrHandler(
  apiToken: string | undefined,
  sender: WhatsAppReplySender,
  senderNumber: string,
  paymentQrUrl: string | undefined,
): Lifecycle.Method {
  const authenticate = createAuthenticator(apiToken);
  return async (request, h) => {
    authenticate(request);
    if (!paymentQrUrl) {
      throw Boom.serverUnavailable("Paytm QR payments are not configured");
    }
    const payload = parseFields(request.payload, ["to", "amount"]);
    const to = parseRecipient(payload.to, senderNumber);
    const amount = parsePaymentAmount(payload.amount);
    if (!amount) {
      throw Boom.badRequest("amount must be a positive rupee amount with at most 2 decimal places, e.g. 250 or 250.50");
    }
    return submit(h, () => sender.send(to, paymentRequestMessage(amount), paymentQrUrl));
  };
}
