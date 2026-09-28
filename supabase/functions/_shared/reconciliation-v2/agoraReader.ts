import type { AgoraLine } from "./types.ts";

type RawRow = Record<string, unknown>;

const object = (value: unknown): RawRow | null => value && typeof value === "object" && !Array.isArray(value) ? value as RawRow : null;
const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;
const number = (value: unknown) => value == null || value === "" || Number.isNaN(Number(value)) ? null : Number(value);

export type AgoraDbLine = {
  id: string;
  connection_id: string;
  provider_product_id: string | null;
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

/** Extract only identities actually present in provider evidence; never use local row ids as TPV identities. */
export function toAgoraLine(row: AgoraDbLine, restaurantId: number): AgoraLine | null {
  const raw = object(row.sales_event.raw_json);
  const rawLine = object(raw?.line) ?? object(raw?.saleLine) ?? object(raw?.item);
  const sourceSystem = text(raw?.sourceSystem) ?? text(raw?.provider) ?? "AGORA";
  const externalOrderId = text(rawLine?.externalOrderId) ?? text(raw?.externalOrderId) ?? text(raw?.orderId);
  const sourceLineId = text(rawLine?.sourceLineId) ?? text(rawLine?.lineId) ?? text(rawLine?.id);
  const effectiveAt = text(rawLine?.effectiveAt) ?? text(rawLine?.createdAt) ?? text(raw?.effectiveAt) ?? text(raw?.createdAt);
  if (!externalOrderId || !sourceLineId || !effectiveAt || !row.winerim_product_id || !row.mapped) return null;
  const amount = row.total_amount == null ? null : Math.round(Number(row.total_amount) * 100);
  return {
    connectionId: row.connection_id,
    restaurantId,
    businessDay: row.sales_event.business_day,
    documentId: row.sales_event.provider_doc_id,
    sourceSystem,
    externalOrderId,
    orderId: text(raw?.orderId),
    sourceLineId,
    wineId: row.winerim_product_id,
    wineName: row.name ?? null,
    family: row.family ?? null,
    providerProductId: row.provider_product_id,
    format: row.format,
    quantity: Number(row.quantity),
    amountMinor: amount,
    effectiveAt,
    isOpen: row.sales_event.doc_type.toLowerCase().includes("open"),
    isCancelled: row.sales_event.doc_type.toLowerCase().includes("refund") || Boolean(raw?.cancelled),
  };
}

export function unresolvedAgoraEvidence(row: AgoraDbLine): string[] {
  const raw = object(row.sales_event.raw_json);
  const rawLine = object(raw?.line) ?? object(raw?.saleLine) ?? object(raw?.item);
  const missing: string[] = [];
  if (!(text(rawLine?.externalOrderId) ?? text(raw?.externalOrderId) ?? text(raw?.orderId))) missing.push("externalOrderId");
  if (!(text(rawLine?.sourceLineId) ?? text(rawLine?.lineId) ?? text(rawLine?.id))) missing.push("sourceLineId");
  if (!(text(rawLine?.effectiveAt) ?? text(rawLine?.createdAt) ?? text(raw?.effectiveAt) ?? text(raw?.createdAt))) missing.push("effectiveAt");
  if (!row.winerim_product_id || !row.mapped) missing.push("winerimProductId");
  if (number(row.quantity) == null) missing.push("quantity");
  return missing;
}
