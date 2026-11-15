import { readFile } from "node:fs/promises";

export const PAYMENT_QR_ROUTE = "/payments/paytm-qr";
export const ORDER_PAYMENT_INSTRUCTION = "Pay using this Paytm QR after the seller confirms your total.";

// WhatsApp accepts PNG and JPEG images up to 5 MB.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
const rupees = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" });

export interface PaymentQr {
  image: Buffer;
  contentType: "image/png" | "image/jpeg";
  url: string;
}

export async function loadPaymentQr(filePath: string, url: string): Promise<PaymentQr> {
  let image: Buffer;
  try {
    image = await readFile(filePath);
  } catch (error) {
    throw new Error(`Cannot read PAYTM_QR_PATH: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (image.length > MAX_IMAGE_BYTES) {
    throw new Error("PAYTM_QR_PATH must point to an image of at most 5 MB");
  }
  const contentType = image.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
    ? "image/png"
    : image.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE) ? "image/jpeg" : undefined;
  if (!contentType) {
    throw new Error("PAYTM_QR_PATH must point to a PNG or JPEG image");
  }
  return { image, contentType, url };
}

/** Returns a normalized rupee amount, or undefined when the value is not a positive amount with up to 2 decimals. */
export function parsePaymentAmount(value: unknown): string | undefined {
  const amount = typeof value === "number" ? String(value) : value;
  if (typeof amount !== "string" || !/^\d{1,7}(?:\.\d{1,2})?$/.test(amount) || Number(amount) <= 0) {
    return undefined;
  }
  return Number(amount).toFixed(2);
}

export function paymentRequestMessage(amount: string): string {
  return `Please pay ${rupees.format(Number(amount))} using this Paytm QR.`;
}
