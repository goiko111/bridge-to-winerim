import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const agoraSource = readFileSync(resolve(repoRoot, "supabase/functions/agora-proxy/index.ts"), "utf8");
const winerimSource = readFileSync(resolve(repoRoot, "supabase/functions/winerim-proxy/index.ts"), "utf8");
const dispatcherSource = readFileSync(resolve(repoRoot, "supabase/functions/agora-cron-dispatcher/index.ts"), "utf8");

describe("catalog auto-push regressions", () => {
  it("keeps every evaluate-auto-push mutation behind one dry-run barrier", () => {
    const start = agoraSource.indexOf('if (action === "evaluate-auto-push")');
    const end = agoraSource.indexOf("// ── READ-ONLY EXPECTED CATALOG AUDIT", start);
    const block = agoraSource.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(block).toContain("const autoPushWritesEnabled = !forceEvaluate && !dryRun");
    expect(block).not.toContain("if (!forceEvaluate && !dryRun)");
    expect(block.match(/if \(autoPushWritesEnabled\)/g) || []).toHaveLength(2);
    expect(block).toContain("if (!autoPushWritesEnabled)");
    expect(block).toContain('dryRun ? "dry_run_would_queue" : "would_queue"');
  });

  it("uses stable DB ordering for both start and enrich catalog pages", () => {
    const start = winerimSource.indexOf('if (action === "fetch-catalog")');
    const end = winerimSource.indexOf("// ── FETCH WINE DETAILS", start);
    const block = winerimSource.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(block).not.toContain(".slice(detailOffset, detailOffset + detailBatchSize)");
    expect(block.match(/\.order\("winerim_id"\)/g) || []).toHaveLength(2);
    expect(block.match(/\.range\(detailOffset, detailOffset \+ detailBatchSize - 1\)/g) || []).toHaveLength(2);

    const apiOrder = ["300", "100", "400", "200"];
    const stableDbOrder = [...apiOrder].sort();
    expect([
      ...stableDbOrder.slice(0, 2),
      ...stableDbOrder.slice(2, 4),
    ]).toEqual(stableDbOrder);
  });

  it("uses bulk wine details before the individual fallback", () => {
    expect(winerimSource).toContain("/wines/bulk");
    expect(winerimSource).toContain("const bulkSize = 100");
    expect(winerimSource).toContain("body: JSON.stringify({ ids: numericIds })");

    const bulkCall = winerimSource.indexOf("/wines/bulk");
    const individualFallback = winerimSource.indexOf("const fallbackIds = Array.from(unresolved)");
    expect(bulkCall).toBeGreaterThan(-1);
    expect(individualFallback).toBeGreaterThan(bulkCall);
  });

  it("does not serialize every catalog cache write", () => {
    expect(winerimSource).toContain("async function runWithConcurrency");
    expect(winerimSource).toContain("runWithConcurrency(listUpserts, 25");
    expect(winerimSource).toContain("runWithConcurrency(detailUpdates, 25");
    expect(winerimSource).toContain("runWithConcurrency(detailFailures, 25");
  });

  it("fails loudly when the catalog dispatcher cannot invoke Agora", () => {
    expect(winerimSource).toContain("async function invokeInternalFunctionJson");
    expect(winerimSource).toContain("if (!response.ok)");
    expect(winerimSource).toContain("returned HTTP ${response.status}");

    const catalogStart = winerimSource.indexOf('if (action === "fetch-catalog")');
    const catalogEnd = winerimSource.indexOf("// ── FETCH WINE DETAILS", catalogStart);
    const catalogBlock = winerimSource.slice(catalogStart, catalogEnd);
    expect(catalogBlock.match(/invokeInternalFunctionJson\(supabaseUrl, supabaseKey, "agora-proxy"/g) || [])
      .toHaveLength(3);
  });

  it("does not turn an enriched wine into a false CREATE candidate", () => {
    expect(winerimSource).toContain('previous?.pricing_status === "READY"');
    expect(winerimSource).toContain('pricingStatus = "READY"');
    expect(winerimSource).toContain("routes real price changes through the CREATE path");

    const previousLookup = winerimSource.indexOf("const previous = existingBeforeList.get(winerimId)");
    const listUpsert = winerimSource.indexOf("listUpserts.push(upsertPayload)", previousLookup);
    expect(previousLookup).toBeGreaterThan(-1);
    expect(listUpsert).toBeGreaterThan(previousLookup);
  });

  it("snapshots old catalog values before the remote detail request", () => {
    const previousDetails = winerimSource.indexOf("const existingBeforeDetails = await loadExistingWineRows(batchWineIds)");
    const remoteDetails = winerimSource.indexOf("await fetchWineDetails(batchWineIds, winerimHeaders, 5)");
    expect(previousDetails).toBeGreaterThan(-1);
    expect(remoteDetails).toBeGreaterThan(previousDetails);
  });

  it("routes READY price changes through UPDATE, including self-healing", () => {
    expect(winerimSource).toContain("const changedReadyWineIds: string[] = []");
    expect(winerimSource).toContain("changedReadyWineIds.push(String(winerimId))");
    expect(winerimSource).toContain('eventType: "UPDATE"');
    expect(winerimSource).toContain("dryRun: autoPushDryRun");
    expect(winerimSource).toContain("autoUpdated");
  });

  it("refreshes published wines before the long catalog walk", () => {
    expect(winerimSource).toContain("const trackedUpdatesOnly = body.trackedUpdatesOnly === true");
    expect(winerimSource).toContain('.from("winerim_push_tracking")');
    expect(winerimSource).toContain('.in("sync_status", ["VERIFIED", "PUSHED"])');

    const trackedRefresh = dispatcherSource.indexOf('action: "fetch-wine-details", connectionId: connection.id, trackedUpdatesOnly: true');
    const fullCatalog = dispatcherSource.indexOf('action: "fetch-catalog", connectionId: connection.id');
    expect(trackedRefresh).toBeGreaterThan(-1);
    expect(fullCatalog).toBeGreaterThan(trackedRefresh);
  });
});
