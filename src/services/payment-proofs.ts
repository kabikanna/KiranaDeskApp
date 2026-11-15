import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface InboundMedia {
  url: string;
  contentType: string;
}

export interface StoredPaymentProof {
  /** `<MessageSid>-<media index>`, stable across Twilio retries. */
  id: string;
  messageSid: string;
  path: string;
  contentType: string;
  size: number;
  receivedAt: string;
}

/** Downloads a customer's payment screenshot and keeps a local copy. */
export interface PaymentProofStore {
  save(orderId: string, messageSid: string, index: number, media: InboundMedia): Promise<StoredPaymentProof>;
}

export const PAYMENT_PROOF_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

const MAX_BYTES = 10 * 1024 * 1024;

/** Twilio-hosted media only, so the account credentials are never sent to another host. */
export function isTwilioMediaUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "api.twilio.com" && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function createPaymentProofStore(
  { accountSid, authToken, directory }: { accountSid: string; authToken: string; directory: string },
  { fetchImpl = fetch, timeoutMs = 8000 }: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): PaymentProofStore {
  const authorization = `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`;
  return {
    async save(orderId, messageSid, index, media) {
      const extension = PAYMENT_PROOF_TYPES[media.contentType];
      if (!extension || !isTwilioMediaUrl(media.url)) {
        throw new Error("Unsupported payment proof attachment");
      }
      // Twilio redirects to a short-lived storage URL; fetch drops the Authorization header on that cross-origin hop.
      const response = await fetchImpl(media.url, {
        headers: { Authorization: authorization },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        throw new Error(`Twilio media download returned HTTP ${response.status}`);
      }
      if (Number(response.headers.get("content-length") ?? 0) > MAX_BYTES) {
        throw new Error("Payment proof is larger than 10 MB");
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length === 0 || bytes.length > MAX_BYTES) {
        throw new Error("Payment proof is empty or larger than 10 MB");
      }
      const id = `${messageSid}-${index}`;
      await mkdir(directory, { recursive: true });
      const path = join(directory, `${orderId}-${id}.${extension}`);
      const tempPath = `${path}.${process.pid}.tmp`;
      await writeFile(tempPath, bytes, { mode: 0o600 });
      await rename(tempPath, path);
      return { id, messageSid, path, contentType: media.contentType, size: bytes.length, receivedAt: new Date().toISOString() };
    },
  };
}
