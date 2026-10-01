import { describe, expect, it } from "vitest";
import { extractWineFromBody, partitionDaysByCutoff, heldLogEntry } from "./sendCutoff";
import { indexFromWines, resolveVariant } from "../winerim-glass-stock-resolve/resolveWinerimVariantStock";

const norm = (s: unknown) => (String(s ?? "").toLowerCase().includes("copa") ? "copa" : "botella");

// Respuesta real de Winerim (Valdelainos, Higuerón)
const body = { success: true, wine: { id: 327193, isActive: false, prices: [
  { isGlass: true, priceId: 362824, stockId: 369017, glass: { serviceable: true } },
] } };

describe("(a) ficha en body.wine", () => {
  it("encuentra la copa de Valdelainos", () => {
    const idx = indexFromWines([extractWineFromBody(body)], norm);
    const r = resolveVariant("327193", "copa", idx, new Map());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.stockId).toBe(369017);
  });
  it("la lectura antigua (body.data) no la veía", () => {
    const old = (body as any).data ?? body;
    const r = resolveVariant("327193", "copa", indexFromWines([old], norm), new Map());
    expect(r.ok).toBe(false);
  });
});

describe("(b) fecha de corte 30-sep", () => {
  it("16 y 17-sep quedan pendientes; 30-sep y 1-oct se envían", () => {
    const p = partitionDaysByCutoff(["2026-09-16", "2026-09-17", "2026-09-29", "2026-09-30", "2026-10-01"]);
    expect(p.held).toEqual(["2026-09-16", "2026-09-17", "2026-09-29"]);
    expect(p.allowed).toEqual(["2026-09-30", "2026-10-01"]);
  });
  it("registro sin envío", () => {
    expect(heldLogEntry("c1", ["2026-09-16"])).toEqual({ tag: "SEPTEMBER_PENDING_APPROVAL", connectionId: "c1", days: ["2026-09-16"], sent: false });
  });
});
