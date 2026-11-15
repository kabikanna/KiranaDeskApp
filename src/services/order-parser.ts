export interface OrderItem {
  /** Lowercase English name, used for pricing. */
  name: string;
  /** Tamil name, when the order was refined by the AI extractor. */
  tamilName?: string;
  quantity: number;
  unit: string;
}

export interface ParsedOrder {
  items: OrderItem[];
  unparsedLines: string[];
}

const UNIT_ALIASES: Record<string, string> = {
  kg: "kg", kgs: "kg", kilo: "kg", kilos: "kg", kilogram: "kg", kilograms: "kg",
  g: "g", gm: "g", gms: "g", gram: "g", grams: "g",
  l: "l", lt: "l", ltr: "l", ltrs: "l", litre: "l", litres: "l", liter: "l", liters: "l",
  ml: "ml",
  pc: "pcs", pcs: "pcs", piece: "pcs", pieces: "pcs", no: "pcs", nos: "pcs", unit: "pcs", units: "pcs",
  pkt: "pack", pkts: "pack", packet: "pack", packets: "pack", pack: "pack", packs: "pack",
  dozen: "dozen", dz: "dozen",
  bottle: "bottle", bottles: "bottle",
  box: "box", boxes: "box",
  bag: "bag", bags: "bag",
};

export function normalizeUnit(unit: string): string | undefined {
  return Object.hasOwn(UNIT_ALIASES, unit.toLowerCase()) ? UNIT_ALIASES[unit.toLowerCase()] : undefined;
}

// Rejects values such as phone numbers that are clearly not item quantities.
const MAX_QUANTITY = 10000;
const UNIT = `(${Object.keys(UNIT_ALIASES).sort((a, b) => b.length - a.length).join("|")})\\.?`;
const QTY = "(\\d+(?:\\.\\d+)?)";
// "2 kg rice", "2kg rice", "12 x eggs", "3 bread"
const QTY_FIRST = new RegExp(`^${QTY}\\s*(?:${UNIT}(?=\\s|$))?\\s*(?:x\\s+|of\\s+)?(.*\\p{L}.*)$`, "iu");
// "rice 2kg", "rice - 2 kg", "eggs x12", "milk: 1 litre"
const QTY_LAST = new RegExp(`^(.*?\\p{L}.*?)\\s*(?:[-:=x×]\\s*)?${QTY}\\s*(?:${UNIT})?$`, "iu");

function normalizeName(name: string): string {
  return name.replace(/[\s.,;:!-]+$/u, "").replace(/\s+/gu, " ").trim().toLowerCase();
}

function parseLine(line: string): OrderItem | undefined {
  const match = QTY_FIRST.exec(line);
  if (match) {
    const name = normalizeName(match[3] ?? "");
    if (name) {
      return { name, quantity: Number(match[1]), unit: UNIT_ALIASES[match[2]?.toLowerCase() ?? ""] ?? "pcs" };
    }
  }
  const trailing = QTY_LAST.exec(line);
  if (trailing) {
    const name = normalizeName(trailing[1] ?? "");
    if (name) {
      return { name, quantity: Number(trailing[2]), unit: UNIT_ALIASES[trailing[3]?.toLowerCase() ?? ""] ?? "pcs" };
    }
  }
  return undefined;
}

/**
 * Extracts a net item list from a free-text order: one item per line or comma/semicolon-separated
 * segment, with repeated items of the same name and unit summed. Segments without a quantity are
 * kept as unparsed lines for the seller to review.
 */
export function parseOrder(text: string): ParsedOrder {
  const totals = new Map<string, OrderItem>();
  const unparsedLines: string[] = [];
  const segments = text
    .split(/[\n\r,;]+|\s+and\s+/iu)
    .map((segment) => segment
      .trim()
      .replace(/^(?:[-*•]+|\d+[.)])\s+/u, "")
      .replace(/^(?:(?:please|pls|plz)\s+)?(?:(?:i\s+)?(?:need|want)|send|add|order|give)(?:\s+me)?\s+/iu, "")
      .trim())
    .filter(Boolean);
  for (const segment of segments) {
    const item = parseLine(segment);
    if (!item || !Number.isFinite(item.quantity) || item.quantity <= 0 || item.quantity > MAX_QUANTITY) {
      unparsedLines.push(segment);
      continue;
    }
    const key = `${item.name}|${item.unit}`;
    const existing = totals.get(key);
    if (existing) {
      existing.quantity = Math.round((existing.quantity + item.quantity) * 1000) / 1000;
    } else {
      totals.set(key, item);
    }
  }
  return { items: [...totals.values()], unparsedLines };
}
