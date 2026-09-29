import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync("supabase/functions/run-daily-reconciliation/index.ts", "utf8");
const handler = src.slice(src.indexOf("Deno.serve("));
const legacyStart = handler.indexOf("const legacyAnalytics = async");
const legacyEnd = handler.indexOf("const rpcAnalytics = async");
const outsideLegacy = handler.slice(0, legacyStart) + handler.slice(legacyEnd);

describe("dryRun canary operational scope", () => {
  it("reads Agora raw data only for [businessDay, nextDay) outside the legacy equivalence closure", () => {
    const calls = [...outsideLegacy.matchAll(/sourceRows\(db, connectionId, ([^)]*)\)/g)].map((m) => m[1]);
    expect(calls).toEqual(["body.businessDay, nextDay"]);
    expect(outsideLegacy).not.toMatch(/-27/);
  });
  it("never runs analytics in dryRun and never fakes coverage", () => {
    expect(handler).toMatch(/dryRun \? \{ analytics: \{ coverage: ANALYTICS_SKIPPED, series: \[\], aggregates: \[\] \}, analyticsCoverage: ANALYTICS_SKIPPED \} : await \(async/);
    expect(handler).toMatch(/complete: null, skipped: "DRY_RUN_OPERATIONAL_ONLY"/);
  });
  it("keeps certification independent of analytics (same completeness/results expressions)", () => {
    expect(handler).toMatch(/winerimComplete: winerim\.complete && deletions\.complete && salesCp\?\.coverage_complete === true/);
    expect(handler).toMatch(/let results = historical \? \[\] : reconcileLines\(\{ connectionId, agora, winerim: winerimRows, deletions: deletionRows, completeness \}\)/);
    const beforeAnalytics = handler.slice(0, handler.indexOf("// Operational/analytics split"));
    expect(beforeAnalytics).not.toMatch(/buildAnalytics|analytics_aggregate/);
  });
  it("bounds daily source volume and fails closed beyond it", () => {
    expect(src).toMatch(/const PAGE = 1000; const MAX_DB_PAGES = 100;/);
    expect(src).toMatch(/return \{ rows, complete: false \};/);
  });
});
