import { describe, expect, it } from "vitest";
import {
  buildAgoraButtonText,
  buildDuplicateSafeAgoraProductLabels,
  buildDuplicateSafeAgoraProductNames,
  configuredAgoraProductNameOverride,
  normalizeAgoraProductNameKey,
} from "../../supabase/functions/_shared/agoraProductNaming";

describe("Agora product naming", () => {
  it("keeps unique product names unchanged", () => {
    const names = buildDuplicateSafeAgoraProductNames([
      { productId: 739259, baseName: "B Alion", winerimId: 239259 },
      { productId: 939259, baseName: "C Alion", winerimId: 239259 },
    ]);

    expect(names["739259"]).toBe("B Alion");
    expect(names["939259"]).toBe("C Alion");
  });

  it("adds deterministic short suffixes to duplicated generated names", () => {
    const names = buildDuplicateSafeAgoraProductNames([
      { productId: 739259, baseName: "B Alion", winerimId: 239259 },
      { productId: 739276, baseName: "B Alion", winerimId: 239276 },
      { productId: 739408, baseName: "B Alion", winerimId: 239408 },
    ]);

    expect(names["739259"]).toBe("B Alion");
    expect(names["739276"]).toBe("B Alion 276");
    expect(names["739408"]).toBe("B Alion 408");
  });

  it("prefers vintage suffixes for duplicated generated names", () => {
    const labels = buildDuplicateSafeAgoraProductLabels([
      { productId: 710280, baseName: "B Chateau Violet-Lamothe", winerimId: 210280, vintage: 2022 },
      { productId: 713744, baseName: "B Chateau Violet-Lamothe", winerimId: 213744, vintage: 2020 },
    ]);

    expect(labels["710280"].name).toBe("B Chateau Violet-Lamothe 2022");
    expect(labels["713744"].name).toBe("B Chateau Violet-Lamothe 2020");
    expect(labels["710280"].buttonText).toBe("B Chateau Viole 2022");
    expect(labels["713744"].buttonText).toBe("B Chateau Viole 2020");
    expect(labels["710280"].buttonText).toHaveLength(20);
    expect(labels["713744"].buttonText).toHaveLength(20);
  });

  it("keeps vintage visible in ButtonText for long duplicated product names", () => {
    const labels = buildDuplicateSafeAgoraProductLabels([
      { productId: 713873, baseName: "B Jacques Prieur Beaune Champs Pimont 1er Cru.", winerimId: 213873, vintage: 2017 },
      { productId: 713874, baseName: "B Jacques Prieur Beaune Champs Pimont 1er Cru.", winerimId: 213874, vintage: 2018 },
    ]);

    expect(labels["713873"].name).toBe("B Jacques Prieur Beaune Champs Pimont 1er Cru. 2017");
    expect(labels["713874"].name).toBe("B Jacques Prieur Beaune Champs Pimont 1er Cru. 2018");
    expect(labels["713873"].buttonText).toBe("B Jacques Prieu 2017");
    expect(labels["713874"].buttonText).toBe("B Jacques Prieu 2018");
    expect(labels["713873"].buttonText).toHaveLength(20);
    expect(labels["713874"].buttonText).toHaveLength(20);
  });

  it("keeps fallback technical names stable when vintage is absent", () => {
    const labels = buildDuplicateSafeAgoraProductLabels([
      { productId: 710280, baseName: "B Very Long Duplicate Wine Name", winerimId: 210280 },
      { productId: 713744, baseName: "B Very Long Duplicate Wine Name", winerimId: 213744 },
    ]);

    expect(labels["710280"].name).toBe("B Very Long Duplicate Wine Name");
    expect(labels["713744"].name).toBe("B Very Long Duplicate Wine Name 744");
    expect(labels["710280"].buttonText).toMatch(/^B .*280$/);
    expect(labels["713744"].buttonText).toMatch(/^B .*744$/);
    expect(labels["710280"].buttonText).not.toBe(labels["713744"].buttonText);
    expect(labels["710280"].buttonText.length).toBeLessThanOrEqual(20);
    expect(labels["713744"].buttonText.length).toBeLessThanOrEqual(20);
  });

  it("uses visible vintage suffixes by default for duplicated vintages", () => {
    const labels = buildDuplicateSafeAgoraProductLabels([
      { productId: 709860, baseName: "B Dom Perignon Brut Vintage", winerimId: 209860, vintage: 2015 },
      { productId: 709872, baseName: "B Dom Perignon Brut Vintage", winerimId: 209872, vintage: 2012 },
    ]);

    expect(labels["709860"].name).toBe("B Dom Perignon Brut Vintage 2015");
    expect(labels["709872"].name).toBe("B Dom Perignon Brut Vintage 2012");
    expect(labels["709860"].buttonText).toBe("B Dom Perignon 2015");
    expect(labels["709872"].buttonText).toBe("B Dom Perignon 2012");
  });

  it("can keep duplicated vintages on the legacy technical suffix path when configured", () => {
    const labels = buildDuplicateSafeAgoraProductLabels(
      [
        { productId: 709860, baseName: "B Dom Perignon Brut Vintage", winerimId: 209860, vintage: 2015 },
        { productId: 709872, baseName: "B Dom Perignon Brut Vintage", winerimId: 209872, vintage: 2012 },
      ],
      [],
      { preferVintageForDuplicateNames: false },
    );

    expect(labels["709860"].name).toBe("B Dom Perignon Brut Vintage");
    expect(labels["709872"].name).toBe("B Dom Perignon Brut Vintage 872");
    expect(labels["709860"].buttonText).toMatch(/^B .*2015$/);
    expect(labels["709872"].buttonText).toMatch(/^B .*2012$/);
    expect(labels["709860"].buttonText).not.toBe(labels["709872"].buttonText);
  });

  it("falls back to a technical suffix when duplicate vintages do not distinguish names", () => {
    const labels = buildDuplicateSafeAgoraProductLabels([
      { productId: 710280, baseName: "B Same Vintage Wine", winerimId: 210280, vintage: 2022 },
      { productId: 713744, baseName: "B Same Vintage Wine", winerimId: 213744, vintage: 2022 },
    ]);

    expect(labels["710280"].name).toBe("B Same Vintage Wine 2022");
    expect(labels["713744"].name).toBe("B Same Vintage Wine 744");
    expect(labels["710280"].buttonText).toContain("2022");
    expect(labels["713744"].buttonText).toContain("2022");
    expect(labels["713744"].buttonText).toContain("744");
    expect(labels["710280"].buttonText).not.toBe(labels["713744"].buttonText);
  });

  it("preserves format prefix and suffix when building short ButtonText", () => {
    expect(buildAgoraButtonText("C Extremely Long Wine Name", "C Extremely Long Wine Name 2021", "2021")).toBe("C Extremely Lon 2021");
    expect(buildAgoraButtonText("M Extremely Long Wine Name", "M Extremely Long Wine Name 999", "999")).toBe("M Extremely Long 999");
  });

  it("suffixes a generated name when the same name belongs to another existing product", () => {
    const names = buildDuplicateSafeAgoraProductNames(
      [{ productId: 739276, baseName: "B Alion", winerimId: 239276 }],
      [{ Id: 739259, Name: "B Alion" }],
    );

    expect(names["739276"]).toBe("B Alion 276");
  });

  it("prefers vintage over technical suffix when a product has an external base-name collision", () => {
    const labels = buildDuplicateSafeAgoraProductLabels(
      [{ productId: 739276, baseName: "B Alion", winerimId: 239276, vintage: 2020 }],
      [{ Id: 739259, Name: "B Alion" }],
    );

    expect(labels["739276"].name).toBe("B Alion 2020");
    expect(labels["739276"].buttonText).toBe("B Alion 2020");
  });

  it("uses the technical suffix for products with an external base-name collision when configured", () => {
    const labels = buildDuplicateSafeAgoraProductLabels(
      [{ productId: 739276, baseName: "B Alion", winerimId: 239276, vintage: 2020 }],
      [{ Id: 739259, Name: "B Alion" }],
      { preferVintageForDuplicateNames: false },
    );

    expect(labels["739276"].name).toBe("B Alion 276");
    expect(labels["739276"].buttonText).toBe("B Alion 276");
  });

  it("allows keeping the same name when updating the same existing product", () => {
    const names = buildDuplicateSafeAgoraProductNames(
      [{ productId: 739259, baseName: "B Alion", winerimId: 239259 }],
      [{ Id: 739259, Name: "B Alion" }],
    );

    expect(names["739259"]).toBe("B Alion");
  });

  it("normalizes spacing and case when checking collisions", () => {
    expect(normalizeAgoraProductNameKey("  B   Alion  ")).toBe(normalizeAgoraProductNameKey("b alion"));
    expect(normalizeAgoraProductNameKey("B Único")).toBe(normalizeAgoraProductNameKey("b unico"));
  });

  it("resolves long ButtonText collisions without changing Name", () => {
    const candidates = [
      { productId: 767461, baseName: "B Billecart-Salmon Brut Reserve Rosé", winerimId: 267461 },
      { productId: 767462, baseName: "B Billecart-Salmon Brut Reserve", winerimId: 267462 },
      { productId: 775273, baseName: "B Barbadillo Manzanilla Pasada en Rama Pastora", winerimId: 275273 },
      { productId: 775281, baseName: "B Barbadillo Manzanilla Nave Trinidad", winerimId: 275281 },
      { productId: 775282, baseName: "B Barbadillo Manzanilla ES de Mirabrás Sumatorio", winerimId: 275282 },
    ];
    const labels = buildDuplicateSafeAgoraProductLabels(candidates);

    for (const candidate of candidates) {
      expect(labels[String(candidate.productId)].name).toBe(candidate.baseName);
      expect(labels[String(candidate.productId)].buttonText).toMatch(/^B /);
      expect(labels[String(candidate.productId)].buttonText.length).toBeLessThanOrEqual(20);
    }
    expect(new Set(Object.values(labels).map((label) => (
      normalizeAgoraProductNameKey(label.buttonText)
    ))).size).toBe(candidates.length);
  });

  it("keeps format and vintage visible while resolving long collisions", () => {
    const labels = buildDuplicateSafeAgoraProductLabels([
      { productId: 771159, baseName: "B Louis Latour Saint-Aubin Premier Cru", winerimId: 271159, vintage: 2021 },
      { productId: 771160, baseName: "B Louis Latour Saint-Aubin Les Frionnes", winerimId: 271160, vintage: 2020 },
    ]);

    expect(labels["771159"].buttonText).toMatch(/^B .*2021$/);
    expect(labels["771160"].buttonText).toMatch(/^B .*2020$/);
    expect(labels["771159"].buttonText.length).toBeLessThanOrEqual(20);
    expect(labels["771160"].buttonText.length).toBeLessThanOrEqual(20);
  });

  it("produces stable ButtonText regardless of candidate order", () => {
    const candidates = [
      { productId: 775273, baseName: "B Barbadillo Manzanilla Pasada en Rama Pastora", winerimId: 275273 },
      { productId: 775281, baseName: "B Barbadillo Manzanilla Nave Trinidad", winerimId: 275281 },
      { productId: 775282, baseName: "B Barbadillo Manzanilla ES de Mirabrás Sumatorio", winerimId: 275282 },
    ];
    expect(buildDuplicateSafeAgoraProductLabels([...candidates].reverse())).toEqual(
      buildDuplicateSafeAgoraProductLabels(candidates),
    );
  });

  it("resolves an Albariza-sized set of long collisions to unique stable buttons", () => {
    const candidates = Array.from({ length: 64 }, (_, index) => ({
      productId: 800000 + index,
      baseName: `B Extremely Long Shared Winery Selection ${String(index).padStart(2, "0")}`,
      winerimId: 300000 + index,
    }));
    const labels = buildDuplicateSafeAgoraProductLabels(candidates);
    const keys = Object.values(labels).map((label) => normalizeAgoraProductNameKey(label.buttonText));

    expect(new Set(keys).size).toBe(64);
    expect(Object.values(labels).every((label) => label.buttonText.length <= 20)).toBe(true);
    expect(Object.values(labels).every((label) => label.buttonText.startsWith("B "))).toBe(true);
    expect(buildDuplicateSafeAgoraProductLabels([...candidates].reverse())).toEqual(labels);
  });

  it("keeps B C and M prefixes when an external ButtonText is reserved", () => {
    const labels = buildDuplicateSafeAgoraProductLabels(
      [
        { productId: 767461, baseName: "B Billecart-Salmon Brut Reserve", winerimId: 267461 },
        { productId: 967461, baseName: "C Billecart-Salmon Brut Reserve", winerimId: 267461 },
        { productId: 1167461, baseName: "M Billecart-Salmon Brut Reserve", winerimId: 267461 },
      ],
      [{ Id: 1, Name: "Legacy", ButtonText: "B Billecart-Salmon B" }],
    );

    expect(labels["767461"].buttonText).toMatch(/^B /);
    expect(labels["967461"].buttonText).toMatch(/^C /);
    expect(labels["1167461"].buttonText).toMatch(/^M /);
    expect(Object.values(labels).every((label) => label.buttonText.length <= 20)).toBe(true);
  });

  it("uses only explicit per-product name overrides", () => {
    const config = {
      agora_product_name_overrides: {
        "680931": "B Emilio Moro 0,5L",
        "680939": "B Emilio Moro 750ml",
      },
    };

    expect(configuredAgoraProductNameOverride(config, 680931)).toBe("B Emilio Moro 0,5L");
    expect(configuredAgoraProductNameOverride(config, "680939")).toBe("B Emilio Moro 750ml");
    expect(configuredAgoraProductNameOverride(config, 722248)).toBeNull();
  });
});
