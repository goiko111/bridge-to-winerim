import { describe, expect, it } from "vitest";
import {
  mergeUnmappedReviewRows,
  unmappedFilterKey,
  type LegacyReviewRow,
} from "@/lib/reviewUnmapped";

const legacy = (overrides: Partial<LegacyReviewRow> = {}): LegacyReviewRow => ({
  provider_product_id: "legacy-1",
  name: "Vino legacy",
  family: "VINOS",
  sale_format: "BOTTLE",
  format_key: "BOTTLE",
  price: 24,
  units_recent: null,
  last_sale_at: null,
  mapping_status: null,
  legacy_state: "LEGACY_ONLY",
  ...overrides,
});

describe("unified unmapped review", () => {
  it("adds unresolved legacy products to the pending queue", () => {
    const rows = mergeUnmappedReviewRows({ activity: [], legacy: [legacy()] });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider_product_id: "legacy-1",
      legacy: true,
      decision_status: "DRAFT",
    });
  });

  it("keeps confirmed legacy mappings out even when activity also contains them", () => {
    const activity = [{
      provider_product_id: "legacy-1",
      provider_product_name: "Vino legacy",
      family: "VINOS",
      sale_format: "BOTTLE",
      format_key: "BOTTLE",
      units: 3,
      line_count: 1,
      last_sale_at: "2026-09-22T10:00:00Z",
      agora_price: 24,
      decision_status: "DRAFT",
      selected_winerim_id: null,
      selected_winerim_name: null,
      selected_format_key: null,
      force_ready: false,
      note: null,
      decided_at: null,
    }];

    const rows = mergeUnmappedReviewRows({
      activity,
      legacy: [legacy({ mapping_status: "CONFIRMED" })],
    });

    expect(rows).toEqual([]);
  });

  it("deduplicates activity and legacy while retaining the legacy origin", () => {
    const activity = [{
      provider_product_id: "legacy-1",
      provider_product_name: "Vino legacy",
      family: "VINOS",
      sale_format: "BOTTLE",
      format_key: "BOTTLE",
      units: 4,
      line_count: 2,
      last_sale_at: "2026-09-22T10:00:00Z",
      agora_price: 24,
      decision_status: "DRAFT",
      selected_winerim_id: null,
      selected_winerim_name: null,
      selected_format_key: null,
      force_ready: false,
      note: null,
      decided_at: null,
    }];

    const rows = mergeUnmappedReviewRows({ activity, legacy: [legacy()] });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ legacy: true, units: 4, line_count: 2 });
  });

  it("deduplicates an unknown legacy format when activity has one format for the product", () => {
    const activity = [{
      provider_product_id: "legacy-1",
      provider_product_name: "Vino legacy",
      family: "VINOS",
      sale_format: "GLASS",
      format_key: "GLASS",
      units: 2,
      line_count: 1,
      last_sale_at: "2026-09-22T10:00:00Z",
      agora_price: 8,
      decision_status: "DRAFT",
      selected_winerim_id: null,
      selected_winerim_name: null,
      selected_format_key: null,
      force_ready: false,
      note: null,
      decided_at: null,
    }];

    const rows = mergeUnmappedReviewRows({
      activity,
      legacy: [legacy({ sale_format: "SIN_DATO", format_key: "SIN_DATO" })],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sale_format: "GLASS", legacy: true, units: 2 });
  });

  it("uses the same restaurant-scoped storage key for navigation and listing", () => {
    expect(unmappedFilterKey("luruna-id")).toBe("review.unmapped.filters.luruna-id");
  });
});
