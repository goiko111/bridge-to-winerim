import { describe, expect, it } from "vitest";
import { splitSourceCoverage, type AgoraDbLine, type WineCandidateClassification } from "../../supabase/functions/_shared/reconciliation-v2/agoraReader";

const line = (id: string, name: string, extra: Partial<AgoraDbLine> = {}): AgoraDbLine => ({ id, connection_id: "c1", provider_product_id: `p-${id}`, format: null, quantity: 1, total_amount: 2, winerim_product_id: null, mapped: false, name, sales_event: { provider_doc_id: "d", business_day: "2026-09-27", doc_type: "BasicInvoice", raw_json: {} }, ...extra });
const run = (items: { row: AgoraDbLine; classification: WineCandidateClassification; id: boolean }[], unmappedWine = 0) => {
  const ids = new Set(items.filter((i) => i.id).map((i) => i.row.id));
  return splitSourceCoverage({ eventCount: 1, pageComplete: true, classified: items, hasProviderIdentity: (r) => ids.has(r.id), hasAmount: (r) => ids.has(r.id), unresolvedMappedWine: 0, unmappedWine });
};
const okWine = { row: line("w", "Rioja", { mapped: true, winerim_product_id: "9" }), classification: "WINE" as const, id: true };

describe("wine vs analytics coverage split", () => {
  it("duplicate non-wine lines without identity do not block wine coverage", () => {
    const cafe = line("c", "CAFE");
    const r = run([okWine, { row: cafe, classification: "NOT_WINE", id: false }, { row: { ...cafe, id: "c2", sales_event: { ...cafe.sales_event, doc_type: "OpenTicket" } }, classification: "NOT_WINE", id: false }]);
    expect(r.wineReconciliationCoverage.complete).toBe(true);
    expect(r.metrics).toMatchObject({ unresolvedAllLines: 2, unresolvedWineLines: 0, unresolvedNonWineLines: 2, unknownClassificationLines: 0 });
    expect(r.analyticsCoverage.complete).toBe(false);
    expect(r.analyticsCoverage.lines).toBe(3);
  });
  it("wine without identity blocks", () => {
    const r = run([okWine, { row: line("w2", "Verdejo"), classification: "WINE", id: false }]);
    expect(r.wineReconciliationCoverage.reasons).toContain("AGORA_IDENTITY_UNRESOLVED");
    expect(r.metrics.unresolvedWineLines).toBe(1);
    expect(r.analyticsCoverage.complete).toBe(false);
  });
  it("UNKNOWN blocks and is grouped without payload", () => {
    const f = line("f", "FRISONA", { is_wine_candidate: true });
    const r = run([okWine, { row: f, classification: "UNKNOWN", id: false }, { row: { ...f, id: "f2" }, classification: "UNKNOWN", id: false }]);
    expect(r.wineReconciliationCoverage.complete).toBe(false);
    expect(r.wineReconciliationCoverage.reasons).toContain("AGORA_WINE_CLASSIFICATION_INCOMPLETE");
    expect(r.metrics.unknownProducts).toEqual([{ providerProductId: "p-f", name: "FRISONA", count: 2 }]);
    expect(JSON.stringify(r)).not.toContain("raw_json");
    expect(r.analyticsCoverage.complete).toBe(false);
  });
  it("unmapped WINE blocks", () => {
    expect(run([okWine], 1).wineReconciliationCoverage.reasons).toContain("AGORA_WINE_MAPPING_INCOMPLETE");
  });
});
