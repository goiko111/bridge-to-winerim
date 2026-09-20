import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(process.cwd(), "supabase/functions/winerim-proxy/index.ts"),
  "utf8",
);

describe("Winerim catalog list walk: no deactivation from a bad read", () => {
  it("reports whether the paginated list walk really saw the whole catalog", () => {
    expect(source).toContain("interface WineListWalk");
    expect(source).toContain("if (page < totalPages) incompleteReason = `empty_page_${page}_of_${totalPages}`");
    expect(source).toContain("incompleteReason = `fetched_${allWines.length}_of_${expectedTotal}`");
    expect(source).toContain("complete: incompleteReason === null");
  });

  it("skips deletion reconciliation on a truncated, empty or mass-deactivating read", () => {
    expect(source).toContain('reconciliationSkippedReason = `incomplete_list_walk:${listWalkIncompleteReason}`');
    expect(source).toContain('reconciliationSkippedReason = "empty_list_response"');
    expect(source).toContain("massDeactivation");
    expect(source).toContain("MASS_DEACTIVATION_RATIO");
    expect(source).toContain("if (missingFromWinerim.length > 0 && reconciliationSkippedReason)");
  });

  it("restores only automatically hidden products once the price is live again", () => {
    expect(source).toContain('AUTOMATIC_HIDE_TRIGGERS = new Set(["AUTO_DEACTIVATION", "AUTO_PRICE_REMOVED"])');
    expect(source).toContain("const restoreAutoHiddenWines = async (");
    expect(source).toContain('wine.pricing_status !== "READY"');
    expect(source).toContain("Number(formatRow.sale_price) > 0");
    // Visibility is only trusted after Agora confirms it back.
    expect(source).toContain("(v) => v?.ok === true");
    expect(source).toContain('sync_status: "VERIFIED"');
  });

  it("restores products inside their existing family, never as main-screen direct sales", () => {
    expect(source).toContain("useAsDirectSale: false");
    expect(source).toContain("saleableAsMain: true");
    expect(source).not.toContain("productId: String(r.agora_product_id), visible: true");
  });
});
