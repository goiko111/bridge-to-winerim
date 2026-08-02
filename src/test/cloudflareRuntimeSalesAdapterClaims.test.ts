import { describe, expect, it, vi } from "vitest";

import type {
  DatabaseAdapter,
  DatabaseTransaction,
  QueryResult,
  SqlStatement,
  TransactionOptions,
} from "../../cloudflare/workers/middleware-api/src/db";
import {
  createPostgresSalesAdapter,
} from "../../cloudflare/workers/middleware-runtime/src/adapters/sales";
import type {
  SalesMutationIntent,
} from "../../cloudflare/workers/middleware-runtime/src/handlers/sales";

function result<Row extends Record<string, unknown>>(rows: Row[] = []): QueryResult<Row> {
  return { rows, rowCount: rows.length };
}

type Route = (statement: SqlStatement) => QueryResult<Record<string, unknown>>;

function fakeDatabase(route: Route) {
  const statements: SqlStatement[] = [];
  const transactionOptions: TransactionOptions[] = [];
  const query = vi.fn(async <Row extends Record<string, unknown>>(statement: SqlStatement) => {
    statements.push(statement);
    return route(statement) as QueryResult<Row>;
  });
  const transaction: DatabaseAdapter["transaction"] = vi.fn(async (work, options = {}) => {
    transactionOptions.push(options);
    return work({ query } as DatabaseTransaction);
  });
  return {
    database: { query, transaction } as DatabaseAdapter,
    statements,
    transactionOptions,
  };
}

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";

function intent(sourceDocumentId: string): SalesMutationIntent {
  return {
    claimKey: "sales-claim:v1:shared-open-final",
    orderId: "mw:v1:agora:2026-07-29:same:b:t1",
    mutationIdempotencyKey: "sales-mutation:v1:same",
    connectionId: CONNECTION_ID,
    provider: "agora",
    businessDay: "2026-07-29",
    lifecycleId: "ticket-100",
    winerimWineId: "47593",
    variant: "BOTTLE",
    desiredQuantity: 1,
    observedAppliedQuantity: 0,
    sourceDocumentIds: [sourceDocumentId],
    sourceLineIds: ["line-1"],
    action: {
      kind: "STOCK_APPLY",
      stockId: "stock-47593",
      variant: "BOTTLE",
      fallbackToSalesOnlyIfStockDidNotMove: true,
      line: {
        lineId: "line-1",
        winerimWineId: "47593",
        variant: "BOTTLE",
        quantity: 1,
        providerProductIds: ["547593"],
      },
    },
  };
}

describe("PostgreSQL sales adapter claims", () => {
  it("prevents OpenTicket to definitive-invoice double application with one durable claim", async () => {
    let state: "NONE" | "RUNNING" | "SUCCESS" = "NONE";
    let appliedQuantity = 0;
    const fake = fakeDatabase((statement) => {
      if (statement.text.includes("INSERT INTO public.runtime_idempotency")) {
        if (state !== "NONE") return result();
        state = "RUNNING";
        return result([{
          status: state,
          applied_quantity: 0,
          result: { appliedQuantity: 0 },
        }]);
      }
      if (statement.text.includes("FOR UPDATE")) {
        return result([{
          idempotency_key: "sales-claim:v1:shared-open-final",
          message_id: "mw:v1:agora:2026-07-29:same:b:t1",
          job: "sales.claim",
          status: state,
          applied_quantity: appliedQuantity,
          lease_expired: false,
          result: { appliedQuantity },
          updated_at: "2026-07-29T13:05:00Z",
        }]);
      }
      if (statement.text.includes("status = 'SUCCESS'")) {
        state = "SUCCESS";
        appliedQuantity = 1;
        return result([{ idempotency_key: "sales-claim:v1:shared-open-final" }]);
      }
      return result();
    });
    const adapter = createPostgresSalesAdapter(fake.database, {
      connectionId: CONNECTION_ID,
      provider: "agora",
      claimLeaseSeconds: 60,
    });

    const openTicket = intent("open-ticket:ticket-100");
    expect(await adapter.reserveClaim(openTicket)).toEqual({ state: "ACQUIRED", appliedQuantity: 0 });
    await adapter.completeClaim({
      claimKey: openTicket.claimKey,
      orderId: openTicket.orderId,
      appliedQuantity: 1,
    });

    const definitive = intent("invoice:invoice-100");
    expect(await adapter.reserveClaim(definitive)).toEqual({ state: "DUPLICATE", appliedQuantity: 1 });

    expect(fake.statements.some((statement) => statement.text.includes("FOR UPDATE"))).toBe(true);
    expect(fake.statements.filter((statement) => statement.text.includes("INSERT INTO public.runtime_idempotency")))
      .toHaveLength(2);
    expect(fake.transactionOptions).toEqual([
      { isolationLevel: "serializable", readOnly: false },
      { isolationLevel: "serializable", readOnly: false },
    ]);
  });

  it("reacquires a completed OpenTicket claim only for a larger definitive total", async () => {
    const fake = fakeDatabase((statement) => {
      if (statement.text.includes("INSERT INTO public.runtime_idempotency")) return result();
      if (statement.text.includes("FOR UPDATE")) {
        return result([{
          idempotency_key: "sales-claim:v1:shared-open-final",
          message_id: "open-order-t1",
          job: "sales.claim",
          status: "SUCCESS",
          applied_quantity: 1,
          lease_expired: true,
          result: { appliedQuantity: 1 },
          updated_at: "2026-07-29T13:05:00Z",
        }]);
      }
      if (statement.text.includes("SET\n          message_id")) {
        return result([{
          idempotency_key: "sales-claim:v1:shared-open-final",
          status: "RUNNING",
          applied_quantity: 1,
          result: { appliedQuantity: 1 },
        }]);
      }
      return result();
    });
    const adapter = createPostgresSalesAdapter(fake.database, {
      connectionId: CONNECTION_ID,
      provider: "agora",
    });
    const definitive = {
      ...intent("invoice:invoice-100"),
      orderId: "final-order-t2",
      desiredQuantity: 2,
      observedAppliedQuantity: 1,
    };

    await expect(adapter.reserveClaim(definitive)).resolves.toEqual({
      state: "ACQUIRED",
      appliedQuantity: 1,
    });
    const reacquire = fake.statements.find((statement) =>
      statement.text.includes("UPDATE public.runtime_idempotency")
      && statement.text.includes("attempt = attempt + 1")
    );
    expect(reacquire?.values).toEqual(expect.arrayContaining([
      "final-order-t2",
      "sales-claim:v1:shared-open-final",
      CONNECTION_ID,
    ]));
  });

  it("loads claim quantities and maps database states without mutating them", async () => {
    const fake = fakeDatabase((statement) => {
      expect(statement.text).toContain("FROM public.runtime_idempotency");
      expect(statement.text).toContain("job =");
      return result([
        {
          idempotency_key: "claim-complete",
          message_id: "order-1",
          job: "sales.claim",
          status: "SUCCESS",
          applied_quantity: "2",
          lease_expires_at: null,
          result: { appliedQuantity: 2 },
          updated_at: "2026-07-29T13:05:00Z",
        },
        {
          idempotency_key: "claim-running",
          message_id: "order-2",
          job: "sales.claim",
          status: "RUNNING",
          applied_quantity: "1",
          lease_expires_at: "2026-07-29T13:07:00Z",
          result: { appliedQuantity: 1 },
          updated_at: "2026-07-29T13:05:00Z",
        },
      ]);
    });
    const adapter = createPostgresSalesAdapter(fake.database, {
      connectionId: CONNECTION_ID,
      provider: "agora",
    });

    await expect(adapter.loadClaims?.(["claim-running", "claim-complete"]))
      .resolves.toEqual([
        { claimKey: "claim-complete", state: "COMPLETE", appliedQuantity: 2 },
        { claimKey: "claim-running", state: "PENDING", appliedQuantity: 1 },
      ]);
    expect(fake.transactionOptions).toEqual([{ isolationLevel: "repeatable-read", readOnly: true }]);
    expect(fake.statements[0].values).toEqual([
      CONNECTION_ID,
      "sales.claim",
      ["claim-complete", "claim-running"],
      ["claim-complete", "claim-running"],
    ]);
  });

  it("parameterizes failure details when releasing a claim", async () => {
    const secretLikeError = "upstream failed for token-do-not-inline";
    const fake = fakeDatabase((statement) => {
      if (statement.text.includes("UPDATE public.runtime_idempotency")) {
        return result([{ idempotency_key: "claim-1" }]);
      }
      return result();
    });
    const adapter = createPostgresSalesAdapter(fake.database, {
      connectionId: CONNECTION_ID,
      provider: "agora",
    });

    await adapter.releaseClaim({
      claimKey: "claim-1",
      orderId: "order-1",
      retryable: true,
      error: secretLikeError,
    });

    expect(fake.statements[0].text).not.toContain(secretLikeError);
    expect(JSON.stringify(fake.statements[0].values)).toContain(secretLikeError);
    expect(fake.statements[0].values).toContain("RETRY");
  });
});
