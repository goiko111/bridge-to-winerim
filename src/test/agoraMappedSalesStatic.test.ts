import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const proxyPath = resolve(process.cwd(), "supabase/functions/agora-proxy/index.ts");
const source = readFileSync(proxyPath, "utf8");

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

  it("chunks stale open-ticket stock lookups and surfaces lookup failures", () => {
    expect(source).toContain("for (let i = 0; i < staleEventIds.length; i += 100)");
    expect(source).toContain("stock_sync_log lookup failed:");
    expect(source).not.toContain('.in("sales_event_id", staleEventIds)');
  });
});
