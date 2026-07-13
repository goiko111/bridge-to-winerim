import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const agoraProxySource = readFileSync(resolve(repoRoot, "supabase/functions/agora-proxy/index.ts"), "utf8");
const dispatcherSource = readFileSync(resolve(repoRoot, "supabase/functions/agora-cron-dispatcher/index.ts"), "utf8");

describe("Agora open tickets pilot and glass publishing gates", () => {
  it("keeps the open-ticket pilot callable but flag-gated", () => {
    expect(agoraProxySource).toContain('action === "probe-open-tickets"');
    expect(agoraProxySource).toContain('action === "sync-open-tickets"');
    expect(agoraProxySource).toContain("/api/export/tickets/");
    expect(agoraProxySource).toContain("open_tickets_sync_enabled");
    expect(agoraProxySource).toContain("open_tickets_stock_sync_enabled");
    expect(agoraProxySource).toContain("open_tickets_min_line_age_minutes");
    expect(dispatcherSource).toContain("open_tickets_sync_enabled");
    expect(dispatcherSource).toContain('action: "sync-open-tickets"');
  });

  it("uses incremental closed-day stock reconciliation when open-ticket sync is enabled", () => {
    expect(agoraProxySource).toContain("isIntradaySalesSyncEnabled(connection) || isOpenTicketsSyncEnabled(connection)");
  });

  it("does not require the legacy serve_by_glass flag when Winerim has a glass price", () => {
    expect(agoraProxySource).toContain("serve_by_glass_not_enabled_but_glass_price_present");
    expect(agoraProxySource).not.toContain('reason: "glass_skipped:serve_by_glass_not_enabled"');
    expect(agoraProxySource).toContain('reason: "glass_skipped:no_glass_sale_price"');
  });

  it("preserves key Agora safety guards", () => {
    expect(agoraProxySource.match(/req\.json\(/g) || []).toHaveLength(1);
    const directProductsCalls = agoraProxySource.match(/fetchWithRetry\([^)]*export-master\/\?filter=Products/g) || [];
    expect(directProductsCalls).toHaveLength(0);
    expect(agoraProxySource).toContain("fetchAgoraProductsXmlCached");
  });

  it("persists Agora sale line time and passes it to Winerim sales import", () => {
    expect(agoraProxySource).toContain("extractAgoraProviderSoldAt");
    expect(agoraProxySource).toContain("line?.CreationDate");
    expect(agoraProxySource).toContain("provider_sold_at");
    expect(agoraProxySource).toContain("provider_sold_at_source");
    expect(agoraProxySource).toContain("soldAt: normalizeProviderSoldAt(input.soldAt) || input.day");
  });

  it("routes inactive Winerim stock variants through sales import without mutating stock", () => {
    expect(agoraProxySource).toContain("function readWinerimStockActive");
    expect(agoraProxySource).toContain("stock.stockActive ?? stock.stock_active ?? stock.active");
    expect(agoraProxySource).toContain("async function importWinerimSalesOnly");
    expect(agoraProxySource).toContain("POST /sales/import failed for inactive stock");
    expect(agoraProxySource.match(/mode: \"sales_only_stock_inactive\"/g) || []).toHaveLength(6);
    expect(agoraProxySource.match(/if \(!match\.stockActive\)/g) || []).toHaveLength(3);
    expect(agoraProxySource).toContain("stockActive: false");
  });

  it("treats stale open-ticket sales as provisional and reversible", () => {
    expect(agoraProxySource).toContain("open_tickets_stock_current_day_only");
    expect(agoraProxySource).toContain("open_tickets_restore_stale_previous_days_enabled");
    expect(agoraProxySource).toContain("open_ticket_cancellation_restore");
    expect(agoraProxySource).toContain("staleDayStockSkippedLines");
    expect(agoraProxySource).toContain("isOpenTicketStockDayAllowed(day, defaultDay, providerConfig)");
    expect(agoraProxySource).toContain('String(event.doc_type || "").toLowerCase() !== "openticket"');
    expect(agoraProxySource).toContain("definitiveEventIds.length > 0 ? definitiveEventIds : allDayEventIds");
    expect(agoraProxySource).toContain("quantity: -restoreQty");
  });
});
