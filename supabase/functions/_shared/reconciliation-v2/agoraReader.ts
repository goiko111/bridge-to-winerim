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

export type AgoraIdentityResolution = { line: AgoraLine | null; missing: string[]; rawLine: RawRow | null };

function rawLines(raw: RawRow | null): RawRow[] {
  return Array.isArray(raw?.lines) ? raw.lines.map(object).filter((line): line is RawRow => Boolean(line)) : [];
}

function signatureMatches(row: AgoraDbLine, candidate: RawRow): boolean {
  if (text(candidate.providerProductId) !== text(row.provider_product_id)) return false;
  if (normalizedNumber(candidate.quantity) !== normalizedNumber(row.quantity)) return false;
  if (normalizedNumber(candidate.totalAmount) !== normalizedNumber(row.total_amount)) return false;
  if (normalizedTime(candidate.soldAt) !== normalizedTime(row.provider_sold_at)) return false;
  const sourceName = normalizedText(candidate.productName); const rowName = normalizedText(row.name);
  return !sourceName || !rowName || sourceName === rowName;
}

/** Resolve only immutable identities from raw_json.lines[]; never promote local UUIDs to TPV identities. */
export function resolveAgoraIdentity(row: AgoraDbLine, restaurantId: number): AgoraIdentityResolution {
  const raw = object(row.sales_event.raw_json);
  const allRawLines = rawLines(raw); const candidates = allRawLines.filter((candidate) => signatureMatches(row, candidate));
  const missing: string[] = [];
  if (!allRawLines.length) missing.push("RAW_LINES_MISSING");
  else if (!candidates.length) missing.push("RAW_LINE_NOT_FOUND");
  else if (candidates.length > 1) missing.push("RAW_LINE_AMBIGUOUS");
  const rawLine = candidates.length === 1 ? candidates[0] : null;
  const sourceSystem = text(raw?.provider) ?? "AGORA";
  const externalOrderId = text(raw?.lifecycleId) ?? text(raw?.documentId) ?? text(row.sales_event.provider_doc_id);
  const orderId = text(raw?.documentId) ?? text(row.sales_event.provider_doc_id);
  const sourceLineId = text(rawLine?.lineId); const effectiveAt = text(rawLine?.soldAt);
  if (!externalOrderId) missing.push("EXTERNAL_ORDER_ID");
  if (!sourceLineId) missing.push("SOURCE_LINE_ID");
  if (!effectiveAt) missing.push("EFFECTIVE_AT");
  if (!row.winerim_product_id || !row.mapped) missing.push("WINERIM_PRODUCT_ID");
  if (number(row.quantity) == null) missing.push("QUANTITY");
  if (missing.length || !rawLine || !externalOrderId || !sourceLineId || !effectiveAt || !row.winerim_product_id) return { line: null, missing: [...new Set(missing)], rawLine };
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
    wineName: row.name ?? text(rawLine.productName),
    family: row.family ?? text(rawLine.familyName),
    providerProductId: row.provider_product_id,
    format: row.format,
    quantity: Number(row.quantity),
    amountMinor: row.total_amount == null ? null : Math.round(Number(row.total_amount) * 100),
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
  const raw = object(row.sales_event.raw_json); const matches = rawLines(raw).filter((candidate) => signatureMatches(row, candidate));
  if (matches.length !== 1) return null;
  const rawLine = matches[0]; const order = text(raw?.lifecycleId) ?? text(raw?.documentId) ?? text(row.sales_event.provider_doc_id);
  const lineId = text(rawLine.lineId); const effectiveAt = text(rawLine.soldAt);
  if (!order || !lineId || !effectiveAt || !row.provider_product_id) return null;
  const polarity = Boolean(raw?.isRefund) || /refund/i.test(`${raw?.kind ?? ""} ${row.sales_event.doc_type}`) ? "REFUND" : "SALE";
  return [polarity, order, lineId, row.provider_product_id, row.format ?? "", row.quantity, row.total_amount ?? "", effectiveAt].join("|");
}

export function classifyAgoraCoverage(input: { eventCount: number; lineCount: number; pageComplete: boolean; unresolvedCount: number }) {
  const reasons: string[] = [];
  if (!input.pageComplete) reasons.push("AGORA_PAGINATION_INCOMPLETE");
  if (input.eventCount === 0) reasons.push("AGORA_NO_EVENTS_FOR_BUSINESS_DAY");
  else if (input.lineCount === 0) reasons.push("AGORA_EVENTS_WITHOUT_LINES");
  if (input.unresolvedCount > 0) reasons.push("AGORA_IDENTITY_UNRESOLVED");
  return { complete: reasons.length === 0, reasons };
}
