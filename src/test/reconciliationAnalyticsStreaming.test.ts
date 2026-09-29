import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync("supabase/functions/run-daily-reconciliation/index.ts", "utf8");
const handler = src.slice(src.indexOf("Deno.serve("));
const rpcBlock = handler.slice(handler.indexOf("const rpcAnalytics = async"), handler.indexOf("const equivalenceDays"));
const migration = readdirSync("supabase/migrations").map((f) => readFileSync(`supabase/migrations/${f}`, "utf8")).find((s) => s.includes("function public.reconciliation_v2_analytics_aggregate")) ?? "";

describe("run-daily-reconciliation persistent analytics via SQL aggregate", () => {
  it("persistent path uses the RPC and never reads historical raw_json in the Worker", () => {
    expect(rpcBlock).toMatch(/db\.rpc\("reconciliation_v2_analytics_aggregate"/);
    expect(rpcBlock).not.toMatch(/sourceRows|raw_json|sales_events|sales_line_items|analytics_events/);
  });
  it("fails closed when the RPC fails (throws before commit)", () => {
    expect(rpcBlock).toMatch(/if \(error \|\| !agg \|\| !Array\.isArray\(agg\.buckets\)\) throw/);
    expect(handler.indexOf("await rpcAnalytics(28)")).toBeLessThan(handler.indexOf("reconciliation_v2_commit_run"));
  });
  it("legacy JS path is only reachable from the manual dryRun equivalence check", () => {
    expect(handler).toMatch(/if \(!dryRun \|\| auth\.scheduler \|\| historical \|\| !Number\.isInteger\(equivalenceDays\)/);
    expect([...handler.matchAll(/await legacyAnalytics\(/g)].length).toBe(1);
  });
});

describe("SQL aggregate contract", () => {
  it("is SECURITY INVOKER with fixed search_path and service_role only", () => {
    expect(migration).toMatch(/reconciliation_v2_analytics_aggregate\(p_connection_id uuid, p_from date, p_to date, p_anchor date\)/);
    expect(migration).toMatch(/stable security invoker set search_path = public/);
    expect(migration).toMatch(/revoke all on function public\.%s from public, anon, authenticated/);
    expect(migration).toMatch(/grant execute on function public\.%s to service_role/);
  });
  it("rejects windows over 28 days, inverted windows and unknown connections", () => {
    expect(migration).toMatch(/if p_to - p_from > 28 then raise exception 'ANALYTICS_WINDOW_TOO_LARGE'/);
    expect(migration).toMatch(/if p_from >= p_to then raise exception 'ANALYTICS_WINDOW_INVALID'/);
    expect(migration).toMatch(/raise exception 'ANALYTICS_CONNECTION_NOT_FOUND'/);
  });
  it("is scoped to one connection and returns only aggregates", () => {
    expect(migration).toMatch(/where e\.connection_id = p_connection_id and e\.business_day >= p_from and e\.business_day < p_to/);
    const output = migration.slice(migration.indexOf("select jsonb_build_object(\n    'identityLines'"));
    expect(output).not.toMatch(/raw|provider_doc_id|name/);
  });
});
