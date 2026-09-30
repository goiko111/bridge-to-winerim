import { canonicalFormat } from "./engine.ts";
import type { ReconciliationResult } from "./types.ts";

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw | null => v && typeof v === "object" && !Array.isArray(v) ? v as Raw : null;
const str = (v: unknown) => v == null || v === "" ? null : String(v).trim() || null;

const KNOWN_FORMATS = new Set(["botella", "copa", "magnum", "media", "media-botella", "jeroboam", "doble-magnum", "benjamin"]);

/**
 * Ágora sometimes stores the product name in `format` when the product has no
 * explicit format tag (Q Tomas, Triana, Luruna). Only recognised labels are kept;
 * anything else is the product's main sale unit → botella (flagged as inferred).
 */
export function resolveAgoraFormat(value: string | null | undefined): { format: string; inferred: boolean } {
  const c = canonicalFormat(value);
  if (KNOWN_FORMATS.has(c)) return { format: c, inferred: false };
  if (c === "mag") return { format: "magnum", inferred: false };
  return { format: "botella", inferred: true };
}

export type AgoraEventLike = { provider_doc_id: string; doc_type: string; raw_json: unknown };
export type AgoraLineLike = { provider_product_id: string | null; provider_sold_at?: string | null; quantity: number; sales_event: AgoraEventLike };

export const isOpenTicketDoc = (docType: string) => /open|ticket|draft|order/i.test(docType) && !/invoice|refund/i.test(docType);

/** GlobalIds of the tickets that were closed into an invoice/refund (InvoiceItems[].GlobalId). */
export function closedTicketGlobalIds(events: AgoraEventLike[]): Set<string> {
  const ids = new Set<string>();
  for (const e of events) {
    if (isOpenTicketDoc(e.doc_type)) continue;
    const raw = obj(e.raw_json); if (!raw) continue;
    const items = Array.isArray(raw.InvoiceItems) ? raw.InvoiceItems : Array.isArray(raw.invoiceItems) ? raw.invoiceItems : [];
    for (const it of items) { const g = str(obj(it)?.GlobalId ?? obj(it)?.globalId); if (g) ids.add(g); }
    const own = str(raw.GlobalId ?? raw.globalId); if (own) ids.add(own);
  }
  return ids;
}

const openGlobalId = (e: AgoraEventLike) => str(obj(e.raw_json)?.GlobalId ?? obj(e.raw_json)?.globalId) ??
  (e.provider_doc_id.startsWith("open_ticket:") ? e.provider_doc_id.slice("open_ticket:".length) : null);

/**
 * One version per ticket: an OPEN snapshot line is superseded when its ticket
 * GlobalId was closed into an invoice (Ágora's own link). Without that link, fall
 * back to an exact closed line with the same product, sold-at and quantity
 * (multiset: each closed line absorbs at most one open line).
 */
export function supersededOpenLines<T extends AgoraLineLike>(lines: T[], closedIds: Set<string>): { kept: T[]; superseded: T[]; byLink: number; byFallback: number } {
  const closedSig = new Map<string, number>();
  const sig = (l: AgoraLineLike) => `${l.provider_product_id ?? ""}|${l.provider_sold_at ?? ""}|${Number(l.quantity)}`;
  for (const l of lines) if (!isOpenTicketDoc(l.sales_event.doc_type) && l.provider_sold_at) closedSig.set(sig(l), (closedSig.get(sig(l)) ?? 0) + 1);
  const kept: T[] = []; const superseded: T[] = []; let byLink = 0; let byFallback = 0;
  for (const l of lines) {
    if (!isOpenTicketDoc(l.sales_event.doc_type)) { kept.push(l); continue; }
    const gid = openGlobalId(l.sales_event);
    if (gid && closedIds.has(gid)) { superseded.push(l); byLink++; continue; }
    const s = sig(l); const n = closedSig.get(s) ?? 0;
    if (l.provider_sold_at && n > 0) { closedSig.set(s, n - 1); superseded.push(l); byFallback++; continue; }
    kept.push(l);
  }
  return { kept, superseded, byLink, byFallback };
}

export type WineFormatGroup = {
  businessDay: string; wineId: string; format: string;
  agoraName: string | null; winerimName: string | null;
  closedQty: number; openQty: number; winerimQty: number;
  expectedQty: number; diff: number;
  state: "MATCHED" | "SHORT_IN_WINERIM" | "EXCESS_IN_WINERIM" | "SOURCE_INCOMPLETE";
  lines: number;
};

type ResultLike = Pick<ReconciliationResult, "businessDay" | "state"> & { agora: Raw | null; winerim: Raw | null };

/**
 * Day comparison by (day, Winerim wine, format) summing units, not sales. Line
 * matching stays only as explanation. OPEN lines not superseded count as sales (openQty column, included in expectedQty).
 */
export function aggregateByWineFormat(results: ResultLike[], sourceComplete = true): { groups: WineFormatGroup[]; summary: { groups: number; matchedGroups: number; closedQty: number; openQty: number; winerimQty: number; absDiff: number; unitMatchPct: number; complete: boolean; fullMatch: boolean } } {
  const map = new Map<string, WineFormatGroup>(); let complete = sourceComplete;
  const q = (v: unknown) => Number(v ?? 0) || 0;
  for (const r of results) {
    if (r.state === "SOURCE_INCOMPLETE") complete = false;
    const a = r.agora; const w = r.winerim;
    const touch = (wineId: string, format: string) => {
      const key = `${r.businessDay}|${wineId}|${format}`;
      let g = map.get(key);
      if (!g) { g = { businessDay: r.businessDay, wineId, format, agoraName: null, winerimName: null, closedQty: 0, openQty: 0, winerimQty: 0, expectedQty: 0, diff: 0, state: "MATCHED", lines: 0 }; map.set(key, g); }
      g.lines++; return g;
    };
    if (a && str(a.wineId)) {
      const g = touch(String(a.wineId), resolveAgoraFormat(str(a.format)).format);
      g.agoraName ??= str(a.wineName);
      const qty = q(a.quantity) * (a.isCancelled && q(a.quantity) > 0 ? -1 : 1);
      if (a.isOpen) g.openQty += qty; else g.closedQty += qty;
    }
    if (w && str(w.wineId) && w.saleStatus !== "rejected" && r.state !== "DELETED_OR_CANCELLED") {
      const g = touch(String(w.wineId), canonicalFormat(str(w.format)) || "botella");
      g.winerimName ??= str(w.wineName);
      g.winerimQty += q(w.quantity);
    }
  }
  const groups = [...map.values()].map((g) => {
    // User GO 2026-09-30: an OPEN ticket counts as a sale. Expected = closed docs (invoices − refunds) + un-superseded OPEN lines (own column).
    const expectedQty = round(g.closedQty + g.openQty); const diff = round(g.winerimQty - expectedQty);
    const state: WineFormatGroup["state"] = !complete ? "SOURCE_INCOMPLETE" : Math.abs(diff) < 1e-9 ? "MATCHED" : diff < 0 ? "SHORT_IN_WINERIM" : "EXCESS_IN_WINERIM";
    return { ...g, closedQty: round(g.closedQty), openQty: round(g.openQty), winerimQty: round(g.winerimQty), expectedQty, diff, state };
  }).sort((x, y) => x.businessDay.localeCompare(y.businessDay) || Math.abs(y.diff) - Math.abs(x.diff) || x.wineId.localeCompare(y.wineId));
  const closedQty = round(groups.reduce((s, g) => s + g.closedQty, 0)); const openQty = round(groups.reduce((s, g) => s + g.openQty, 0));
  const winerimQty = round(groups.reduce((s, g) => s + g.winerimQty, 0)); const absDiff = round(groups.reduce((s, g) => s + Math.abs(g.diff), 0));
  const expected = round(closedQty + openQty); const matchedGroups = groups.filter((g) => g.state === "MATCHED").length;
  const unitMatchPct = expected > 0 ? Math.max(0, Math.round((1 - absDiff / Math.max(expected, winerimQty)) * 1000) / 10) : winerimQty === 0 ? 100 : 0;
  return { groups, summary: { groups: groups.length, matchedGroups, closedQty, openQty, winerimQty, absDiff, unitMatchPct, complete, fullMatch: complete && matchedGroups === groups.length } };
}

const round = (n: number) => Math.round(n * 1000) / 1000;
