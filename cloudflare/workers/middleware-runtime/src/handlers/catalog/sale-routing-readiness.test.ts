import { describe, expect, it } from "vitest";

import { auditSaleRoutingReadiness, type SaleRoutingReadinessInput } from "./sale-routing-readiness";

function fixture(): SaleRoutingReadinessInput {
  return {
    connectionId: "connection-a",
    selectedSaleCenterIds: ["center-main", "center-terrace"],
    saleCenters: [
      { id: "center-main", currentPriceListId: "price-main" },
      { id: "center-terrace", priceListId: "price-terrace" },
    ],
    priceLists: [
      { id: "price-main" },
      { id: "price-terrace" },
    ],
    preparationTypes: [{ id: "beverages" }],
    preparationOrders: [{ id: "drinks-printer" }],
    products: [
      {
        productId: "bottle-1",
        source: "WINERIM",
        format: "BOTTLE",
        familyId: "reds",
        saleableAsMain: true,
        useAsDirectSale: false,
        preparationTypeId: "beverages",
        preparationOrderId: "drinks-printer",
        prices: [
          { priceListId: "price-main", mainPrice: 24 },
          { priceListId: "price-terrace", mainPrice: 25 },
        ],
      },
      {
        productId: "glass-1",
        source: "WINERIM",
        format: "GLASS",
        familyId: "reds",
        saleableAsMain: true,
        useAsDirectSale: false,
        preparationTypeId: "beverages",
        preparationOrderId: "drinks-printer",
        prices: [
          { priceListId: "price-main", mainPrice: 5 },
          { priceListId: "price-terrace", mainPrice: 5.5 },
        ],
      },
      {
        productId: "legacy-1",
        source: "LEGACY",
        format: "BOTTLE",
        familyId: "legacy",
        saleableAsMain: false,
        useAsDirectSale: false,
        prices: [],
      },
      {
        productId: "magnum-1",
        source: "WINERIM",
        format: "MAGNUM",
        familyId: "reds",
        saleableAsMain: true,
        useAsDirectSale: false,
        prices: [],
      },
    ],
  };
}

describe("auditSaleRoutingReadiness", () => {
  it("certifies every selected center only when bottle and glass cover its effective price list and preparation route", () => {
    const input = fixture();
    const before = JSON.stringify(input);

    const result = auditSaleRoutingReadiness(input);

    expect(result.status).toBe("READY");
    expect(result.summary).toEqual({
      selectedSaleCenters: 2,
      expectedBottleProducts: 2,
      expectedGlassProducts: 2,
      readyBottleProducts: 2,
      readyGlassProducts: 2,
      blockingIssues: 0,
    });
    expect(result.selectedSaleCenters.map((center) => center.priceListId)).toEqual([
      "price-main",
      "price-terrace",
    ]);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("uses CurrentPriceList before the fallback PriceListId and blocks a missing glass price in one selected center", () => {
    const source = fixture();
    const input: SaleRoutingReadinessInput = {
      ...source,
      saleCenters: [{ id: "center-main", currentPriceListId: "price-main", priceListId: "price-terrace" }, ...source.saleCenters.slice(1)],
      products: [source.products[0], {
        ...source.products[1],
        prices: [{ priceListId: "price-main", mainPrice: 5 }],
      }, ...source.products.slice(2)],
    };

    const result = auditSaleRoutingReadiness(input);

    expect(result.status).toBe("BLOCKED");
    expect(result.selectedSaleCenters[0].priceListId).toBe("price-main");
    expect(result.selectedSaleCenters[1].issues).toContainEqual({
      code: "PRODUCT_PRICE_MISSING",
      saleCenterId: "center-terrace",
      priceListId: "price-terrace",
      productId: "glass-1",
      format: "GLASS",
    });
  });

  it("fails closed for an unselected center and an invalid preparation pair", () => {
    const source = fixture();
    const input: SaleRoutingReadinessInput = {
      ...source,
      selectedSaleCenterIds: ["missing-center", "center-main"],
      products: [{ ...source.products[0], preparationOrderId: "" }, ...source.products.slice(1)],
    };

    const result = auditSaleRoutingReadiness(input);

    expect(result.status).toBe("BLOCKED");
    expect(result.issues.map((item) => item.code)).toEqual(expect.arrayContaining([
      "SELECTED_SALE_CENTER_NOT_FOUND",
      "PREPARATION_ROUTE_PARTIAL",
    ]));
  });

  it("fails closed when a selected center resolves to a price list absent from the master", () => {
    const source = fixture();
    const input: SaleRoutingReadinessInput = {
      ...source,
      selectedSaleCenterIds: ["center-main"],
      saleCenters: [{ id: "center-main", currentPriceListId: "missing-price-list" }, ...source.saleCenters.slice(1)],
    };

    const result = auditSaleRoutingReadiness(input);

    expect(result.status).toBe("BLOCKED");
    expect(result.issues).toEqual([{
      code: "PRICE_LIST_NOT_FOUND",
      saleCenterId: "center-main",
      priceListId: "missing-price-list",
    }]);
  });

  it("requires a real preparation route and normal saleability for both formats", () => {
    const source = fixture();
    const input: SaleRoutingReadinessInput = {
      ...source,
      products: [{
        ...source.products[0],
        saleableAsMain: false,
        useAsDirectSale: true,
        preparationTypeId: "",
        preparationOrderId: "",
      }, {
        ...source.products[1],
        preparationTypeId: "unknown-type",
        preparationOrderId: "unknown-order",
        prices: [
          { priceListId: "price-main", mainPrice: 0 },
          { priceListId: "price-terrace", mainPrice: -1 },
        ],
      }, ...source.products.slice(2)],
    };

    const result = auditSaleRoutingReadiness(input);

    expect(result.issues.map((item) => item.code)).toEqual(expect.arrayContaining([
      "PRODUCT_NOT_SALEABLE",
      "PRODUCT_DIRECT_SALE_ENABLED",
      "PREPARATION_ROUTE_MISSING",
      "PREPARATION_TYPE_NOT_FOUND",
      "PREPARATION_ORDER_NOT_FOUND",
      "PRODUCT_PRICE_NONPOSITIVE",
    ]));
  });

  it("does not treat an empty SaleCenter selection as ready", () => {
    const input: SaleRoutingReadinessInput = { ...fixture(), selectedSaleCenterIds: [] };

    const result = auditSaleRoutingReadiness(input);

    expect(result.status).toBe("BLOCKED");
    expect(result.issues).toEqual([{ code: "SALE_CENTER_SELECTION_EMPTY" }]);
  });
});
