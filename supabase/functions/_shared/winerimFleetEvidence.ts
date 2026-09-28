// Pure logic (no I/O) for the Winerim fleet read-only integration.
// - evaluateExternalResolution: decides if an audit case was cancelled outside the middleware.
// - reconcileDay: AUDIT_ONLY daily Agora <-> Winerim comparison.
// - estimateCalls: API cost estimate.
// Never produces write actions: the only outputs are verdicts, evidence and manual actions.

export type SaleDeletion = {
  saleId: number; saleDetailId: number | null; lineId: string;
  reason: "sale_cancelled" | "empty_bottle_discarded" | "product_deleted" | "line_deleted";
  deletedAt: string; effectiveAt: string | null; externalOrderId: string | null;
};
export type SaleLine = {
  lineId: string; saleDetailId: number | null; format: string | null; qty: number;
  source?: { externalOrderId?: string | null; receiptId?: string | null } | null;
  stockEffect?: { known?: boolean; receiptId?: string | null; movements?: Array<{ stockMovementId: number; exists: boolean; difference: number | null }> | null } | null;
};
export type SaleRecord = {
  saleId: number; status: "confirmed" | "pending" | "rejected"; qty: number;
  wine: { wineId: number }; variant: { priceId: number; stockId: number | null; format: string | null };
  source?: { externalOrderId?: string | null } | null; lines: SaleLine[];
};
export type StockMovement = {
  movementId: number; recordedAt: string; variant: { priceId: number | null; stockId: number | null; format: string | null };
  wine: { wineId: number | null };
  quantityBefore: number | null; change: number | null; quantityAfter: number | null; stockControlled: boolean;
  category: "sale" | "purchase" | "return" | "transfer" | "adjustment" | "inventory" | "correction" | "other";
  cause: string | null;
  sale: { saleId: number | null; saleExists: boolean; saleDetailIds: number[]; receiptId?: string; orderId?: string } | null;
};
export type CandidateTarget = { saleId: string; saleDetailId: string | null; qty: number };
export type AuditCase = {
  id: string; connection_id: string; identity_scope: "SALE" | "DETAIL" | null;
  evidence_classification: string; keep_sale_ids: string | null; candidate_targets: CandidateTarget[];
  winerim_wine_id: string | null; reverse_qty: number; history_units_excess: number | null; bottles_overdeducted: number | null;
};
export type ReadContext = {
  connectionId: string; winerimRestaurantId: number; responseRestaurantId: number;
  deletions: SaleDeletion[];              // from sales/records sync mode
  keptSales: SaleRecord[];                // exact reads of keep_sale_ids
  candidateSalesStillPresent: SaleRecord[]; // candidate saleIds found as live sales
  returnMovements: StockMovement[];       // stock/movements category=return
  checkedAt: string; runId: string;
  deletionsWindowStart: string | null;    // earliest instant covered by the sync read
};

export type ExternalVerdict =
  | "RESOLVED_EXTERNALLY"
  | "EXTERNAL_RESOLUTION_EVIDENCE_INCOMPLETE"
  | "NOT_CANCELLED_YET"
  | "BLOCKED_DETAIL_SCOPE"
  | "NOT_ELIGIBLE"
  | "CONFLICT";

export type EvidenceRow = {
  audit_case_id: string; connection_id: string; winerim_restaurant_id: number; run_id: string; checked_at: string;
  verdict: ExternalVerdict; missing: string[];
  cancelled_sale_id: number | null; kept_sale_id: number | null; sale_detail_id: number | null;
  deletion_reason: string | null; deleted_at: string | null;
  movement_id: number | null; quantity_before: number | null; change: number | null; quantity_after: number | null;
  receipt_id: string | null; expected_restored_qty: number | null;
  sources: Record<string, string>;
};

const RETURN_WINDOW_MS = 30 * 60 * 1000; // return must be recorded within 30 min of deletedAt

export function evaluateExternalResolution(c: AuditCase, ctx: ReadContext): EvidenceRow {
  const base: EvidenceRow = {
    audit_case_id: c.id, connection_id: c.connection_id, winerim_restaurant_id: ctx.winerimRestaurantId,
    run_id: ctx.runId, checked_at: ctx.checkedAt, verdict: "EXTERNAL_RESOLUTION_EVIDENCE_INCOMPLETE", missing: [],
    cancelled_sale_id: null, kept_sale_id: null, sale_detail_id: null, deletion_reason: null, deleted_at: null,
    movement_id: null, quantity_before: null, change: null, quantity_after: null, receipt_id: null,
    expected_restored_qty: null,
    sources: {
      deletion: "GET /api/v2/sales/records (sync: changedSince/cursor) .deletions",
      kept_sale: "GET /api/v2/sales/records (orderId/date) exact saleId",
      movement: "GET /api/v2/stock/movements?category=return",
    },
  };
  const out = (v: ExternalVerdict, missing: string[] = []) => ({ ...base, verdict: v, missing });

  if (ctx.connectionId !== c.connection_id) return out("CONFLICT", ["connection_mismatch"]);
  if (ctx.responseRestaurantId !== ctx.winerimRestaurantId) return out("CONFLICT", ["restaurant_mismatch"]);
  if (c.identity_scope === "DETAIL") return out("BLOCKED_DETAIL_SCOPE");
  if (c.identity_scope !== "SALE" || !c.evidence_classification.startsWith("CONFIRMED_DUPLICATE")) return out("NOT_ELIGIBLE");
  const targets = c.candidate_targets || [];
  const saleIds = [...new Set(targets.map((t) => t.saleId))];
  if (saleIds.length !== 1 || targets.some((t) => t.saleDetailId != null && targets.length > 1 && false)) return out("NOT_ELIGIBLE", ["single_candidate_sale_required"]);
  const candId = Number(saleIds[0]);
  base.cancelled_sale_id = candId;
  const detailIds = targets.map((t) => t.saleDetailId).filter(Boolean) as string[];
  base.sale_detail_id = detailIds.length === 1 ? Number(detailIds[0]) : null;

  // 1. Candidate still present as a live sale => not cancelled.
  if (ctx.candidateSalesStillPresent.some((s) => s.saleId === candId && s.status !== "rejected")) return out("NOT_CANCELLED_YET");

  const missing: string[] = [];
  // 2. sale_cancelled event for exactly this sale (whole sale, no detail).
  const dels = ctx.deletions.filter((d) => d.saleId === candId);
  const cancel = dels.find((d) => d.reason === "sale_cancelled" && d.saleDetailId == null);
  if (dels.some((d) => d.reason === "line_deleted" || d.saleDetailId != null)) return out("CONFLICT", ["line_level_deletion_on_sale_scope"]);
  if (!cancel) missing.push(ctx.deletionsWindowStart ? "sale_cancelled_not_in_window" : "sale_cancelled");
  else { base.deletion_reason = cancel.reason; base.deleted_at = cancel.deletedAt; }

  // 3. Kept sale still present and confirmed.
  const keepIds = String(c.keep_sale_ids || "").split(/\s+/).filter(Boolean).map(Number);
  const kept = ctx.keptSales.filter((s) => keepIds.includes(s.saleId) && s.status === "confirmed");
  if (!keepIds.length || kept.length !== keepIds.length) missing.push("kept_sale_present");
  else base.kept_sale_id = kept[0].saleId;
  if (ctx.deletions.some((d) => keepIds.includes(d.saleId))) return out("CONFLICT", ["kept_sale_deleted"]);

  // 4-5. Return movement with exact restored quantity.
  const expected = Number(c.bottles_overdeducted || 0);
  base.expected_restored_qty = expected;
  const refVariant = kept[0]?.variant;
  if (expected === 0) {
    // History-only duplicate: no stock was deducted, so no return must exist.
    const bogus = cancel && ctx.returnMovements.find((m) => m.sale?.saleId === candId);
    if (bogus) return out("CONFLICT", ["unexpected_return_for_history_only"]);
  } else if (!cancel) {
    missing.push("return_movement");
  } else {
    const t0 = Date.parse(cancel.deletedAt);
    const cands = ctx.returnMovements.filter((m) =>
      m.category === "return" && m.stockControlled &&
      (m.sale?.saleId === candId ||
        (m.sale == null && refVariant && m.variant.priceId === refVariant.priceId && m.variant.stockId === refVariant.stockId &&
          Math.abs(Date.parse(m.recordedAt) - t0) <= RETURN_WINDOW_MS)));
    if (cands.length === 0) missing.push("return_movement");
    else if (cands.length > 1) missing.push("return_movement_ambiguous");
    else {
      const m = cands[0];
      base.movement_id = m.movementId; base.quantity_before = m.quantityBefore; base.change = m.change; base.quantity_after = m.quantityAfter;
      base.receipt_id = m.sale?.receiptId ?? null;
      if (m.change == null || m.quantityBefore == null || m.quantityAfter == null) missing.push("movement_quantities");
      else if (m.change !== expected) return out("CONFLICT", [`restored_${m.change}_expected_${expected}`]);
      else if (m.quantityAfter - m.quantityBefore !== m.change) missing.push("movement_inconsistent");
    }
  }
  if (!base.receipt_id) {
    const r = ctx.keptSales.flatMap((s) => s.lines).find((l) => l.stockEffect?.receiptId)?.stockEffect?.receiptId;
    base.receipt_id = null; void r; // receiptId only when the cancelled sale/return provides it
  }
  if (missing.length) return out("EXTERNAL_RESOLUTION_EVIDENCE_INCOMPLETE", missing);
  return { ...base, verdict: "RESOLVED_EXTERNALLY", missing: [] };
}

// ---------- Daily reconciler (AUDIT_ONLY) ----------
export type AgoraDayGroup = { day: string; winerimWineId: string; formatKey: string; agoraRealQty: number; supersededQty: number; cancelledQty: number };
export type ReconResult = {
  day: string; winerim_wine_id: string; format_key: string; agora_net_qty: number; winerim_history_qty: number;
  winerim_stock_units: number | null; diff: number;
  status: "MATCH" | "WINERIM_EXCESS" | "WINERIM_MISSING" | "STOCK_UNKNOWN";
  manual_action: string; mode: "AUDIT_ONLY";
};
export function reconcileDay(groups: AgoraDayGroup[], sales: SaleRecord[], orderPrefix: string, deletions: SaleDeletion[] = []): ReconResult[] {
  const deleted = new Set(deletions.filter((d) => d.saleDetailId == null).map((d) => d.saleId));
  const deletedLines = new Set(deletions.filter((d) => d.saleDetailId != null).map((d) => d.saleDetailId));
  return groups.map((g) => {
    const lines = sales.filter((s) => s.status === "confirmed" && !deleted.has(s.saleId) && String(s.wine.wineId) === g.winerimWineId)
      .flatMap((s) => s.lines.map((l) => ({ s, l })))
      .filter(({ s, l }) => !deletedLines.has(l.saleDetailId) && String(l.format || "").toLowerCase() === g.formatKey &&
        String(l.source?.externalOrderId || s.source?.externalOrderId || "").startsWith(orderPrefix));
    const hist = lines.reduce((a, x) => a + Number(x.l.qty || 0), 0);
    const known = lines.every(({ l }) => l.stockEffect?.known === true);
    const mv = new Map<number, number>();
    for (const { l } of lines) for (const m of l.stockEffect?.movements || []) if (m.exists) mv.set(m.stockMovementId, Number(m.difference || 0));
    const stock = known ? -[...mv.values()].reduce((a, b) => a + b, 0) : null;
    const net = Math.max(0, g.agoraRealQty - g.cancelledQty);
    const diff = hist - net;
    const status: ReconResult["status"] = diff > 0 ? "WINERIM_EXCESS" : diff < 0 ? "WINERIM_MISSING" : !known && lines.length ? "STOCK_UNKNOWN" : "MATCH";
    const manual_action = status === "WINERIM_EXCESS" ? `Revisión manual: ${diff} ud(s) de más en Winerim; no revertir automáticamente`
      : status === "WINERIM_MISSING" ? `Revisión manual: faltan ${-diff} ud(s) en Winerim; nunca revertir`
      : status === "STOCK_UNKNOWN" ? "Historial cuadra; stock desconocido (sin recibo)" : "Ninguna";
    return { day: g.day, winerim_wine_id: g.winerimWineId, format_key: g.formatKey, agora_net_qty: net, winerim_history_qty: hist, winerim_stock_units: stock, diff, status, manual_action, mode: "AUDIT_ONLY" };
  });
}

// ---------- Call estimate ----------
export function estimateCalls(p: { restaurants: number; days: number; salesPagesPerDay: number; syncPagesPerRun: number; movementPagesPerRun: number; runsPerDay: number; cases: number }) {
  const discovery = 1;
  const checker = p.restaurants * (p.syncPagesPerRun + p.movementPagesPerRun) + p.cases; // + 1 exact kept-sale read per case
  const reconcilerPerDay = p.restaurants * p.salesPagesPerDay;
  const perDay = discovery + p.runsPerDay * (p.restaurants * (p.syncPagesPerRun + p.movementPagesPerRun)) + reconcilerPerDay;
  return { discovery, checkerOneShot: checker, reconcilerPerDay, steadyStatePerDay: perDay, peakPerHour: Math.ceil(perDay / 24) + checker, limitPerHour: 10000, backfill: p.restaurants * p.days * p.salesPagesPerDay };
}
