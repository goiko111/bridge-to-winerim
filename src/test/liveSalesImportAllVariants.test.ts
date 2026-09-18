import { describe, expect, it } from "vitest";
import {
  isLiveSalesImportForAllVariantsEnabled,
  shouldRequireWinerimSalesImportStockApplied,
} from "../../supabase/functions/_shared/stockSyncUtils.ts";

describe("live sales import for all variants", () => {
  it("is disabled unless explicitly enabled per connection", () => {
    expect(isLiveSalesImportForAllVariantsEnabled(null)).toBe(false);
    expect(isLiveSalesImportForAllVariantsEnabled({})).toBe(false);
    expect(isLiveSalesImportForAllVariantsEnabled({ live_sales_import_all_variants: "true" })).toBe(false);
    expect(isLiveSalesImportForAllVariantsEnabled({ live_sales_import_all_variants: true })).toBe(true);
  });

  it("requires stock applied for bottles routed through the live lane", () => {
    expect(shouldRequireWinerimSalesImportStockApplied({ variant: "botella", mode: "operational" })).toBe(false);
    expect(
      shouldRequireWinerimSalesImportStockApplied({ variant: "botella", mode: "operational", forceLive: true }),
    ).toBe(true);
    expect(
      shouldRequireWinerimSalesImportStockApplied({ variant: "botella", mode: "historical", forceLive: true }),
    ).toBe(false);
    expect(shouldRequireWinerimSalesImportStockApplied({ variant: "copa", mode: "operational" })).toBe(true);
  });
});
