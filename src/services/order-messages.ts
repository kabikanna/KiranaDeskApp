import type { Order, OrderLanguage } from "../repositories/orders.ts";

const amountFormat = (amount: number) => new Intl.NumberFormat("en-IN", {
  minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
  maximumFractionDigits: 2,
}).format(amount);

export const formatRupees = (amount: number): string => `₹${amountFormat(amount)}`;

const TAMIL_SCRIPT = /[\u0B80-\u0BFF]/u;

/** Replies in Tamil when the customer wrote in Tamil script; English (including Tanglish) otherwise. */
export const detectLanguage = (text: string): OrderLanguage => TAMIL_SCRIPT.test(text) ? "ta" : "en";

const UNIT_LABELS: Record<OrderLanguage, Record<string, string>> = {
  en: { l: "litre" },
  ta: { kg: "கிலோ", g: "கிராம்", l: "லிட்டர்", ml: "மி.லி", pcs: "எண்ணம்", pack: "பாக்கெட்", dozen: "டஜன்" },
};

const unitLabel = (unit: string, lang: OrderLanguage): string => UNIT_LABELS[lang][unit] ?? unit;

/** "1. Rice - 0.5 kg × ₹60/kg = ₹30"; unpriced items show only the quantity. */
function itemLine(item: Order["items"][number], index: number, lang: OrderLanguage): string {
  const name = lang === "ta" && item.tamilName
    ? item.tamilName
    : `${item.name.charAt(0).toUpperCase()}${item.name.slice(1)}`;
  const line = `${index + 1}. ${name} - ${item.quantity} ${unitLabel(item.unit, lang)}`;
  if (item.amount === undefined || item.unitPrice === undefined) {
    return line;
  }
  return `${line} × ${formatRupees(item.unitPrice)}/${unitLabel(item.priceUnit ?? item.unit, lang)} = ${formatRupees(item.amount)}`;
}

const itemLines = (order: Order, lang: OrderLanguage): string[] =>
  order.items.map((item, index) => itemLine(item, index, lang));

const languageOf = (order: Pick<Order, "language">): OrderLanguage => order.language ?? "en";

export function orderConfirmationMessage(order: Order): string {
  const lang = languageOf(order);
  const items = itemLines(order, lang);
  if (lang === "ta") {
    return [
      "உங்கள் ஆர்டர் பெறப்பட்டது!",
      "",
      `ஆர்டர் எண்: ${order.id}`,
      "",
      "ஆர்டர் விவரம்:",
      ...items,
      "",
      order.totalAmount === undefined
        ? "மொத்த தொகை: விற்பனையாளர் உறுதிசெய்வார்"
        : `மொத்த தொகை: ${formatRupees(order.totalAmount)}`,
      "",
      "உங்கள் ஆர்டரைத் தொடரலாமா?",
      "உறுதிசெய்ய YES அல்லது ரத்துசெய்ய NO என பதிலளிக்கவும். ஏதேனும் தவறாக இருந்தால், NO என பதிலளித்து உங்கள் ஆர்டரை மீண்டும் அனுப்பவும்.",
    ].join("\n");
  }
  return [
    "Your order has been received!",
    "",
    `Order ID: ${order.id}`,
    "",
    "Order Summary:",
    ...items,
    "",
    order.totalAmount === undefined
      ? "Total Amount: To be confirmed by the seller"
      : `Total Amount: ${formatRupees(order.totalAmount)}`,
    "",
    "Can we proceed with your order?",
    "Reply YES to confirm or NO to cancel. If anything is missing above, reply NO and send your order again.",
  ].join("\n");
}

export function paymentMessage(order: Order, hasQr: boolean): string {
  const lang = languageOf(order);
  const amount = order.totalAmount === undefined ? undefined : formatRupees(order.totalAmount);
  if (lang === "ta") {
    const instruction = !hasQr
      ? "பணம் செலுத்தும் விவரங்களை விற்பனையாளர் விரைவில் பகிர்வார்."
      : amount
        ? `கீழே உள்ள QR குறியீட்டை ஸ்கேன் செய்து ${amount} செலுத்தவும்.`
        : "கீழே உள்ள QR குறியீட்டை ஸ்கேன் செய்யவும். செலுத்த வேண்டிய தொகையை விற்பனையாளர் உறுதிசெய்வார்.";
    return [
      "உங்கள் ஆர்டர் உறுதிசெய்யப்பட்டது!",
      "",
      `ஆர்டர் எண்: ${order.id}`,
      "",
      "பில் விவரம்:",
      ...itemLines(order, lang),
      "",
      ...(amount ? [`செலுத்த வேண்டிய தொகை: ${amount}`, ""] : []),
      instruction,
      ...(hasQr ? ["", "பணம் செலுத்திய பிறகு, அதன் உறுதிப்படுத்தலைப் பகிரவும்."] : []),
    ].join("\n");
  }
  const instruction = !hasQr
    ? "The seller will share the payment details shortly."
    : amount
      ? `Please scan the QR code below and pay ${amount}.`
      : "Please scan the QR code below. The seller will confirm the amount to pay.";
  return [
    "Your order is confirmed!",
    "",
    `Order ID: ${order.id}`,
    "",
    "Bill:",
    ...itemLines(order, lang),
    "",
    ...(amount ? [`Amount to Pay: ${amount}`, ""] : []),
    instruction,
    ...(hasQr ? ["", "After completing the payment, please share the payment confirmation."] : []),
  ].join("\n");
}

export const cancellationMessage = (orderId: string, lang: OrderLanguage = "en"): string => lang === "ta"
  ? `உங்கள் ஆர்டர் ${orderId} ரத்துசெய்யப்பட்டது.\nநன்றி!`
  : `Your order ${orderId} has been cancelled.\nThank you!`;

export const alreadyCancelledMessage = (orderId: string, lang: OrderLanguage = "en"): string => lang === "ta"
  ? `ஆர்டர் ${orderId} ஏற்கனவே ரத்துசெய்யப்பட்டது.`
  : `Order ${orderId} has already been cancelled.`;

export const cannotConfirmCancelledMessage = (orderId: string, lang: OrderLanguage = "en"): string => lang === "ta"
  ? `ஆர்டர் ${orderId} ரத்துசெய்யப்பட்டது. புதிய ஆர்டருக்கு உங்கள் பொருட்களை மீண்டும் அனுப்பவும்.`
  : `Order ${orderId} was cancelled. Please send your items again to place a new order.`;

export const cannotCancelConfirmedMessage = (orderId: string, lang: OrderLanguage = "en"): string => lang === "ta"
  ? `ஆர்டர் ${orderId} ஏற்கனவே உறுதிசெய்யப்பட்டதால் இங்கே ரத்துசெய்ய முடியாது. விற்பனையாளரைத் தொடர்புகொள்ளவும்.`
  : `Order ${orderId} is already confirmed, so it cannot be cancelled here. Please contact the seller.`;

export const notAwaitingMessage = (orderId: string, lang: OrderLanguage = "en"): string => lang === "ta"
  ? `ஆர்டர் ${orderId} உறுதிப்படுத்தலுக்காகக் காத்திருக்கவில்லை.`
  : `Order ${orderId} is not waiting for confirmation.`;

export function orderNotFoundMessage(orderId?: string, lang: OrderLanguage = "en"): string {
  if (lang === "ta") {
    return orderId
      ? `உங்கள் எண்ணுக்கு ஆர்டர் ${orderId} கிடைக்கவில்லை.`
      : "உறுதிப்படுத்தலுக்காகக் காத்திருக்கும் ஆர்டர் எதுவும் இல்லை. ஆர்டர் செய்ய உங்கள் பொருட்களை அனுப்பவும்.";
  }
  return orderId
    ? `We could not find order ${orderId} for your number.`
    : "We could not find an order waiting for your confirmation. Please send your items to place an order.";
}

/** Prompts for a YES/NO answer; asks for the order ID when more than one order is waiting (given newest first). */
export function pendingOrdersPrompt(waiting: readonly Order[]): string {
  const oldestFirst = [...waiting].reverse();
  const [first] = oldestFirst;
  const lang = waiting[0] ? languageOf(waiting[0]) : "en";
  if (oldestFirst.length === 1 && first) {
    return lang === "ta"
      ? `ஆர்டர் ${first.id}-ஐ உறுதிசெய்ய YES அல்லது ரத்துசெய்ய NO என பதிலளிக்கவும்.`
      : `Please reply YES to confirm or NO to cancel order ${first.id}.`;
  }
  const ids = oldestFirst.map((order) => order.id).join(", ");
  const example = `YES ${first?.id ?? "ORD001"}`;
  return lang === "ta"
    ? `உறுதிப்படுத்தலுக்காக பல ஆர்டர்கள் காத்திருக்கின்றன (${ids}). ஆர்டர் எண்ணையும் சேர்த்து பதிலளிக்கவும், உதாரணம்: ${example}`
    : `You have several orders waiting for confirmation (${ids}). Please include the order ID, for example: ${example}`;
}

export const paymentProofReceivedMessage = (orderId: string, lang: OrderLanguage = "en"): string => lang === "ta"
  ? `ஆர்டர் ${orderId}-க்கான பணம் செலுத்திய ஸ்கிரீன்ஷாட் பெறப்பட்டது. விற்பனையாளர் சரிபார்த்து உறுதிசெய்வார். நன்றி!`
  : `Payment screenshot received for order ${orderId}. The seller will verify it and confirm. Thank you!`;

export const paymentProofFailedMessage = (lang: OrderLanguage = "en"): string => lang === "ta"
  ? "உங்கள் ஸ்கிரீன்ஷாட்டைச் சேமிக்க முடியவில்லை. தயவுசெய்து மீண்டும் அனுப்பவும்."
  : "We could not save your payment screenshot. Please send it again.";

export const noPayableOrderMessage = (lang: OrderLanguage = "en"): string => lang === "ta"
  ? "பணம் செலுத்தக் காத்திருக்கும் ஆர்டர் எதுவும் இல்லை. ஸ்கிரீன்ஷாட்டுடன் ஆர்டர் எண்ணையும் அனுப்பவும், உதாரணம்: ORD001"
  : "We could not find a confirmed order waiting for payment. Please send the screenshot with your order ID, for example: ORD001";
