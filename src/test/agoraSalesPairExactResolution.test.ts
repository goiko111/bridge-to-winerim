import { describe, expect, it } from "vitest";
import {
  agoraSalesPairKey,
  resolveAgoraSalesLineIdentityForConnection,
  type AgoraSalesResolution,
} from "../../supabase/functions/_shared/agoraSalesLineIdentity";

const PONZANO = "a700d425-9194-4758-95ff-7fee86419e14";
const SANTANDER = "79280cb8-0fe7-4a57-93a4-04172205ac70";
const OTHER = "e5b988f1-8471-4336-a1f7-a5c1626deab1";

// Exact compound identities seeded in agora_sales_variant_mappings.
const pairMappings = new Map<string, AgoraSalesResolution>([
  [agoraSalesPairKey("1759", "1868"), { winerim_wine_id: "232510", format: "GLASS" }],
  [agoraSalesPairKey("1957", "2198"), { winerim_wine_id: "233673", format: "GLASS" }],
  [agoraSalesPairKey("1648", "1763"), { winerim_wine_id: "38167", format: "GLASS" }],
  [agoraSalesPairKey("2232481", "3232481"), { winerim_wine_id: "232481", format: "GLASS" }],
  [agoraSalesPairKey("2037684", "3037684"), { winerim_wine_id: "37684", format: "GLASS" }],
]);

// Legacy flat maps that MUST never win on their own.
const resolutionMap = new Map<string, AgoraSalesResolution>([
  ["1855", { winerim_wine_id: "227648", format: "BOTTLE" }], // CONTADOR 2019, colliding legacy id
  ["1746", { winerim_wine_id: "227648", format: "BOTTLE" }], // water product wrongly adopted
  ["2232481", { winerim_wine_id: "232481", format: "BOTTLE" }],
]);

const activeWineFormats = new Map<string, Set<string>>([
  ["232481", new Set(["BOTTLE", "GLASS", "MAGNUM"])],
  ["37684", new Set(["BOTTLE", "GLASS"])],
  ["227648", new Set(["BOTTLE"])],
]);

function resolve(connectionId: string, productId: unknown, saleFormatId: unknown) {
  return resolveAgoraSalesLineIdentityForConnection({
    connectionId,
    productId,
    saleFormatId,
    legacyProviderProductId: String(productId ?? ""),
    resolutionMap,
    pairMappings,
    activeWineFormats,
  });
}

describe("pair_exact -> native -> unresolved resolution (Don Bernardo)", () => {
  it("resolves Ponzano legacy adopted pair 1759/1868 to wine 232510 GLASS", () => {
    expect(resolve(PONZANO, "1759", "1868")).toEqual({
      providerProductId: "1868",
      resolution: { winerim_wine_id: "232510", format: "GLASS" },
      source: "pair_exact",
    });
  });

  it("resolves Ponzano legacy adopted pair 1957/2198 to wine 233673 GLASS", () => {
    const line = resolve(PONZANO, "1957", "2198");
    expect(line.resolution).toEqual({ winerim_wine_id: "233673", format: "GLASS" });
    expect(line.source).toBe("pair_exact");
  });

  it("resolves Santander legacy adopted pair 1648/1763 to wine 38167 GLASS", () => {
    const line = resolve(SANTANDER, "1648", "1763");
    expect(line.resolution).toEqual({ winerim_wine_id: "38167", format: "GLASS" });
    expect(line.source).toBe("pair_exact");
  });

  it("never resolves water 1746/1855 (Contador collision) as wine", () => {
    const line = resolve(PONZANO, "1746", "1855");
    expect(line.resolution).toBeNull();
    expect(line.blockedReason).toBe("pair_mapping_missing");
  });

  it("still resolves native namespaces 2232481/3232481 and 2037684/3037684", () => {
    expect(resolve(PONZANO, "2232481", "3232481").resolution)
      .toEqual({ winerim_wine_id: "232481", format: "GLASS" });
    expect(resolve(SANTANDER, "2037684", "3037684").resolution)
      .toEqual({ winerim_wine_id: "37684", format: "GLASS" });
  });

  it("falls back to the deterministic native identity when no pair row exists", () => {
    const line = resolveAgoraSalesLineIdentityForConnection({
      connectionId: PONZANO,
      productId: "2232481",
      saleFormatId: "3232481",
      legacyProviderProductId: "2232481",
      resolutionMap,
      pairMappings: new Map(),
      activeWineFormats,
    });
    expect(line.resolution).toEqual({ winerim_wine_id: "232481", format: "GLASS" });
    expect(line.source).toBe("sale_format_first");
  });

  it("fails closed on a crossed/mismatched pair", () => {
    expect(resolve(PONZANO, "1759", "2198").resolution).toBeNull();
    expect(resolve(PONZANO, "1957", "1868").resolution).toBeNull();
  });

  it("is idempotent across two cycles", () => {
    for (const pair of [["1759", "1868"], ["1746", "1855"], ["1759", "2198"]] as const) {
      const first = resolve(PONZANO, pair[0], pair[1]);
      const second = resolve(PONZANO, pair[0], pair[1]);
      expect(second).toEqual(first);
    }
  });

  it("keeps non allowlisted connections on legacy behaviour", () => {
    expect(resolve(OTHER, "1746", "1855")).toEqual({
      providerProductId: "1746",
      resolution: { winerim_wine_id: "227648", format: "BOTTLE" },
      source: "legacy",
    });
  });
});
