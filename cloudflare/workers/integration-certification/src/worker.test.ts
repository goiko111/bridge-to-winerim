import { describe, expect, it, vi } from "vitest";

import type { DatabaseAdapter, DatabaseTransaction, QueryResult } from "../../middleware-api/src/db";
import { runCertificationScheduled } from "./worker";

function result<Row extends Record<string, unknown>>(rows: Row[] = []): QueryResult<Row> {
  return { rows, rowCount: rows.length };
}

describe("integration certification worker", () => {
  it("stays inert unless explicitly enabled", async () => {
    await expect(runCertificationScheduled(
      { scheduledTime: Date.parse("2026-08-09T18:00:00.000Z") },
      { MONITOR_ENABLED: "false" },
    )).resolves.toEqual({ status: "inactive", reason: "MONITOR_DISABLED" });
  });

  it("writes one evidence snapshot and never mutates business tables", async () => {
    const statements: string[] = [];
    const query = vi.fn(async <Row extends Record<string, unknown>>(statement: { text: string }) => {
      statements.push(statement.text);
      if (statement.text.includes("FROM public.pos_connections connection")) return result([{
        connection_id: "89fc3241-ed1e-41b6-aee0-7fe8398c476c",
        location_name: "Albariza",
        enabled: true,
        catalog_sync_enabled: true,
        circuit_breaker_paused_until: null,
        last_business_day_synced: "2026-08-09",
        active_scope_count: 1,
        active_credential_count: 2,
        policy: {},
      }]) as unknown as QueryResult<Row>;
      if (statement.text.includes("WITH active_connections") && statement.text.includes("ranked AS")) {
        return result([
          { connection_id: "89fc3241-ed1e-41b6-aee0-7fe8398c476c", job: "catalog.fetch-winerim", outcome: "SUCCESS", error_class: null, created_at: "2026-08-09T17:55:00.000Z", recent_connectivity_failures: 0 },
          { connection_id: "89fc3241-ed1e-41b6-aee0-7fe8398c476c", job: "catalog.sync-master", outcome: "SUCCESS", error_class: null, created_at: "2026-08-09T17:55:00.000Z", recent_connectivity_failures: 0 },
          { connection_id: "89fc3241-ed1e-41b6-aee0-7fe8398c476c", job: "sales.auto-sync", outcome: "SUCCESS", error_class: null, created_at: "2026-08-09T17:55:00.000Z", recent_connectivity_failures: 0 },
        ]) as unknown as QueryResult<Row>;
      }
      if (statement.text.includes("CROSS JOIN LATERAL")) return result([{
        connection_id: "89fc3241-ed1e-41b6-aee0-7fe8398c476c",
        expected_catalog_products: 1,
        confirmed_catalog_products: 1,
        missing_catalog_products: 0,
        price_divergences: 0,
        master_fetched_at: "2026-08-09T17:55:00.000Z",
      }]) as unknown as QueryResult<Row>;
      if (statement.text.includes("public.sales_events event")) return result([{
        connection_id: "89fc3241-ed1e-41b6-aee0-7fe8398c476c",
        recent_sales_events: 1,
        recent_wine_lines: 1,
        recent_unmapped_wine_lines: 0,
      }]) as unknown as QueryResult<Row>;
      if (statement.text.includes("duplicates AS")) return result([{
        connection_id: "89fc3241-ed1e-41b6-aee0-7fe8398c476c",
        recent_stock_failures: 0,
        duplicate_stock_applications: 0,
        stock_coverage_since: "2026-08-09T17:50:00.000Z",
        stock_required_claims: 1,
        stock_certified_claims: 1,
        sales_only_claims: 1,
        missing_stock_certifications: 0,
        unknown_stock_policy_claims: 0,
        stock_shortfall_claims: 0,
      }]) as unknown as QueryResult<Row>;
      if (statement.text.includes("public.outbound_tasks task")) return result([{
        connection_id: "89fc3241-ed1e-41b6-aee0-7fe8398c476c",
        live_queue_tasks: 0,
        failed_queue_tasks_recent: 0,
      }]) as unknown as QueryResult<Row>;
      if (statement.text.includes("public.integration_certification_snapshots snapshot")) return result([{
        connection_id: "89fc3241-ed1e-41b6-aee0-7fe8398c476c",
        state: "CATCHUP_PENDING",
        healthy_cycle_streak: 1,
      }]) as unknown as QueryResult<Row>;
      return result() as QueryResult<Row>;
    });
    const adapter = {
      query,
      transaction: async <T>(work: (transaction: DatabaseTransaction) => Promise<T>) => work({ query } as DatabaseTransaction),
    } as DatabaseAdapter;

    const output = await runCertificationScheduled(
      { scheduledTime: Date.parse("2026-08-09T18:00:00.000Z") },
      { MONITOR_ENABLED: "true" },
      { database: () => adapter },
    );

    expect(output).toMatchObject({ status: "completed", connections: 1, states: { ONLINE_OK: 1 } });
    expect(statements.filter((statement) => statement.includes("INSERT INTO public.integration_certification_snapshots"))).toHaveLength(1);
    expect(statements.some((statement) => (
      /^\s*(?:UPDATE|DELETE)\b/i.test(statement)
      || /INSERT INTO public\.(?:sales|stock|outbound|pos_connections)/i.test(statement)
    ))).toBe(false);
  });
});
