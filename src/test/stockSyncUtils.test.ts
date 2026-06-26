import {
  buildStockSyncGroupKey,
  buildStockSyncIdempotencyKey,
  decideSalesCursorAdvance,
  findEntryForVariant,
  findStockForVariant,
  isStockGroupAlreadySynced,
  isTerminalStockSyncError,
  normalizeWinerimVariant,
  parseWinerimStockRows,
  salesImportQtyWhenStockDidNotMove,
  variantForAgoraFormat,
} from "../../supabase/functions/_shared/stockSyncUtils";

describe("stock sync utils", () => {
  it("normalizes Winerim variants in Spanish and English", () => {
    expect(normalizeWinerimVariant("copa")).toBe("copa");
    expect(normalizeWinerimVariant("glass")).toBe("copa");
    expect(normalizeWinerimVariant("botella")).toBe("botella");
    expect(normalizeWinerimVariant("bottle")).toBe("botella");
    expect(normalizeWinerimVariant("magnum")).toBe("magnum");
    expect(normalizeWinerimVariant("unknown")).toBeNull();
  });

  it("maps Agora sale formats to canonical Winerim variants", () => {
    expect(variantForAgoraFormat("COPA")).toBe("copa");
    expect(variantForAgoraFormat("Glass")).toBe("copa");
    expect(variantForAgoraFormat("MAGNUM")).toBe("magnum");
    expect(variantForAgoraFormat("BOTELLA")).toBe("botella");
    expect(variantForAgoraFormat(null)).toBe("botella");
  });

  it("finds price and stock rows by variant aliases", () => {
    const prices = [
      { variant: "glass", price: "7.50" },
      { variant: "bottle", price: "42.00" },
    ];
    expect(findEntryForVariant(prices, "copa")?.price).toBe("7.50");
    expect(findEntryForVariant(prices, "botella")?.price).toBe("42.00");

    const stocks = parseWinerimStockRows({
      stocks: [
        { id: 101, stock: 8, winePrice: { variant: "glass" } },
        { id: 102, stock: 12, winePrice: { variant: "botella" } },
      ],
    });
    expect(findStockForVariant(stocks, "copa")?.id).toBe(101);
    expect(findStockForVariant(stocks, "botella")?.id).toBe(102);
  });

  it("builds line-level idempotency keys per variant", () => {
    const glassKey = buildStockSyncIdempotencyKey("conn-1", "line-1", "copa");
    const bottleKey = buildStockSyncIdempotencyKey("conn-1", "line-1", "botella");
    expect(glassKey).toBe("conn-1:line-1:copa");
    expect(glassKey).not.toBe(bottleKey);
  });

  it("builds stable event/wine/variant keys that survive line re-inserts", () => {
    const firstLineKey = buildStockSyncIdempotencyKey("conn-1", "line-old", "copa");
    const secondLineKey = buildStockSyncIdempotencyKey("conn-1", "line-new", "copa");
    const groupKey = buildStockSyncGroupKey("event-1", "wine-1", "copa");

    expect(firstLineKey).not.toBe(secondLineKey);
    expect(groupKey).toBe("event-1:wine-1:copa");
    expect(groupKey).toBe(buildStockSyncGroupKey("event-1", "wine-1", "copa"));
  });

  it("recognizes already synced stock groups, including legacy rows without variant", () => {
    const rows = [
      { sales_event_id: "event-1", winerim_product_id: "wine-1", variant: "glass" },
      { sales_event_id: "event-2", winerim_product_id: "wine-2", variant: null },
    ];

    expect(isStockGroupAlreadySynced(rows, "event-1", "wine-1", "copa")).toBe(true);
    expect(isStockGroupAlreadySynced(rows, "event-1", "wine-1", "botella")).toBe(false);
    expect(isStockGroupAlreadySynced(rows, "event-2", "wine-2", "magnum")).toBe(true);
  });

  it("keeps the sales cursor behind when stock still needs retry", () => {
    expect(decideSalesCursorAdvance({
      resolvedLines: 3,
      hasWinerimToken: true,
      stockFailed: 1,
    })).toEqual({ advance: false, reason: "stock_failed" });

    expect(decideSalesCursorAdvance({
      resolvedLines: 3,
      hasWinerimToken: false,
      stockFailed: 0,
    })).toEqual({ advance: false, reason: "missing_winerim_token" });

    expect(decideSalesCursorAdvance({
      resolvedLines: 3,
      hasWinerimToken: true,
      stockFailed: 0,
    })).toEqual({ advance: true, reason: "stock_ok" });

    expect(decideSalesCursorAdvance({
      resolvedLines: 0,
      hasWinerimToken: false,
      stockFailed: 0,
    })).toEqual({ advance: true, reason: "stock_not_required" });
  });

  it("classifies terminal stock failures that should not be logged repeatedly", () => {
    expect(isTerminalStockSyncError("GET /stock/wine/123 -> 404: Wine not found")).toBe(true);
    expect(isTerminalStockSyncError("Variant 'copa' not found for wine 123")).toBe(true);
    expect(isTerminalStockSyncError("timeout connecting to Winerim")).toBe(false);
  });

  it("imports sales history only when stock did not move", () => {
    expect(salesImportQtyWhenStockDidNotMove({
      soldQty: 3,
      previousStock: 0,
      newStock: 0,
    })).toBe(3);

    expect(salesImportQtyWhenStockDidNotMove({
      soldQty: 3,
      previousStock: 10,
      newStock: 7,
    })).toBe(0);

    expect(salesImportQtyWhenStockDidNotMove({
      soldQty: 0,
      previousStock: 0,
      newStock: 0,
    })).toBe(0);
  });
});
