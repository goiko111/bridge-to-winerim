import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync("supabase/functions/run-daily-reconciliation/index.ts", "utf8");
const handler = src.slice(src.indexOf("Deno.serve("));

describe("dryRun canary operational scope", () => {
  it("reads Agora raw data only for [businessDay, nextDay) outside the analytics closure", () => {
    const outside = handler.replace(/const computeAnalytics = async \(\) => \{[\s\S]*?\n    \};\n/, "");
    const calls = [...outside.matchAll(/sourceRows\(db, connectionId, ([^)]*)\)/g)].map((m) => m[1]);
    expect(calls).toEqual(["body.businessDay, nextDay"]);
    expect(outside).not.toMatch(/-27/);
  });
  it("never runs the 28-day analytics in dryRun and never fakes coverage", () => {
    expect(handler).toMatch(/dryRun \? \{ analytics: \{ coverage: ANALYTICS_SKIPPED, series: \[\], aggregates: \[\] \}, analyticsCoverage: ANALYTICS_SKIPPED \} : await computeAnalytics\(\)/);
    expect(handler).toMatch(/complete: null, skipped: "DRY_RUN_OPERATIONAL_ONLY"/);
  });
  it("keeps certification independent of analytics (same completeness/results expressions)", () => {
    expect(handler).toMatch(/winerimComplete: winerim\.complete && deletions\.complete && salesCp\?\.coverage_complete === true/);
    expect(handler).toMatch(/let results = historical \? \[\] : reconcileLines\(\{ connectionId, agora, winerim: winerimRows, deletions: deletionRows, completeness \}\)/);
    const beforeAnalytics = handler.slice(0, handler.indexOf("const computeAnalytics"));
    expect(beforeAnalytics).not.toMatch(/analytics/i.test("") ? /$^/ : /buildAnalytics/);
  });
  it("bounds daily source volume and fails closed beyond it", () => {
    expect(src).toMatch(/const PAGE = 1000; const MAX_DB_PAGES = 100;/);
    expect(src).toMatch(/return \{ rows, complete: false \};/);
  });
});
