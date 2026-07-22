import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const proxyPath = resolve(process.cwd(), "supabase/functions/agora-proxy/index.ts");
const source = readFileSync(proxyPath, "utf8");
const saveSalesSource = source.slice(
  source.indexOf('if (action === "save-sales")'),
  source.indexOf('if (action === "sync-intraday-sales")'),
);
const autoSyncSalesSource = source.slice(
  source.indexOf('if (action === "auto-sync-sales")'),
  source.indexOf('if (action === "resolve-sales")'),
);

describe("Agora mapped sales precedence", () => {
  it("treats an explicit Winerim mapping as a wine candidate", () => {
    expect(source).toContain("function isResolvedWineCandidate(");
    expect(source).toContain('Boolean(String(winerimProductId || "").trim()) || heuristicCandidate');
  });

  it("uses the effective candidate in open tickets and every persisted invoice flow", () => {
    expect(source).toContain(
      "const stockCandidate = effectiveWineCandidate && oldEnoughForStock && stockDayAllowed;",
    );
    expect(source.match(/is_wine_candidate: effectiveWineCandidate/g)).toHaveLength(4);
    expect(source).not.toMatch(/is_wine_candidate:\s*wr\.candidate/);
  });

  it("does not discard mapped definitive sales because of stale candidate metadata", () => {
    expect(source).toContain("if (openTicketEventIds.has(line.sales_event_id) && !line.is_wine_candidate) continue;");
    expect(source).toContain('if (desiredSource === "open_ticket" && !line.is_wine_candidate) continue;');
    expect(source).toContain("l.is_wine_candidate || !openTicketEventIds.has(l.sales_event_id)");
    expect(source).not.toMatch(
      /\.select\("sales_event_id, quantity, winerim_product_id, format, is_wine_candidate"\)\s*\.eq\("connection_id", connectionId\)\s*\.eq\("is_wine_candidate", true\)/,
    );
  });

  it("chunks stale open-ticket stock lookups and surfaces lookup failures", () => {
    expect(source).toContain("for (let i = 0; i < staleEventIds.length; i += 100)");
    expect(source).toContain("stock_sync_log lookup failed:");
    expect(source).not.toContain('.in("sales_event_id", staleEventIds)');
  });

  it("never exposes partial line selection for stock recovery", () => {
    expect(source).not.toContain("salesLineItemIds");
    expect(source).not.toContain("sales_line_item_ids");
    expect(source).toContain("sales_events lookup failed:");
    expect(source).toContain("sales_line_items lookup failed:");
  });

  it("routes Agora HTTP calls through the throttled retry wrapper", () => {
    expect(source.match(/await fetch\(url,/g)).toHaveLength(2);
    expect(source).not.toContain("await fetch(`${baseUrlClean}");
    expect(source).toContain("await fetchWithRetry(url, { headers }, 10_000)");
  });

  it("keeps manual imports away from the live cursor and advances automatic cursors monotonically", () => {
    expect(source).toContain('if (!isBusinessDay(day))');
    expect(source).toContain('businessDay must use YYYY-MM-DD');
    expect(source).toContain('async function updateSalesCursorMonotonically(');
    expect(source).toContain('const cursorBefore = String(connection.last_business_day_synced || "").trim()');
    expect(source).toContain('const cursorAfter = cursorBefore || null');
    expect(source).toContain('const cursorAdvanced = false');
    expect(source).toContain(".or(`last_business_day_synced.is.null,last_business_day_synced.lt.${candidateDay}`)");
    expect(source).toContain('connectionId,\n        null,\n        syncedAt,');
    expect(source.match(/updateSalesCursorMonotonically\(/g)?.length || 0).toBeGreaterThanOrEqual(5);
    expect(source).not.toContain('.update({ last_business_day_synced: completedDayCursor');
    expect(source).not.toContain('.update({ last_business_day_synced: cursorAdvancedTo');
  });

  it("blocks cursor advancement when any invoice or stock lookup is only partially persisted", () => {
    expect(source).toContain('let ingestionError: string | null = null;');
    expect(source).toContain('ingestionError = `Could not save invoice ${docId}:');
    expect(source).toContain('saveBlockedReason = `event_upsert_failed:');
    expect(source).toContain('saveBlockedReason = `line_replace_failed:');
    expect(source).toContain('blockedBySaveFailureReason: saveBlockedReason');
    expect(source).toContain('throw new Error(`Could not read sales events for ${day}:');
    expect(source).toContain('throw new Error(`Could not read sales lines for ${day}:');
    expect(saveSalesSource).not.toContain('if (eventErr || !eventRow) continue;');
    expect(autoSyncSalesSource).not.toContain('if (eventErr || !eventRow) continue;');
  });
});
