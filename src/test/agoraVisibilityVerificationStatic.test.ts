import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(process.cwd(), "supabase/functions/agora-proxy/index.ts"),
  "utf8",
);

describe("Agora visibility writes", () => {
  it("reads families back before reporting a visibility change as successful", () => {
    expect(source).toContain("No se pudo verificar familias tras importar");
    expect(source).toContain("Agora aceptó la importación, pero no persistió toda la visibilidad de familias");
    expect(source).toContain("verification.length === applied.length");
  });

  it("forces a fresh Products read before reporting product visibility success", () => {
    expect(source).toContain("No se pudo verificar productos tras importar");
    expect(source).toContain("Agora aceptó la importación, pero no persistió toda la visibilidad de productos");
    expect(source).toContain("actualUseAsDirectSale === item.useAsDirectSale");
    expect(source).toContain("actualSaleableAsMain === item.saleableAsMain");
    expect(source).toContain("fetchWithRetry, 30000, true");
  });

  it("does not turn retired or unpriced products back into verified tracking rows", () => {
    expect(source).toContain(
      '.select("winerim_id, is_active, bottle_sale_price, glass_sale_price, magnum_sale_price")',
    );
    expect(source).toContain("const shouldTrackAsHidden = Boolean(");
    expect(source).toContain("const actualProductIsSaleable = Boolean(");
    expect(source).toContain('Retired product ${productId} is still saleable in Agora');
    expect(source).toContain('? "HIDDEN"');
  });
});
