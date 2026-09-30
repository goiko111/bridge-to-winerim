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
    { isGlass: true, priceId: 900001, stockId: 371017, glass: { bottlePriceId: 271717, bottleStockId: 277910, glassesPerBottle: 6, serviceable: true } },
  ] },
];

describe("resolver copa por /wines o /stock, no por /stock/wine/{id}", () => {
  const W = indexFromWines(wines, norm);
  const S = indexFromStock(stockRows, norm);

  it("Quinta de Couselo copa: stockId 371017 y priceId de la copa (desde /wines)", () => {
    const r = resolveVariant("242208", "copa", W, S);
    expect(r).toMatchObject({ ok: true, value: { stockId: 371017, priceId: 900001, stockActive: false, source: "wines" } });
    if (r.ok) expect(r.value.glass).toEqual({ bottlePriceId: 271717, bottleStockId: 277910, glassesPerBottle: 6, serviceable: true });
  });

  it("Cillar de Silos copa: si /wines no la trae, sale de /stock (371038) pero sin serviceable → cola «pendiente de configurar en Winerim»", () => {
    const r = resolveVariant("242234", "copa", W, S);
    expect(r).toMatchObject({ ok: false, code: "GLASS_NOT_SERVICEABLE" });
    if (!r.ok) expect(r.serviceProblem).toContain("ausente");
  });

  it("Cillar de Silos copa con serviceable=true en /wines: se envía (371038)", () => {
    const W2 = indexFromWines([{ id: 242234, prices: [
      { isGlass: true, priceId: 900003, stockId: 371038, isActive: false, glass: { bottlePriceId: 271743, bottleStockId: 277936, glassesPerBottle: 6, serviceable: true } },
    ] }], norm);
    expect(resolveVariant("242234", "copa", W2, S)).toMatchObject({ ok: true, value: { stockId: 371038, priceId: 900003, isActive: false } });
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

  it("copa inactiva pero serviceable (isActive=false, caso Valdelainos 327193): se envía con priceId y stockId de la copa", () => {
    const Wi = indexFromWines([{ id: 327193, prices: [
      { isGlass: false, format: "botella", priceId: 362825, stockId: 369018, isActive: true },
      { isGlass: true, priceId: 900002, stockId: 369017, isActive: false, glass: { bottlePriceId: 362825, bottleStockId: 369018, glassesPerBottle: 6, serviceable: true } },
    ] }], norm);
    const Si = indexFromStock([{ id: 369017, wineId: 327193, variant: "copa", stock: 0, stockActive: false }], norm);
    expect(resolveVariant("327193", "copa", Wi, Si)).toMatchObject({ ok: true, value: { stockId: 369017, priceId: 900002, isActive: false, source: "wines" } });
    expect(resolveVariant("327193", "botella", Wi, Si)).toMatchObject({ ok: true, value: { stockId: 369018, isActive: true } });
  });

  it("Sa Pedrera Iamontanum copa (326344): sin botella en la ficha → cola «pendiente de configurar en Winerim», no se envía", () => {
    const Wp = indexFromWines([{ id: 326344, prices: [
      { isGlass: true, priceId: 900004, stockId: 400001, isActive: false, glass: { bottlePriceId: null, bottleStockId: null, glassesPerBottle: null, serviceable: false } },
    ] }], norm);
    const r = resolveVariant("326344", "copa", Wp, new Map());
    expect(r).toMatchObject({ ok: false, code: "GLASS_NOT_SERVICEABLE", serviceProblem: "glass.serviceable=false" });
  });

  it("copa sin datos de glass en /wines → cola, no se envía", () => {
    const Wn = indexFromWines([{ id: 7, prices: [{ isGlass: true, priceId: 1, stockId: 2 }] }], norm);
    expect(resolveVariant("7", "copa", Wn, new Map())).toMatchObject({ ok: false, code: "GLASS_NOT_SERVICEABLE" });
  });

  it("stockActive=false por sí solo no bloquea la botella", () => {
    const Sb = indexFromStock([{ id: 277910, wineId: 242208, variant: "botella", stockActive: false }], norm);
    expect(resolveVariant("242208", "botella", new Map(), Sb)).toMatchObject({ ok: true });
  });
});
