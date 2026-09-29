import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const sql = readFileSync("supabase/migrations/20260929051739_42122234-12f8-4fe0-982a-d53a5ac42d8d.sql", "utf8");
describe("commit_sales_page JSON null contract", () => {
  it("maps JSON null lines/movements to [] and rejects other scalars", () => {
    expect(sql).toMatch(/jsonb_typeof\(p_value\) = 'null' then return '\[\]'::jsonb/);
    expect(sql).toMatch(/raise exception 'invalid % payload/);
    expect(sql).not.toMatch(/coalesce\(item->'lines','\[\]'::jsonb\)/);
    expect(sql).toMatch(/not p_has_more,null\)/);
  });
});
