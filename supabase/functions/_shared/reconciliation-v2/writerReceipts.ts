import { canonicalFormat } from "./engine.ts";
import type { AgoraLine, ReconciliationResult, WinerimLine } from "./types.ts";

// Second causal source for historical_range AUDIT_ONLY: writer acknowledgements
// already persisted in stock_sync_log.winerim_response. Read-only. Used only when
// Winerim appended the line as a detail of an older sale (bottle already open),
// which a header-date range read cannot return. Never fabricates a range line.

export type WriterReceipt = {
  logId: string; receiptId: string; orderId: string; saleId: number; saleDetailIds: number[];
  wineId: string; format: string; quantity: number; amountMinor: number | null; amountSource: string | null;
  effectiveAtLocal: string; sourceLineId: string | null; operationId: number | null;
  stock: { stockApplied: boolean | null; bottleDeducted: boolean | null; bottlesOpened: number | null; movementIds: number[]; glasses: Record<string, unknown> | null };
};

const obj = (v: unknown): Record<string, unknown> | null => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
const str = (v: unknown) => v == null || v === "" ? null : String(v);
const num = (v: unknown) => v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v);
const norm = (v: unknown) => String(v ?? "").trim().toLowerCase();

/** Converts an offset timestamp to wall-clock time in the binding timezone (YYYY-MM-DDTHH:mm:ss). */
export function toLocalWallClock(iso: string, timeZone: string): string | null {
  const date = new Date(iso); if (Number.isNaN(date.getTime())) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(date).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

/** Extracts only acknowledgements that prove history: log SUCCESS, sale httpStatus 200, historyWritten true, APPLIED, receipt + orderId of this connection/day/wine. */
export function extractWriterReceipts(rows: Array<{ id: string; status: string | null; winerim_product_id?: string | null; winerim_response: unknown }>, input: { connectionId: string; businessDay: string; timeZone: string }): { receipts: WriterReceipt[]; rejected: Record<string, number> } {
  const rejected: Record<string, number> = {}; const bump = (k: string) => { rejected[k] = (rejected[k] ?? 0) + 1; };
  const seen = new Set<string>(); const receipts: WriterReceipt[] = [];
  const orderPrefix = `agora:${input.connectionId.slice(0, 8)}:${input.businessDay}:`;
  for (const row of rows) {
    const response = obj(row.winerim_response); const imp = obj(response?.salesImport); const sales = obj(imp?.response)?.sales;
    if (norm(row.status) !== "success" || norm(response?.businessDay) !== norm(input.businessDay) || !Array.isArray(sales)) { bump("LOG_NOT_SUCCESS_OR_OTHER_DAY"); continue; }
    for (const raw of sales) {
      const s = obj(raw); if (!s) continue;
      if (num(s.httpStatus) !== 200 || norm(s.result) !== "applied") { bump("NOT_HTTP_200_APPLIED"); continue; }
      if (s.historyWritten !== true) { bump("HISTORY_NOT_WRITTEN"); continue; }
      const receiptId = str(s.receiptId); const orderId = str(s.orderId); const saleId = num(s.saleId); const eff = str(s.effectiveAt);
      const wineId = str(row.winerim_product_id); const format = canonicalFormat(str(s.variant));
      const wineFromOrder = orderId?.startsWith(orderPrefix) ? orderId.slice(orderPrefix.length).split(":")[0] : null;
      if (!receiptId || !orderId || saleId == null || !eff || norm(s.sourceSystem) !== "agora" || !wineFromOrder) { bump("IDENTITY_INCOMPLETE_OR_FOREIGN"); continue; }
      if (wineId && norm(wineId) !== norm(wineFromOrder)) { bump("ORDER_WINE_MISMATCH"); continue; }
      const local = toLocalWallClock(eff, input.timeZone); if (!local) { bump("EFFECTIVE_AT_INVALID"); continue; }
      const details = Array.isArray(s.saleDetailIds) ? s.saleDetailIds.map(Number).filter(Number.isFinite).sort((a, b) => a - b) : [];
      const key = `${receiptId}|${saleId}|${details.join(",")}`; if (seen.has(key)) { bump("DUPLICATE_RECEIPT"); continue; } seen.add(key);
      const amounts = obj(s.amounts); const total = num(amounts?.totalAmount);
      receipts.push({
        logId: row.id, receiptId, orderId, saleId, saleDetailIds: details, wineId: wineFromOrder, format, quantity: Number(s.qty), amountMinor: total == null ? null : Math.round(total * 100), amountSource: str(amounts?.source),
        effectiveAtLocal: local, sourceLineId: str(s.sourceLineId), operationId: num(s.operationId),
        stock: { stockApplied: typeof s.stockApplied === "boolean" ? s.stockApplied : null, bottleDeducted: typeof s.bottleDeducted === "boolean" ? s.bottleDeducted : null, bottlesOpened: num(s.bottlesOpened), movementIds: Array.isArray(s.stockMovementIds) ? s.stockMovementIds.map(Number).filter(Number.isFinite) : [], glasses: obj(s.glasses) },
      });
    }
  }
  return { receipts, rejected };
}

const sig = (wineId: string, format: string | null, at: string) => `${norm(wineId)}|${canonicalFormat(format)}|${at}`;
const wf = (wineId: string, format: string | null) => `${norm(wineId)}|${canonicalFormat(format)}`;

/**
 * Applies writer receipts only to closed HISTORY_MISSING rows. A signature group (wine+format+effectiveAt)
 * is confirmed only when it contains exactly one closed Agora line in HISTORY_MISSING and its receipts sum
 * exactly the Agora quantity and amount. Receipts whose sale detail is already in range/persisted evidence
 * are excluded (never consumed twice). Incompatible candidates turn the row AMBIGUOUS. OPEN rows are untouched.
 */
export function applyWriterReceipts(results: ReconciliationResult[], receipts: WriterReceipt[], known: WinerimLine[]) {
  const knownDetails = new Set(known.flatMap((w) => w.saleDetailId == null ? [] : [`${w.saleId}|${w.saleDetailId}`]));
  const knownDetailFromLine = new Set(known.map((w) => { const m = /^detail:(\d+)$/.exec(w.lineId); return m ? `${w.saleId}|${m[1]}` : `${w.saleId}|sale`; }));
  const usable = receipts.filter((r) => !knownDetailFromLine.has(`${r.saleId}|sale`) && !r.saleDetailIds.some((d) => knownDetails.has(`${r.saleId}|${d}`) || knownDetailFromLine.has(`${r.saleId}|${d}`)));
  const excludedAlreadyInRange = receipts.length - usable.length;
  const missing = results.filter((r) => r.state === "HISTORY_MISSING" && r.agora && !r.agora.isOpen && !r.agora.isCancelled);
  const agoraBySig = new Map<string, ReconciliationResult[]>(); for (const r of missing) { const a = r.agora as AgoraLine; const k = sig(a.wineId, a.format, a.effectiveAt); agoraBySig.set(k, [...(agoraBySig.get(k) ?? []), r]); }
  const receiptsBySig = new Map<string, WriterReceipt[]>(); for (const r of usable) { const k = sig(r.wineId, r.format, r.effectiveAtLocal); receiptsBySig.set(k, [...(receiptsBySig.get(k) ?? []), r]); }
  const confirmedReceipts = new Set<WriterReceipt>(); const decided = new Map<ReconciliationResult, ReconciliationResult>();
  for (const [k, rows] of agoraBySig) {
    const cands = receiptsBySig.get(k) ?? []; if (!cands.length) continue;
    const a = rows[0].agora as AgoraLine; const qty = cands.reduce((s, r) => s + r.quantity, 0);
    const amount = cands.every((r) => r.amountMinor != null) ? cands.reduce((s, r) => s + Number(r.amountMinor), 0) : null;
    const reasons = [rows.length !== 1 ? "MULTIPLE_AGORA_LINES_SAME_SIGNATURE" : null, qty !== a.quantity ? "QUANTITY_MISMATCH" : null, amount == null || a.amountMinor == null || Math.round(amount) !== Math.round(a.amountMinor) ? "AMOUNT_MISMATCH" : null].filter(Boolean) as string[];
    if (reasons.length) { for (const row of rows) decided.set(row, ambiguous(row, cands, reasons)); continue; }
    cands.forEach((c) => confirmedReceipts.add(c));
    const row = rows[0]; const movementIds = cands.flatMap((c) => c.stock.movementIds);
    decided.set(row, {
      ...row, state: "MATCHED",
      evidence: {
        evidenceKind: "WRITER_RECEIPT", appearedInRemoteRange: false, reason: "WINERIM_ACK_HISTORY_WRITTEN_DETAIL_ON_EXISTING_SALE",
        provenance: cands.map((c) => ({ source: "stock_sync_log.winerim_response", logId: c.logId, operationId: c.operationId })),
        saleIds: [...new Set(cands.map((c) => c.saleId))], saleDetailIds: cands.flatMap((c) => c.saleDetailIds), orderIds: cands.map((c) => c.orderId), receiptIds: cands.map((c) => c.receiptId),
        quantity: qty, amountMinor: amount, amountSource: [...new Set(cands.map((c) => c.amountSource))],
        stockEffect: { source: "WRITER_RECEIPT", stockApplied: cands.every((c) => c.stock.stockApplied === true) ? true : cands.some((c) => c.stock.stockApplied === false) ? false : null, movementIds, bottleDeducted: cands.some((c) => c.stock.bottleDeducted === true), bottlesOpened: cands.reduce((s, c) => s + Number(c.stock.bottlesOpened ?? 0), 0), glasses: cands.map((c) => c.stock.glasses), bottleMovementInferred: false },
      },
      manualAction: "Ninguna; confirmado por acuse del writer (no por lectura de rango)",
    });
  }
  // Same wine+format receipts exist but no exact signature: never force, mark AMBIGUOUS.
  const leftoverByWf = new Map<string, WriterReceipt[]>(); for (const r of usable) if (!confirmedReceipts.has(r)) { const k = wf(r.wineId, r.format); leftoverByWf.set(k, [...(leftoverByWf.get(k) ?? []), r]); }
  for (const row of missing) {
    if (decided.has(row)) continue; const a = row.agora as AgoraLine; const cands = leftoverByWf.get(wf(a.wineId, a.format)) ?? [];
    if (cands.length) decided.set(row, ambiguous(row, cands, ["EFFECTIVE_AT_MISMATCH"]));
  }
  return { results: results.map((r) => decided.get(r) ?? r), usableReceipts: usable.length, excludedAlreadyInRange, confirmed: [...decided.values()].filter((r) => r.state === "MATCHED").length };
}

function ambiguous(row: ReconciliationResult, cands: WriterReceipt[], reasons: string[]): ReconciliationResult {
  return { ...row, state: "AMBIGUOUS", evidence: { evidenceKind: "WRITER_RECEIPT_INCOMPATIBLE", reasons, candidateSaleIds: [...new Set(cands.map((c) => c.saleId))], candidateSaleDetailIds: cands.flatMap((c) => c.saleDetailIds), candidateReceiptIds: cands.map((c) => c.receiptId), candidateQty: cands.reduce((s, c) => s + c.quantity, 0), candidateEffectiveAt: [...new Set(cands.map((c) => c.effectiveAtLocal))], stockEffect: "UNKNOWN" }, manualAction: "Revisión manual; acuse del writer no compatible, no se consume" };
}
