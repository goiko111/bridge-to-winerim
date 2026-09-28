import { describe, it, expect } from "vitest";
import { decideCatalogChange } from "../../supabase/functions/_shared/winerimCatalogFingerprint";

const base = { name: "Pétalos del Bierzo", wine_type: "Tinto", vintage: "2023", is_active: true };
describe("alta de vino que recibe precio en un ciclo posterior", () => {
  it("sin precio previo → con precio = alta", () => {
    const d = decideCatalogChange({ previous: { ...base, pricing_status: "MISSING", bottle_sale_price: null }, payload: { ...base, bottle_sale_price: 37 }, pricingReady: true });
    expect(d.outcome).toBe("new");
  });
  it("sigue sin precio = no se envía", () => {
    const d = decideCatalogChange({ previous: { ...base, pricing_status: "MISSING" }, payload: { ...base }, pricingReady: false });
    expect(d.outcome).not.toBe("new");
  });
  it("ya con precio y sin cambios = no se reenvía", () => {
    const row = { ...base, pricing_status: "READY", bottle_sale_price: 37 };
    const d = decideCatalogChange({ previous: row, payload: { bottle_sale_price: 37 }, pricingReady: true });
    expect(d.outcome).toBe("unchanged");
  });
});
