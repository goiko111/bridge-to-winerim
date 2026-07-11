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
});
