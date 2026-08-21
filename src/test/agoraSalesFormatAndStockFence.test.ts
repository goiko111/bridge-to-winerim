import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  agoraSalesPairKey,
  canonicalAgoraSalesLineFormat,
  resolveAgoraSalesLineIdentityForConnection,
  type AgoraSalesResolution,
} from "../../supabase/functions/_shared/agoraSalesLineIdentity";
import { decideAgoraStockFence } from "../../supabase/functions/_shared/agoraStockFence";

const PONZANO = "a700d425-9194-4758-95ff-7fee86419e14";
const SANTANDER = "79280cb8-0fe7-4a57-93a4-04172205ac70";
const OTHER = "e5b988f1-8471-4336-a1f7-a5c1626deab1";

const pairMappings = new Map<string, AgoraSalesResolution>([
  [agoraSalesPairKey("1759", "1868"), { winerim_wine_id: "232510", format: "GLASS" }],
  [agoraSalesPairKey("1648", "1763"), { winerim_wine_id: "38167", format: "GLASS" }],
]);
const resolutionMap = new Map<string, AgoraSalesResolution>([
  ["1855", { winerim_wine_id: "227648", format: "BOTTLE" }],
]);

function persistedFormat(connectionId: string, productId: string, saleFormatId: string, productName: string) {
  const identity = resolveAgoraSalesLineIdentityForConnection({
    connectionId,
    productId,
    saleFormatId,
    legacyProviderProductId: productId,
    resolutionMap,
    pairMappings,
    activeWineFormats: new Map(),
  });
  // Agora's own SaleFormatName for these legacy buttons is just the wine name,
  // which normalizeAgoraLineFormat degrades to BOTTLE.
  return canonicalAgoraSalesLineFormat({ connectionId, identity, fallbackFormat: "BOTTLE" });
}

describe("canonical persisted format for pair_exact lines", () => {
  it("persists GLASS for Ponzano 1759/1868 (RAMON BILBAO VERDEJO)", () => {
    expect(persistedFormat(PONZANO, "1759", "1868", "RAMON BILBAO VERDEJO")).toBe("GLASS");
  });

  it("persists GLASS for Santander 1648/1763", () => {
    expect(persistedFormat(SANTANDER, "1648", "1763", "PAZO DE SEÑORANS")).toBe("GLASS");
  });

  it("keeps the name-derived fallback for unresolved lines", () => {
    expect(persistedFormat(PONZANO, "1746", "1855", "CABREIROA AGUA GAS")).toBe("BOTTLE");
  });

  it("never overrides format for non-VINOTECA connections", () => {
    expect(persistedFormat(OTHER, "1855", "1855", "CONTADOR 2019")).toBe("BOTTLE");
  });
});

describe("absolute stock fence", () => {
  it("blocks stock when skipStockSync is true, even with force", () => {
    const decision = decideAgoraStockFence({ payload: { force: true, skipStockSync: true }, providerConfig: { sales_stock_sync_enabled: true } });
    expect(decision).toEqual({ allowed: false, skipped: true, reason: "skip_stock_sync_requested" });
  });

  it("blocks stock when sales_stock_sync_enabled is false, even with force", () => {
    const decision = decideAgoraStockFence({ payload: { force: true }, providerConfig: { sales_stock_sync_enabled: false } });
    expect(decision).toEqual({ allowed: false, skipped: true, reason: "sales_stock_sync_disabled" });
  });

  it("allows stock when the flag is enabled and no skip was requested", () => {
    expect(decideAgoraStockFence({ payload: { force: true }, providerConfig: { sales_stock_sync_enabled: true } }).allowed).toBe(true);
    expect(decideAgoraStockFence({ payload: {}, providerConfig: {} }).allowed).toBe(true);
  });
});

describe("agora-proxy wiring", () => {
  const source = readFileSync(resolve(process.cwd(), "supabase/functions/agora-proxy/index.ts"), "utf8");

  it("computes the fence once per request and gates every stock call site", () => {
    expect(source).toContain("const stockFence = decideAgoraStockFence({ payload, providerConfig: connection.provider_config });");
    const gated = source.match(/stockFence\.allowed/g) || [];
    expect(gated.length).toBeGreaterThanOrEqual(6);
    expect(source).not.toContain("const shouldSyncStock = !skipStockSync && resolvedLines > 0;");
    expect(source).toContain("stockSyncSkipped: stockFence.skipped");
  });

  it("uses the canonical format at every sales persistence call site", () => {
    expect(source.match(/format: canonicalAgoraSalesLineFormat\(\{ connectionId, identity: salesIdentity/g)).toHaveLength(5);
  });
});
