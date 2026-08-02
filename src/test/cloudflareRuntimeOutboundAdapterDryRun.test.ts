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
const TRANSPORT_SECRET = "pos-transport-secret";
const PAYLOAD_SECRET = "payload-api-token-secret";

type QueryRecord = {
  transactionId: number;
  options: TransactionOptions | undefined;
  statement: SqlStatement;
};

function result(rows: Record<string, unknown>[] = [], rowCount = rows.length) {
  return { rows, rowCount };
}

function databaseHarness(router: (statement: SqlStatement) => QueryResult<Record<string, unknown>>) {
  const records: QueryRecord[] = [];
  let transactionId = 0;
  const database: DatabaseAdapter = {
    query: async () => { throw new Error("adapter queries must be transaction-scoped"); },
    transaction: async <T>(
      work: (transaction: DatabaseTransaction) => Promise<T>,
      options?: TransactionOptions,
    ) => {
      const currentTransactionId = ++transactionId;
      return work({
        query: async <Row extends Record<string, unknown>>(statement: SqlStatement) => {
          records.push({ transactionId: currentTransactionId, options, statement });
          return router(statement) as QueryResult<Row>;
        },
      });
    },
  };
  return { database, records };
}

function row() {
  return {
    id: TASK_ID,
    connection_id: CONNECTION_ID,
    provider: "agora",
    task_type: "AGORA_XML_UPSERT_PRODUCT",
    payload_json: {
      apiToken: PAYLOAD_SECRET,
      _idempotency_key: "catalog:210280:BOTTLE",
      _winerim_wine_id: "210280",
      _format_types: ["BOTTLE"],
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

describe("PostgreSQL outbound adapter dry-run and retry persistence", () => {
  it("keeps dry-run fully read-only and never invokes POS transport or limiter", async () => {
    const { database, records } = databaseHarness((statement) => {
      const sql = statement.text.trim();
      if (!sql.startsWith("SELECT")) throw new Error(`dry-run attempted a write: ${sql}`);
      if (sql.includes("FROM public.pos_connections")) return result([breakerRow()]);
      if (sql.includes("FROM public.outbound_tasks")) return result([row()]);
      throw new Error(`unexpected dry-run SQL: ${sql}`);
    });
    const transport: PosOutboundTransport = { execute: vi.fn() };
    const limiter = { acquire: vi.fn() };
    const adapter = createPostgresOutboundAdapter(database, transport, {
      connectionId: CONNECTION_ID,
      provider: "agora",
      dryRun: true,
      limiter,
      clock: { now: () => new Date(NOW) },
    });

    const processed = await adapter.process({ taskTypes: ["AGORA_XML_UPSERT_PRODUCT"] });

    expect(processed).toMatchObject({
      dryRun: true,
      lockAcquired: true,
      summary: { claimed: 1, completed: 1 },
      journal: {
        claimedTaskIds: [TASK_ID],
        transitions: [{ taskId: TASK_ID, decision: { action: "complete", status: "SUCCESS" } }],
        logs: [{ outcome: "complete", detail: "dry_run_no_transport" }],
      },
    });
    expect(transport.execute).not.toHaveBeenCalled();
    expect(limiter.acquire).not.toHaveBeenCalled();
    expect(records.every(({ options }) => options?.readOnly === true)).toBe(true);
    expect(records.some(({ statement }) => statement.text.includes("SKIP LOCKED"))).toBe(false);
    expect(records.some(({ statement }) => /\b(?:INSERT|UPDATE|DELETE)\b/i.test(statement.text))).toBe(false);
  });

  it("persists retry, breaker, backoff, sanitized log and exact tracking in one transaction", async () => {
    const { database, records } = databaseHarness((statement) => {
      const sql = statement.text;
      if (sql.includes("acquire_agora_dispatch_lock")) return result([{ value: true }]);
      if (sql.includes("release_agora_dispatch_lock")) return result([{ value: true }]);
      if (sql.includes("FROM public.pos_connections")) return result([breakerRow(4)]);
      if (sql.includes("WITH picked AS")) return result([row()]);
      if (sql.includes("pg_advisory_xact_lock")) return result();
      if (sql.includes("UPDATE public.pos_connections")) return result();
      if (sql.includes("UPDATE public.outbound_tasks")) return result([{ id: TASK_ID }], 1);
      if (sql.includes("UPDATE public.winerim_push_tracking")) return result([{}], 1);
      if (sql.includes("INSERT INTO public.runtime_execution_log")) return result([], 1);
      throw new Error(`unexpected SQL: ${sql}`);
    });
    const transport: PosOutboundTransport = {
      execute: vi.fn(async () => {
        throw new Error(`TCP connect timeout Authorization: Bearer ${TRANSPORT_SECRET}`);
      }),
    };
    const adapter = createPostgresOutboundAdapter(database, transport, {
      connectionId: CONNECTION_ID,
      provider: "agora",
      limiter: { acquire: async () => ({ granted: true, waitedMs: 0 }) },
      clock: { now: () => new Date(NOW) },
      lockTokenFactory: () => "outbound-test-lock",
    });

    const processed = await adapter.process({ taskTypes: ["AGORA_XML_UPSERT_PRODUCT"] });

    expect(processed).toMatchObject({
      summary: { claimed: 1, retried: 1, completed: 0 },
      journal: {
        transitions: [{
          taskId: TASK_ID,
          decision: {
            action: "retry",
            status: "QUEUED",
            nextRetryAt: "2026-08-02T10:02:00.000Z",
            failure: { class: "POS_DOWN" },
          },
        }],
      },
    });

    const taskUpdate = records.find(({ statement }) =>
      statement.text.includes("UPDATE public.outbound_tasks") && !statement.text.includes("WITH picked AS")
    );
    expect(taskUpdate?.statement.values).toEqual(expect.arrayContaining([
      "QUEUED",
      "2026-08-02T10:02:00.000Z",
      TASK_ID,
      CONNECTION_ID,
      1,
    ]));
    const settlementTransactionId = taskUpdate!.transactionId;
    const settlement = records.filter(({ transactionId }) => transactionId === settlementTransactionId);
    expect(settlement.some(({ statement }) => statement.text.includes("UPDATE public.pos_connections"))).toBe(true);
    expect(settlement.some(({ statement }) => statement.text.includes("UPDATE public.winerim_push_tracking"))).toBe(true);
    expect(settlement.some(({ statement }) => statement.text.includes("runtime_execution_log"))).toBe(true);
    expect(settlement.every(({ options }) =>
      options?.isolationLevel === "serializable" && options.readOnly === false
    )).toBe(true);

    const breakerUpdate = settlement.find(({ statement }) => statement.text.includes("UPDATE public.pos_connections"));
    expect(breakerUpdate?.statement.values).toEqual(expect.arrayContaining([
      5,
      "2026-08-02T11:00:00.000Z",
      "POS_DOWN",
      CONNECTION_ID,
    ]));
    const trackingUpdate = settlement.find(({ statement }) => statement.text.includes("winerim_push_tracking"));
    expect(trackingUpdate?.statement.values).toEqual(expect.arrayContaining([
      "QUEUED",
      TASK_ID,
      CONNECTION_ID,
      "210280",
      ["BOTTLE"],
    ]));

    const persistedValues = JSON.stringify(records.flatMap(({ statement }) => statement.values));
    expect(persistedValues).not.toContain(TRANSPORT_SECRET);
    expect(persistedValues).not.toContain(PAYLOAD_SECRET);
    expect(persistedValues).toContain("[REDACTED]");
  });
});
