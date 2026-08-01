import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(process.cwd(), "supabase/functions/agora-proxy/index.ts"),
  "utf8",
);

function actionBlock(action: string, nextAction: string): string {
  const start = source.indexOf(`if (action === "${action}")`);
  const end = source.indexOf(`if (action === "${nextAction}")`, start + 1);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("Agora forward sales identity integration", () => {
  it.each([
    ["sync-open-tickets", "fetch-day"],
    ["save-sales", "sync-intraday-sales"],
    ["sync-intraday-sales", "auto-sync-sales"],
    ["auto-sync-sales", "debug-bundle"],
  ])("resolves ProductId and SaleFormatId in %s", (action, nextAction) => {
    const block = actionBlock(action, nextAction);
    expect(block.match(/resolveForwardAgoraSalesLineIdentity\(/g)).toHaveLength(1);
    expect(block).toContain("providerProductId: line.ProductId");
    expect(block).toContain("saleFormatId: line.SaleFormatId");
  });

  it("does not apply the forward-only resolver to historical backfill", () => {
    const block = actionBlock("backfill-sales-analytics", "save-sales");
    expect(block).not.toContain("resolveForwardAgoraSalesLineIdentity(");
    expect(block).toContain('const productId = String(line.ProductId || "")');
  });
});
