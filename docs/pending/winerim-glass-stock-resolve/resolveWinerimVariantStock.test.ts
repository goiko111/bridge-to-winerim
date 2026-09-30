import { describe, expect, it } from "vitest";
import { indexFromStock, indexFromWines, resolveVariant } from "./resolveWinerimVariantStock";

const norm = (s: unknown) => {
  const t = String(s ?? "").toLowerCase();
  if (t.includes("copa") || t === "glass") return "copa";
  if (t.includes("botella") || t === "bottle") return "botella";
  return null;
};

// Casa Nene (871): datos reales leídos de /api/v2/stock
const stockRows = [
  { id: 277910, wineId: 242208, variant: "botella", stock: 12, stockActive: true, priceId: 271717 },
  { id: 371017, wineId: 242208, variant: "copa", stock: 0, stockActive: false },
  { id: 371038, wineId: 242234, variant: "copa", stock: 0, stockActive: false },
];
const wines = [
  { id: 242208, prices: [
    { isGlass: false, format: "botella", priceId: 271717, stockId: 277910 },
    { isGlass: true, priceId: 900001, stockId: 371017, glass: { bottlePriceId: 271717, bottleStockId: 277910, glassesPerBottle: 6 } },
  ] },
];

describe("resolver copa por /wines o /stock, no por /stock/wine/{id}", () => {
  const W = indexFromWines(wines, norm);
  const S = indexFromStock(stockRows, norm);

  it("Quinta de Couselo copa: stockId 371017 y priceId de la copa (desde /wines)", () => {
    const r = resolveVariant("242208", "copa", W, S);
    expect(r).toMatchObject({ ok: true, value: { stockId: 371017, priceId: 900001, stockActive: false, source: "wines" } });
    if (r.ok) expect(r.value.glass).toEqual({ bottlePriceId: 271717, bottleStockId: 277910, glassesPerBottle: 6 });
  });

  it("Cillar de Silos copa: si /wines no la trae, sale de /stock (371038, stockActive=false)", () => {
    expect(resolveVariant("242234", "copa", W, S)).toMatchObject({ ok: true, value: { stockId: 371038, source: "stock" } });
  });

  it("nunca cae a botella si falta la copa", () => {
    expect(resolveVariant("242234", "botella", W, S)).toEqual({ ok: false, code: "VARIANT_NOT_FOUND" });
  });

  it("stockId distinto entre /wines y /stock → no envía", () => {
    const S2 = indexFromStock([{ id: 999, wineId: 242208, variant: "copa" }], norm);
    expect(resolveVariant("242208", "copa", W, S2)).toEqual({ ok: false, code: "STOCK_ID_MISMATCH" });
  });

  it("dos filas de copa para el mismo vino → ambiguo, no envía", () => {
    const S3 = indexFromStock([{ id: 1, wineId: 5, variant: "copa" }, { id: 2, wineId: 5, variant: "copa" }], norm);
    expect(resolveVariant("5", "copa", new Map(), S3)).toEqual({ ok: false, code: "VARIANT_AMBIGUOUS" });
  });

  it("copa inactiva (isActive=false en /wines, caso Valdelainos 327193): no envía salvo permiso explícito", () => {
    const Wi = indexFromWines([{ id: 327193, prices: [
      { isGlass: false, format: "botella", priceId: 362825, stockId: 369018, isActive: true },
      { isGlass: true, priceId: 900002, stockId: 369017, isActive: false, glass: { bottlePriceId: 362825, bottleStockId: 369018, glassesPerBottle: 6 } },
    ] }], norm);
    const Si = indexFromStock([{ id: 369017, wineId: 327193, variant: "copa", stock: 0, stockActive: false }], norm);
    expect(resolveVariant("327193", "copa", Wi, Si)).toEqual({ ok: false, code: "VARIANT_INACTIVE" });
    expect(resolveVariant("327193", "copa", Wi, Si, { allowInactive: true })).toMatchObject({ ok: true, value: { stockId: 369017, isActive: false } });
    expect(resolveVariant("327193", "botella", Wi, Si)).toMatchObject({ ok: true, value: { stockId: 369018, isActive: true } });
  });

  it("stockActive=false por sí solo no bloquea (es lo normal en copas)", () => {
    const Si = indexFromStock([{ id: 371038, wineId: 242234, variant: "copa", stockActive: false }], norm);
    expect(resolveVariant("242234", "copa", new Map(), Si)).toMatchObject({ ok: true });
  });
});
