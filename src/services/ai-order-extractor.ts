import { normalizeUnit } from "./order-parser.ts";
import type { OrderItem } from "./order-parser.ts";

export interface AzureOpenAiConfig {
  /** Resource endpoint, e.g. https://kirana-openai.openai.azure.com */
  endpoint: string;
  apiKey: string;
  deployment: string;
  apiVersion: string;
}

/** Turns a free-text (Tamil, Tanglish or English) order into clean items; resolves to [] when it holds no items. */
export interface OrderExtractor {
  extract(text: string): Promise<OrderItem[]>;
}

const SYSTEM_PROMPT = "Extract grocery items from a kirana order. Input may be Tamil, Tanglish or English and may " +
  "have spelling or speech mistakes. Fix the mistakes. For each item give the correct Tamil name, the English name, " +
  "the quantity as a number, and the unit (kg, g, l, ml, packet, pcs). Never put the quantity or the unit inside a name; " +
  "the Tamil name is only the product, e.g. அரிசி, never அரை கிலோ அரிசி. " +
  "Interpret arai=0.5, kaal=0.25, oru=1, rendu=2, moonu=3. If no quantity is given, use 1 pcs. " +
  "If the message is not a grocery order (for example a greeting or a question), return no items.";

const RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "items",
    strict: true,
    schema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              tamil: { type: "string" },
              english: { type: "string" },
              quantity: { type: "number" },
              unit: { type: "string", enum: ["kg", "g", "l", "ml", "packet", "pcs"] },
            },
            required: ["tamil", "english", "quantity", "unit"],
            additionalProperties: false,
          },
        },
      },
      required: ["items"],
      additionalProperties: false,
    },
  },
} as const;

const MAX_ITEMS = 50;
const MAX_QUANTITY = 10000;
const MAX_INPUT_LENGTH = 2000;

/** Validates the model's JSON and merges repeated items, mirroring the rule-based parser's output. */
export function parseExtractedItems(content: string): OrderItem[] {
  const data: unknown = JSON.parse(content);
  const rawItems = (data as { items?: unknown } | null)?.items;
  if (!Array.isArray(rawItems) || rawItems.length > MAX_ITEMS) {
    throw new Error("Order extraction returned an invalid item list");
  }
  const totals = new Map<string, OrderItem>();
  for (const raw of rawItems as Record<string, unknown>[]) {
    const name = typeof raw?.english === "string" ? raw.english.replace(/\s+/gu, " ").trim().toLowerCase() : "";
    const tamilName = typeof raw?.tamil === "string" ? raw.tamil.replace(/\s+/gu, " ").trim() : "";
    const unit = typeof raw?.unit === "string" ? normalizeUnit(raw.unit) : undefined;
    const quantity = raw?.quantity;
    if (
      !name || !unit || typeof quantity !== "number" || !Number.isFinite(quantity) ||
      quantity <= 0 || quantity > MAX_QUANTITY
    ) {
      throw new Error("Order extraction returned an invalid item");
    }
    const key = `${name}|${unit}`;
    const existing = totals.get(key);
    if (existing) {
      existing.quantity = Math.round((existing.quantity + quantity) * 1000) / 1000;
    } else {
      totals.set(key, { name, quantity, unit, ...(tamilName ? { tamilName } : {}) });
    }
  }
  return [...totals.values()];
}

export function createAzureOpenAiOrderExtractor(
  config: AzureOpenAiConfig,
  { fetchImpl = fetch, timeoutMs = 8000, productNames = [] }: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    /** Price-list names; the model is asked to use them so items can be priced. */
    productNames?: readonly string[];
  } = {},
): OrderExtractor {
  const systemPrompt = productNames.length === 0 ? SYSTEM_PROMPT : `${SYSTEM_PROMPT} ` +
    "For the English name, use exactly one of these shop product names when the item matches it " +
    `(including synonyms, e.g. chakkarai/cheeni = sugar), otherwise a short common name: ${productNames.join(", ")}.`;
  const url = new URL(
    `/openai/deployments/${encodeURIComponent(config.deployment)}/chat/completions`,
    config.endpoint,
  );
  url.searchParams.set("api-version", config.apiVersion);
  return {
    async extract(text) {
      // Twilio waits about 15 seconds for the webhook, so a slow model call must not exceed that.
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "api-key": config.apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          temperature: 0,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: text.slice(0, MAX_INPUT_LENGTH) },
          ],
          response_format: RESPONSE_FORMAT,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        throw new Error(`Azure OpenAI returned HTTP ${response.status}`);
      }
      const body = await response.json() as { choices?: { message?: { content?: unknown; refusal?: unknown } }[] };
      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== "string") {
        throw new Error("Azure OpenAI returned no message content");
      }
      return parseExtractedItems(content);
    },
  };
}
