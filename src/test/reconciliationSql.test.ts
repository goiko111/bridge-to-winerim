import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Lovable renames migration files on apply; locate them by content.
const findMigration = (marker: string) => { const dir = resolve(process.cwd(), "supabase/migrations"); return readdirSync(dir).sort().map((n) => readFileSync(resolve(dir, n), "utf8")).find((t) => t.includes(marker)) ?? ""; };
const sql = findMigration("reconciliation_v2_commit_sales_page");
const stateSql = findMigration("state_contract_version");

describe("migration security invariants", () => {
  it("uses RLS, security-invoker views and service-role-only mutating RPCs", () => {
    expect(sql).toContain("enable row level security"); expect(sql).toContain("security_invoker = true");
    expect(sql).toContain("revoke all on function public.reconciliation_v2_commit_sales_page");
    expect(sql).not.toContain("grant execute on function public.reconciliation_v2_commit_sales_page(uuid,bigint,uuid,jsonb,jsonb,text,boolean,timestamptz) to authenticated");
    expect(sql).not.toMatch(/grant select on public\.winerim_(?:sales_records|sales_lines|stock_movements|sync_checkpoints|restaurant_bindings) to authenticated/i);
    expect(sql).toContain("grant select on public.reconciliation_v2_latest to service_role");
    expect(sql).not.toContain("grant select on public.reconciliation_v2_latest to authenticated");
  });

  it("has no scheduler activation, realtime publication or repair executor", () => {
    expect(sql).not.toMatch(/cron\.schedule/i); expect(sql).not.toMatch(/supabase_realtime/i); expect(sql).not.toMatch(/create\s+or\s+replace\s+function\s+.*repair/i);
  });

  it("persists exclusions and never fixes a global fleet count", () => {
    expect(sql).toContain("reconciliation_v2_connection_exclusions");
    expect(sql).toContain("706b952e-767d-41af-9cba-8e225b16a877");
    expect(sql).toContain("RECONCILIATION_EXCLUSION_IDENTITY_NOT_UNIQUE");
    expect(sql).not.toContain("EXPECTED_ACTIVE_RESTAURANTS"); expect(sql).not.toContain("Ocean Club");
  });

  it("shows only results belonging to the latest run for a restaurant day", () => {
    expect(sql).toContain("latest.id=result.run_id");
    expect(sql).toContain("order by connection_id,business_day,source_cutoff_at desc");
  });

  it("publishes the canonical state contract while preserving the persisted legacy value", () => {
    expect(stateSql).toContain("canonical_state"); expect(stateSql).toContain("state_contract_version");
    for (const state of ["MATCHED","HISTORY_MISSING","STOCK_MISSING","BOTH_MISSING","STOCK_UNKNOWN","AMBIGUOUS","SOURCE_INCOMPLETE","DELETED_OR_CANCELLED","OPEN"]) expect(stateSql).toContain(`'${state}'`);
    expect(stateSql).toContain("canonical_state as state");
  });
});
