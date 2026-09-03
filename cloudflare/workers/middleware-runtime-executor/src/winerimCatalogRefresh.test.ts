import { describe, expect, it } from "vitest";

import { normalizedWine } from "./winerimCatalogRefresh";

describe("Winerim catalog refresh stock identities", () => {
  it("persists stock identity independently for bottle, glass and magnum", () => {
    expect(normalizedWine({
      id: 358327,
      name: "Volver Tinaja Macabeo",
      prices: [
        { variant: "botella", price: "21", erpStock: { id: 402848, stockActive: true } },
        { variant: "copa", price: "3.50", erpStock: { id: 402849, stockActive: false } },
        { variant: "magnum", price: "48", erpStock: { id: 402850, stockActive: true } },
      ],
    }, {})).toMatchObject({
      bottle_stock_id: "402848",
      glass_stock_id: "402849",
      magnum_stock_id: "402850",
      bottle_sale_price: 21,
      glass_sale_price: 3.5,
      magnum_sale_price: 48,
    });
  });

  it("does not invent a stock identity when a variant has none", () => {
    expect(normalizedWine({
      id: 273880,
      name: "No Sin Tou Tsefs",
      prices: [{ variant: "botella", price: "37" }],
    }, {})).toMatchObject({
      bottle_stock_id: null,
      glass_stock_id: null,
      magnum_stock_id: null,
    });
  });

  it("does not collapse an unsupported half bottle into a bottle", () => {
    expect(normalizedWine({
      id: 323087,
      name: "Andre Clouet Grande Réserve",
      prices: [{ variant: "media-botella", price: "35", erpStock: { id: 365230, stockActive: true } }],
    }, {})).toMatchObject({
      bottle_sale_price: null,
      bottle_stock_id: null,
      serve_by_glass: false,
      pricing_status: "BLOCKED_PRICING_MISSING",
    });
  });
});
