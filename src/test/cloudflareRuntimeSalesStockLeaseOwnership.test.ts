import { describe, expect, it, vi } from "vitest";

import type {
  DatabaseAdapter,
  DatabaseTransaction,
  QueryResult,
  SqlStatement,
} from "../../cloudflare/workers/middleware-api/src/db";
import { createPostgresStockAdapter } from "../../cloudflare/workers/middleware-runtime/src/adapters/stock";

function result<Row extends Record<string, unknown>>(rows: Row[] = []): QueryResult<Row> {
  return { rows, rowCount: rows.length };
}

describe("sales stock claim lease ownership", () => {
  it("does not persist a stale stock finalizer after its lease was replaced", async () => {
    const statements: SqlStatement[] = [];
    const query = vi.fn(async <Row extends Record<string, unknown>>(statement: SqlStatement) => {
      statements.push(statement);
      if (statement.text.includes("status IN ('PENDING', 'SUCCESS')")) return result() as QueryResult<Row>;
      if (statement.text.includes("INSERT INTO public.runtime_idempotency")) {
        return result([{ attempt: 1 }]) as QueryResult<Row>;
      }
      if (statement.text.includes("UPDATE public.runtime_idempotency")) {
        return result() as QueryResult<Row>;
      }
      throw new Error(`unexpected SQL: ${statement.text}`);
    });
    const database: DatabaseAdapter = {
      query,
      transaction: async (work) => work({ query } as DatabaseTransaction),
    };
    const transport = {
      send: vi.fn().mockResolvedValue({
        status: 200,
        body: {
          sales: [{ orderId: "order-1", status: "imported", stockApplied: true }],
        },
      }),
      sleep: vi.fn().mockResolvedValue(undefined),
    };
    const adapter = createPostgresStockAdapter(database, {
      connectionId: "11111111-1111-4111-8111-111111111111",
      transport,
    });

    await expect(adapter.execute({
      idempotencyKey: "sales-mutation:v1:lease-test",
      productName: "Lease Test Wine",
      mutation: {
        mode: "operational",
        orderId: "order-1",
        soldAt: "2026-08-03T12:00:00.000Z",
        quantity: 1,
        soldStock: { wineId: "47593", stockId: 1001, variant: "bottle" },
        stockSource: { wineId: "47593", stockId: 1001, variant: "bottle" },
        currentSourceStock: 10,
      },
    })).rejects.toMatchObject({ code: "STOCK_CLAIM_FINALIZE_NOT_OWNED" });

    const insert = statements.find((statement) => statement.text.includes("INSERT INTO public.runtime_idempotency"));
    const finalize = statements.find((statement) => statement.text.includes("UPDATE public.runtime_idempotency"));
    expect(insert?.text).toContain("payload_sha256");
    expect(insert?.text).toContain("lease_token");
    expect(finalize?.text).toContain("payload_sha256 =");
    expect(finalize?.text).toContain("lease_token =");
    expect(statements.some((statement) => statement.text.includes("INSERT INTO public.stock_sync_log"))).toBe(false);
  });
});
