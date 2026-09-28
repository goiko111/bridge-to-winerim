import { describe, it, expect } from "vitest";
import { evaluateExternalResolution, reconcileDay, estimateCalls, type AuditCase, type ReadContext, type SaleRecord, type StockMovement } from "../../supabase/functions/_shared/winerimFleetEvidence";
import { createFleetClient, redact } from "../../supabase/functions/_shared/winerimFleetClient";

const CONN = "8466c229-773d-4ad9-a747-9bb862d7ae6b";
const sale = (saleId: number, status: SaleRecord["status"] = "confirmed", qty = 1): SaleRecord => ({
  saleId, status, qty, wine: { wineId: 900 }, variant: { priceId: 11, stockId: 22, format: "botella" },
  source: { externalOrderId: "agora:8466c229:2026-09-25:42531" },
  lines: [{ lineId: `sale:${saleId}`, saleDetailId: null, format: "botella", qty, source: { externalOrderId: "agora:8466c229:2026-09-25:42531" }, stockEffect: { known: true, movements: [{ stockMovementId: saleId * 10, exists: true, difference: -qty }] } }],
});
const ret = (over: Partial<StockMovement> = {}): StockMovement => ({
  movementId: 5001, recordedAt: "2026-09-27T10:05:00+02:00", variant: { priceId: 11, stockId: 22, format: "botella" }, wine: { wineId: 900 },
  quantityBefore: 6, change: 1, quantityAfter: 7, stockControlled: true, category: "return", cause: "sale_cancelled", sale: null, ...over,
});
const baseCase = (o: Partial<AuditCase> = {}): AuditCase => ({
  id: "c1", connection_id: CONN, identity_scope: "SALE", evidence_classification: "CONFIRMED_DUPLICATE_STOCK",
  keep_sale_ids: "188510", candidate_targets: [{ saleId: "188690", saleDetailId: null, qty: 1 }], winerim_wine_id: "900",
  reverse_qty: 1, history_units_excess: 1, bottles_overdeducted: 1, ...o,
});
const ctx = (o: Partial<ReadContext> = {}): ReadContext => ({
  connectionId: CONN, winerimRestaurantId: 77, responseRestaurantId: 77,
  deletions: [{ saleId: 188690, saleDetailId: null, lineId: "sale:188690", reason: "sale_cancelled", deletedAt: "2026-09-27T10:04:00+02:00", effectiveAt: null, externalOrderId: null }],
  keptSales: [sale(188510)], candidateSalesStillPresent: [], returnMovements: [ret()],
  checkedAt: "2026-09-28T07:00:00Z", runId: "r1", deletionsWindowStart: "2026-09-14T00:00:00Z", ...o,
});

describe("evaluateExternalResolution", () => {
  it("E1 caso Don Quijote completo → RESOLVED_EXTERNALLY con todas las evidencias", () => {
    const r = evaluateExternalResolution(baseCase(), ctx());
    expect(r.verdict).toBe("RESOLVED_EXTERNALLY");
    expect(r).toMatchObject({ cancelled_sale_id: 188690, kept_sale_id: 188510, deletion_reason: "sale_cancelled", movement_id: 5001, quantity_before: 6, change: 1, quantity_after: 7, run_id: "r1" });
  });
  it("E2 sin evento sale_cancelled (anulada antes de la ventana) → EVIDENCE_INCOMPLETE", () => {
    expect(evaluateExternalResolution(baseCase(), ctx({ deletions: [] })).verdict).toBe("EXTERNAL_RESOLUTION_EVIDENCE_INCOMPLETE");
  });
  it("E3 sin movimiento return → EVIDENCE_INCOMPLETE", () => {
    const r = evaluateExternalResolution(baseCase(), ctx({ returnMovements: [] }));
    expect(r.verdict).toBe("EXTERNAL_RESOLUTION_EVIDENCE_INCOMPLETE"); expect(r.missing).toContain("return_movement");
  });
  it("E4 cantidad restaurada distinta → CONFLICT", () => {
    expect(evaluateExternalResolution(baseCase(), ctx({ returnMovements: [ret({ change: 2, quantityAfter: 8 })] })).verdict).toBe("CONFLICT");
  });
  it("E5 venta conservada ausente → EVIDENCE_INCOMPLETE", () => {
    expect(evaluateExternalResolution(baseCase(), ctx({ keptSales: [] })).verdict).toBe("EXTERNAL_RESOLUTION_EVIDENCE_INCOMPLETE");
  });
  it("E6 venta conservada borrada → CONFLICT", () => {
    const d = ctx().deletions.concat([{ saleId: 188510, saleDetailId: null, lineId: "sale:188510", reason: "sale_cancelled", deletedAt: "2026-09-27T10:00:00Z", effectiveAt: null, externalOrderId: null }]);
    expect(evaluateExternalResolution(baseCase(), ctx({ deletions: d })).verdict).toBe("CONFLICT");
  });
  it("E7 candidata todavía viva → NOT_CANCELLED_YET", () => {
    expect(evaluateExternalResolution(baseCase(), ctx({ candidateSalesStillPresent: [sale(188690)] })).verdict).toBe("NOT_CANCELLED_YET");
  });
  it("E8 restaurante o conexión distintos → CONFLICT", () => {
    expect(evaluateExternalResolution(baseCase(), ctx({ responseRestaurantId: 78 })).verdict).toBe("CONFLICT");
    expect(evaluateExternalResolution(baseCase(), ctx({ connectionId: "other" })).verdict).toBe("CONFLICT");
  });
  it("E9 caso DETAIL (copas) → BLOCKED_DETAIL_SCOPE aunque exista line_deleted", () => {
    const r = evaluateExternalResolution(baseCase({ identity_scope: "DETAIL", candidate_targets: [{ saleId: "181057", saleDetailId: "41426", qty: 1 }] }), ctx());
    expect(r.verdict).toBe("BLOCKED_DETAIL_SCOPE");
  });
  it("E10 line_deleted en caso SALE → CONFLICT (no se acepta como anulación completa)", () => {
    const d = [{ ...ctx().deletions[0], reason: "line_deleted" as const, saleDetailId: 1 }];
    expect(evaluateExternalResolution(baseCase(), ctx({ deletions: d })).verdict).toBe("CONFLICT");
  });
  it("E11 dos returns posibles → EVIDENCE_INCOMPLETE (ambiguo)", () => {
    const r = evaluateExternalResolution(baseCase(), ctx({ returnMovements: [ret(), ret({ movementId: 5002 })] }));
    expect(r.missing).toContain("return_movement_ambiguous");
  });
  it("E12 return fuera de ventana temporal no se atribuye", () => {
    expect(evaluateExternalResolution(baseCase(), ctx({ returnMovements: [ret({ recordedAt: "2026-09-27T15:00:00+02:00" })] })).verdict).toBe("EXTERNAL_RESOLUTION_EVIDENCE_INCOMPLETE");
  });
  it("E13 return vinculado por sale.saleId se acepta aunque esté lejos en el tiempo", () => {
    const m = ret({ recordedAt: "2026-09-28T01:00:00Z", sale: { saleId: 188690, saleExists: false, saleDetailIds: [], receiptId: "rcpt-1" } });
    const r = evaluateExternalResolution(baseCase(), ctx({ returnMovements: [m] }));
    expect(r.verdict).toBe("RESOLVED_EXTERNALLY"); expect(r.receipt_id).toBe("rcpt-1");
  });
  it("E14 duplicado solo de historial: resuelto sin return; con return inesperado → CONFLICT", () => {
    const c = baseCase({ evidence_classification: "CONFIRMED_DUPLICATE_HISTORY", bottles_overdeducted: 0 });
    expect(evaluateExternalResolution(c, ctx({ returnMovements: [] })).verdict).toBe("RESOLVED_EXTERNALLY");
    expect(evaluateExternalResolution(c, ctx({ returnMovements: [ret({ sale: { saleId: 188690, saleExists: false, saleDetailIds: [] } })] })).verdict).toBe("CONFLICT");
  });
  it("E15 probable/ambiguo → NOT_ELIGIBLE", () => {
    expect(evaluateExternalResolution(baseCase({ evidence_classification: "PROBABLE_DUPLICATE" }), ctx()).verdict).toBe("NOT_ELIGIBLE");
  });
  it("E16 movimiento sin cantidades (stock no controlado) → EVIDENCE_INCOMPLETE", () => {
    const r = evaluateExternalResolution(baseCase(), ctx({ returnMovements: [ret({ stockControlled: false })] }));
    expect(r.verdict).toBe("EXTERNAL_RESOLUTION_EVIDENCE_INCOMPLETE");
  });
});

describe("reconcileDay (AUDIT_ONLY)", () => {
  const g = { day: "2026-09-25", winerimWineId: "900", formatKey: "botella", agoraRealQty: 1, supersededQty: 1, cancelledQty: 0 };
  it("R1 duplicado visible → WINERIM_EXCESS con acción manual", () => {
    const [r] = reconcileDay([g], [sale(188510), sale(188690)], "agora:8466c229:2026-09-25:");
    expect(r).toMatchObject({ status: "WINERIM_EXCESS", diff: 1, mode: "AUDIT_ONLY" });
  });
  it("R2 tras la anulación externa → MATCH", () => {
    const d = [{ saleId: 188690, saleDetailId: null, lineId: "sale:188690", reason: "sale_cancelled" as const, deletedAt: "x", effectiveAt: null, externalOrderId: null }];
    expect(reconcileDay([g], [sale(188510), sale(188690)], "agora:8466c229:2026-09-25:", d)[0].status).toBe("MATCH");
  });
  it("R3 venta que falta en Winerim → WINERIM_MISSING, nunca revertir", () => {
    const [r] = reconcileDay([{ ...g, agoraRealQty: 2 }], [sale(188510)], "agora:8466c229:2026-09-25:");
    expect(r.status).toBe("WINERIM_MISSING"); expect(r.manual_action).toMatch(/nunca revertir/);
  });
  it("R4 otro restaurante (prefijo distinto) no cuenta", () => {
    expect(reconcileDay([g], [sale(188510)], "agora:ffffffff:2026-09-25:")[0].status).toBe("WINERIM_MISSING");
  });
});

describe("fleet client", () => {
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  it("C1 rechaza token que no es de flota", () => { expect(() => createFleetClient("abc")).toThrow(); });
  it("C2 exige restaurantId y solo usa GET", async () => {
    const seen: RequestInit[] = []; const urls: string[] = [];
    const c = createFleetClient("wfk_ab12cd34_SECRET", (async (u: string, i: RequestInit) => { urls.push(u); seen.push(i); return ok({ data: [] }); }) as unknown as typeof fetch);
    await c.salesSync(77, "2026-09-14T00:00:00Z");
    expect(seen[0].method).toBe("GET"); expect(urls[0]).toContain("restaurantId=77");
    await expect((c as any).movements(undefined, {})).rejects.toThrow(/restaurantId/);
  });
  it("C3 respeta Retry-After en 429", async () => {
    let n = 0; const waits: number[] = [];
    const c = createFleetClient("wfk_a_b", (async () => (++n === 1 ? new Response("", { status: 429, headers: { "Retry-After": "7" } }) : ok({ data: [] }))) as unknown as typeof fetch, async (ms) => { waits.push(ms); });
    await c.restaurants(); expect(waits).toEqual([7000]); expect(c.calls).toBe(2);
  });
  it("C4 nunca devuelve el secreto en errores", () => {
    expect(redact("fallo con wfk_ab12cd34_SECRETVALUE")).not.toContain("SECRETVALUE");
  });
});

describe("estimateCalls", () => {
  it("E-cost dentro del límite de 10.000/h", () => {
    const e = estimateCalls({ restaurants: 25, days: 30, salesPagesPerDay: 2, syncPagesPerRun: 1, movementPagesPerRun: 1, runsPerDay: 24, cases: 21 });
    expect(e.peakPerHour).toBeLessThan(10000);
    expect(e).toMatchObject({ checkerOneShot: 71, reconcilerPerDay: 50, steadyStatePerDay: 1251, backfill: 1500 });
  });
});
