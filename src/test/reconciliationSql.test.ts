import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Applied once via the migration tool; the platform stored it under its own versioned name
// (identical SQL minus the two header comment lines). Keeping a second copy would register a duplicate migration.
const sql = readFileSync(resolve(process.cwd(), "supabase/migrations/20260928084312_d44bc070-e653-4209-9f14-2188f0019ae6.sql"), "utf8");

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
});
