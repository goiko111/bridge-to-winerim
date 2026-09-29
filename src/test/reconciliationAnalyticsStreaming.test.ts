import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync("supabase/functions/run-daily-reconciliation/index.ts", "utf8");

describe("run-daily-reconciliation analytics memory bound", () => {
  it("never loads the 28-day analytics range in a single read", () => {
    expect(src).not.toMatch(/sourceRows\(db, connectionId, plusDays\(body\.businessDay, -27\), nextDay\)/);
    expect(src).toMatch(/for \(let offsetDay = -27; offsetDay <= 0; offsetDay \+= 1\)/);
  });
  it("reuses the already-loaded business day and keeps last-wins dedupe", () => {
    expect(src).toMatch(/offsetDay === 0 \? source :/);
    expect(src).toMatch(/uniqueAnalytics\.set\(identity,/);
  });
  it("stays fail-closed on incomplete chunks", () => {
    expect(src).toMatch(/analyticsComplete = analyticsComplete && chunk\.complete/);
  });
});
