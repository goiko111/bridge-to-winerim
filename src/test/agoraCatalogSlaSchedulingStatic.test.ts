import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const agoraSource = readFileSync(resolve(repoRoot, "supabase/functions/agora-proxy/index.ts"), "utf8");
const winerimSource = readFileSync(resolve(repoRoot, "supabase/functions/winerim-proxy/index.ts"), "utf8");
const dispatcherSource = readFileSync(resolve(repoRoot, "supabase/functions/agora-cron-dispatcher/index.ts"), "utf8");

const evaluateBlock = (() => {
  const start = agoraSource.indexOf('if (action === "evaluate-auto-push")');
  const end = agoraSource.indexOf('console.log(`[evaluate-auto-push]', start);
  return agoraSource.slice(start, end);
})();

const catalogBlock = (() => {
  const start = winerimSource.indexOf('if (action === "fetch-catalog")');
  const end = winerimSource.indexOf("// ── FETCH WINE DETAILS", start);
  return winerimSource.slice(start, end);
})();

describe("Agora catalog SLA scheduling", () => {
  it("runs sync-master-data before fetch-catalog in the catalog job", () => {
    const master = dispatcherSource.indexOf('action: "sync-master-data", connectionId: connection.id');
    const catalog = dispatcherSource.indexOf('action: "fetch-catalog", connectionId: connection.id');
    expect(master).toBeGreaterThan(-1);
    expect(catalog).toBeGreaterThan(master);
    // strictly sequential per connection
    expect(dispatcherSource).toContain("const result = await invokeOne(dispatch);");
    expect(dispatcherSource).toContain("SKIPPED_FETCH_CATALOG_STALE_AGORA_MASTER");
  });

  it("compares UPDATE candidates against a freshly read Products export", () => {
    expect(evaluateBlock).toContain(
      "fetchAgoraProductsXmlCached(connectionId, baseUrlClean, apiTokenClean, fetchWithRetry, 30000, true)",
    );
    // exactly one forced refresh per evaluation, never per product
    expect(evaluateBlock.match(/fetchWithRetry, 30000, true\)/g) || []).toHaveLength(1);
    // the diff itself is no longer skipped in dry-run mode, so wouldQueue is accurate
    expect(evaluateBlock).toContain(
      'if (evtType === "UPDATE" && updateDiffEnabled && updateDiffCurrentXml && !forceEvaluate) {',
    );
  });

  it("keeps dryRun read-only behind a single write barrier", () => {
    expect(evaluateBlock).toContain("const autoPushWritesEnabled = !forceEvaluate && !dryRun");
    expect(evaluateBlock).not.toContain("if (!forceEvaluate && !dryRun)");
    expect(evaluateBlock).toContain("if (!autoPushWritesEnabled)");
    expect(evaluateBlock).toContain('dryRun ? "dry_run_would_queue" : "would_queue"');
    // the only insert into outbound_tasks sits after the barrier
    const barrier = evaluateBlock.lastIndexOf("if (!autoPushWritesEnabled)");
    const insert = evaluateBlock.indexOf('supabase.from("outbound_tasks").insert(', barrier);
    expect(insert).toBeGreaterThan(barrier);
  });

  it("evaluates allowlisted / canary wine ids in the first catalog batch", () => {
    expect(catalogBlock).toContain("auto_push_update_winerim_ids");
    expect(catalogBlock).toContain("auto_push_update_canary_winerim_ids");
    expect(catalogBlock).toContain("const prioritizeFirstBatch =");
    expect(catalogBlock.match(/prioritizeFirstBatch\(/g) || []).toHaveLength(2);
    // fail-closed: no allowlist or later pages keep legacy ordering
    expect(catalogBlock).toContain("if (catalogPriorityWineIds.length === 0 || detailOffset !== 0) return ids;");
  });

  it("advances the catalog cursor by page size, not by promoted extras", () => {
    expect(catalogBlock).toContain("let batchPageSize = 0");
    expect(winerimSource).toContain("Math.min(totalWines, detailOffset + batchPageSize)");
    expect(winerimSource).toContain("next_offset: detailOffset + batchPageSize");
  });

  it("keeps one writer per connection under a dispatch lock", () => {
    expect(dispatcherSource).toContain("acquire_agora_dispatch_lock");
    expect(dispatcherSource).toContain("release_agora_dispatch_lock");
    expect(dispatcherSource).toContain('reason: "DISPATCH_ALREADY_RUNNING"');
  });
});

describe("catalog priority ordering semantics", () => {
  const prioritize = (
    ids: string[],
    priority: string[],
    detailOffset: number,
    detailBatchSize: number,
    allowed?: Set<string>,
  ): string[] => {
    if (priority.length === 0 || detailOffset !== 0) return ids;
    const already = new Set(ids);
    const promoted = priority.filter((id) => !already.has(id) && (!allowed || allowed.has(id)));
    return [
      ...priority.filter((id) => already.has(id)),
      ...promoted,
      ...ids.filter((id) => !priority.includes(id)),
    ].slice(0, Math.max(detailBatchSize, priority.length));
  };

  it("promotes the canary 363449 into the first batch", () => {
    const page = ["100", "200", "300"];
    const out = prioritize(page, ["363449"], 0, 3, new Set([...page, "363449"]));
    expect(out[0]).toBe("363449");
    expect(out).toHaveLength(3);
  });

  it("is idempotent on a second cycle and untouched on later pages", () => {
    const page = ["363449", "100", "200"];
    const first = prioritize(page, ["363449"], 0, 3);
    expect(first).toEqual(["363449", "100", "200"]);
    expect(prioritize(first, ["363449"], 0, 3)).toEqual(first);
    const later = ["900", "901"];
    expect(prioritize(later, ["363449"], 100, 3)).toEqual(later);
  });
});
