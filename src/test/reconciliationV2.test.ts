import { describe, expect, it } from "vitest";
import { buildAnalytics } from "../../supabase/functions/_shared/reconciliation-v2/analytics";
import { compareAuthorizedBatch, evaluateExternalResolution, reconcileLines } from "../../supabase/functions/_shared/reconciliation-v2/engine";
import { AUTHORIZED_EXTERNAL_RESOLUTIONS_19 } from "../../supabase/functions/_shared/reconciliation-v2/fixtures/authorized-external-resolutions-19";
import type { AgoraLine, ExternalResolutionCase, StockMovement, WinerimLine } from "../../supabase/functions/_shared/reconciliation-v2/types";
import { businessWindow } from "../../supabase/functions/_shared/reconciliation-v2/time";

const agora = (overrides: Partial<AgoraLine> = {}): AgoraLine => ({ connectionId: "11111111-1111-4111-8111-111111111111", restaurantId: 1, businessDay: "2026-09-28", documentId: "F-1", sourceSystem: "AGORA", externalOrderId: "O-1", orderId: null, sourceLineId: "L-1", wineId: "10", format: "botella", quantity: 1, amountMinor: 2500, effectiveAt: "2026-09-28T12:00:00", isOpen: false, isCancelled: false, ...overrides });
const winerim = (overrides: Partial<WinerimLine> = {}): WinerimLine => ({ restaurantId: 1, saleId: 100, lineId: "WL-1", saleDetailId: null, saleStatus: "confirmed", sourceSystem: "AGORA", externalOrderId: "O-1", orderId: null, sourceLineId: "L-1", invoiceId: "F-1", receiptId: "R-1", wineId: "10", format: "botella", quantity: 1, amountMinor: 2500, effectiveAt: "2026-09-28T12:00:00", businessDay: "2026-09-28", stockEffect: { known: true, status: "APPLIED", stockApplied: true, receiptId: "R-1", movementIds: [8], movementDifference: -1, unbackedQty: 0 }, ...overrides });
const complete = { agoraComplete: true, winerimComplete: true, stockComplete: true, pagesRead: 1, expectedPages: 1 };
const reconcile = (input: Omit<Parameters<typeof reconcileLines>[0], "connectionId">) => reconcileLines({ connectionId: "11111111-1111-4111-8111-111111111111", ...input });

describe("reconciliation engine", () => {
  it("matches exact source identity and consumes the Winerim line once", () => {
    const result = reconcile({ agora: [agora()], winerim: [winerim()], completeness: complete });
    expect(result).toHaveLength(1); expect(result[0].state).toBe("MATCHED"); expect(result[0].evidence.matchKind).toBe("EXACT_SOURCE_IDENTITY");
  });

  it("uses fallback only when date/time, wine, format, quantity and amount are all exact and unique", () => {
    const a = agora({ externalOrderId: null, sourceLineId: null });
    const one = winerim({ externalOrderId: null, sourceLineId: null });
    expect(reconcile({ agora: [a], winerim: [one], completeness: complete })[0].evidence.matchKind).toBe("UNIQUE_SIGNATURE_FALLBACK");
    const ambiguous = reconcile({ agora: [a], winerim: [one, { ...one, saleId: 101, lineId: "WL-2" }], completeness: complete });
    expect(ambiguous[0].state).toBe("AMBIGUOUS");
  });

  it("never classifies incomplete sources as a proven missing sale", () => {
    const result = reconcile({ agora: [agora()], winerim: [], completeness: { ...complete, winerimComplete: false } });
    expect(result[0].state).toBe("SOURCE_INCOMPLETE");
  });

  it("does not classify Winerim-only rows when Ágora coverage is zero", () => {
    const result = reconcile({ agora: [], winerim: [winerim()], completeness: { ...complete, agoraComplete: false, reason: "AGORA_NO_EVENTS_FOR_BUSINESS_DAY" } });
    expect(result[0].state).toBe("SOURCE_INCOMPLETE");
  });

  it("keeps source cancellations pending until a causally linked stock effect exists", () => {
    const result = reconcile({ agora: [agora({ isCancelled: true, externalOrderId: "T1", sourceLineId: "L1" })], winerim: [], completeness: complete });
    expect(result[0].state).toBe("DELETED_OR_CANCELLED"); expect(result[0].evidence.stockStatus).toBe("UNKNOWN");
  });

  it.each([
    [{ known: false, status: "UNKNOWN", stockApplied: null, receiptId: null, movementIds: [], movementDifference: null, unbackedQty: null }, "STOCK_UNKNOWN"],
    [{ known: true, status: "MOVEMENT_MISSING", stockApplied: null, receiptId: "R", movementIds: [], movementDifference: null, unbackedQty: null }, "STOCK_MISSING"],
    [{ known: true, status: "PARTIAL", stockApplied: true, receiptId: "R", movementIds: [1], movementDifference: -1, unbackedQty: 1 }, "STOCK_MISSING"],
  ])("keeps stock evidence states explicit", (stockEffect, state) => {
    const result = reconcile({ agora: [agora({ quantity: 2 })], winerim: [winerim({ quantity: 2, stockEffect })], completeness: complete });
    expect(result[0].state).toBe(state);
  });

  it.each([
    [agora({ quantity: 5, format: "copa" }), winerim({ quantity: 5, format: "copa", stockEffect: { known: true, status: "APPLIED", stockApplied: true, receiptId: "R", movementIds: [], movementDifference: null, unbackedQty: 0 } })],
    [agora({ quantity: 1, format: "copa" }), winerim({ quantity: 1, format: "copa", stockEffect: { known: true, status: "APPLIED", stockApplied: true, receiptId: "R", movementIds: [9], movementDifference: -1, unbackedQty: 0 } })],
    [agora({ quantity: 1, format: "botella" }), winerim({ quantity: 1, format: "botella", stockEffect: { known: true, status: "APPLIED", stockApplied: true, receiptId: "R", movementIds: [10], movementDifference: -1, unbackedQty: 0 } })],
  ])("trusts contractual stockEffect for glasses and bottles", (source, target) => {
    expect(reconcile({ agora: [source], winerim: [target], completeness: complete })[0].state).toBe("MATCHED");
  });
});

describe("restaurant business-day window", () => {
  it("uses the configured cutoff and handles Europe/Madrid DST", () => {
    expect(businessWindow({ metadata: { timezone: "Europe/Madrid", businessDayCutoffHour: 6 } }, "2026-09-28")).toMatchObject({ localFrom: "2026-09-28T06:00:00", from: "2026-09-28T04:00:00.000Z", to: "2026-09-29T04:00:00.000Z" });
    expect(businessWindow({ metadata: { timezone: "Europe/Madrid", businessDayCutoffHour: 6 } }, "2026-12-28").from).toBe("2026-12-28T05:00:00.000Z");
  });
});

describe("authoritative external resolution", () => {
  it("accepts exactly the 19 authorized SALE cases and rejects extras or omissions", () => {
    expect(compareAuthorizedBatch(AUTHORIZED_EXTERNAL_RESOLUTIONS_19, AUTHORIZED_EXTERNAL_RESOLUTIONS_19).state).toBe("MATCHED");
    const ocean = { caseFingerprint: "ocean-club-excluded", candidateTargets: [{ saleId: "183047", saleDetailId: null, qty: 1 }] };
    expect(compareAuthorizedBatch(AUTHORIZED_EXTERNAL_RESOLUTIONS_19, [...AUTHORIZED_EXTERNAL_RESOLUTIONS_19, ocean]).state).toBe("CARDINALITY_CONFLICT");
    expect(compareAuthorizedBatch(AUTHORIZED_EXTERNAL_RESOLUTIONS_19, AUTHORIZED_EXTERNAL_RESOLUTIONS_19.slice(1)).state).toBe("CARDINALITY_CONFLICT");
  });

  it("keeps all six DETAIL/glass cases blocked", () => {
    const fingerprints = [
      "89fc3241-ed1e-41b6-aee0-7fe8398c476c|2026-09-25|refund:2026-09-25:td:18 refund:2026-09-25:td:18|973012|copa",
      "5bed7bf7-f28a-4a1c-95f4-bc02ecb9298f|2026-09-13|refund:2026-09-13:td26:6 refund:2026-09-13:td26:6|1066406|copa",
      "d15af3ec-1225-4438-bb95-af672da43512|2026-09-07|refund:2026-09-07:td:993 refund:2026-09-07:td:994|986093|copa",
      "21ee3345-1090-4e83-94f2-43126d6e7695|2026-09-15|refund:2026-09-15:td:235 refund:2026-09-15:td:235|939936|copa",
      "e5b988f1-8471-4336-a1f7-a5c1626deab1|2026-09-22|refund:2026-09-22:td:113|972374|copa",
      "e5b988f1-8471-4336-a1f7-a5c1626deab1|2026-09-26|refund:2026-09-26:td:115|848012|copa",
    ];
    const verdicts = fingerprints.map((caseFingerprint, index) => evaluateExternalResolution({ auditCase: { id: String(index), connectionId: "c", caseFingerprint, identityScope: "DETAIL", evidenceClassification: "CONFIRMED_DUPLICATE_HISTORY", keepSaleIds: [], candidateTargets: [{ saleId: "1", saleDetailId: "2", qty: 1 }], expectedRestoredQty: 0 }, authoritativeBatch: AUTHORIZED_EXTERNAL_RESOLUTIONS_19, liveSaleIds: [], confirmedKeptSaleIds: [], deletions: [], movements: [], checkedAt: "2026-09-28T00:00:00Z" }).verdict);
    expect(verdicts).toEqual(Array(6).fill("BLOCKED_DETAIL_SCOPE"));
  });

  it("requires causal movement links and accepts multiple exact movements that sum correctly", () => {
    const authorized = AUTHORIZED_EXTERNAL_RESOLUTIONS_19[0]; const target = authorized.candidateTargets[0];
    const auditCase: ExternalResolutionCase = { id: "audit", connectionId: authorized.connectionId, caseFingerprint: authorized.caseFingerprint, identityScope: "SALE", evidenceClassification: "CONFIRMED_DUPLICATE_STOCK", keepSaleIds: authorized.keepSaleIds, candidateTargets: authorized.candidateTargets, expectedRestoredQty: 1 };
    const movement = (id: number, linked: boolean, change: number): StockMovement => ({ movementId: id, category: "return", change, quantityBefore: 5, quantityAfter: 5 + change, wine: { wineId: Number(target.wineId) }, variant: { priceId: null, stockId: null, format: target.format ?? null }, sale: linked ? { saleId: Number(target.saleId), saleDetailIds: [], receiptId: target.receiptId ?? null, orderId: null } : null, reference: null });
    const common = { auditCase, authoritativeBatch: AUTHORIZED_EXTERNAL_RESOLUTIONS_19, liveSaleIds: [], confirmedKeptSaleIds: authorized.keepSaleIds.map(Number), deletions: [{ saleId: Number(target.saleId), saleDetailId: null, lineId: "x", reason: "sale_cancelled" as const, deletedAt: "2026-09-28T00:00:00Z", effectiveAt: null, externalOrderId: null }], checkedAt: "2026-09-28T00:00:00Z" };
    expect(evaluateExternalResolution({ ...common, movements: [movement(1, false, 1)] }).verdict).toBe("EXTERNAL_RESOLUTION_EVIDENCE_INCOMPLETE");
    expect(evaluateExternalResolution({ ...common, movements: [movement(2, true, 0.4), movement(3, true, 0.6)] }).verdict).toBe("RESOLVED_EXTERNALLY");
  });
});

describe("analytics", () => {
  it("keeps explicit categories, subtracts returns and leaves margins null when costs are incomplete", () => {
    const rows = buildAnalytics([
      { connectionId: "c", effectiveAt: "2026-09-28T10:00:00Z", category: "WINE", quantity: 2, revenueMinor: 3000, costMinor: 1000, ticketId: "A", isReturn: false, currency: "EUR" },
      { connectionId: "c", effectiveAt: "2026-09-28T11:00:00Z", category: "FOOD", quantity: 1, revenueMinor: 2000, costMinor: null, ticketId: "A", isReturn: false, currency: "EUR" },
      { connectionId: "c", effectiveAt: "2026-09-28T12:00:00Z", category: "WINE", quantity: 1, revenueMinor: 1500, costMinor: 500, ticketId: "B", isReturn: true, currency: "EUR" },
    ], "2026-09-28");
    const dayWine = rows.find((row) => row.period === "DAY" && row.category === "WINE")!; const total = rows.find((row) => row.period === "DAY" && row.category === "ALL")!;
    expect(dayWine.revenueMinor).toBe(1500); expect(dayWine.quantity).toBe(1); expect(dayWine.revenueShare).toBeCloseTo(1500 / 3500); expect(total.marginMinor).toBeNull();
    expect(rows.some((row) => row.period === "ROLLING_7D")).toBe(true); expect(rows.some((row) => row.period === "ROLLING_28D")).toBe(true);
  });
});
