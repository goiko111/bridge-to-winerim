import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const agoraSource = readFileSync(resolve(repoRoot, "supabase/functions/agora-proxy/index.ts"), "utf8");
const winerimSource = readFileSync(resolve(repoRoot, "supabase/functions/winerim-proxy/index.ts"), "utf8");

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
});
