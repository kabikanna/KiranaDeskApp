import { readFile } from "node:fs/promises";
import { normalizeUnit } from "./order-parser.ts";
import type { OrderItem } from "./order-parser.ts";

export interface PricedOrderItem extends OrderItem {
  /** Rupees per catalog unit; absent when the product is not in the catalog. */
  unitPrice?: number;
  /** Unit that unitPrice is quoted per, e.g. kg when 500 g was ordered. */
  priceUnit?: string;
  /** Rupees for this line, rounded to paise; absent when the item cannot be priced. */
  amount?: number;
}

export interface PricedOrder {
  items: PricedOrderItem[];
  /** Present only when every item could be priced. */
  totalAmount?: number;
}

export interface CatalogPrice { unit: string; price: number }
/** A product may have one price, or several for different units (e.g. milk per litre and per packet). */
export type PriceCatalog = ReadonlyMap<string, CatalogPrice | readonly CatalogPrice[]>;

// Only weight and volume units are convertible, e.g. 500 g against a per-kg price.
const MEASURES: Record<string, { base: "g" | "ml"; factor: number }> = {
  kg: { base: "g", factor: 1000 },
  g: { base: "g", factor: 1 },
  l: { base: "ml", factor: 1000 },
  ml: { base: "ml", factor: 1 },
};

const roundToPaise = (value: number): number => Math.round(value * 100) / 100;

/**
 * Loads `{ "rice": { "unit": "kg", "price": 60 }, "milk": [{ "unit": "l", "price": 56 }, { "unit": "pack", "price": 28 }] }`;
 * keys are lowercase English product names.
 */
export async function loadPriceCatalog(filePath: string): Promise<PriceCatalog> {
  let data: unknown;
  try {
    data = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read PRODUCT_PRICES_PATH: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("PRODUCT_PRICES_PATH must contain a JSON object keyed by product name");
  }
  const catalog = new Map<string, CatalogPrice | CatalogPrice[]>();
  for (const [name, entry] of Object.entries(data)) {
    const entries = Array.isArray(entry) ? entry : [entry];
    const prices = entries.map((candidate: unknown) => {
      const { unit, price } = (typeof candidate === "object" && candidate !== null ? candidate : {}) as Record<string, unknown>;
      const normalizedUnit = typeof unit === "string" ? normalizeUnit(unit) : undefined;
      if (
        name !== name.trim().toLowerCase() || !name || !normalizedUnit ||
        typeof price !== "number" || !Number.isFinite(price) || price <= 0
      ) {
        throw new Error(`PRODUCT_PRICES_PATH entry "${name}" needs a lowercase name, a known unit and a positive price`);
      }
      return { unit: normalizedUnit, price };
    });
    if (prices.length === 0) {
      throw new Error(`PRODUCT_PRICES_PATH entry "${name}" needs at least one price`);
    }
    catalog.set(name, prices.length === 1 && !Array.isArray(entry) ? prices[0] as CatalogPrice : prices);
  }
  return catalog;
}

function lineAmount(item: OrderItem, entry: CatalogPrice): number | undefined {
  if (item.unit === entry.unit) {
    return roundToPaise(item.quantity * entry.price);
  }
  const ordered = MEASURES[item.unit];
  const priced = MEASURES[entry.unit];
  return ordered && priced && ordered.base === priced.base
    ? roundToPaise((item.quantity * ordered.factor) / priced.factor * entry.price)
    : undefined;
}

export function priceItems(items: OrderItem[], catalog: PriceCatalog | undefined): PricedOrder {
  let total = 0;
  let complete = true;
  const priced = items.map((item): PricedOrderItem => {
    const found = catalog?.get(item.name);
    const entries: readonly CatalogPrice[] = found === undefined ? [] : Array.isArray(found) ? found : [found as CatalogPrice];
    // Prefer a price in the ordered unit, then any convertible one.
    const entry = entries.find((candidate) => candidate.unit === item.unit) ??
      entries.find((candidate) => lineAmount(item, candidate) !== undefined);
    const amount = entry ? lineAmount(item, entry) : undefined;
    if (!entry || amount === undefined) {
      complete = false;
      return { ...item };
    }
    total += amount;
    return { ...item, unitPrice: entry.price, priceUnit: entry.unit, amount };
  });
  return complete && priced.length > 0
    ? { items: priced, totalAmount: roundToPaise(total) }
    : { items: priced };
}
