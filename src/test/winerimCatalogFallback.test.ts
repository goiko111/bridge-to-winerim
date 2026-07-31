import { describe, expect, it } from "vitest";
import {
  canUseWinerimListPayloadAsDetailFallback,
  normalizeWinerimCatalogFields,
} from "../../supabase/functions/_shared/winerimCatalogFallback";

describe("Winerim catalog detail fallback", () => {
  const smallBottle = {
    id: 180931,
    name: "Emilio Moro",
    active: true,
    prices: [{
      variant: "botella-pequena",
      price: "26",
      erpStock: { id: 208854, stock: 3 },
    }],
  };

  it("recovers an active small-bottle variant from the list payload", () => {
    const normalized = normalizeWinerimCatalogFields(smallBottle);

    expect(normalized.isActive).toBe(true);
    expect(normalized.bottleSalePrice).toBe(26);
    expect(normalized.bottleStockId).toBe(208854);
    expect(normalized.stockQuantity).toBe(3);
    expect(canUseWinerimListPayloadAsDetailFallback(smallBottle, "detail_fetch_failed")).toBe(true);
  });

  it("recovers a regular bottle from the list payload", () => {
    const normalized = normalizeWinerimCatalogFields({
      id: 180939,
      active: true,
      prices: [{ variant: "botella", price: "39.50", erpStock: { id: 208862, stock: 3 } }],
    });

    expect(normalized.bottleSalePrice).toBe(39.5);
    expect(normalized.bottleStockId).toBe(208862);
  });

  it("does not mask transient failures or payloads without usable prices", () => {
    expect(canUseWinerimListPayloadAsDetailFallback(smallBottle, "503_from_winerim")).toBe(false);
    expect(canUseWinerimListPayloadAsDetailFallback({ active: true, prices: [] }, "detail_fetch_failed")).toBe(false);
  });
});
