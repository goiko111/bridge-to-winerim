import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync("supabase/functions/run-daily-reconciliation/index.ts", "utf8");
const handler = src.slice(src.indexOf("Deno.serve("));
const rpcBlock = handler.slice(handler.indexOf("const rpcAnalytics = async"), handler.indexOf("const backfillDays"));
// Latest migration defining the projection (Lovable renames files; locate by content, newest wins).
const files = readdirSync("supabase/migrations").sort().reverse().map((f) => readFileSync(`supabase/migrations/${f}`, "utf8"));
const migration = files.find((s) => s.includes("create table if not exists reconciliation_private.analytics_line_projection")) ?? "";
const latestRefresh = files.find((s) => s.includes("create or replace function reconciliation_private.refresh_analytics_day")) ?? "";
const fnBody = (name: string) => { const i = migration.indexOf(`create or replace function ${name}(`); return migration.slice(i, migration.indexOf("end $$;", i)); };
const aggregate = fnBody("reconciliation_private.analytics_aggregate");
const refresh = latestRefresh.slice(latestRefresh.indexOf("create or replace function reconciliation_private.refresh_analytics_day("), latestRefresh.indexOf("end $$;", latestRefresh.indexOf("create or replace function reconciliation_private.refresh_analytics_day(")));

describe("run-daily-reconciliation persistent analytics via incremental projection", () => {
  it("persistent path refreshes only anchor-1 and anchor, then aggregates (never 28 raw days)", () => {
    expect(handler).toMatch(/await refreshDay\(plusDays\(body\.businessDay, -1\), false\); await refreshDay\(body\.businessDay, false\);[^;]*; return rpcAnalytics\(28\)/);
    expect(rpcBlock).toMatch(/db\.rpc\("reconciliation_v2_analytics_aggregate"/);
    expect(rpcBlock).not.toMatch(/sourceRows|raw_json|sales_events|sales_line_items/);
  });
  it("fails closed when the RPC fails (throws before commit)", () => {
    expect(rpcBlock).toMatch(/if \(error \|\| !agg \|\| !Array\.isArray\(agg\.buckets\)\) throw/);
    expect(handler.indexOf("return rpcAnalytics(28)")).toBeLessThan(handler.indexOf("reconciliation_v2_commit_run"));
  });
  it("backfill is serial, resumable (only_missing) and stops at the first failing day", () => {
    expect(handler).toMatch(/if \(!dryRun \|\| auth\.scheduler \|\| historical \|\| !Number\.isInteger\(backfillDays\)/);
    expect(handler).toMatch(/journal\.push\(\{ \.\.\.\(await refreshDay\(day, true\)\)/);
    expect(handler).toMatch(/catch \(error\) \{ return json\(request, \{ ok: false[^}]*stoppedAt: day/);
  });
  it("legacy JS path is only reachable from the manual dryRun equivalence check", () => {
    expect(handler).toMatch(/if \(!dryRun \|\| auth\.scheduler \|\| historical \|\| !Number\.isInteger\(equivalenceDays\)/);
    expect([...handler.matchAll(/await legacyAnalytics\(/g)].length).toBe(1);
  });
});

describe("projection SQL contract", () => {
  it("private schema, compact table without raw payload, PK per connection+line", () => {
    expect(migration).toMatch(/revoke all on schema reconciliation_private from public, anon, authenticated/);
    const table = migration.slice(migration.indexOf("create table if not exists reconciliation_private.analytics_line_projection"), migration.indexOf("create index"));
    expect(table).not.toMatch(/raw|payload|jsonb/);
    expect(table).toMatch(/primary key \(connection_id, source_line_item_id\)/);
    expect(table).toMatch(/canonical_identity text,\n\s+amount numeric,/); // nullable: coverage rows preserved
  });
  it("security invoker, empty search_path, service_role only; obsolete public helpers dropped", () => {
    for (const body of [aggregate, refresh]) { expect(body).toMatch(/security invoker set search_path = ''/); expect(body).not.toMatch(/security definer/); }
    expect(migration).toMatch(/revoke all on function %s from public, anon, authenticated/);
    expect(migration).toMatch(/grant execute on function %s to service_role/);
    for (const f of ["rv2_field", "rv2_trim", "rv2_text", "rv2_ident", "rv2_num", "rv2_norm", "rv2_ntext", "rv2_time_key", "rv2_truthy"]) expect(migration).toContain(`drop function if exists public.${f}(`);
  });
  it("refresh rebuilds one day slice idempotently and handles deleted/corrected/moved lines", () => {
    expect(refresh).toMatch(/delete from reconciliation_private\.analytics_line_projection p where p\.connection_id = p_connection_id and p\.business_day = p_business_day/);
    expect(refresh).toMatch(/e\.connection_id = p_connection_id and e\.business_day = p_business_day/);
    expect(refresh).toMatch(/on conflict \(connection_id, source_line_item_id\) do update/);
    expect(refresh).toMatch(/d\.line_count <> \(select pg_catalog\.count\(\*\)/); // moved line invalidates old day journal
    expect(refresh).toMatch(/slice_hash/);
  });
  it("aggregate reads only the projection, bounded window, fail-closed on missing day, cross-day last-wins dedupe", () => {
    expect(aggregate).not.toMatch(/sales_events|sales_line_items|raw_json/);
    expect(aggregate).toMatch(/if p_to - p_from > 28 then raise exception 'ANALYTICS_WINDOW_TOO_LARGE'/);
    expect(aggregate).toMatch(/if p_from >= p_to then raise exception 'ANALYTICS_WINDOW_INVALID'/);
    expect(aggregate).toMatch(/raise exception 'ANALYTICS_CONNECTION_NOT_FOUND'/);
    expect(aggregate).toMatch(/raise exception 'ANALYTICS_PROJECTION_INCOMPLETE/);
    expect(aggregate).toMatch(/where p\.connection_id = p_connection_id and p\.business_day >= p_from and p\.business_day < p_to/);
    expect(aggregate).toMatch(/partition by canonical_identity order by business_day desc, chunk_no desc, source_line_item_id desc/);
  });
});
