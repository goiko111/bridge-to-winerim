import type {
  ProviderSalesDocument,
  ProviderSalesLine,
  SalesIdentitySource,
  SalesVariant,
} from "./types";

type UnknownRecord = Record<string, unknown>;

export type OpenTicketParseOptions = {
  provider: string;
  businessDay: string;
  observedAt?: string;
};

function isRecord(value: unknown): value is UnknownRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as UnknownRecord;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

function fallbackHash(value: unknown): string {
  const text = stableStringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function getField(record: UnknownRecord, ...names: string[]): unknown {
  const keys = Object.keys(record);
  for (const name of names) {
    if (name in record) return record[name];
    const found = keys.find((key) => key.toLowerCase() === name.toLowerCase());
    if (found) return record[found];
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Number(value.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function decodeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function parseXmlAttributes(value: string): UnknownRecord {
  const result: UnknownRecord = {};
  const attributePattern = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = attributePattern.exec(value))) {
    result[match[1]] = decodeXml(match[2] ?? match[3] ?? "");
  }
  return result;
}

function variantFromValue(value: unknown): SalesVariant | undefined {
  const normalized = asString(value)?.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
  if (!normalized) return undefined;
  if (/^(C|COPA|GLASS)(\b|_)/.test(normalized)) return "GLASS";
  if (/^(M|MAGNUM)(\b|_)/.test(normalized)) return "MAGNUM";
  if (/^(B|BOT|BOTELLA|BOTTLE)(\b|_)/.test(normalized)) return "BOTTLE";
  return undefined;
}

function normalizeLine(raw: UnknownRecord, index: number): ProviderSalesLine {
  const providerProductId = asString(getField(raw, "ProductId", "ProviderProductId", "ItemId", "ArticleId")) ?? "0";
  const productName = asString(getField(raw, "ProductName", "Name", "Description", "ItemName")) ?? "";
  const quantity = asNumber(getField(raw, "Quantity", "Qty", "Units", "Amount")) ?? 0;
  const rawLineId = asString(getField(raw, "LineId", "Index", "Id", "Position"));
  const lineId = rawLineId ?? `line_${index}_${fallbackHash({ providerProductId, productName, quantity })}`;
  const saleFormatId = asString(getField(raw, "SaleFormatId", "FormatId", "PriceId"));
  const familyName = asString(getField(raw, "FamilyName", "Family", "CategoryName"));
  const unitPrice = asNumber(getField(raw, "UnitPrice", "Price", "PriceWithTaxes"));
  const totalAmount = asNumber(getField(raw, "TotalAmount", "Total", "AmountWithTaxes"));
  const soldAt = asString(getField(raw, "SoldAt", "Date", "CreatedAt", "UpdatedAt"));
  const suggestedVariant = variantFromValue(
    getField(raw, "Variant", "Format", "FormatName") ?? productName ?? familyName,
  );

  return {
    lineId,
    providerProductId,
    saleFormatId,
    productName,
    familyName,
    quantity,
    unitPrice,
    totalAmount,
    soldAt,
    suggestedVariant,
  };
}

function extractJsonTickets(payload: unknown): UnknownRecord[] {
  if (Array.isArray(payload)) return payload.filter(isRecord);
  if (!isRecord(payload)) return [];

  const direct = getField(payload, "Tickets", "TicketModels", "TicketModel", "Ticket");
  if (Array.isArray(direct)) return direct.filter(isRecord);
  if (isRecord(direct)) return [direct];

  const data = getField(payload, "Data");
  if (data !== undefined) return extractJsonTickets(data);
  return [payload];
}

function extractJsonLines(ticket: UnknownRecord): UnknownRecord[] {
  const direct = getField(ticket, "Lines", "TicketLines", "Items", "Products");
  if (Array.isArray(direct)) return direct.filter(isRecord);
  if (isRecord(direct)) {
    const nested = getField(direct, "Line", "Lines", "Item", "Items");
    if (Array.isArray(nested)) return nested.filter(isRecord);
    if (isRecord(nested)) return [nested];
  }
  return [];
}

function normalizeTicket(ticket: UnknownRecord, index: number, options: OpenTicketParseOptions): ProviderSalesDocument {
  const providerIdentity = asString(getField(
    ticket,
    "GlobalId",
    "TicketGlobalId",
    "TicketId",
    "DocumentId",
    "DocId",
    "Id",
    "Number",
    "Code",
  ));
  const identitySource: SalesIdentitySource = providerIdentity ? "PROVIDER" : "FALLBACK";
  const lifecycleId = providerIdentity ?? `fallback_${index}_${fallbackHash(ticket)}`;
  const businessDay = asString(getField(ticket, "BusinessDay", "BusinessDate", "Date"))?.slice(0, 10) || options.businessDay;
  const observedAt = asString(getField(ticket, "UpdatedAt", "ModifiedAt", "Date")) ?? options.observedAt;
  const lines = extractJsonLines(ticket).map(normalizeLine);

  return {
    provider: options.provider,
    documentId: `open-ticket:${lifecycleId}`,
    lifecycleId,
    identitySource,
    businessDay,
    kind: "OPEN_TICKET",
    isRefund: false,
    observedAt,
    lines,
  };
}

function parseXmlTickets(xml: string): UnknownRecord[] {
  const tickets: UnknownRecord[] = [];
  const ticketPattern = /<(TicketModel|Ticket)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  let ticketMatch: RegExpExecArray | null;
  while ((ticketMatch = ticketPattern.exec(xml))) {
    const ticket = parseXmlAttributes(ticketMatch[2]);
    const lines: UnknownRecord[] = [];
    const linePattern = /<Line\b([^>]*)\/?>(?:[\s\S]*?<\/Line>)?/gi;
    let lineMatch: RegExpExecArray | null;
    while ((lineMatch = linePattern.exec(ticketMatch[3]))) {
      lines.push(parseXmlAttributes(lineMatch[1]));
    }
    ticket.Lines = lines;
    tickets.push(ticket);
  }
  return tickets;
}

export function parseOpenTicketPayload(
  payload: string | unknown,
  options: OpenTicketParseOptions,
): ProviderSalesDocument[] {
  let tickets: UnknownRecord[];
  if (typeof payload === "string") {
    const trimmed = payload.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith("<")) {
      tickets = parseXmlTickets(trimmed);
    } else {
      tickets = extractJsonTickets(JSON.parse(trimmed));
    }
  } else {
    tickets = extractJsonTickets(payload);
  }
  return tickets.map((ticket, index) => normalizeTicket(ticket, index, options));
}

export function countOpenTickets(payload: string | unknown, options: OpenTicketParseOptions): number {
  return parseOpenTicketPayload(payload, options).length;
}
