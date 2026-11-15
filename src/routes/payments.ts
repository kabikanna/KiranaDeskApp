import type { Server } from "@hapi/hapi";
import { PAYMENT_QR_ROUTE } from "../services/payment-qr.ts";
import type { PaymentQr } from "../services/payment-qr.ts";

export function registerPaymentRoutes(server: Server, paymentQr: PaymentQr): void {
  // Public so Twilio can fetch the image when sending it to WhatsApp.
  server.route({
    method: "GET",
    path: PAYMENT_QR_ROUTE,
    options: { auth: false },
    handler: (_request, h) => h.response(paymentQr.image)
      .type(paymentQr.contentType)
      .header("x-content-type-options", "nosniff"),
  });
}
