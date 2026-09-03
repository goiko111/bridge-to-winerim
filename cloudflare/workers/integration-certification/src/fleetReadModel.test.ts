import { describe, expect, it, vi } from "vitest";

import type { DatabaseAdapter, DatabaseTransaction, QueryResult, TransactionOptions } from "../../middleware-api/src/db";
import { mapWithConcurrency, refreshAgoraFleetReadModel } from "./fleetReadModel";

function result<Row extends Record<string, unknown>>(rows: Row[] = []): QueryResult<Row> {
  return { rows, rowCount: rows.length };
}

function source(connectionId: string, locationName: string) {
  return {
    connection_id: connectionId,
    location_name: locationName,
    enabled: true,
    write_mode: "NONE",
    last_sync_at: "2026-09-03T04:00:00.000Z",
    last_business_day_synced: "2026-09-02",
    catalog_sync_enabled: true,
    circuit_breaker_paused_until: null,
    circuit_breaker_reason: null,
    consecutive_failures: 0,
    verified_products: 2,
    master_data: {
      families_json: [{ Id: "1", Name: "VINOS", ShowInPos: true }],
      products_summary_json: [{ Id: "2", Name: "Legacy Rioja", FamilyId: "1", UseAsDirectSale: true, SaleableAsMain: true }],
    },
    stock_error: null,
    outbound_error: null,
    mapped_sales_7d: 3,
    sales_lines_7d: 4,
    stock_success_7d: 2,
    stock_failed_open: 0,
    outbound_open: 0,
    outbound_failed: 0,
    active_leases: 0,
  };
}

describe("Agora fleet read model", () => {
  it("never exceeds the requested connection concurrency", async () => {
    let active = 0;
    let maximum = 0;
    const output = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return value * 2;
    });

    expect(output).toEqual([2, 4, 6, 8, 10]);
    expect(maximum).toBe(2);
  });

  it("discovers once, persists the fleet set-based, and verifies one readback", async () => {
    const statements: string[] = [];
    const transactions: TransactionOptions[] = [];
    const query = vi.fn(async <Row extends Record<string, unknown>>(statement: { text: string }) => {
      statements.push(statement.text);
      if (statement.text.includes("WITH connections AS MATERIALIZED")) {
        return result([
          source("11111111-1111-4111-8111-111111111111", "Uno"),
          source("22222222-2222-4222-8222-222222222222", "Dos"),
          source("33333333-3333-4333-8333-333333333333", "Tres"),
        ]) as unknown as QueryResult<Row>;
      }
      if (statement.text.includes("INSERT INTO public.agora_fleet_read_model")) return result() as QueryResult<Row>;
      if (statement.text.includes("count(DISTINCT source_hash)")) {
        return result([{ connections: 3, hashes: 3 }]) as unknown as QueryResult<Row>;
      }
      throw new Error(`Unexpected query: ${statement.text}`);
    });
    const adapter = {
      query,
      transaction: async <T>(
        work: (transaction: DatabaseTransaction) => Promise<T>,
        options: TransactionOptions = {},
      ) => {
        transactions.push(options);
        return work({ query } as DatabaseTransaction);
      },
    } as DatabaseAdapter;
    let clock = 0;

    const summary = await refreshAgoraFleetReadModel(
      adapter,
      "2026-09-03T04:30:00.000Z",
      9,
      () => (clock += 5),
    );

    expect(summary).toMatchObject({ connections: 3, concurrency: 2, sourceHashCount: 3 });
    expect(summary.phasesMs).toEqual({ discover: 5, plan: 5, execute: 5, certify: 5, total: 20 });
    expect(transactions).toEqual([
      { isolationLevel: "repeatable-read", readOnly: true },
      { isolationLevel: "read-committed" },
    ]);
    expect(statements).toHaveLength(3);
    expect(statements[0]).toContain("FROM public.outbound_tasks");
    expect(statements[1]).toContain("jsonb_to_recordset");
    expect(statements[1]).toContain("ON CONFLICT (connection_id) DO UPDATE");
    expect(statements.some((statement) => /https?:\/\//i.test(statement))).toBe(false);
  });
});
