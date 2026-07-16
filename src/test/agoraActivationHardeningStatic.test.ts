import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "../..");
const agoraProxySource = readFileSync(
  resolve(repoRoot, "supabase/functions/agora-proxy/index.ts"),
  "utf8",
);
const winerimProxySource = readFileSync(
  resolve(repoRoot, "supabase/functions/winerim-proxy/index.ts"),
  "utf8",
);
const runbookSource = readFileSync(
  resolve(repoRoot, "scripts/activate-agora-live-ready.mjs"),
  "utf8",
);
const dispatcherSource = readFileSync(
  resolve(repoRoot, "supabase/functions/agora-cron-dispatcher/index.ts"),
  "utf8",
);
const lockMigrationSource = [
  "supabase/migrations/20260716073810_7228e9d1-4322-4852-8f43-6181cf8ab9d5.sql",
  "supabase/migrations/20260716074136_2e472ece-158f-4c6b-a46c-806487c539ba.sql",
].map((file) => readFileSync(resolve(repoRoot, file), "utf8")).join("\n");

describe("Agora staged activation hardening", () => {
  it("fails closed on deterministic ID collisions and unverified writes", () => {
    expect(agoraProxySource).toContain("AGORA_PRODUCT_ID_COLLISION");
    expect(agoraProxySource).toContain('.eq("source", "WINERIM")');
    expect(agoraProxySource).toContain('.eq("sync_status", "VERIFIED")');
    expect(agoraProxySource).toContain('.eq("status", "CONFIRMED")');
    expect(agoraProxySource).toContain('taskVerification.success = false');
    expect(agoraProxySource).toContain('code: "PRICE_MISMATCH"');
    expect(agoraProxySource).toContain('code: "NAME_MISMATCH"');
  });

  it("limits staged price writes to selected sale-center price lists", () => {
    expect(agoraProxySource).toContain('price_write_scope === "SELECTED_SALE_CENTERS"');
    expect(agoraProxySource).toContain("CurrentPriceListId || saleCenter.PriceListId");
    expect(runbookSource).toContain('price_write_scope: "SELECTED_SALE_CENTERS"');
    expect(runbookSource).toContain("CurrentPriceListId || item.PriceListId");
  });

  it("clears authoritative prices removed from Winerim", () => {
    expect(winerimProxySource).toContain("bottle_sale_price: nf.bottleSalePrice");
    expect(winerimProxySource).toContain("glass_sale_price: nf.glassSalePrice");
    expect(winerimProxySource).toContain("magnum_sale_price: nf.magnumSalePrice");
  });

  it("keeps activation synchronous and prevents historical stock catch-up", () => {
    expect(runbookSource).toContain("serverLoop: false");
    expect(runbookSource).toContain("scheduleNextBatch: false");
    expect(runbookSource).toContain("runSelfHealing: false");
    expect(runbookSource).toContain("ACTIVATION_ROLLBACK_CANCELLED");
    expect(runbookSource).toContain("stock_sync_not_before");
    expect(runbookSource).toContain("stock_sync_not_before_at");
    expect(agoraProxySource).toContain("isStockSyncDayAllowed");
    expect(agoraProxySource).toContain("providerSaleIsAfterStockStart");
    expect(runbookSource).toContain("const preserveExistingLiveState = originalConnection.enabled === true");
    expect(runbookSource).toContain('"CATALOG_READY_PENDING_SALE"');
    expect(runbookSource).toContain("enabled: preserveExistingLiveState");
    expect(runbookSource).toContain("Live activation requires an explicit Lovable Cloud service-role key");
  });

  it("requires a fresh read-only catalog audit before and after writes", () => {
    expect(agoraProxySource).toContain('action === "audit-winerim-products"');
    expect(agoraProxySource).toContain("readOnly: true");
    expect(runbookSource.match(/action: "audit-winerim-products"/g) || []).toHaveLength(2);
    expect(agoraProxySource).toContain("EXPECTED_XML_VALIDATION_FAILED");
    expect(agoraProxySource).toContain("expectedAuditValidationKeys");
    expect(agoraProxySource).toContain('expectedAuditValidationKeys.has(`${item.winerimId}:${item.formatType}`)');
    expect(agoraProxySource).toContain("const auditWineBatchSize = 500");
    expect(agoraProxySource).toContain(".range(offset, offset + auditWineBatchSize - 1)");
    expect(agoraProxySource).toContain("function agoraProductDifferenceReasons");
    expect(agoraProxySource).toContain('replace(/\\s+/g, " ").trim()');
    expect(agoraProxySource).toContain('decodeXmlAttribute(expected.attrs[attr] || "")');
    expect(agoraProxySource).toContain('decodeXmlAttribute(actual.attrs[attr] || "")');
    expect(agoraProxySource).toContain("differences,");
  });

  it("serializes cron jobs per connection with an expiring database lease", () => {
    expect(dispatcherSource).toContain('rpc("acquire_agora_dispatch_lock"');
    expect(dispatcherSource).toContain('rpc("release_agora_dispatch_lock"');
    expect(dispatcherSource).toContain("lockHeartbeat = setInterval");
    expect(dispatcherSource).toContain("if (lockHeartbeatError) throw lockHeartbeatError");
    expect(dispatcherSource).toContain("if (lockHeartbeatInFlight) await lockHeartbeatInFlight");
    expect(runbookSource).toContain("if (lockHeartbeatInFlight) await lockHeartbeatInFlight");
    expect(dispatcherSource).toContain("for (const dispatch of buildRequests(connection))");
    expect(lockMigrationSource).toContain("primary key (connection_id)");
    expect(lockMigrationSource).toContain("locked_until <= now()");
    expect(lockMigrationSource).toContain("return coalesce(acquired_token = p_lock_token, false)");
  });

  it("uses verified preparation routes and creates pilot families hidden", () => {
    expect(agoraProxySource).toContain("preparation_routes");
    expect(agoraProxySource).toContain("INVALID_PREPARATION_ROUTE");
    expect(agoraProxySource).toContain('ShowInPos="false"');
    expect(agoraProxySource).toContain("AGORA_FAMILY_VERIFICATION_FAILED");
    expect(runbookSource).toContain("inferPreparationRoutes");
  });
});
