import { describe, expect, it } from "vitest";
import {
  buildVinotecaReferencePlan,
  type VinotecaCatalogRoute,
} from "../../supabase/functions/_shared/agoraVinotecaNativeFormats";

// Live evidence 2026-08-22 (Don Bernardo Santander / Ponzano):
// adopted references keep their legacy parent ProductId + SaleFormatIds and must
// never be duplicated with the deterministic 2M/3M/4M namespace.

const CRUZ_DE_ALBA_ROBLE: VinotecaCatalogRoute = {
  productId: "1368",
  baseFormat: "GLASS",
  formatIds: { GLASS: "1368", BOTTLE: "1405" },
};

const MACAN_CLASICO: VinotecaCatalogRoute = {
  productId: "1663",
  baseFormat: "BOTTLE",
  formatIds: { BOTTLE: "1663", GLASS: "1699" },
};

function wine(overrides: Record<string, unknown> = {}) {
  return {
    winerimWineId: "41079",
    wineName: "Cruz de Alba Roble",
    region: "Ribera del Duero",
    bottleSalePrice: 25,
    glassSalePrice: 3.2,
    ...overrides,
  };
}

describe("adopted VINOTECA reference plans", () => {
  it("41079: GLASS base 1368 + BOTTLE additional 1405, no 2041079 duplicate", () => {
    const { plan, skipped } = buildVinotecaReferencePlan(wine(), CRUZ_DE_ALBA_ROBLE);
    expect(skipped).toBeNull();
    expect(plan?.productId).toBe("1368");
    expect(plan?.baseFormat).toBe("GLASS");
    expect(plan?.formats.map((f) => [f.format, f.agoraId, f.salePrice, f.isBase])).toEqual([
      ["GLASS", "1368", 3.2, true],
      ["BOTTLE", "1405", 25, false],
    ]);
    expect(plan?.formats.some((f) => f.agoraId.startsWith("204") || f.agoraId.startsWith("304"))).toBe(false);
  });

  it("51122: keeps exact parent 1663 and updates the glass price without duplicates", () => {
    const { plan } = buildVinotecaReferencePlan(
      wine({ winerimWineId: "51122", wineName: "Macan Clasico", bottleSalePrice: 90, glassSalePrice: 14 }),
      MACAN_CLASICO,
    );
    expect(plan?.productId).toBe("1663");
    expect(plan?.baseFormat).toBe("BOTTLE");
    expect(plan?.formats.find((f) => f.format === "GLASS")).toMatchObject({ agoraId: "1699", salePrice: 14 });
  });

  it("250852: native identities when there is no adopted route", () => {
    const { plan } = buildVinotecaReferencePlan(
      wine({ winerimWineId: "250852", wineName: "Abel Mendoza 4D4", bottleSalePrice: 34, glassSalePrice: 3.9 }),
    );
    expect(plan?.productId).toBe("2250852");
    expect(plan?.formats.find((f) => f.format === "GLASS")).toMatchObject({ agoraId: "3250852", salePrice: 3.9 });
  });

  it("37879: brand-new reference creates 2037879 + 3037879 in the exact region", () => {
    const { plan } = buildVinotecaReferencePlan(
      wine({
        winerimWineId: "37879",
        wineName: "Caraballas Verdejo Ecologico",
        region: "Rueda",
        bottleSalePrice: 28,
        glassSalePrice: 3.5,
      }),
    );
    expect(plan?.region).toBe("Rueda");
    expect(plan?.formats.map((f) => f.agoraId)).toEqual(["2037879", "3037879"]);
  });

  it("261273: adds a new GLASS id to an adopted BOTTLE route without changing the ProductId", () => {
    const { plan, skipped } = buildVinotecaReferencePlan(
      wine({
        winerimWineId: "261273",
        wineName: "Marques de Riscal XR",
        region: "Rioja",
        bottleSalePrice: 45,
        glassSalePrice: 9,
      }),
      {
        productId: "761273",
        baseFormat: "BOTTLE",
        formatIds: { BOTTLE: "761273" },
      },
    );
    expect(skipped).toBeNull();
    expect(plan?.productId).toBe("761273");
    expect(plan?.formats).toEqual([
      expect.objectContaining({ format: "BOTTLE", agoraId: "761273", isBase: true, salePrice: 45 }),
      expect.objectContaining({ format: "GLASS", agoraId: "3261273", isBase: false, salePrice: 9 }),
    ]);
    expect(buildVinotecaReferencePlan(
      wine({
        winerimWineId: "261273",
        wineName: "Marques de Riscal XR",
        region: "Rioja",
        bottleSalePrice: 45,
        glassSalePrice: 9,
      }),
      {
        productId: "761273",
        baseFormat: "BOTTLE",
        formatIds: { BOTTLE: "761273", GLASS: "3261273" },
      },
    ).plan).toEqual(plan);
  });

  it("2363537: an inactive wine is never rebuilt, so it cannot be reactivated", () => {
    const { plan, skipped } = buildVinotecaReferencePlan(
      wine({ winerimWineId: "363537", wineName: "Retirado", isActive: false }),
    );
    expect(plan).toBeNull();
    expect(skipped?.reason).toBe("inactive_wine");
  });

  it("fails closed on an inconsistent adopted route and on a format that would be lost", () => {
    expect(buildVinotecaReferencePlan(wine(), null).skipped?.reason).toBe("incomplete_adopted_route");
    // A new additional format gets a deterministic identity and does not
    // rewrite either of the already adopted identities.
    expect(buildVinotecaReferencePlan(wine({ magnumSalePrice: 60 }), CRUZ_DE_ALBA_ROBLE).plan)
      .toMatchObject({
        productId: "1368",
        formats: expect.arrayContaining([
          expect.objectContaining({ format: "MAGNUM", agoraId: "4041079", salePrice: 60 }),
        ]),
      });
    // The adopted base format itself has no positive price.
    expect(
      buildVinotecaReferencePlan(wine({ glassSalePrice: 0 }), CRUZ_DE_ALBA_ROBLE).skipped?.reason,
    ).toBe("incomplete_adopted_route");
    // Adopted additional GLASS exists in Agora but Winerim has no glass price.
    expect(
      buildVinotecaReferencePlan(
        wine({ winerimWineId: "51122", wineName: "Macan Clasico", bottleSalePrice: 90, glassSalePrice: 0 }),
        MACAN_CLASICO,
      ).skipped?.reason,
    ).toBe("adopted_format_would_be_lost");
  });

  it("is idempotent: the same input yields the same identities and prices", () => {
    const first = buildVinotecaReferencePlan(wine(), CRUZ_DE_ALBA_ROBLE).plan;
    const second = buildVinotecaReferencePlan(wine(), CRUZ_DE_ALBA_ROBLE).plan;
    expect(second).toEqual(first);
    const changed = buildVinotecaReferencePlan(wine({ glassSalePrice: 3.5 }), CRUZ_DE_ALBA_ROBLE).plan;
    expect(changed).not.toEqual(first);
  });
});
