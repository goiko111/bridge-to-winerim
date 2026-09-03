import { describe, expect, it, vi } from "vitest";
import type {
  DatabaseAdapter,
  DatabaseTransaction,
  QueryResult,
} from "../../cloudflare/workers/middleware-api/src/db";
import {
  buildStockMutationPayloadHash,
  createPostgresStockAdapter,
  type StockMutationContext,
} from "../../cloudflare/workers/middleware-runtime/src/adapters/stock";
import type { WinerimMutationTransport } from "../../cloudflare/workers/middleware-runtime/src/handlers/stock";

type RecordedQuery = { text: string; values: readonly unknown[] };

function databaseDouble(
  handler: (query: RecordedQuery) => QueryResult<Record<string, unknown>>,
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

function result(rows: Record<string, unknown>[] = [], rowCount = rows.length) {
  return { rows, rowCount };
}

const connectionId = "11111111-1111-4111-8111-111111111111";
const eventId = "22222222-2222-4222-8222-222222222222";
const lineId = "33333333-3333-4333-8333-333333333333";
const bottle = { wineId: "wine-42", stockId: 4201, variant: "bottle" as const };
const glass = { wineId: "wine-42", stockId: 4202, variant: "glass" as const };

function context(overrides: Partial<StockMutationContext> = {}): StockMutationContext {
  return {
    idempotencyKey: "stock:agora:ticket-1:line-1:glass",
    productName: "C Test Wine",
    providerProductId: "54202",
    salesEventId: eventId,
    salesLineItemId: lineId,
    mutation: {
      mode: "operational",
      orderId: "agora:ticket-1:line-1:glass",
      soldAt: "2026-08-02T12:00:00Z",
      quantity: 1,
      soldStock: glass,
      stockSource: bottle,
    },
    ...overrides,
  };
}

function transport(responses: { status: number; body?: unknown }[]): WinerimMutationTransport & {
  send: ReturnType<typeof vi.fn>;
  sleep: ReturnType<typeof vi.fn>;
} {
  const remaining = [...responses];
  return {
    send: vi.fn(async () => {
      const response = remaining.shift();
      if (!response) throw new Error("missing test response");
      return response;
    }),
    sleep: vi.fn(async () => undefined),
  };
}

function successfulReadbackRows(payloadHash: string) {
  return {
    claim: {
      idempotency_key: "stock:agora:ticket-1:line-1:glass",
      message_id: "agora:ticket-1:line-1:glass",
      connection_id: connectionId,
      job: "stock.mutation",
      status: "SUCCESS",
      attempt: 1,
      lease_expires_at: null,
      result: { payloadHash, orderId: "agora:ticket-1:line-1:glass" },
      created_at: "2026-08-02T12:00:00Z",
      updated_at: "2026-08-02T12:00:01Z",
    },
    execution: {
      id: "91",
      message_id: "agora:ticket-1:line-1:glass",
      idempotency_key: "stock:agora:ticket-1:line-1:glass",
      outcome: "SUCCESS",
      attempt: 1,
      duration_ms: 25,
      error_class: null,
      detail: { payloadHash, stockSource: bottle },
      created_at: "2026-08-02T12:00:01Z",
    },
    stock: {
      id: "44444444-4444-4444-8444-444444444444",
      sales_event_id: eventId,
      sales_line_item_id: lineId,
      provider_product_id: "54202",
      winerim_product_id: "wine-42",
      product_name: "C Test Wine",
      quantity: 1,
      status: "SUCCESS",
      variant: "copa",
      stock_id: "4202",
      idempotency_key: "stock:agora:ticket-1:line-1:glass",
      error_message: null,
      winerim_response: { payloadHash, stockSource: bottle },
      created_at: "2026-08-02T12:00:01Z",
      synced_at: "2026-08-02T12:00:01Z",
    },
  };
}

describe("Cloudflare PostgreSQL stock adapter claims", () => {
  it("keeps the payload hash stable across refreshed line ids but changes it for business payload changes", async () => {
    const original = context();
    const refreshedLine = context({
      salesLineItemId: "55555555-5555-4555-8555-555555555555",
    });
    const changedQuantity = context({
      mutation: { ...original.mutation, quantity: 2 },
    });

    await expect(buildStockMutationPayloadHash(refreshedLine))
      .resolves.toBe(await buildStockMutationPayloadHash(original));
    await expect(buildStockMutationPayloadHash(changedQuantity))
      .resolves.not.toBe(await buildStockMutationPayloadHash(original));
  });

  it("claims atomically, records a certified mutation and returns audit readback", async () => {
    const input = context();
    const payloadHash = await buildStockMutationPayloadHash(input);
    const rows = successfulReadbackRows(payloadHash);
    const db = databaseDouble((query) => {
      if (query.text.includes("status IN ('PENDING', 'SUCCESS')")) return result();
      if (query.text.includes("INSERT INTO public.runtime_idempotency")) {
        return result([{ attempt: 1 }]);
      }
      if (query.text.includes("UPDATE public.runtime_idempotency")) {
        return result([{ idempotency_key: input.idempotencyKey }]);
      }
      if (query.text.includes("INSERT INTO public.stock_sync_log")) return result([], 1);
      if (query.text.includes("INSERT INTO public.runtime_execution_log")) return result([], 1);
      if (query.text.includes("FROM public.runtime_idempotency")) return result([rows.claim]);
      if (query.text.includes("FROM public.runtime_execution_log")) return result([rows.execution]);
      if (query.text.includes("FROM public.stock_sync_log")) return result([rows.stock]);
      throw new Error(`unexpected SQL: ${query.text}`);
    });
    const winerim = transport([{
      status: 200,
      body: {
        sales: [{
          orderId: input.mutation.orderId,
          status: "imported",
          stockApplied: true,
        }],
      },
    }]);
    const adapter = createPostgresStockAdapter(db.database, {
      connectionId,
      transport: winerim,
      now: (() => {
        const values = [1_000, 1_025, 1_025];
        return () => values.shift() ?? 1_025;
      })(),
    });

    const execution = await adapter.execute(input);

    expect(execution).toMatchObject({
      state: "APPLIED",
      writesPerformed: true,
      payloadHash,
      audit: {
        claim: { status: "SUCCESS", attempt: 1 },
        executions: [{ outcome: "SUCCESS", durationMs: 25 }],
        stockLogs: [{ status: "SUCCESS", variant: "copa", stockId: "4202" }],
      },
    });
    expect(winerim.send).toHaveBeenCalledOnce();
    expect(db.transactions).toEqual([
      { isolationLevel: "serializable", readOnly: false },
      { isolationLevel: "serializable", readOnly: false },
      { isolationLevel: "repeatable-read", readOnly: true },
    ]);

    const claimInsert = db.queries.find((query) =>
      query.text.includes("INSERT INTO public.runtime_idempotency")
    );
    const metadata = claimInsert?.values.find((value) =>
      typeof value === "string" && value.includes('"payloadHash"')
    );
    expect(JSON.parse(String(metadata))).toMatchObject({
      payloadHash,
      orderId: input.mutation.orderId,
      soldStock: glass,
      stockSource: bottle,
      request: { kind: "sales-import", body: { live: true } },
    });

    const allSql = db.queries.map((query) => query.text).join("\n");
    expect(allSql).toContain("ON CONFLICT (idempotency_key) DO NOTHING");
    expect(allSql).not.toMatch(/last_business_day_synced|cursor|historical_sales/i);
    const legacyStockRead = db.queries.find((query) =>
      query.text.includes("FROM public.stock_sync_log")
      && query.text.includes("status IN ('PENDING', 'SUCCESS')")
    );
    expect(legacyStockRead?.text).not.toContain("FOR UPDATE");
  });

  it("reacquires only the same orderId and payload, retaining the exact request on 409", async () => {
    const input = context();
    const payloadHash = await buildStockMutationPayloadHash(input);
    const rows = successfulReadbackRows(payloadHash);
    rows.claim.attempt = 2;
    const db = databaseDouble((query) => {
      if (query.text.includes("status IN ('PENDING', 'SUCCESS')")) return result();
      if (query.text.includes("INSERT INTO public.runtime_idempotency")) return result();
      if (query.text.includes("FROM public.runtime_idempotency") && query.text.includes("FOR UPDATE")) {
        return result([{
          ...rows.claim,
          status: "RETRY",
          attempt: 1,
          lease_expired: true,
          result: { payloadHash, orderId: input.mutation.orderId },
        }]);
      }
      if (query.text.includes("UPDATE public.runtime_idempotency") &&
          query.text.includes("attempt = attempt + 1")) {
        return result([{ ...rows.claim, status: "RUNNING", attempt: 2 }]);
      }
      if (query.text.includes("UPDATE public.runtime_idempotency")) {
        return result([{ idempotency_key: input.idempotencyKey }]);
      }
      if (query.text.includes("INSERT INTO public.stock_sync_log")) return result([], 1);
      if (query.text.includes("INSERT INTO public.runtime_execution_log")) return result([], 1);
      if (query.text.includes("FROM public.runtime_idempotency")) return result([rows.claim]);
      if (query.text.includes("FROM public.runtime_execution_log")) return result([rows.execution]);
      if (query.text.includes("FROM public.stock_sync_log")) return result([rows.stock]);
      throw new Error(`unexpected SQL: ${query.text}`);
    });
    const winerim = transport([
      { status: 409, body: { error: "Conflict" } },
      {
        status: 200,
        body: {
          sales: [{
            orderId: input.mutation.orderId,
            status: "imported",
            stockApplied: true,
          }],
        },
      },
    ]);
    const adapter = createPostgresStockAdapter(db.database, {
      connectionId,
      transport: winerim,
    });

    const execution = await adapter.execute(input);
    const requests = winerim.send.mock.calls.map(([request]) => request);

    expect(execution.state).toBe("APPLIED");
    expect(winerim.send).toHaveBeenCalledTimes(2);
    expect(requests[1]).toBe(requests[0]);
    expect(requests[1].body).toBe(requests[0].body);
    expect(requests[1].body.sales[0].orderId).toBe(input.mutation.orderId);
    const reacquire = db.queries.find((query) => query.text.includes("attempt = attempt + 1"));
    expect(reacquire?.text).toContain("result ->> 'payloadHash'");
    expect(reacquire?.values).toContain(payloadHash);
    expect(reacquire?.values).toContain(input.mutation.orderId);
  });

  it("blocks an idempotency key reused with a different payload before transport", async () => {
    const input = context();
    const db = databaseDouble((query) => {
      if (query.text.includes("status IN ('PENDING', 'SUCCESS')")) return result();
      if (query.text.includes("INSERT INTO public.runtime_idempotency")) return result();
      if (query.text.includes("FROM public.runtime_idempotency") && query.text.includes("FOR UPDATE")) {
        return result([{
          idempotency_key: input.idempotencyKey,
          message_id: input.mutation.orderId,
          connection_id: connectionId,
          job: "stock.mutation",
          status: "RETRY",
          attempt: 1,
          lease_expires_at: null,
          lease_expired: true,
          result: { payloadHash: "different-payload", orderId: input.mutation.orderId },
          created_at: "2026-08-02T12:00:00Z",
          updated_at: "2026-08-02T12:00:00Z",
        }]);
      }
      if (query.text.includes("FROM public.runtime_idempotency")) return result();
      if (query.text.includes("FROM public.runtime_execution_log")) return result();
      if (query.text.includes("FROM public.stock_sync_log")) return result();
      throw new Error(`unexpected SQL: ${query.text}`);
    });
    const winerim = transport([]);
    const adapter = createPostgresStockAdapter(db.database, {
      connectionId,
      transport: winerim,
    });

    const execution = await adapter.execute(input);

    expect(execution).toMatchObject({
      state: "IDEMPOTENCY_CONFLICT",
      writesPerformed: false,
      reason: "idempotency_key_order_or_payload_mismatch",
    });
    expect(winerim.send).not.toHaveBeenCalled();
    expect(db.queries.some((query) => query.text.includes("attempt = attempt + 1"))).toBe(false);
  });
});
