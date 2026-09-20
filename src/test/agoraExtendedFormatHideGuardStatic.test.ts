import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(process.cwd(), "supabase/functions/agora-proxy/index.ts"),
  "utf8",
);

describe("auto-push evaluator: extended formats are not hidden for missing data", () => {
  it("loads winerim_wine_formats prices before judging extended-format availability", () => {
    expect(source).toContain('.select("winerim_id, format_key, sale_price, cost_price, is_active")');
    expect(source).toContain("const extendedRowsByWine = new Map<string, Record<string, unknown>[]>()");
    expect(source).toContain("attachExtendedFormatPrices(");
    expect(source).toContain("extendedRowsByWine.get(String(wine.winerim_id)) || []");
  });

  it("fails closed when the format price table cannot be read", () => {
    expect(source).toContain("could_not_read_winerim_wine_formats");
  });
});
