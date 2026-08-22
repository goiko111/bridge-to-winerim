import { describe, expect, it } from "vitest";
import {
  buildVinotecaMappingRows,
  buildVinotecaReferencePlan,
  isValidVinotecaRegion,
  isVinotecaNativeFormatsConnection,
  VINOTECA_REGION_REFERENCE_NATIVE_FORMATS,
  VINOTECA_REGION_FAMILY_COLOR,
  findWinerimOwnedVinotecaRegionFamily,
  vinotecaFormatId,
  vinotecaRegionFamilyOrder,
  vinotecaRegionFamilyTechnicalName,
} from "../../supabase/functions/_shared/agoraVinotecaNativeFormats";
import {
  isAgoraSaleFormatFirstConnection,
  resolveAgoraSalesLineIdentityForConnection,
  type AgoraSalesResolution,
} from "../../supabase/functions/_shared/agoraSalesLineIdentity";

const PONZANO = "a700d425-9194-4758-95ff-7fee86419e14";
const SANTANDER = "79280cb8-0fe7-4a57-93a4-04172205ac70";
const OTHER = "e5b988f1-8471-4336-a1f7-a5c1626deab1";

const VINOTECA_MODE = { family_structure_mode: VINOTECA_REGION_REFERENCE_NATIVE_FORMATS };

function wine(overrides: Record<string, unknown> = {}) {
  return {
    winerimWineId: 363449,
    wineName: "Vega Sicilia Unico",
    region: "RIBERA",
    bottleSalePrice: 180,
    bottleCostPrice: 120,
    glassSalePrice: 24,
    glassCostPrice: 18,
    ...overrides,
  };
}

describe("VINOTECA_REGION_REFERENCE_NATIVE_FORMATS gating", () => {
  it("only activates for the two Don Bernardo connections with the mode set", () => {
    expect(isVinotecaNativeFormatsConnection(PONZANO, VINOTECA_MODE)).toBe(true);
    expect(isVinotecaNativeFormatsConnection(SANTANDER, VINOTECA_MODE)).toBe(true);
    expect(isVinotecaNativeFormatsConnection(OTHER, VINOTECA_MODE)).toBe(false);
    expect(isVinotecaNativeFormatsConnection(PONZANO, { family_structure_mode: "GEOGRAPHIC_FAMILIES" })).toBe(false);
    expect(isVinotecaNativeFormatsConnection(PONZANO, {})).toBe(false);
  });

  it("uses the deterministic identity bases per format", () => {
    expect(vinotecaFormatId("BOTTLE", 363449)).toBe("2363449");
    expect(vinotecaFormatId("GLASS", 363449)).toBe("3363449");
    expect(vinotecaFormatId("MAGNUM", 363449)).toBe("4363449");
    expect(vinotecaFormatId("BOTTLE", 0)).toBeNull();
    expect(vinotecaFormatId("UNKNOWN", 363449)).toBeNull();
  });

  it("keeps every dynamic region on the canonical color and alphabetical position", () => {
    expect(VINOTECA_REGION_FAMILY_COLOR).toBe("#722F37");
    const siblings = ["Rioja", "Toro", "Bierzo", "Cava"];
    expect(vinotecaRegionFamilyOrder("Bordeaux", siblings)).toBe(2);
    expect(vinotecaRegionFamilyOrder("Toro", siblings)).toBe(4);
    expect(vinotecaRegionFamilyOrder("Rías Baixas", [...siblings, "Rías Baixas"])).toBe(3);
  });

  it("never adopts a bare same-named legacy region family", () => {
    const families = [
      { Id: "123", Name: "Cava", ParentFamilyId: "112", ShowInPos: true },
      { Id: "900284", Name: "VINOTECA ABIERTA - Cava", ParentFamilyId: "112", ShowInPos: true },
    ];
    expect(vinotecaRegionFamilyTechnicalName(" Cava ")).toBe("VINOTECA ABIERTA - Cava");
    expect(findWinerimOwnedVinotecaRegionFamily(families, "112", "Cava")?.Id).toBe("900284");
    expect(findWinerimOwnedVinotecaRegionFamily([families[0]], "112", "Cava")).toBeNull();
  });
});

describe("new reference intake", () => {
  it("plans bottle plus native glass format", () => {
    const { plan, skipped } = buildVinotecaReferencePlan(wine());
    expect(skipped).toBeNull();
    expect(plan?.productId).toBe("2363449");
    expect(plan?.region).toBe("RIBERA");
    expect(plan?.formats.map((f) => [f.format, f.agoraId, f.salePrice])).toEqual([
      ["BOTTLE", "2363449", 180],
      ["GLASS", "3363449", 24],
    ]);
  });

  it("adds MAGNUM as a native format when priced", () => {
    const { plan } = buildVinotecaReferencePlan(wine({ magnumSalePrice: 340, magnumCostPrice: 250 }));
    expect(plan?.formats.at(-1)).toEqual({
      format: "MAGNUM",
      agoraId: "4363449",
      salePrice: 340,
      costPrice: 250,
      isBase: false,
    });
  });

  it("preserves an adopted Agora parent whose base format is GLASS", () => {
    const { plan, skipped } = buildVinotecaReferencePlan(wine(), {
      productId: "1368",
      baseFormat: "GLASS",
      formatIds: { GLASS: "1368", BOTTLE: "1405" },
    });
    expect(skipped).toBeNull();
    expect(plan?.productId).toBe("1368");
    expect(plan?.baseFormat).toBe("GLASS");
    expect(plan?.formats.map((format) => [format.format, format.agoraId, format.isBase, format.salePrice])).toEqual([
      ["GLASS", "1368", true, 24],
      ["BOTTLE", "1405", false, 180],
    ]);
  });

  it("adds a newly active format to an adopted route without changing its ProductId", () => {
    const { plan, skipped } = buildVinotecaReferencePlan(wine(), {
      productId: "1368",
      baseFormat: "GLASS",
      formatIds: { GLASS: "1368" },
    });
    expect(skipped).toBeNull();
    expect(plan?.productId).toBe("1368");
    expect(plan?.formats.map((format) => [format.format, format.agoraId, format.isBase])).toEqual([
      ["GLASS", "1368", true],
      ["BOTTLE", "2363449", false],
    ]);
    expect(buildVinotecaReferencePlan(wine(), null).skipped?.reason).toBe("incomplete_adopted_route");
  });

  it("is idempotent across a second cycle (same identities, no duplicates)", () => {
    const first = buildVinotecaReferencePlan(wine()).plan!;
    const second = buildVinotecaReferencePlan(wine()).plan!;
    expect(second).toEqual(first);

    const rowsA = buildVinotecaMappingRows(SANTANDER, first);
    const rowsB = buildVinotecaMappingRows(SANTANDER, second);
    expect(rowsB).toEqual(rowsA);
    expect(new Set(rowsB.map((r) => r.provider_product_id)).size).toBe(rowsB.length);
  });

  it("keeps identities stable when the price changes", () => {
    const before = buildVinotecaReferencePlan(wine()).plan!;
    const after = buildVinotecaReferencePlan(wine({ bottleSalePrice: 195, glassSalePrice: 26 })).plan!;
    expect(after.productId).toBe(before.productId);
    expect(after.formats.map((f) => f.agoraId)).toEqual(before.formats.map((f) => f.agoraId));
    expect(after.formats.map((f) => f.salePrice)).toEqual([195, 26]);
  });

  it("fails closed without region, bottle price or valid id", () => {
    expect(buildVinotecaReferencePlan(wine({ region: "" })).skipped?.reason).toBe("missing_region");
    expect(buildVinotecaReferencePlan(wine({ region: "Sin región" })).skipped?.reason).toBe("missing_region");
    expect(buildVinotecaReferencePlan(wine({ bottleSalePrice: 0 })).skipped?.reason).toBe("missing_bottle_price");
    expect(buildVinotecaReferencePlan(wine({ winerimWineId: null })).skipped?.reason).toBe("invalid_winerim_id");
    expect(isValidVinotecaRegion("Otras")).toBe(false);
    expect(isValidVinotecaRegion("RIOJA")).toBe(true);
  });
});

describe("sales resolution: SaleFormatId before ProductId", () => {
  const resolutionMap = new Map<string, AgoraSalesResolution>([
    ["2363449", { winerim_wine_id: "363449", format: "BOTTLE" }],
    ["3363449", { winerim_wine_id: "363449", format: "GLASS" }],
  ]);

  it("resolves a glass line by SaleFormatId even when ProductId is the bottle", () => {
    expect(resolveAgoraSalesLineIdentityForConnection({
      connectionId: SANTANDER,
      productId: "2363449",
      saleFormatId: "3363449",
      legacyProviderProductId: "2363449",
      resolutionMap,
    })).toEqual({
      providerProductId: "3363449",
      resolution: { winerim_wine_id: "363449", format: "GLASS" },
      source: "sale_format_first",
    });
  });

  it("falls back to ProductId for bottle lines without a mapped SaleFormatId", () => {
    expect(resolveAgoraSalesLineIdentityForConnection({
      connectionId: PONZANO,
      productId: "2363449",
      saleFormatId: "999999",
      legacyProviderProductId: "2363449",
      resolutionMap,
    })).toEqual({
      providerProductId: "2363449",
      resolution: { winerim_wine_id: "363449", format: "BOTTLE" },
      source: "product_first",
    });
  });

  it("leaves every other connection on its exact legacy identity", () => {
    expect(isAgoraSaleFormatFirstConnection(OTHER)).toBe(false);
    expect(resolveAgoraSalesLineIdentityForConnection({
      connectionId: OTHER,
      productId: "2363449",
      saleFormatId: "3363449",
      legacyProviderProductId: "2363449",
      resolutionMap,
    })).toEqual({
      providerProductId: "2363449",
      resolution: { winerim_wine_id: "363449", format: "BOTTLE" },
      source: "legacy",
    });
  });
});
