import { describe, expect, it, vi } from "vitest";
import type {
  DatabaseAdapter,
  DatabaseTransaction,
  QueryResult,
} from "../../cloudflare/workers/middleware-api/src/db";
import {
  createPostgresStockAdapter,
  type StockMutationContext,
} from "../../cloudflare/workers/middleware-runtime/src/adapters/stock";
import type { WinerimMutationTransport } from "../../cloudflare/workers/middleware-runtime/src/handlers/stock";

type RecordedQuery = { text: string; values: readonly unknown[] };

function databaseDouble(
  handler: (query: RecordedQuery) => QueryResult<Record<string, unknown>> = () => ({
    rows: [],
    rowCount: 0,
  }),
) {
  const queries: RecordedQuery[] = [];
  const transactions: unknown[] = [];
  const query = vi.fn(async (statement: RecordedQuery) => {
    queries.push({ text: statement.text, values: [...statement.values] });
    return handler(statement);
  });
  const database: DatabaseAdapter = {
    query: query as DatabaseAdapter["query"],
    async transaction<T>(work: (transaction: DatabaseTransaction) => Promise<T>, options?: unknown) {
      transactions.push(options);
      return work({ query: query as DatabaseTransaction["query"] });
    },
  };
  return { database, queries, transactions };
}

function transport(): WinerimMutationTransport & {
  send: ReturnType<typeof vi.fn>;
  sleep: ReturnType<typeof vi.fn>;
} {
  return {
    send: vi.fn(async () => ({ status: 500 })),
    sleep: vi.fn(async () => undefined),
  };
}

const connectionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const bottle = { wineId: "wine-7", stockId: 7001, variant: "bottle" as const };
const glass = { wineId: "wine-7", stockId: 7002, variant: "glass" as const };

function operationalInput(dryRun = false): StockMutationContext {
  return {
    idempotencyKey: "stock:dry-run:1",
    productName: "C Dry Run",
    dryRun,
    mutation: {
      mode: "operational",
      orderId: "order:dry-run:1",
      soldAt: "2026-08-02T12:00:00Z",
      quantity: 1,
      soldStock: glass,
      stockSource: bottle,
    },
  };
}

describe("Cloudflare PostgreSQL stock adapter safety guards", () => {
  it("makes dryRun a pure preview with zero database and external writes", async () => {
    const db = databaseDouble();
    const winerim = transport();
    const adapter = createPostgresStockAdapter(db.database, {
      connectionId,
      transport: winerim,
    });

    const execution = await adapter.execute(operationalInput(true));

    expect(execution).toMatchObject({
      state: "DRY_RUN",
      writesPerformed: false,
      reason: "dry_run_no_database_or_external_writes",
      plan: {
        mode: "operational",
        mutatesStock: true,
        request: { kind: "sales-import", body: { live: true } },
      },
    });
    expect(db.queries).toHaveLength(0);
    expect(db.transactions).toHaveLength(0);
    expect(winerim.send).not.toHaveBeenCalled();
  });

  it("refuses mutable historical execution while still allowing historical dryRun planning", async () => {
    const db = databaseDouble();
    const winerim = transport();
    const adapter = createPostgresStockAdapter(db.database, {
      connectionId,
      transport: winerim,
    });
    const historical: StockMutationContext = {
      idempotencyKey: "stock:historical:1",
      productName: "B Historical",
      mutation: {
        mode: "historical",
        orderId: "history:order:1",
        soldAt: "2026-05-01T12:00:00Z",
        quantity: 2,
        soldStock: bottle,
        stockSource: bottle,
      },
    };

    const blocked = await adapter.execute(historical);
    const preview = await adapter.execute({ ...historical, dryRun: true });

    expect(blocked).toMatchObject({
      state: "HISTORICAL_BLOCKED",
      writesPerformed: false,
      plan: { mode: "historical", mutatesStock: false },
    });
    expect(preview).toMatchObject({
      state: "DRY_RUN",
      writesPerformed: false,
      plan: {
        mode: "historical",
        request: { kind: "sales-import", body: { sales: expect.any(Array) } },
      },
    });
    expect("live" in (preview.plan.request as { body: Record<string, unknown> }).body).toBe(false);
    expect(db.queries).toHaveLength(0);
    expect(db.transactions).toHaveLength(0);
    expect(winerim.send).not.toHaveBeenCalled();
  });

  it("reads claim, execution and stock audit in one repeatable-read transaction", async () => {
    const db = databaseDouble((query) => {
      if (query.text.includes("FROM public.runtime_idempotency")) {
        return {
          rows: [{
            idempotency_key: "stock:audit:1",
            message_id: "order:audit:1",
            connection_id: connectionId,
            job: "stock.mutation",
            status: "SUCCESS",
            attempt: 2,
            lease_expires_at: null,
            result: JSON.stringify({ payloadHash: "hash-1", stockSource: bottle }),
            created_at: "2026-08-02T12:00:00Z",
            updated_at: "2026-08-02T12:00:01Z",
          }],
          rowCount: 1,
        };
      }
      if (query.text.includes("FROM public.runtime_execution_log")) {
        return {
          rows: [{
            id: "10",
            message_id: "order:audit:1",
            idempotency_key: "stock:audit:1",
            outcome: "SUCCESS",
            attempt: 2,
            duration_ms: 30,
            error_class: null,
            detail: { requestKind: "sales-import" },
            created_at: "2026-08-02T12:00:01Z",
          }],
          rowCount: 1,
        };
      }
      if (query.text.includes("FROM public.stock_sync_log")) {
        return {
          rows: [{
            id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            sales_event_id: null,
            sales_line_item_id: null,
            provider_product_id: "57002",
            winerim_product_id: "wine-7",
            product_name: "C Audit",
            quantity: "1",
            status: "SUCCESS",
            variant: "copa",
            stock_id: "7002",
            idempotency_key: "stock:audit:1",
            error_message: null,
            winerim_response: { stockSource: bottle },
            created_at: "2026-08-02T12:00:01Z",
            synced_at: "2026-08-02T12:00:01Z",
          }],
          rowCount: 1,
        };
      }
      throw new Error(`unexpected SQL: ${query.text}`);
    });
    const adapter = createPostgresStockAdapter(db.database, {
      connectionId,
      transport: transport(),
    });

    const audit = await adapter.readAudit("stock:audit:1");

    expect(audit).toEqual({
      claim: expect.objectContaining({
        idempotencyKey: "stock:audit:1",
        orderId: "order:audit:1",
        status: "SUCCESS",
        attempt: 2,
        result: { payloadHash: "hash-1", stockSource: bottle },
      }),
      executions: [expect.objectContaining({ outcome: "SUCCESS", durationMs: 30 })],
      stockLogs: [expect.objectContaining({
        status: "SUCCESS",
        variant: "copa",
        stockId: "7002",
        winerimResponse: { stockSource: bottle },
      })],
    });
    expect(db.transactions).toEqual([
      { isolationLevel: "repeatable-read", readOnly: true },
    ]);
    const sqlText = db.queries.map((query) => query.text).join("\n");
    expect(sqlText).not.toMatch(/last_business_day_synced|cursor|historical_sales/i);
  });
});
