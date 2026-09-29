import type { AgoraLine } from "./types.ts";

type RawRow = Record<string, unknown>;

const object = (value: unknown): RawRow | null => value && typeof value === "object" && !Array.isArray(value) ? value as RawRow : null;
const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;
const number = (value: unknown) => value == null || value === "" || Number.isNaN(Number(value)) ? null : Number(value);
const normalizedText = (value: unknown) => String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase().replace(/\s+/g, " ");
const normalizedNumber = (value: unknown) => { const parsed = number(value); return parsed == null ? null : Math.round(parsed * 1_000_000) / 1_000_000; };
const normalizedTime = (value: unknown) => { const valueText = text(value); if (!valueText) return null; const epoch = Date.parse(valueText); return Number.isNaN(epoch) ? valueText : new Date(epoch).toISOString(); };

export type AgoraDbLine = {
  id: string;
  connection_id: string;
  provider_product_id: string | null;
  provider_sold_at?: string | null;
  format: string | null;
  quantity: number;
  total_amount: number | null;
  winerim_product_id: string | null;
  mapped: boolean;
  is_wine_candidate?: boolean;
  family?: string | null;
  name?: string | null;
  sales_event: {
    provider_doc_id: string;
    business_day: string;
    doc_type: string;
    raw_json: unknown;
  };
};

export type ProviderProductClassification = {
  provider_product_id: string;
  is_wine_candidate?: boolean | null;
  classification_override?: string | null;
  winerim_wine_id?: string | null;
};

export type WineCandidateClassification = "WINE" | "NOT_WINE" | "UNKNOWN";

/**
 * Classify against the current provider catalogue, not the historical flag copied
 * into a sales line. Explicit mappings remain authoritative. A stale positive flag
 * without a current catalogue row is UNKNOWN and must fail closed upstream.
 */
export function classifyWineCandidate(
  row: AgoraDbLine,
  product: ProviderProductClassification | null,
): WineCandidateClassification {
  if (row.mapped === true && Boolean(row.winerim_product_id)) return "WINE";
  if (!product) return row.is_wine_candidate === true ? "UNKNOWN" : "NOT_WINE";
  const override = normalizedText(product.classification_override).replace(/[\s-]+/g, "_");
  if (override === "not_wine") return "NOT_WINE";
  if (override === "wine") return "WINE";
  return product.is_wine_candidate === true || Boolean(product.winerim_wine_id) ? "WINE" : "NOT_WINE";
}

export type AgoraIdentityResolution = { line: AgoraLine | null; missing: string[]; rawLine: RawRow | null };

type RawLineCandidate = { line: RawRow; container: RawRow; containerIndex: number | null };

const field = (row: RawRow | null, camel: string, pascal: string) => row?.[camel] ?? row?.[pascal];
const identifier = (value: unknown) => value == null || value === "" ? null : String(value).trim() || null;

function candidateLines(container: RawRow, containerIndex: number | null): RawLineCandidate[] {
  const values = Array.isArray(container.lines) ? container.lines : Array.isArray(container.Lines) ? container.Lines : [];
  return values.map(object).filter((line): line is RawRow => Boolean(line)).map((line) => ({ line, container, containerIndex }));
}

function rawLines(raw: RawRow | null): RawLineCandidate[] {
  if (!raw) return [];
  const direct = candidateLines(raw, null);
  const invoiceItems = (Array.isArray(raw.invoiceItems) ? raw.invoiceItems : Array.isArray(raw.InvoiceItems) ? raw.InvoiceItems : [])
    .map(object).filter((item): item is RawRow => Boolean(item));
  return [...direct, ...invoiceItems.flatMap((item, index) => candidateLines(item, index))];
}

// Per-event index: raw_json lines are flattened and bucketed once per sales event by the
// strict part of the signature (productId|quantity|soldAt). signatureMatches still runs on
// the bucket, so the matched set is identical to the previous full scan (order preserved).
type RawIndex = { all: RawLineCandidate[]; buckets: Map<string, RawLineCandidate[]> };
const rawIndexCache = new WeakMap<object, RawIndex>();
const strictKey = (productId: unknown, quantity: unknown, soldAt: unknown) => `${identifier(productId) ?? ""}\u0001${normalizedNumber(quantity) ?? ""}\u0001${normalizedTime(soldAt) ?? ""}`;
function rawIndex(raw: RawRow | null): RawIndex {
  if (!raw) return { all: [], buckets: new Map() };
  const cached = rawIndexCache.get(raw); if (cached) return cached;
  const all = rawLines(raw); const buckets = new Map<string, RawLineCandidate[]>();
  for (const candidate of all) {
    const key = strictKey(field(candidate.line, "providerProductId", "ProductId"), field(candidate.line, "quantity", "Quantity"), field(candidate.line, "soldAt", "CreationDate"));
    const bucket = buckets.get(key); if (bucket) bucket.push(candidate); else buckets.set(key, [candidate]);
  }
  const index = { all, buckets }; rawIndexCache.set(raw, index); return index;
}
const matchCache = new WeakMap<object, RawLineCandidate[]>();
/** Candidates whose full signature matches the DB line; memoised per row object. */
export function matchingRawLines(row: AgoraDbLine): RawLineCandidate[] {
  const cached = matchCache.get(row); if (cached) return cached;
  const index = rawIndex(object(row.sales_event.raw_json));
  const bucket = index.buckets.get(strictKey(row.provider_product_id, row.quantity, row.provider_sold_at)) ?? [];
  const matches = bucket.filter((candidate) => signatureMatches(row, candidate)); matchCache.set(row, matches); return matches;
}
export function rawLineCount(row: AgoraDbLine): number { return rawIndex(object(row.sales_event.raw_json)).all.length; }

function signatureMatches(row: AgoraDbLine, candidate: RawLineCandidate): boolean {
  const line = candidate.line;
  if (identifier(field(line, "providerProductId", "ProductId")) !== identifier(row.provider_product_id)) return false;
  if (normalizedNumber(field(line, "quantity", "Quantity")) !== normalizedNumber(row.quantity)) return false;
  const rowAmount = normalizedNumber(row.total_amount); const quantity = normalizedNumber(field(line, "quantity", "Quantity"));
  const amounts = [field(line, "totalAmount", "TotalAmount"), field(line, "unitPrice", "UnitPrice"), field(line, "productPrice", "ProductPrice")]
    .map((value, index) => index === 0 ? normalizedNumber(value) : quantity == null || normalizedNumber(value) == null ? null : normalizedNumber(Number(value) * quantity))
    .filter((value): value is number => value != null);
  if (rowAmount == null || !amounts.includes(rowAmount)) return false;
  if (normalizedTime(field(line, "soldAt", "CreationDate")) !== normalizedTime(row.provider_sold_at)) return false;
  const sourceName = normalizedText(field(line, "productName", "ProductName")); const rowName = normalizedText(row.name);
  return !sourceName || !rowName || sourceName === rowName;
}

function providerLineId(candidate: RawLineCandidate, raw: RawRow | null): string | null {
  const explicit = identifier(field(candidate.line, "lineId", "LineId"));
  if (explicit) return explicit;
  const globalId = identifier(field(candidate.container, "globalId", "GlobalId")) ?? identifier(field(raw, "globalId", "GlobalId"));
  const index = identifier(field(candidate.line, "index", "Index"));
  return globalId && index != null ? `${globalId}:${index}` : null;
}

function providerAmount(candidate: RawLineCandidate): number | null {
  return number(field(candidate.line, "totalAmount", "TotalAmount"));
}

/** Resolve only immutable identities from raw_json.lines[]; never promote local UUIDs to TPV identities. */
export function resolveAgoraIdentity(row: AgoraDbLine, restaurantId: number): AgoraIdentityResolution {
  const raw = object(row.sales_event.raw_json);
  const candidates = matchingRawLines(row);
  const missing: string[] = [];
  if (!rawLineCount(row)) missing.push("RAW_LINES_MISSING");
  else if (!candidates.length) missing.push("RAW_LINE_NOT_FOUND");
  else if (candidates.length > 1) missing.push("RAW_LINE_AMBIGUOUS");
  const rawCandidate = candidates.length === 1 ? candidates[0] : null;
  const rawLine = rawCandidate?.line ?? null;
  const sourceSystem = text(field(raw, "provider", "Provider")) ?? "AGORA";
  const containerGlobalId = rawCandidate ? identifier(field(rawCandidate.container, "globalId", "GlobalId")) : null;
  const externalOrderId = text(raw?.lifecycleId) ?? text(raw?.documentId) ?? containerGlobalId ?? identifier(field(raw, "globalId", "GlobalId")) ?? text(row.sales_event.provider_doc_id);
  const orderId = text(raw?.documentId) ?? identifier(field(raw, "number", "Number")) ?? text(row.sales_event.provider_doc_id);
  const sourceLineId = rawCandidate ? providerLineId(rawCandidate, raw) : null; const effectiveAt = text(field(rawLine, "soldAt", "CreationDate"));
  if (!externalOrderId) missing.push("EXTERNAL_ORDER_ID");
  if (!sourceLineId) missing.push("SOURCE_LINE_ID");
  if (!effectiveAt) missing.push("EFFECTIVE_AT");
  if (!row.winerim_product_id || !row.mapped) missing.push("WINERIM_PRODUCT_ID");
  if (number(row.quantity) == null) missing.push("QUANTITY");
  if (missing.length || !rawLine || !externalOrderId || !sourceLineId || !effectiveAt || !row.winerim_product_id) return { line: null, missing: [...new Set(missing)], rawLine };
  const netAmount = providerAmount(rawCandidate!);
  const rawKind = `${text(raw?.kind) ?? ""} ${row.sales_event.doc_type}`.toLowerCase();
  return { missing: [], rawLine, line: {
    connectionId: row.connection_id,
    restaurantId,
    businessDay: row.sales_event.business_day,
    documentId: orderId ?? row.sales_event.provider_doc_id,
    sourceSystem,
    externalOrderId,
    orderId,
    sourceLineId,
    wineId: row.winerim_product_id,
    wineName: row.name ?? text(field(rawLine, "productName", "ProductName")),
    family: row.family ?? text(field(rawLine, "familyName", "FamilyName")),
    providerProductId: row.provider_product_id,
    format: row.format,
    quantity: Number(row.quantity),
    amountMinor: netAmount == null ? row.total_amount == null ? null : Math.round(Number(row.total_amount) * 100) : Math.round(netAmount * 100),
    effectiveAt,
    isOpen: /open|draft|ticket|order/.test(rawKind) && !/invoice|refund/.test(rawKind),
    isCancelled: Boolean(raw?.isRefund) || /refund|void|cancelled|canceled/.test(rawKind),
  } };
}

export function toAgoraLine(row: AgoraDbLine, restaurantId: number): AgoraLine | null {
  return resolveAgoraIdentity(row, restaurantId).line;
}

export function unresolvedAgoraEvidence(row: AgoraDbLine): string[] {
  return resolveAgoraIdentity(row, 0).missing;
}

/** Stable provider identity for analytics, including non-wine/unmapped lines. */
export function agoraProviderIdentity(row: AgoraDbLine): string | null {
  const raw = object(row.sales_event.raw_json); const matches = matchingRawLines(row);
  if (matches.length !== 1) return null;
  const candidate = matches[0]; const rawLine = candidate.line;
  const order = text(raw?.lifecycleId) ?? text(raw?.documentId) ?? identifier(field(candidate.container, "globalId", "GlobalId")) ?? identifier(field(raw, "globalId", "GlobalId")) ?? identifier(field(raw, "number", "Number")) ?? text(row.sales_event.provider_doc_id);
  const lineId = providerLineId(candidate, raw); const effectiveAt = text(field(rawLine, "soldAt", "CreationDate"));
  if (!order || !lineId || !effectiveAt || !row.provider_product_id) return null;
  const polarity = Boolean(raw?.isRefund) || /refund/i.test(`${raw?.kind ?? ""} ${row.sales_event.doc_type}`) ? "REFUND" : "SALE";
  return [polarity, order, lineId, row.provider_product_id, row.format ?? "", row.quantity, providerAmount(candidate) ?? row.total_amount ?? "", effectiveAt].join("|");
}

/** Net amount reported by Ágora for the uniquely matched provider line. */
export function agoraProviderAmount(row: AgoraDbLine): number | null {
  const matches = matchingRawLines(row);
  return matches.length === 1 ? providerAmount(matches[0]) ?? number(row.total_amount) : null;
}

export function classifyAgoraCoverage(input: { eventCount: number; lineCount: number; pageComplete: boolean; unresolvedCount: number }) {
  const reasons: string[] = [];
  if (!input.pageComplete) reasons.push("AGORA_PAGINATION_INCOMPLETE");
  if (input.eventCount === 0) reasons.push("AGORA_NO_EVENTS_FOR_BUSINESS_DAY");
  else if (input.lineCount === 0) reasons.push("AGORA_EVENTS_WITHOUT_LINES");
  if (input.unresolvedCount > 0) reasons.push("AGORA_IDENTITY_UNRESOLVED");
  return { complete: reasons.length === 0, reasons };
}

/**
 * Two explicit coverages. wineReconciliationCoverage gates the wine reconciliation:
 * only WINE lines without identity, UNKNOWN classifications and WINE without mapping
 * block it. analyticsCoverage measures every source line (identity + amount) and is
 * never relaxed by classification. No payloads: counts and product id/name only.
 */
export function splitSourceCoverage(input: {
  eventCount: number; pageComplete: boolean;
  classified: { row: AgoraDbLine; classification: WineCandidateClassification }[];
  hasProviderIdentity: (row: AgoraDbLine) => boolean;
  hasAmount: (row: AgoraDbLine) => boolean;
  unresolvedMappedWine: number; unmappedWine: number;
}) {
  const noId = input.classified.filter((c) => !input.hasProviderIdentity(c.row));
  const unresolvedWineLines = noId.filter((c) => c.classification === "WINE").length + input.unresolvedMappedWine;
  const unresolvedNonWineLines = noId.filter((c) => c.classification === "NOT_WINE").length;
  const unresolvedUnknownLines = noId.filter((c) => c.classification === "UNKNOWN").length;
  const unknown = input.classified.filter((c) => c.classification === "UNKNOWN");
  const groups = new Map<string, { providerProductId: string | null; name: string | null; count: number }>();
  for (const c of unknown) {
    const id = c.row.provider_product_id ? String(c.row.provider_product_id) : null;
    const name = (c.row as Record<string, unknown>).product_name == null ? null : String((c.row as Record<string, unknown>).product_name);
    const key = `${id}|${name}`; const g = groups.get(key) ?? { providerProductId: id, name, count: 0 }; g.count++; groups.set(key, g);
  }
  const unknownProducts = [...groups.values()].sort((a, b) => b.count - a.count || String(a.providerProductId).localeCompare(String(b.providerProductId)));
  const wine = classifyAgoraCoverage({ eventCount: input.eventCount, lineCount: input.classified.length, pageComplete: input.pageComplete, unresolvedCount: unresolvedWineLines + unresolvedUnknownLines });
  if (unknown.length) { wine.complete = false; wine.reasons.push("AGORA_WINE_CLASSIFICATION_INCOMPLETE"); }
  if (input.unmappedWine) { wine.complete = false; wine.reasons.push("AGORA_WINE_MAPPING_INCOMPLETE"); }
  const missingAmountLines = input.classified.filter((c) => !input.hasAmount(c.row)).length;
  const analytics = classifyAgoraCoverage({ eventCount: input.eventCount, lineCount: input.classified.length, pageComplete: input.pageComplete, unresolvedCount: noId.length });
  if (missingAmountLines) { analytics.complete = false; analytics.reasons.push("AGORA_AMOUNT_MISSING"); }
  return {
    wineReconciliationCoverage: wine,
    analyticsCoverage: { ...analytics, lines: input.classified.length, missingIdentityLines: noId.length, missingAmountLines },
    metrics: { unresolvedAllLines: noId.length + input.unresolvedMappedWine, unresolvedWineLines, unresolvedNonWineLines, unresolvedUnknownLines, unknownClassificationLines: unknown.length, unknownProducts },
  };
}
