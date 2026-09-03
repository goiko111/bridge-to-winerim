import { describe, expect, it } from "vitest";

import {
  SaleRoutingReadinessCollectionError,
  collectSaleRoutingReadiness,
} from "./sale-routing-readiness-collector";

function client(overrides: Record<string, unknown> = {}) {
  const masters: Record<string, unknown> = {
    SaleCenters: [{ Id: "center", CurrentPriceListId: "price" }],
    PriceLists: [{ Id: "price" }],
    PreparationTypes: [{ Id: "beverages" }],
    PreparationOrders: [{ Id: "drinks" }],
    Products: [{
      Id: "product-bottle",
      FamilyId: "reds",
      SaleableAsMain: true,
      UseAsDirectSale: false,
      PreparationTypeId: "beverages",
      PreparationOrderId: "drinks",
      Prices: [{ PriceListId: "price", MainPrice: 24 }],
    }, {
      Id: "product-glass",
      FamilyId: "reds",
      SaleableAsMain: true,
      UseAsDirectSale: false,
      PreparationTypeId: "beverages",
      PreparationOrderId: "drinks",
      Prices: [{ PriceListId: "price", MainPrice: 5 }],
    }],
    ...overrides,
  };
  return {
    exportMaster: async ([filter]: readonly string[]) => ({
      ok: true,
      status: 200,
      contentType: "application/json",
      body: masters[filter],
    }),
  };
}

describe("collectSaleRoutingReadiness", () => {
  it("collects only master reads and certifies an exact bottle and glass snapshot", async () => {
    const result = await collectSaleRoutingReadiness({
      connectionId: "connection-a",
      selectedSaleCenterIds: ["center"],
      expectedProducts: [
        { productId: "product-bottle", format: "BOTTLE" },
        { productId: "product-glass", format: "GLASS" },
      ],
      agora: client(),
    });

    expect(result.status).toBe("READY");
    expect(result.receipts.map((receipt) => receipt.filter)).toEqual([
      "SaleCenters", "PriceLists", "PreparationTypes", "PreparationOrders", "Products",
    ]);
    expect(result.receipts.every((receipt) => receipt.status === 200)).toBe(true);
  });

  it("fails closed when an expected Winerim product is absent from the master", async () => {
    const result = await collectSaleRoutingReadiness({
      connectionId: "connection-a",
      selectedSaleCenterIds: ["center"],
      expectedProducts: [{ productId: "missing", format: "GLASS" }],
      agora: client(),
    });

    expect(result.status).toBe("BLOCKED");
    expect(result.collectionIssues).toEqual([
      { code: "WINERIM_PRODUCT_MISSING_FROM_MASTER", productId: "missing" },
    ]);
  });

  it("keeps HTTP evidence sanitized and stops on an unavailable master", async () => {
    const agora = client();
    agora.exportMaster = async ([filter]: readonly string[]) => ({
      ok: filter !== "PreparationOrders",
      status: filter === "PreparationOrders" ? 503 : 200,
      contentType: "application/xml",
      body: filter === "PreparationOrders" ? "provider details omitted" : [{ Id: filter }],
    });

    await expect(collectSaleRoutingReadiness({
      connectionId: "connection-a",
      selectedSaleCenterIds: ["center"],
      expectedProducts: [],
      agora,
    })).rejects.toEqual(new SaleRoutingReadinessCollectionError(
      "AGORA_MASTER_HTTP_ERROR",
      "PreparationOrders",
      503,
    ));
  });

  it("parses attribute-only XML master rows without logging the payload", async () => {
    const agora = client({
      SaleCenters: '<SaleCenter Id="center" CurrentPriceListId="price" />',
      PriceLists: '<PriceList Id="price" />',
      PreparationTypes: '<PreparationType Id="beverages" />',
      PreparationOrders: '<PreparationOrder Id="drinks" />',
      Products: '<Product Id="product-bottle" FamilyId="reds" SaleableAsMain="true" UseAsDirectSale="false" PreparationTypeId="beverages" PreparationOrderId="drinks" PriceListId="price" MainPrice="24" />',
    });

    const result = await collectSaleRoutingReadiness({
      connectionId: "connection-a",
      selectedSaleCenterIds: ["center"],
      expectedProducts: [{ productId: "product-bottle", format: "BOTTLE" }],
      agora,
    });

    expect(result.status).toBe("READY");
    expect(result.receipts.every((receipt) => receipt.contentType === "application/json")).toBe(true);
  });
});
