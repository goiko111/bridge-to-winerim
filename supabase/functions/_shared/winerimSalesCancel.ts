// POST /api/v2/sales/cancel — pure contract layer (per API_TOKEN_V2_DOCUMENTATION HTML, 2026-09).
// Transport is DISABLED: nothing here performs network calls. Real cancellations need a separate GO,
// nominal human approval and readback. Never compensate a sale with PUT /stock.

export const CANCEL_EXECUTION_ENABLED = false as const;
export const CANCEL_MAX_ENTRIES = 100;

export type ImportMode = "history_and_stock" | "history_only" | "stock_only" | "legacy" | "UNKNOWN";
export type CancelEntry = { orderId: string; sourceLineId?: string; cancelUpTo?: number; reason?: string };
export type CancelPayload = { sourceSystem: string; correlationId: string; cancels: CancelEntry[] };

const fail = (m: string, code: string) => Object.assign(new Error(m), { status: 400, code });

export function buildCancelPayload(sourceSystem: string, correlationId: string, cancels: CancelEntry[]): CancelPayload {
  if (!/^.{1,64}$/.test(sourceSystem.trim())) throw fail("sourceSystem inválido", "CANCEL_SOURCE_SYSTEM_INVALID");
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(correlationId)) throw fail("correlationId inválido", "CANCEL_CORRELATION_INVALID");
  if (cancels.length < 1 || cancels.length > CANCEL_MAX_ENTRIES) throw fail("Entre 1 y 100 entradas", "CANCEL_BATCH_SIZE");
  const seen = new Set<string>();
  const out = cancels.map((c, i) => {
    const orderId = String(c.orderId ?? "").trim();
    if (!orderId || orderId.length > 191) throw fail(`cancels[${i}]: orderId`, "CANCEL_ORDER_ID_INVALID");
    const line = c.sourceLineId == null ? undefined : String(c.sourceLineId).trim();
    if (line !== undefined && (line.length < 1 || line.length > 128)) throw fail(`cancels[${i}]: sourceLineId`, "CANCEL_LINE_ID_INVALID");
    if (c.cancelUpTo !== undefined) {
      if (!Number.isInteger(c.cancelUpTo) || c.cancelUpTo < 1) throw fail(`cancels[${i}]: cancelUpTo es un total absoluto entero ≥ 1`, "CANCEL_UP_TO_INVALID");
      if (line === undefined) throw fail(`cancels[${i}]: cancelUpTo exige sourceLineId`, "CANCEL_UP_TO_REQUIRES_LINE");
    }
    const key = `${orderId}\u0000${line ?? "*"}`;
    if (seen.has(key)) throw fail(`cancels[${i}]: identidad duplicada en el lote`, "CANCEL_DUPLICATE_IDENTITY");
    seen.add(key);
    return { orderId, ...(line !== undefined ? { sourceLineId: line } : {}), ...(c.cancelUpTo !== undefined ? { cancelUpTo: c.cancelUpTo } : {}), ...(c.reason ? { reason: c.reason.trim().slice(0, 191) } : {}) };
  });
  return { sourceSystem: sourceSystem.trim(), correlationId, cancels: out };
}

export type EligibilityInput = {
  mode: ImportMode; receiptId: string | null; orderId: string | null; sourceLineId: string | null;
  soldQty: number | null; alreadyCancelledQty: number | null; targetCancelledQty: number | null;
  format: "BOTTLE" | "GLASS" | "OTHER" | "UNKNOWN"; partitionMismatch: boolean | null;
};
export type Eligibility = { eligible: boolean; code: string; effect: { history: "REMOVE" | "LOWER" | "NONE" | "UNKNOWN"; stock: "RETURN" | "NONE" | "UNKNOWN"; visibleIn: "DELETIONS" | "UPDATED_RECORD" | "NOT_IN_HISTORY" | "UNKNOWN" } };

const unknownEffect = { history: "UNKNOWN", stock: "UNKNOWN", visibleIn: "UNKNOWN" } as const;

/** Case-by-case eligibility. UNKNOWN is never coerced to a safe default. */
export function classifyCancelEligibility(c: EligibilityInput): Eligibility {
  if (c.mode === "legacy") return { eligible: false, code: "LEGACY_REQUIRES_MANUAL_REVIEW", effect: unknownEffect };
  if (c.mode === "UNKNOWN") return { eligible: false, code: "MODE_UNKNOWN", effect: unknownEffect };
  if (!c.receiptId) return { eligible: false, code: "RECEIPT_MISSING", effect: unknownEffect };
  if (!c.orderId || !c.sourceLineId) return { eligible: false, code: "IDENTITY_INCOMPLETE", effect: unknownEffect };
  if (c.format === "UNKNOWN") return { eligible: false, code: "FORMAT_UNKNOWN", effect: unknownEffect };
  if (c.format === "GLASS" && c.partitionMismatch !== false) return { eligible: false, code: c.partitionMismatch === true ? "PARTITION_MISMATCH" : "PARTITION_UNKNOWN", effect: unknownEffect };
  if (c.soldQty == null || c.alreadyCancelledQty == null || c.targetCancelledQty == null) return { eligible: false, code: "QTY_UNKNOWN", effect: unknownEffect };
  if (c.targetCancelledQty < c.alreadyCancelledQty) return { eligible: false, code: "CANCELLED_QTY_CANNOT_DECREASE", effect: unknownEffect };
  if (c.targetCancelledQty > c.soldQty) return { eligible: false, code: "CANCELLED_QTY_EXCEEDS_SOLD", effect: unknownEffect };
  if (c.targetCancelledQty === c.alreadyCancelledQty) return { eligible: false, code: "NOTHING_TO_CANCEL", effect: { history: "NONE", stock: "NONE", visibleIn: "UNKNOWN" } };
  const full = c.targetCancelledQty === c.soldQty;
  const history = c.mode === "stock_only" ? "NONE" : full ? "REMOVE" : "LOWER";
  const stock = c.mode === "history_only" ? "NONE" : "RETURN";
  const visibleIn = c.mode === "stock_only" ? "NOT_IN_HISTORY" : full ? "DELETIONS" : "UPDATED_RECORD";
  return { eligible: true, code: "ELIGIBLE_PENDING_APPROVAL", effect: { history, stock, visibleIn } };
}

export type CancelResultEntry = { index: number; result: "CANCELLED" | "ALREADY_CANCELLED" | "NOT_FOUND" | "REJECTED" | "UNCERTAIN"; reasonCode: string | null; retryable: boolean; orderId: string; lineId: string | null; receiptId: string | null; cancelledQty: number | null; stockReturned: number; glassesReturned: number; saleDeletionIds: unknown[] };
export type ParsedCancel = { perEntry: Array<CancelResultEntry & { next: "DONE" | "CHECK_IDS" | "MANUAL" | "RESEND_SAME" | "READBACK_THEN_RESEND_SAME" }>; requiresReadback: boolean; counterMismatch: boolean };

/** Every entry is processed on its own even when the global HTTP is 200. */
export function parseCancelResponse(httpStatus: number, body: unknown, sent: CancelPayload): ParsedCancel {
  if (httpStatus !== 200 || !body || typeof body !== "object") throw Object.assign(new Error("Respuesta de cancelación no verificable"), { code: `CANCEL_HTTP_${httpStatus}` });
  const b = body as Record<string, unknown>; const entries = Array.isArray(b.cancels) ? b.cancels as CancelResultEntry[] : null;
  if (!entries || b.correlationId !== sent.correlationId) throw Object.assign(new Error("Respuesta sin entradas o correlationId distinto"), { code: "CANCEL_RESPONSE_INVALID" });
  const covered = new Set(entries.map((e) => e.index));
  for (let i = 0; i < sent.cancels.length; i++) if (!covered.has(i)) throw Object.assign(new Error(`Falta resultado para cancels[${i}]`), { code: "CANCEL_RESPONSE_MISSING_ENTRY" });
  const perEntry = entries.map((e) => ({ ...e, next: e.result === "CANCELLED" || e.result === "ALREADY_CANCELLED" ? "DONE" as const : e.result === "NOT_FOUND" ? "CHECK_IDS" as const : e.result === "UNCERTAIN" ? "READBACK_THEN_RESEND_SAME" as const : e.retryable ? "RESEND_SAME" as const : "MANUAL" as const }));
  const count = (r: string) => entries.filter((e) => e.result === r).length;
  const counterMismatch = b.cancelled !== count("CANCELLED") || b.alreadyCancelled !== count("ALREADY_CANCELLED") || b.notFound !== count("NOT_FOUND") || b.rejected !== count("REJECTED") || b.uncertain !== count("UNCERTAIN");
  return { perEntry, requiresReadback: perEntry.some((e) => e.next === "READBACK_THEN_RESEND_SAME") || counterMismatch, counterMismatch };
}

/** Transport gate: always refuses while CANCEL_EXECUTION_ENABLED is false. */
export function assertCancelExecutionAllowed(approval: { approvedBy?: string | null; secondCheckBy?: string | null }): never | void {
  if (!CANCEL_EXECUTION_ENABLED) throw Object.assign(new Error("Transporte de cancelación desactivado: requiere GO separado"), { status: 423, code: "CANCEL_EXECUTION_DISABLED" });
  if (!approval.approvedBy || !approval.secondCheckBy || approval.approvedBy === approval.secondCheckBy) throw Object.assign(new Error("Aprobación nominal doble requerida"), { status: 403, code: "CANCEL_APPROVAL_REQUIRED" });
}
