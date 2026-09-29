import { describe, expect, it } from "vitest";
import { assertCancelExecutionAllowed, buildCancelPayload, CANCEL_EXECUTION_ENABLED, classifyCancelEligibility, parseCancelResponse, type EligibilityInput } from "../../supabase/functions/_shared/winerimSalesCancel";

const base: EligibilityInput = { mode: "history_and_stock", receiptId: "rcpt_1", orderId: "T1", sourceLineId: "3", soldQty: 3, alreadyCancelledQty: 0, targetCancelledQty: 1, format: "BOTTLE", partitionMismatch: false };

describe("sales/cancel payload", () => {
  it("cancelUpTo absoluto exige línea y entero ≥1", () => {
    expect(() => buildCancelPayload("agora", "c-1", [{ orderId: "T1", cancelUpTo: 1 }])).toThrow(/sourceLineId/);
    expect(() => buildCancelPayload("agora", "c-1", [{ orderId: "T1", sourceLineId: "3", cancelUpTo: 0 }])).toThrow(/absoluto/);
    expect(buildCancelPayload("agora", "c-1", [{ orderId: " T1 ", sourceLineId: "3", cancelUpTo: 2 }]).cancels[0]).toEqual({ orderId: "T1", sourceLineId: "3", cancelUpTo: 2 });
  });
  it("rechaza >100, duplicados y correlationId inválido", () => {
    expect(() => buildCancelPayload("agora", "c-1", Array.from({ length: 101 }, (_, i) => ({ orderId: `T${i}` })))).toThrow();
    expect(() => buildCancelPayload("agora", "c-1", [{ orderId: "T1", sourceLineId: "1" }, { orderId: "T1", sourceLineId: "1" }])).toThrow(/duplicada/);
    expect(() => buildCancelPayload("agora", "bad id!", [{ orderId: "T1" }])).toThrow();
  });
});

describe("elegibilidad caso a caso", () => {
  it("legacy, modo desconocido, sin receipt y copa partida bloquean", () => {
    expect(classifyCancelEligibility({ ...base, mode: "legacy" }).code).toBe("LEGACY_REQUIRES_MANUAL_REVIEW");
    expect(classifyCancelEligibility({ ...base, mode: "UNKNOWN" }).eligible).toBe(false);
    expect(classifyCancelEligibility({ ...base, receiptId: null }).code).toBe("RECEIPT_MISSING");
    expect(classifyCancelEligibility({ ...base, format: "GLASS", partitionMismatch: true }).code).toBe("PARTITION_MISMATCH");
    expect(classifyCancelEligibility({ ...base, format: "GLASS", partitionMismatch: null }).code).toBe("PARTITION_UNKNOWN");
    expect(classifyCancelEligibility({ ...base, soldQty: null }).code).toBe("QTY_UNKNOWN");
  });
  it("efectos por modo: parcial = registro actualizado; total = deletions; stock_only fuera del historial", () => {
    expect(classifyCancelEligibility(base).effect).toEqual({ history: "LOWER", stock: "RETURN", visibleIn: "UPDATED_RECORD" });
    expect(classifyCancelEligibility({ ...base, targetCancelledQty: 3 }).effect).toEqual({ history: "REMOVE", stock: "RETURN", visibleIn: "DELETIONS" });
    expect(classifyCancelEligibility({ ...base, mode: "history_only", targetCancelledQty: 3 }).effect.stock).toBe("NONE");
    expect(classifyCancelEligibility({ ...base, mode: "stock_only" }).effect).toEqual({ history: "NONE", stock: "RETURN", visibleIn: "NOT_IN_HISTORY" });
  });
  it("no disminuye, no excede, idempotente", () => {
    expect(classifyCancelEligibility({ ...base, alreadyCancelledQty: 2, targetCancelledQty: 1 }).code).toBe("CANCELLED_QTY_CANNOT_DECREASE");
    expect(classifyCancelEligibility({ ...base, targetCancelledQty: 4 }).code).toBe("CANCELLED_QTY_EXCEEDS_SOLD");
    expect(classifyCancelEligibility({ ...base, alreadyCancelledQty: 1, targetCancelledQty: 1 }).code).toBe("NOTHING_TO_CANCEL");
  });
});

describe("respuesta 200 mixta y UNCERTAIN", () => {
  const sent = buildCancelPayload("agora", "c-9", [{ orderId: "A", sourceLineId: "1", cancelUpTo: 1 }, { orderId: "B", sourceLineId: "2" }, { orderId: "C", sourceLineId: "3" }]);
  const e = (index: number, result: string, retryable = false) => ({ index, result, reasonCode: null, retryable, orderId: "x", lineId: "1", receiptId: null, cancelledQty: null, stockReturned: 0, glassesReturned: 0, saleDeletionIds: [] });
  it("procesa cada entrada y exige readback ante UNCERTAIN", () => {
    const r = parseCancelResponse(200, { correlationId: "c-9", cancelled: 1, alreadyCancelled: 0, notFound: 0, rejected: 1, uncertain: 1, cancels: [e(0, "CANCELLED"), e(1, "REJECTED"), e(2, "UNCERTAIN")] }, sent);
    expect(r.perEntry.map((x) => x.next)).toEqual(["DONE", "MANUAL", "READBACK_THEN_RESEND_SAME"]);
    expect(r.requiresReadback).toBe(true);
  });
  it("falla cerrado si falta una entrada o cambia el correlationId", () => {
    expect(() => parseCancelResponse(200, { correlationId: "c-9", cancels: [e(0, "CANCELLED")] }, sent)).toThrow(/Falta/);
    expect(() => parseCancelResponse(200, { correlationId: "otro", cancels: [] }, sent)).toThrow();
  });
});

describe("transporte", () => {
  it("activo solo con dos aprobadores distintos", () => {
    expect(CANCEL_EXECUTION_ENABLED).toBe(true);
    expect(() => assertCancelExecutionAllowed({ approvedBy: "a", secondCheckBy: "b" })).not.toThrow();
    expect(() => assertCancelExecutionAllowed({ approvedBy: "a", secondCheckBy: "a" })).toThrow(/doble/);
    expect(() => assertCancelExecutionAllowed({ approvedBy: "a", secondCheckBy: null })).toThrow(/doble/);
  });
});
