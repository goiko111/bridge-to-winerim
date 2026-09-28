import { describe, expect, it } from "vitest";
import { compareAuthorizedBatch, evaluateExternalResolution, reconcileLines } from "../../supabase/functions/_shared/reconciliation-v2/engine";
import { createWinerimFleetClient } from "../../supabase/functions/_shared/reconciliation-v2/winerimFleetClient";
import type { AgoraLine, ExternalResolutionCase, SaleDeletion, StockMovement, WinerimLine } from "../../supabase/functions/_shared/reconciliation-v2/types";

const connectionId = "8466c229-773d-4ad9-a747-9bb862d7ae6b";
const target = { saleId: "188690", saleDetailId: null, qty: 1, receiptId: "rcpt-1", wineId: "900", priceId: "11", stockId: "22", format: "botella" };
const auditCase = (over: Partial<ExternalResolutionCase> = {}): ExternalResolutionCase => ({ id: "c1", connectionId, caseFingerprint: "fp-1", identityScope: "SALE", evidenceClassification: "CONFIRMED_DUPLICATE_STOCK", keepSaleIds: ["188510"], candidateTargets: [target], expectedRestoredQty: 1, ...over });
const deletion = (over: Partial<SaleDeletion> = {}): SaleDeletion => ({ saleId: 188690, saleDetailId: null, lineId: "sale:188690", reason: "sale_cancelled", deletedAt: "2026-09-27T10:04:00+02:00", effectiveAt: null, externalOrderId: null, ...over });
const movement = (over: Partial<StockMovement> = {}): StockMovement => ({ movementId: 5001, category: "return", change: 1, quantityBefore: 6, quantityAfter: 7, wine: { wineId: 900 }, variant: { priceId: 11, stockId: 22, format: "botella" }, sale: { saleId: 188690, saleDetailIds: [], receiptId: "rcpt-1", orderId: null }, reference: null, ...over });
const evaluate = (over: Partial<Parameters<typeof evaluateExternalResolution>[0]> = {}) => evaluateExternalResolution({ auditCase: auditCase(), authoritativeBatch: [{ caseFingerprint: "fp-1", candidateTargets: [target] }], liveSaleIds: [], confirmedKeptSaleIds: [188510], deletions: [deletion()], movements: [movement()], checkedAt: "2026-09-28T07:00:00Z", ...over });

describe("adapted external-resolution coverage", () => {
  it("E1 resolves a whole-sale cancellation with exact evidence", () => expect(evaluate().verdict).toBe("RESOLVED_EXTERNALLY"));
  it("E2 requires sale_cancelled", () => expect(evaluate({ deletions: [] }).missing).toContain("sale_cancelled"));
  it("E3 requires a causally linked return", () => expect(evaluate({ movements: [] }).missing).toContain("return_movement_exact_link"));
  it("E4 rejects an incorrect restored quantity", () => expect(evaluate({ movements: [movement({ change: 2, quantityAfter: 8 })] }).missing).toContain("movement_quantity_conflict"));
  it("E5 requires every kept sale", () => expect(evaluate({ confirmedKeptSaleIds: [] }).missing).toContain("kept_sale_present"));
  it("E6 reports a live candidate as not cancelled", () => expect(evaluate({ liveSaleIds: [188690] }).verdict).toBe("NOT_CANCELLED_YET"));
  it("E7 blocks DETAIL scope", () => expect(evaluate({ auditCase: auditCase({ identityScope: "DETAIL" }) }).verdict).toBe("BLOCKED_DETAIL_SCOPE"));
  it("E8 rejects non-confirmed duplicate classifications", () => expect(evaluate({ auditCase: auditCase({ evidenceClassification: "PROBABLE_DUPLICATE" }) }).verdict).toBe("NOT_ELIGIBLE"));
  it("E9 requires exactly one candidate sale", () => expect(evaluate({ auditCase: auditCase({ candidateTargets: [target, { ...target, saleId: "188691" }] }) }).verdict).toBe("CARDINALITY_CONFLICT"));
  it("E10 rejects a changed authoritative fingerprint", () => expect(evaluate({ auditCase: auditCase({ caseFingerprint: "changed" }) }).verdict).toBe("CARDINALITY_CONFLICT"));
  it("E11 does not infer causality from matching wine and time", () => expect(evaluate({ movements: [movement({ sale: null, reference: null })] }).missing).toContain("return_movement_exact_link"));
  it("E12 accepts an exact sale reference without temporal proximity", () => expect(evaluate({ movements: [movement({ sale: null, reference: { type: "sale", id: 188690 } })] }).verdict).toBe("RESOLVED_EXTERNALLY"));
  it("E13 accepts several exact movements when their sum matches", () => expect(evaluate({ movements: [movement({ movementId: 1, change: 0.4, quantityAfter: 6.4 }), movement({ movementId: 2, change: 0.6, quantityBefore: 6.4, quantityAfter: 7 })] }).verdict).toBe("RESOLVED_EXTERNALLY"));
  it("E14 requires quantities on linked movements", () => expect(evaluate({ movements: [movement({ change: null, quantityBefore: null, quantityAfter: null })] }).missing).toContain("movement_quantities"));
  it("E15 history-only remains incomplete without independent stock readback", () => expect(evaluate({ auditCase: auditCase({ evidenceClassification: "CONFIRMED_DUPLICATE_HISTORY", expectedRestoredQty: 0 }), movements: [] }).missing).toContain("history_only_cancellation_stock_readback"));
  it("E16 history-only conflicts with an exact unexpected return", () => expect(evaluate({ auditCase: auditCase({ evidenceClassification: "CONFIRMED_DUPLICATE_HISTORY", expectedRestoredQty: 0 }) }).verdict).toBe("CONFLICT"));
});

const agora = (over: Partial<AgoraLine> = {}): AgoraLine => ({ connectionId, restaurantId: 839, businessDay: "2026-09-25", documentId: "42531", sourceSystem: "AGORA", externalOrderId: "T-42531", orderId: null, sourceLineId: "1", wineId: "900", format: "botella", quantity: 1, amountMinor: 2500, effectiveAt: "2026-09-25T21:00:00", isOpen: false, isCancelled: false, ...over });
const winerim = (over: Partial<WinerimLine> = {}): WinerimLine => ({ restaurantId: 839, saleId: 188510, lineId: "sale:188510", saleDetailId: null, saleStatus: "confirmed", sourceSystem: "AGORA", externalOrderId: "T-42531", orderId: null, sourceLineId: "1", invoiceId: "42531", receiptId: "rcpt-1", wineId: "900", format: "botella", quantity: 1, amountMinor: 2500, effectiveAt: "2026-09-25T21:00:00", businessDay: "2026-09-25", stockEffect: { known: true, status: "APPLIED", stockApplied: true, receiptId: "rcpt-1", movementIds: [1], movementDifference: -1, unbackedQty: 0 }, ...over });
const complete = { agoraComplete: true, winerimComplete: true, stockComplete: true, pagesRead: 1, expectedPages: 1 };

describe("adapted daily audit coverage", () => {
  it("R1 exact identity matches", () => expect(reconcileLines({ connectionId, agora: [agora()], winerim: [winerim()], completeness: complete })[0].state).toBe("MATCHED"));
  it("R2 duplicate exact identities are never consumed automatically", () => expect(reconcileLines({ connectionId, agora: [agora()], winerim: [winerim(), winerim({ saleId: 188511, lineId: "sale:188511" })], completeness: complete })[0].state).toBe("AMBIGUOUS"));
  it("R3 missing history stays audit-only", () => { const row = reconcileLines({ connectionId, agora: [agora()], winerim: [], completeness: complete })[0]; expect(row.state).toBe("HISTORY_MISSING"); expect(row.mode).toBe("AUDIT_ONLY"); });
  it("R4 incomplete pagination never becomes a proven missing sale", () => expect(reconcileLines({ connectionId, agora: [agora()], winerim: [], completeness: { ...complete, winerimComplete: false } })[0].state).toBe("SOURCE_INCOMPLETE"));
});

describe("adapted fleet-client coverage", () => {
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  it("C1 rejects non-fleet credentials", () => expect(() => createWinerimFleetClient({ token: "abc" })).toThrow());
  it("C2 composes the relative /sales/records resource on the v2 base", async () => { const seen: string[] = []; const client = createWinerimFleetClient({ token: "wfk_test", fetchImpl: async (url) => { seen.push(String(url)); return ok({ restaurantId: 839, data: [], deletions: [], sync: { nextCursor: "c", hasMore: false } }); } }); await client.salesSync(839, { changedSince: "2026-09-27T00:00:00+02:00" }); expect(new URL(seen[0]).pathname).toBe("/api/v2/sales/records"); });
  it("C3 stops immediately on authorization errors", async () => { let calls = 0; const client = createWinerimFleetClient({ token: "wfk_test", fetchImpl: async () => { calls += 1; return new Response("", { status: 403 }); }, sleep: async () => {} }); await expect(client.restaurants()).rejects.toMatchObject({ code: "HTTP_403" }); expect(calls).toBe(1); });
  it("C4 bounds retries", async () => { let calls = 0; const client = createWinerimFleetClient({ token: "wfk_test", fetchImpl: async () => { calls += 1; return new Response("", { status: 503 }); }, sleep: async () => {} }); await expect(client.restaurants()).rejects.toMatchObject({ code: "HTTP_503" }); expect(calls).toBe(3); });
});

describe("adapted batch contract", () => {
  it("B1 detects additions and omissions in the authorized set", () => { const one = [{ caseFingerprint: "fp", candidateTargets: [target] }]; expect(compareAuthorizedBatch(one, one).state).toBe("MATCHED"); expect(compareAuthorizedBatch(one, []).state).toBe("CARDINALITY_CONFLICT"); });
});
