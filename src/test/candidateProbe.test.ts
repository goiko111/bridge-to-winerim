import { describe, expect, it } from "vitest";
import { assertClosedBusinessDay, nextBusinessDay, normalizeCandidateSales, parseCandidateProbeRequest } from "../../supabase/functions/_shared/reconciliation-v2/candidateProbe";

const connectionId = "1c5177f1-9459-4ee9-8b6e-4780f8b6b96b";

describe("bounded candidate probe", () => {
  it("accepts only the fixed action and exact body", () => {
    expect(parseCandidateProbeRequest({ action: "VERIFY_CANDIDATE_SALES", connectionId, restaurantId: 346, businessDay: "2026-09-27" })).toEqual({ action: "VERIFY_CANDIDATE_SALES", connectionId, restaurantId: 346, businessDay: "2026-09-27" });
    expect(() => parseCandidateProbeRequest({ action: "VERIFY_CANDIDATE_SALES", connectionId, restaurantId: 346, businessDay: "2026-09-27", path: "/anything" })).toThrow(/Campos no permitidos/);
    expect(() => parseCandidateProbeRequest({ action: "GET", connectionId, restaurantId: 346, businessDay: "2026-09-27" })).toThrow();
  });

  it("enforces one closed calendar day", () => {
    expect(nextBusinessDay("2026-09-27")).toBe("2026-09-28");
    expect(() => assertClosedBusinessDay("2026-09-27", "Europe/Madrid", new Date("2026-09-28T08:00:00Z"))).not.toThrow();
    expect(() => assertClosedBusinessDay("2026-09-28", "Europe/Madrid", new Date("2026-09-28T08:00:00Z"))).toThrow(/día local ya cerrado/);
  });

  it("returns normalized evidence and omits free-form table and raw payload fields", () => {
    const evidence = normalizeCandidateSales([{ saleId: 9, status: "confirmed", effectiveAt: "2026-09-27T12:00:00", timeReliable: true, recordedAt: null, updatedAt: "2026-09-27T12:01:00+02:00", wine: { wineId: 88, name: "Vino" }, variant: { priceId: 99, stockId: 100, format: "botella", name: "Botella" }, qty: 1, servedQty: null, bottleOpen: false, unbackedQty: 0, amounts: { total: 25, basis: "sale_total", currency: "EUR" }, source: { origin: "tpv", channel: "api_token", contract: "mode", integrationId: "x", recordType: "api_tpv", externalOrderId: "T-1", serviceChannel: "carta", tableNumber: "Mesa secreta", arbitrary: "drop" }, lines: [{ lineId: "sale:9", saleDetailId: null, lineType: "sale", format: "botella", qty: 1, unitAmount: 25, totalAmount: 25, taxIncluded: true, effectiveAt: "2026-09-27T12:00:00", timeReliable: true, recordedAt: null, source: { origin: "tpv", channel: "api_token", contract: "mode", externalOrderId: "T-1", sourceSystem: "agora", sourceLineId: "1", invoiceId: "F-1", receiptId: "R-1", mode: "history_and_stock", other: "drop" }, stockEffect: { known: true, status: "APPLIED", stockApplied: true, receiptId: "R-1", movements: [{ stockMovementId: 7, difference: -1, unitsBefore: 3, unitsAfter: 2, exists: true, raw: "drop" }] } }], raw: { secret: true } }]);
    expect(evidence[0].saleId).toBe(9);
    expect(JSON.stringify(evidence)).not.toContain("Mesa secreta");
    expect(JSON.stringify(evidence)).not.toContain("arbitrary");
    expect(JSON.stringify(evidence)).not.toContain("secret");
    expect(evidence[0].lines[0].stockEffect?.movements?.[0].stockMovementId).toBe(7);
  });
});
