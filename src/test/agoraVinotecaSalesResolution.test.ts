import { describe, expect, it } from "vitest";
import {
  resolveAgoraSalesLineIdentityForConnection,
  type AgoraSalesResolution,
} from "../../supabase/functions/_shared/agoraSalesLineIdentity";
import { parseVinotecaNativeId } from "../../supabase/functions/_shared/agoraVinotecaNativeFormats";

const PONZANO = "a700d425-9194-4758-95ff-7fee86419e14";
const SANTANDER = "79280cb8-0fe7-4a57-93a4-04172205ac70";
const OTHER = "e5b988f1-8471-4336-a1f7-a5c1626deab1";

const resolutionMap = new Map<string, AgoraSalesResolution>([
  // Cruz de Alba (Ponzano)
  ["2232481", { winerim_wine_id: "232481", format: "BOTTLE" }],
  ["3232481", { winerim_wine_id: "232481", format: "GLASS" }],
  ["4232481", { winerim_wine_id: "232481", format: "MAGNUM" }],
  // Les Terrasses (Santander)
  ["2037684", { winerim_wine_id: "37684", format: "BOTTLE" }],
  ["3037684", { winerim_wine_id: "37684", format: "GLASS" }],
  // Legacy low id belonging to an unrelated wine (CONTADOR 2019)
  ["1855", { winerim_wine_id: "227648", format: "BOTTLE" }],
  // Native id whose wine is not active
  ["3999111", { winerim_wine_id: "999111", format: "GLASS" }],
]);

const activeWineIds = new Set(["232481", "37684", "227648"]);

function resolve(connectionId: string, productId: unknown, saleFormatId: unknown) {
  return resolveAgoraSalesLineIdentityForConnection({
    connectionId,
    productId,
    saleFormatId,
    legacyProviderProductId: String(productId ?? ""),
    resolutionMap,
    activeWineIds,
  });
}

describe("vinoteca native namespace", () => {
  it("recognises only deterministic 2M/3M/4M ids", () => {
    expect(parseVinotecaNativeId("2232481")).toEqual({ format: "BOTTLE", wineId: "232481", agoraId: "2232481" });
    expect(parseVinotecaNativeId("3232481")).toEqual({ format: "GLASS", wineId: "232481", agoraId: "3232481" });
    expect(parseVinotecaNativeId("4232481")).toEqual({ format: "MAGNUM", wineId: "232481", agoraId: "4232481" });
    expect(parseVinotecaNativeId("1855")).toBeNull();
    expect(parseVinotecaNativeId("1746")).toBeNull();
    expect(parseVinotecaNativeId("")).toBeNull();
  });
});

describe("forward sales resolution (VINOTECA connections)", () => {
  it("never resolves a non-wine line through a legacy SaleFormatId", () => {
    const line = resolve(PONZANO, "1746", "1855");
    expect(Boolean(line.resolution)).toBe(false);
    expect(line.resolution).toBeNull();
    expect(line.providerProductId).toBe("1746");
    expect(line.source).toBe("product_first");
  });

  it("resolves Ponzano invoice 9154 glass line to wineId 232481", () => {
    expect(resolve(PONZANO, "2232481", "3232481")).toEqual({
      providerProductId: "3232481",
      resolution: { winerim_wine_id: "232481", format: "GLASS" },
      source: "sale_format_first",
    });
  });

  it("resolves Santander invoice 76423 glass line to wineId 37684", () => {
    expect(resolve(SANTANDER, "2037684", "3037684")).toEqual({
      providerProductId: "3037684",
      resolution: { winerim_wine_id: "37684", format: "GLASS" },
      source: "sale_format_first",
    });
  });

  it("resolves bottle and magnum through their own namespaces", () => {
    expect(resolve(PONZANO, "2232481", 0).resolution).toEqual({ winerim_wine_id: "232481", format: "BOTTLE" });
    expect(resolve(PONZANO, "4232481", 0).resolution).toEqual({ winerim_wine_id: "232481", format: "MAGNUM" });
  });

  it("fails closed for a native id whose wine is not active", () => {
    const line = resolve(PONZANO, 0, "3999111");
    expect(line.resolution).toBeNull();
    expect(line.blockedReason).toBe("winerim_wine_inactive");
  });

  it("fails closed for a native id without mapping or with mismatched identity", () => {
    expect(resolve(PONZANO, 0, "3111222").blockedReason).toBe("native_mapping_missing");
    expect(resolveAgoraSalesLineIdentityForConnection({
      connectionId: PONZANO,
      productId: 0,
      saleFormatId: "3232481",
      legacyProviderProductId: "",
      resolutionMap: new Map([["3232481", { winerim_wine_id: "999", format: "GLASS" }]]),
      activeWineIds,
    }).blockedReason).toBe("native_identity_mismatch");
  });

  it("is idempotent across repeated cycles", () => {
    const first = resolve(PONZANO, "2232481", "3232481");
    const second = resolve(PONZANO, "2232481", "3232481");
    expect(second).toEqual(first);
    expect(resolve(PONZANO, "1746", "1855")).toEqual(resolve(PONZANO, "1746", "1855"));
  });
});

describe("generic connections keep the previous behaviour", () => {
  it("uses the legacy flat identity untouched", () => {
    expect(resolve(OTHER, "1746", "1855")).toEqual({
      providerProductId: "1746",
      resolution: null,
      source: "legacy",
    });
    expect(resolve(OTHER, "2232481", "3232481")).toEqual({
      providerProductId: "2232481",
      resolution: { winerim_wine_id: "232481", format: "BOTTLE" },
      source: "legacy",
    });
  });
});
