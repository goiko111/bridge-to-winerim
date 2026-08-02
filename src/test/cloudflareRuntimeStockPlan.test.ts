import { describe, expect, it } from "vitest";
import {
  planWinerimStockMutation,
  WinerimMutationPlanError,
  WinerimStockIdentity,
} from "../../cloudflare/workers/middleware-runtime/src/handlers/stock";

const bottle: WinerimStockIdentity = {
  wineId: "wine-42",
  stockId: 4201,
  variant: "bottle",
};

const glass: WinerimStockIdentity = {
  wineId: "wine-42",
  stockId: 4202,
  variant: "glass",
};

describe("Cloudflare runtime Winerim stock planning", () => {
  it("plans operational bottle stock as one absolute PUT to its own variant", () => {
    const plan = planWinerimStockMutation({
      mode: "operational",
      orderId: "provider:order-1:bottle",
      soldAt: "2026-08-02T12:00:00Z",
      quantity: 2,
      soldStock: bottle,
      stockSource: bottle,
      currentSourceStock: 7,
    });

    expect(plan).toMatchObject({
      mode: "operational",
      mutatesStock: true,
      requiresLiveStockCertification: false,
      request: {
        kind: "stock-put",
        method: "PUT",
        path: "/api/v2/stock/4201",
        body: { stock: 5 },
      },
    });
  });

  it("never makes an operational bottle stock target negative", () => {
    const plan = planWinerimStockMutation({
      mode: "operational",
      orderId: "provider:order-2:bottle",
      soldAt: "2026-08-02T12:00:00Z",
      quantity: 4,
      soldStock: bottle,
      stockSource: bottle,
      currentSourceStock: 1,
    });

    expect(plan.request).toMatchObject({ kind: "stock-put", body: { stock: 0 } });
  });

  it("plans an operational glass sale with live true and the sold glass stockId", () => {
    const plan = planWinerimStockMutation({
      mode: "operational",
      orderId: "provider:order-3:glass",
      soldAt: "2026-08-02T12:00:00Z",
      quantity: 3,
      soldStock: glass,
      stockSource: bottle,
    });

    expect(plan).toMatchObject({
      mutatesStock: true,
      requiresLiveStockCertification: true,
      soldStock: glass,
      stockSource: bottle,
      request: {
        kind: "sales-import",
        method: "POST",
        path: "/api/v2/sales/import",
        body: {
          live: true,
          sales: [{
            stockId: 4202,
            qty: 3,
            soldAt: "2026-08-02T12:00:00Z",
            orderId: "provider:order-3:glass",
          }],
        },
      },
    });
    expect(JSON.stringify(plan.request.body)).not.toContain("4201");
  });

  it("keeps historical imports sales-only for every variant", () => {
    for (const soldStock of [glass, bottle] as const) {
      const plan = planWinerimStockMutation({
        mode: "historical",
        orderId: `history:${soldStock.variant}`,
        soldAt: "2026-05-01T12:00:00Z",
        quantity: 2,
        soldStock,
        stockSource: soldStock.variant === "glass" ? bottle : soldStock,
        currentSourceStock: 99,
      });

      expect(plan.mutatesStock).toBe(false);
      expect(plan.requiresLiveStockCertification).toBe(false);
      expect(plan.request.kind).toBe("sales-import");
      expect(plan.request.body).toEqual({
        sales: [{
          stockId: soldStock.stockId,
          qty: 2,
          soldAt: "2026-05-01T12:00:00Z",
          orderId: `history:${soldStock.variant}`,
        }],
      });
      expect("live" in plan.request.body).toBe(false);
    }
  });

  it("fails closed when the sold variant and stock source identity are unsafe", () => {
    const wrongWine = { ...bottle, wineId: "wine-other" };
    const wrongBottleSource = { ...bottle, stockId: 9999 };
    const magnum = { wineId: "wine-42", stockId: 4203, variant: "magnum" as const };

    expect(() => planWinerimStockMutation({
      mode: "operational",
      orderId: "unsafe-cross-wine",
      soldAt: "2026-08-02",
      quantity: 1,
      soldStock: glass,
      stockSource: wrongWine,
    })).toThrowError(expect.objectContaining({ code: "CROSS_WINE_STOCK_SOURCE" }));

    expect(() => planWinerimStockMutation({
      mode: "operational",
      orderId: "unsafe-other-stock",
      soldAt: "2026-08-02",
      quantity: 1,
      soldStock: bottle,
      stockSource: wrongBottleSource,
      currentSourceStock: 5,
    })).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_STOCK_SOURCE" }));

    expect(() => planWinerimStockMutation({
      mode: "operational",
      orderId: "unsafe-magnum-source",
      soldAt: "2026-08-02",
      quantity: 1,
      soldStock: magnum,
      stockSource: bottle,
      currentSourceStock: 5,
    })).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_STOCK_SOURCE" }));
  });

  it("rejects malformed mutation inputs before producing a request", () => {
    expect(() => planWinerimStockMutation({
      mode: "operational",
      orderId: "",
      soldAt: "2026-08-02",
      quantity: 1,
      soldStock: bottle,
      stockSource: bottle,
      currentSourceStock: 5,
    })).toThrow(WinerimMutationPlanError);

    expect(() => planWinerimStockMutation({
      mode: "operational",
      orderId: "bad-qty",
      soldAt: "2026-08-02",
      quantity: 0.5,
      soldStock: bottle,
      stockSource: bottle,
      currentSourceStock: 5,
    })).toThrowError(expect.objectContaining({ code: "INVALID_QUANTITY" }));
  });
});
