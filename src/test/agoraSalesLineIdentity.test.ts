import { describe, expect, it } from "vitest";
import {
  resolveForwardAgoraSalesLineIdentity,
  type AgoraSalesResolution,
} from "../../supabase/functions/_shared/agoraSalesLineIdentity";

const SA_VIDA = "e5b988f1-8471-4336-a1f7-a5c1626deab1";

function mappings(
  guimaro: AgoraSalesResolution = { winerim_wine_id: "148468", format: "GLASS" },
) {
  return new Map<string, AgoraSalesResolution>([
    ["848468", guimaro],
    ["648999", { winerim_wine_id: "148999", format: "BOTTLE" }],
  ]);
}

function resolve(overrides: Partial<Parameters<typeof resolveForwardAgoraSalesLineIdentity>[0]> = {}) {
  return resolveForwardAgoraSalesLineIdentity({
    connectionId: SA_VIDA,
    providerProductId: 0,
    saleFormatId: 0,
    productName: "Copa Guimaro Godello",
    normalizedFormat: "COPA",
    resolutionMap: mappings(),
    ...overrides,
  });
}

describe("resolveForwardAgoraSalesLineIdentity", () => {
  it("prefers a native ProductId over SaleFormatId", () => {
    expect(resolve({ providerProductId: "648999", saleFormatId: "848468" })).toEqual({
      providerProductId: "648999",
      resolution: { winerim_wine_id: "148999", format: "BOTTLE" },
      source: "native_product",
    });
  });

  it("falls back from ProductId zero to the native SaleFormatId", () => {
    expect(resolve({ providerProductId: 0, saleFormatId: "848468" })).toEqual({
      providerProductId: "848468",
      resolution: { winerim_wine_id: "148468", format: "GLASS" },
      source: "native_sale_format",
    });
  });

  it("treats string zero as absent", () => {
    expect(resolve({ providerProductId: "0", saleFormatId: "848468" }).source)
      .toBe("native_sale_format");
  });

  it("uses a mapped SaleFormatId when ProductId exists but is not mapped", () => {
    expect(resolve({ providerProductId: "123", saleFormatId: "848468" })).toEqual({
      providerProductId: "848468",
      resolution: { winerim_wine_id: "148468", format: "GLASS" },
      source: "native_sale_format",
    });
  });

  it("preserves an unmapped native ID without applying a text alias", () => {
    expect(resolve({ providerProductId: "123", saleFormatId: 0 })).toEqual({
      providerProductId: "123",
      resolution: null,
      source: "native_product",
      blockedReason: "authoritative_mapping_missing",
    });
  });

  it("maps only the exact Sa Vida Guimaro glass identity when both IDs are absent", () => {
    expect(resolve()).toEqual({
      providerProductId: "848468",
      resolution: { winerim_wine_id: "148468", format: "GLASS" },
      source: "sa_vida_guimaro_exact",
    });
  });

  it("accepts only harmless case, accent and whitespace normalization", () => {
    expect(resolve({ productName: "  COPA   GUÍMARO   GODELLO " }).source)
      .toBe("sa_vida_guimaro_exact");
    expect(resolve({ productName: "Copa Godello Guimaro" }).source)
      .toBe("sa_vida_guimaro_exact");
  });

  it.each([
    ["another connection", { connectionId: "other" }, "connection_not_allowlisted"],
    ["bottle format", { normalizedFormat: "BOT" }, "format_not_glass"],
    ["ambiguous short name", { productName: "Copa Guimaro" }, "label_not_exact"],
    ["ambiguous bare name", { productName: "Guimaro Godello" }, "label_not_exact"],
    ["suffix added", { productName: "Copa Guimaro Godello Reserva" }, "label_not_exact"],
  ])("fails closed for %s", (_label, overrides, blockedReason) => {
    expect(resolve(overrides)).toMatchObject({
      providerProductId: "",
      resolution: null,
      source: "unresolved",
      blockedReason,
    });
  });

  it("fails closed when the authoritative mapping is missing or changed", () => {
    expect(resolve({ resolutionMap: new Map() }).blockedReason)
      .toBe("authoritative_mapping_guard_failed");
    expect(resolve({
      resolutionMap: mappings({ winerim_wine_id: "999999", format: "GLASS" }),
    }).blockedReason).toBe("authoritative_mapping_guard_failed");
    expect(resolve({
      resolutionMap: mappings({ winerim_wine_id: "148468", format: "BOTTLE" }),
    }).blockedReason).toBe("authoritative_mapping_guard_failed");
  });
});
