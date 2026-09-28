// Agora ticket lifecycle: reopen / payment-change / refund handling.
//
// Root cause this module fixes (Don Quijote Marbella, 25/09/2026):
// a table closed as invoice T 42530, reopened via refund TD 742
// (RefundSource="Reopen", RelatedInvoice={Serie:T,Number:42530}) and closed
// again as T 42531. The refund is correctly not stock-eligible, but both
// invoices stayed "definitive", so the day target for the wine became 2 and a
// second sale was imported. A reopen refund that exactly negates its related
// invoice means that invoice was SUPERSEDED: it must leave the desired set.
//
// Pure functions only. No I/O, no Winerim writes.

type Json = Record<string, unknown>;

export type LifecycleEvent = {
  id: string;
  doc_type?: string | null;
  provider_doc_id?: string | null;
  raw_json?: unknown;
};

export type RefundClassification =
  | { kind: "REOPEN_SUPERSEDES"; refundEventId: string; supersededEventId: string }
  | { kind: "REVERSAL_PENDING"; refundEventId: string; relatedEventId: string; reason: string }
  | { kind: "AMBIGUOUS"; refundEventId: string; relatedEventId: string | null; reason: string };

function obj(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}

function str(value: unknown): string {
  return String(value ?? "").trim();
}

export function isRefundEvent(event: LifecycleEvent): boolean {
  const raw = obj(event.raw_json);
  return raw._agora_refund === true || /refund/i.test(str(event.doc_type));
}

function invoiceKey(serie: unknown, number: unknown): string {
  const s = str(serie).toUpperCase();
  const n = str(number);
  return s && n ? `${s}#${n}` : "";
}

/** Stable per-line fingerprint used ONLY to prove a refund negates an invoice. */
export function lineFingerprint(line: Json): string {
  return [
    str(line.ProductId),
    str(line.SaleFormatId),
    str(line.Index),
    str(line.CreationDate),
    Number(line.UnitPrice ?? 0).toFixed(2),
  ].join("|");
}

function linesOf(raw: Json): Json[] {
  const out: Json[] = [];
  const items = Array.isArray(raw.InvoiceItems) ? raw.InvoiceItems : [];
  for (const item of items) {
    const lines = Array.isArray(obj(item).Lines) ? obj(item).Lines as unknown[] : [];
    for (const line of lines) out.push(obj(line));
  }
  return out;
}

function quantityByFingerprint(raw: Json, sign: 1 | -1): Map<string, number> | null {
  const map = new Map<string, number>();
  for (const line of linesOf(raw)) {
    const fp = lineFingerprint(line);
    if (!str(line.CreationDate)) return null; // no stable identity → cannot prove
    const qty = Number(line.Quantity ?? 0) * sign;
    map.set(fp, (map.get(fp) || 0) + qty);
  }
  return map;
}

/** True when refund lines are the exact negation of the invoice lines (line by line). */
export function refundExactlyNegatesInvoice(refundRaw: Json, invoiceRaw: Json): boolean {
  const refund = quantityByFingerprint(refundRaw, -1);
  const invoice = quantityByFingerprint(invoiceRaw, 1);
  if (!refund || !invoice || invoice.size === 0 || refund.size !== invoice.size) return false;
  for (const [fp, qty] of invoice) {
    if (Math.abs((refund.get(fp) ?? NaN) - qty) > 1e-9) return false;
  }
  return true;
}

export function classifyAgoraRefunds(events: LifecycleEvent[]): RefundClassification[] {
  const invoicesByKey = new Map<string, LifecycleEvent[]>();
  for (const event of events) {
    if (isRefundEvent(event)) continue;
    const raw = obj(event.raw_json);
    const key = invoiceKey(raw.Serie, raw.Number);
    if (!key) continue;
    const list = invoicesByKey.get(key) || [];
    list.push(event);
    invoicesByKey.set(key, list);
  }

  const out: RefundClassification[] = [];
  for (const refund of events) {
    if (!isRefundEvent(refund)) continue;
    const raw = obj(refund.raw_json);
    const related = obj(raw.RelatedInvoice);
    const key = invoiceKey(related.Serie, related.Number);
    const matches = key ? invoicesByKey.get(key) || [] : [];
    if (matches.length !== 1) {
      out.push({
        kind: "AMBIGUOUS",
        refundEventId: refund.id,
        relatedEventId: null,
        reason: key ? `related_invoice_matches_${matches.length}` : "no_related_invoice",
      });
      continue;
    }
    const invoice = matches[0];
    const isReopen = str(raw.RefundSource).toLowerCase() === "reopen";
    const exact = refundExactlyNegatesInvoice(raw, obj(invoice.raw_json));
    if (isReopen && exact) {
      out.push({ kind: "REOPEN_SUPERSEDES", refundEventId: refund.id, supersededEventId: invoice.id });
    } else if (isReopen) {
      out.push({ kind: "AMBIGUOUS", refundEventId: refund.id, relatedEventId: invoice.id, reason: "reopen_refund_not_exact_negation" });
    } else {
      out.push({
        kind: "REVERSAL_PENDING",
        refundEventId: refund.id,
        relatedEventId: invoice.id,
        reason: exact ? "full_cancellation" : "partial_refund",
      });
    }
  }
  return out;
}

/** Event ids that must not contribute to the desired stock state. */
export function reopenSupersededEventIds(events: LifecycleEvent[]): Set<string> {
  return new Set(
    classifyAgoraRefunds(events)
      .filter((c): c is Extract<RefundClassification, { kind: "REOPEN_SUPERSEDES" }> => c.kind === "REOPEN_SUPERSEDES")
      .map((c) => c.supersededEventId),
  );
}

export function excludeReopenSupersededEvents<T extends LifecycleEvent>(eligible: T[], allDayEvents: LifecycleEvent[]): T[] {
  const superseded = reopenSupersededEventIds(allDayEvents);
  return superseded.size ? eligible.filter((e) => !superseded.has(e.id)) : eligible;
}

// ── Canonical line identity & per-line deltas ──────────────────────────

export type CanonicalLine = {
  restaurantId: string;
  agoraTicketId: string | null;
  sourceLineId: string | null;
  format: string;
  observedQty: number;
};

export function canonicalLineKey(line: CanonicalLine): string | null {
  if (!str(line.restaurantId) || !str(line.agoraTicketId) || !str(line.sourceLineId) || !str(line.format)) return null;
  return [line.restaurantId, line.agoraTicketId, line.sourceLineId, line.format.toUpperCase()].join(":");
}

export type LineAction =
  | { kind: "APPLY"; key: string; deltaQty: number; orderId: string }
  | { kind: "NOOP"; key: string }
  | { kind: "REVERSAL_PENDING"; key: string; reverseQty: number }
  | { kind: "AMBIGUOUS"; reason: string };

/**
 * Decide what to do with one line given the qty already applied in Winerim.
 * Increments get a deterministic orderId per cumulative target, so re-reading
 * the same ticket never re-applies. Decreases never write: they queue a reversal.
 */
export function planLineAction(line: CanonicalLine, appliedQty: number): LineAction {
  const key = canonicalLineKey(line);
  if (!key) return { kind: "AMBIGUOUS", reason: "unstable_line_identity" };
  const observed = Math.max(0, Math.trunc(Number(line.observedQty) || 0));
  const applied = Math.max(0, Math.trunc(Number(appliedQty) || 0));
  if (observed > applied) {
    return { kind: "APPLY", key, deltaQty: observed - applied, orderId: `agora:${key}:upto:${observed}` };
  }
  if (observed < applied) return { kind: "REVERSAL_PENDING", key, reverseQty: applied - observed };
  return { kind: "NOOP", key };
}

// ── Future certified reversal endpoint (disabled) ──────────────────────

export type ReversalRequest = {
  receiptId: string | null;
  orderId: string | null;
  qty: number;
  effects: { history: boolean; stock: boolean };
};

export type ReversalResult = { executed: false; reason: string } | { executed: true; receipt: unknown };

export function prepareReversal(input: {
  receiptId?: string | null;
  orderId?: string | null;
  qty: number;
  historyApplied: boolean;
  stockApplied: boolean;
  legacy?: boolean;
}): ReversalRequest | { rejected: string } {
  if (input.legacy) return { rejected: "legacy_sale_without_certified_receipt" };
  if (!input.receiptId && !input.orderId) return { rejected: "no_receipt_or_deterministic_identity" };
  if (!(input.qty > 0)) return { rejected: "non_positive_qty" };
  if (!input.historyApplied && !input.stockApplied) return { rejected: "no_applied_effects" };
  return {
    receiptId: input.receiptId ?? null,
    orderId: input.orderId ?? null,
    qty: input.qty,
    effects: { history: input.historyApplied, stock: input.stockApplied },
  };
}

/** Always disabled until Winerim publishes the certified reversal contract. */
export const WINERIM_REVERSAL_ENABLED = false as const;

export async function executeWinerimReversal(_req: ReversalRequest): Promise<ReversalResult> {
  return { executed: false, reason: "winerim_reversal_endpoint_not_available" };
}
