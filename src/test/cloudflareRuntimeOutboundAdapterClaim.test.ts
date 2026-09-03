import { describe, expect, it, vi } from "vitest";
import type {
  DatabaseAdapter,
  DatabaseTransaction,
  QueryResult,
  SqlStatement,
  TransactionOptions,
} from "../../cloudflare/workers/middleware-api/src/db";
import {
  createPostgresOutboundAdapter,
  type PosOutboundTransport,
} from "../../cloudflare/workers/middleware-runtime/src/adapters/outbound";

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const TASK_ID = "22222222-2222-4222-8222-222222222222";
const NOW = "2026-08-02T10:00:00.000Z";

type QueryRecord = {
  transactionId: number;
  options: TransactionOptions | undefined;
  statement: SqlStatement;
};

type QueryRouter = (
  statement: SqlStatement,
  transactionId: number,
  options: TransactionOptions | undefined,
) => QueryResult<Record<string, unknown>> | Promise<QueryResult<Record<string, unknown>>>;

function result(rows: Record<string, unknown>[] = [], rowCount = rows.length) {
  return { rows, rowCount };
}

function createDatabase(router: QueryRouter) {
  const records: QueryRecord[] = [];
  let nextTransactionId = 0;
  const query = async () => {
    throw new Error("adapter queries must be transaction-scoped");
  };
  const database: DatabaseAdapter = {
    query,
    transaction: async <T>(
      work: (transaction: DatabaseTransaction) => Promise<T>,
      options?: TransactionOptions,
    ) => {
      const transactionId = ++nextTransactionId;
      const transaction: DatabaseTransaction = {
        query: async <Row extends Record<string, unknown>>(statement: SqlStatement) => {
          records.push({ transactionId, options, statement });
          return await router(statement, transactionId, options) as QueryResult<Row>;
        },
      };
      return work(transaction);
    },
  };
  return { database, records };
}

function taskRow(payload: Record<string, unknown> = {}) {
  return {
    id: TASK_ID,
    connection_id: CONNECTION_ID,
    provider: "agora",
    task_type: "AGORA_XML_UPSERT_PRODUCT",
    payload_json: {
      _idempotency_key: "catalog:210280:BOTTLE",
      _winerim_wine_id: "210280",
      _format_types: ["BOTTLE", "GLASS"],
      ...payload,
    },
    status: "RUNNING",
    attempts: 1,
    max_attempts: 5,
    created_at: NOW,
    updated_at: NOW,
    external_id: null,
  };
}

function breakerRow(failures = 0) {
  return {
    consecutive_failures: failures,
    circuit_breaker_paused_until: null,
    circuit_breaker_reason: null,
    revision: NOW,
  };
}

function successfulRouter(statement: SqlStatement) {
  const text = statement.text;
  if (text.includes("acquire_agora_dispatch_lock")) return result([{ value: true }]);
  if (text.includes("release_agora_dispatch_lock")) return result([{ value: true }]);
  if (text.includes("FROM public.pos_connections")) return result([breakerRow()]);
  if (text.includes("WITH picked AS")) return result([taskRow()]);
  if (text.includes("pg_advisory_xact_lock")) return result();
  if (text.includes("UPDATE public.pos_connections")) return result();
  if (text.includes("UPDATE public.outbound_tasks")) return result([{ id: TASK_ID }], 1);
  if (text.includes("UPDATE public.winerim_push_tracking")) return result([{}, {}], 2);
  if (text.includes("INSERT INTO public.runtime_execution_log")) return result([], 1);
  throw new Error(`unexpected SQL: ${text}`);
}

describe("PostgreSQL outbound adapter claim and settlement", () => {
  it("claims with SKIP LOCKED and settles breaker, task, tracking and log atomically", async () => {
    const { database, records } = createDatabase(successfulRouter);
    const transport: PosOutboundTransport = {
      execute: vi.fn(async () => ({
        kind: "success" as const,
        externalId: "agora-product-710280",
        detail: "provider accepted",
      })),
    };
    const limiter = { acquire: vi.fn(async () => ({ granted: true as const, waitedMs: 17 })) };
    const adapter = createPostgresOutboundAdapter(database, transport, {
      connectionId: CONNECTION_ID,
      provider: "agora",
      limiter,
      clock: { now: () => new Date(NOW) },
      lockTokenFactory: () => "outbound-test-lock",
    });

    const processed = await adapter.process({
      taskTypes: ["AGORA_XML_UPSERT_PRODUCT"],
      limit: 5,
    });

    expect(processed).toMatchObject({
      dryRun: false,
      lockAcquired: true,
      summary: { claimed: 1, completed: 1, retried: 0, terminal: 0 },
    });
    expect(transport.execute).toHaveBeenCalledOnce();
    expect(limiter.acquire).toHaveBeenCalledOnce();

    const claim = records.find(({ statement }) => statement.text.includes("WITH picked AS"));
    expect(claim?.statement.text).toContain("FOR UPDATE OF t SKIP LOCKED");
    expect(claim?.statement.text).toContain("attempts = COALESCE(t.attempts, 0) + 1");
    expect(claim?.statement.text).toContain("t.connection_id =");
    expect(claim?.statement.values).toEqual(expect.arrayContaining([
      CONNECTION_ID,
      "agora",
      ["AGORA_XML_UPSERT_PRODUCT"],
      NOW,
      5,
    ]));

    const taskUpdate = records.find(({ statement }) =>
      statement.text.includes("UPDATE public.outbound_tasks") && !statement.text.includes("WITH picked AS")
    );
    expect(taskUpdate).toBeDefined();
    const settlementTransactionId = taskUpdate!.transactionId;
    const settlementSql = records
      .filter(({ transactionId }) => transactionId === settlementTransactionId)
      .map(({ statement }) => statement.text)
      .join("\n");
    expect(settlementSql).toContain("pg_advisory_xact_lock");
    expect(settlementSql).toContain("FOR UPDATE");
    expect(settlementSql).toContain("UPDATE public.pos_connections");
    expect(settlementSql).toContain("UPDATE public.outbound_tasks");
    expect(settlementSql).toContain("UPDATE public.winerim_push_tracking");
    expect(settlementSql).toContain("INSERT INTO public.runtime_execution_log");
    expect(taskUpdate!.options).toEqual({ isolationLevel: "serializable", readOnly: false });

    const tracking = records.find(({ statement }) => statement.text.includes("winerim_push_tracking"));
    expect(tracking?.statement.values).toEqual(expect.arrayContaining([
      "VERIFIED",
      TASK_ID,
      CONNECTION_ID,
      "210280",
      ["BOTTLE", "GLASS"],
    ]));
  });

  it("does not claim or call the transport when the connection dispatch lock is busy", async () => {
    const { database, records } = createDatabase((statement) => {
      if (statement.text.includes("acquire_agora_dispatch_lock")) return result([{ value: false }]);
      throw new Error(`unexpected SQL after busy lock: ${statement.text}`);
    });
    const transport: PosOutboundTransport = { execute: vi.fn() };
    const limiter = { acquire: vi.fn() };
    const adapter = createPostgresOutboundAdapter(database, transport, {
      connectionId: CONNECTION_ID,
      provider: "agora",
      limiter,
      lockTokenFactory: () => "outbound-test-lock",
    });

    await expect(adapter.process({ taskTypes: ["AGORA_XML_UPSERT_PRODUCT"] })).resolves.toMatchObject({
      lockAcquired: false,
      summary: { claimed: 0 },
    });
    expect(transport.execute).not.toHaveBeenCalled();
    expect(limiter.acquire).not.toHaveBeenCalled();
    expect(records).toHaveLength(1);
  });
});
