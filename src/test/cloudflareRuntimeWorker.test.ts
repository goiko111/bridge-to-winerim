import { describe, expect, it, vi } from "vitest";

import type {
  DatabaseAdapter,
  DatabaseTransaction,
  QueryResult,
} from "../../cloudflare/workers/middleware-api/src/db";
import { createRuntimeEnvelope } from "../../cloudflare/workers/middleware-runtime/src/idempotency";
import type {
  CloudflareMessageBatchLike,
  RuntimeExecutionResult,
} from "../../cloudflare/workers/middleware-runtime/src/queue";
import {
  createMiddlewareRuntimeWorker,
  runRuntimeQueue,
  runRuntimeScheduled,
  type MiddlewareRuntimeEnv,
  type RuntimeExecutor,
  type RuntimeQueueProducer,
  type RuntimeWorkerDependencies,
} from "../../cloudflare/workers/middleware-runtime/src/worker";

type StatementLike = { text: string; values: readonly unknown[] };

function result<Row extends Record<string, unknown>>(rows: Row[] = []): QueryResult<Row> {
  return { rows, rowCount: rows.length };
}

function fakeDatabase(
  route: (statement: StatementLike) => QueryResult<Record<string, unknown>> | Promise<QueryResult<Record<string, unknown>>>,
): DatabaseAdapter {
  const query = async <Row extends Record<string, unknown>>(statement: StatementLike) =>
    route(statement) as Promise<QueryResult<Row>>;
  const transaction: DatabaseAdapter["transaction"] = async (work) => {
    const tx = { query } as DatabaseTransaction;
    return work(tx);
  };
  return { query, transaction } as DatabaseAdapter;
}

function producer() {
  return { sendBatch: vi.fn(async () => undefined) } satisfies RuntimeQueueProducer;
}

function readyEnv(): MiddlewareRuntimeEnv {
  return {
    ENVIRONMENT: "staging",
    RELEASE: "test-release",
    RUNTIME_EXECUTION_ENABLED: "true",
    MIDDLEWARE_DB: { connectionString: "postgres://runtime.invalid/staging" },
    RUNTIME_EXECUTOR: { fetch: vi.fn() },
    MIDDLEWARE_CATALOG_QUEUE: producer(),
    MIDDLEWARE_SALES_STOCK_QUEUE: producer(),
    MIDDLEWARE_SALES_IMPORT_QUEUE: producer(),
    MIDDLEWARE_STOCK_SYNC_QUEUE: producer(),
    MIDDLEWARE_OUTBOUND_QUEUE: producer(),
    MIDDLEWARE_MAINTENANCE_QUEUE: producer(),
  };
}

const successfulExecutor: RuntimeExecutor = {
  execute: vi.fn(async (): Promise<RuntimeExecutionResult> => ({ ok: true, detail: "completed" })),
};

function dependencies(database: DatabaseAdapter, executor: RuntimeExecutor | null = successfulExecutor) {
  return {
    database: () => database,
    executor: () => executor,
  } satisfies Required<RuntimeWorkerDependencies>;
}

async function queueEnvelope(scope: string) {
  return createRuntimeEnvelope({
    connectionId: "11111111-1111-4111-8111-111111111111",
    job: "outbound.process",
    dedupeScope: scope,
    source: { kind: "queue", eventId: scope },
    payload: { taskId: scope },
    createdAt: "2026-08-02T10:00:00.000Z",
  });
}

describe("staging-only Cloudflare middleware runtime Worker", () => {
  it("serves liveness without opening the database or an executor", async () => {
    const database = vi.fn(() => {
      throw new Error("database must not be opened");
    });
    const worker = createMiddlewareRuntimeWorker({ database, executor: () => null });
    const response = await worker.fetch(
      new Request("https://runtime.invalid/health"),
      { ENVIRONMENT: "staging", RELEASE: "release-a" },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      service: "winerim-middleware-runtime",
      stagingOnly: true,
      externalWrites: false,
      executionEnabled: false,
    });
    expect(database).not.toHaveBeenCalled();
  });

  it("accepts an injected local executor without requiring a service binding", async () => {
    const query = vi.fn(async () => result([{
      environment: "staging",
      runtime_idempotency_ready: true,
      runtime_execution_log_ready: true,
    }]));
    const database = fakeDatabase(query);
    const env = readyEnv();
    env.RUNTIME_EXECUTOR = undefined;

    const worker = createMiddlewareRuntimeWorker(dependencies(database, successfulExecutor));
    const response = await worker.fetch(new Request("https://runtime.invalid/ready"), env);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      executorBound: true,
      missingBindings: [],
    });
  });

  it("sanitizes executor binding failures instead of propagating provider details", async () => {
    const database = fakeDatabase(() => result());
    const env = readyEnv();
    env.RUNTIME_EXECUTOR = {
      fetch: vi.fn(async () => {
        throw new Error("upstream included sensitive fixture material");
      }),
    };
    const body = await queueEnvelope("executor-binding-failure");
    const message = { id: "cf-binding", attempts: 1, body, ack: vi.fn(), retry: vi.fn() };

    await createMiddlewareRuntimeWorker({ database: () => database }).queue(
      { queue: "runtime", messages: [message] },
      env,
    );

    expect(message.retry).toHaveBeenCalled();
    expect(message.ack).not.toHaveBeenCalled();
  });

  it("treats a malformed successful executor response as unavailable", async () => {
    const statements: string[] = [];
    const database = fakeDatabase((statement) => {
      statements.push(statement.text);
      if (statement.text.includes("INSERT INTO public.runtime_idempotency")) return result([{ attempt: 1 }]);
      if (statement.text.includes("SET status = 'RETRY'")) return result([{ attempt: 1 }]);
      return result();
    });
    const env = readyEnv();
    env.RUNTIME_EXECUTOR = {
      fetch: vi.fn(async () => new Response(JSON.stringify({ ok: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })),
    };
    const body = await queueEnvelope("executor-invalid-success-response");
    const message = { id: "cf-invalid", attempts: 1, body, ack: vi.fn(), retry: vi.fn() };

    await createMiddlewareRuntimeWorker({ database: () => database }).queue(
      { queue: "runtime", messages: [message] },
      env,
    );

    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 120 });
    expect(message.ack).not.toHaveBeenCalled();
    expect(statements.some((text) => text.includes("status = 'RETRY'"))).toBe(true);
  });

  it("reports readiness only when staging schema, queues and executor gate are complete", async () => {
    const query = vi.fn(async () => result([{
      environment: "staging",
      runtime_idempotency_ready: true,
      runtime_execution_log_ready: true,
    }]));
    const database = fakeDatabase(query);
    const env = readyEnv();

    const readyWorker = createMiddlewareRuntimeWorker(dependencies(database));
    const readyResponse = await readyWorker.fetch(new Request("https://runtime.invalid/ready"), env);
    expect(readyResponse.status).toBe(200);
    expect(await readyResponse.json()).toMatchObject({ ok: true, database: "ready" });

    const closedWorker = createMiddlewareRuntimeWorker(dependencies(database, null));
    const closedResponse = await closedWorker.fetch(new Request("https://runtime.invalid/ready"), {
      ...env,
      RUNTIME_EXECUTOR: undefined,
    });
    expect(closedResponse.status).toBe(503);
    expect(await closedResponse.json()).toMatchObject({
      ok: false,
      executorBound: false,
      reason: "RUNTIME_NOT_READY",
    });
  });

  it("does not read Postgres or publish when the staging execution gate is closed", async () => {
    const database = fakeDatabase(() => {
      throw new Error("database must not be read");
    });
    const env = readyEnv();
    env.ENVIRONMENT = "production";

    const result = await runRuntimeScheduled(
      { cron: "*/5 * * * *", scheduledTime: Date.parse("2026-08-02T10:00:00.000Z") },
      env,
      dependencies(database),
    );

    expect(result).toEqual({
      status: "inactive",
      reason: "NOT_STAGING",
      connections: 0,
      messages: 0,
    });
    for (const queue of Object.values(env).filter((value) => value && typeof value === "object" && "sendBatch" in value)) {
      expect((queue as RuntimeQueueProducer).sendBatch).not.toHaveBeenCalled();
    }
  });

  it("loads enabled connections and publishes deterministic envelopes to their lane queues", async () => {
    const database = fakeDatabase((statement) => {
      expect(statement.text).toContain("FROM public.pos_connections");
      expect(statement.text).toContain("enabled = true");
      return result([{
        connection_id: "11111111-1111-4111-8111-111111111111",
        enabled: true,
        circuit_breaker_paused_until: null,
        intraday_sales_sync_enabled: true,
        open_tickets_sync_enabled: true,
      }]);
    });
    const env = readyEnv();

    const dispatched = await runRuntimeScheduled(
      { cron: "*/5 * * * *", scheduledTime: Date.parse("2026-08-02T10:00:00.000Z") },
      env,
      dependencies(database),
    );

    expect(dispatched).toEqual({ status: "dispatched", connections: 1, messages: 6 });
    expect(env.MIDDLEWARE_CATALOG_QUEUE?.sendBatch).toHaveBeenCalledOnce();
    expect(env.MIDDLEWARE_SALES_STOCK_QUEUE?.sendBatch).toHaveBeenCalledOnce();
    expect(env.MIDDLEWARE_OUTBOUND_QUEUE?.sendBatch).toHaveBeenCalledOnce();
    expect(env.MIDDLEWARE_SALES_IMPORT_QUEUE?.sendBatch).not.toHaveBeenCalled();
    const catalogBatch = vi.mocked(env.MIDDLEWARE_CATALOG_QUEUE!.sendBatch).mock.calls[0][0];
    expect(catalogBatch).toHaveLength(2);
    expect(catalogBatch.every((message) => message.body.connectionId === "11111111-1111-4111-8111-111111111111"))
      .toBe(true);
  });

  it("retries every queue message without database writes when no executor is injected", async () => {
    const body = await queueEnvelope("no-executor");
    const message = { id: "cf-1", attempts: 1, body, ack: vi.fn(), retry: vi.fn() };
    const databaseFactory = vi.fn(() => fakeDatabase(() => result()));

    await runRuntimeQueue(
      { queue: "runtime", messages: [message] },
      readyEnv(),
      { database: databaseFactory, executor: () => null },
    );

    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 300 });
    expect(message.ack).not.toHaveBeenCalled();
    expect(databaseFactory).not.toHaveBeenCalled();
  });

  it("persists a reservation and success before acknowledging the message", async () => {
    const statements: string[] = [];
    const database = fakeDatabase((statement) => {
      statements.push(statement.text);
      if (statement.text.includes("INSERT INTO public.runtime_idempotency")) return result([{ attempt: 1 }]);
      if (statement.text.includes("SET status = 'SUCCESS'")) return result([{ attempt: 1 }]);
      return result();
    });
    const executor = { execute: vi.fn(async () => ({ ok: true as const, detail: "ok" })) };
    const body = await queueEnvelope("success");
    const message = { id: "cf-2", attempts: 1, body, ack: vi.fn(), retry: vi.fn() };

    await runRuntimeQueue(
      { queue: "runtime", messages: [message] },
      readyEnv(),
      dependencies(database, executor),
    );

    expect(executor.execute).toHaveBeenCalledOnce();
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(statements.some((text) => text.includes("runtime_idempotency"))).toBe(true);
    expect(statements.some((text) => text.includes("runtime_execution_log"))).toBe(true);
    expect(statements.some((text) => text.includes("status = 'SUCCESS'"))).toBe(true);
  });

  it("acknowledges a persisted duplicate without invoking the executor", async () => {
    const statements: string[] = [];
    const database = fakeDatabase((statement) => {
      statements.push(statement.text);
      if (statement.text.includes("INSERT INTO public.runtime_idempotency")) return result();
      if (statement.text.includes("FROM public.runtime_idempotency")) {
        return result([{ status: "SUCCESS", attempt: 2, lease_expired: null }]);
      }
      return result();
    });
    const executor = { execute: vi.fn(async () => ({ ok: true as const })) };
    const body = await queueEnvelope("duplicate");
    const message = { id: "cf-3", attempts: 2, body, ack: vi.fn(), retry: vi.fn() };

    await runRuntimeQueue(
      { queue: "runtime", messages: [message] } as CloudflareMessageBatchLike,
      readyEnv(),
      dependencies(database, executor),
    );

    expect(message.ack).toHaveBeenCalledOnce();
    expect(executor.execute).not.toHaveBeenCalled();
    expect(statements.some((text) => text.includes("runtime_execution_log"))).toBe(true);
  });

  it("persists retry disposition while preserving the same idempotency key", async () => {
    const statements: string[] = [];
    const database = fakeDatabase((statement) => {
      statements.push(statement.text);
      if (statement.text.includes("INSERT INTO public.runtime_idempotency")) return result([{ attempt: 1 }]);
      if (statement.text.includes("SET status = 'RETRY'")) return result([{ attempt: 1 }]);
      return result();
    });
    const executor = { execute: vi.fn(async () => ({
      ok: false as const,
      failure: { httpStatus: 503 },
    })) };
    const body = await queueEnvelope("retry");
    const idempotencyKey = body.idempotencyKey;
    const message = { id: "cf-4", attempts: 1, body, ack: vi.fn(), retry: vi.fn() };

    await runRuntimeQueue(
      { queue: "runtime", messages: [message] },
      readyEnv(),
      dependencies(database, executor),
    );

    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 120 });
    expect(message.body.idempotencyKey).toBe(idempotencyKey);
    expect(statements.some((text) => text.includes("status = 'RETRY'"))).toBe(true);
    expect(statements.some((text) => text.includes("runtime_execution_log"))).toBe(true);
  });

  it("persists a non-retryable terminal outcome before acknowledging", async () => {
    const statements: string[] = [];
    const database = fakeDatabase((statement) => {
      statements.push(statement.text);
      if (statement.text.includes("INSERT INTO public.runtime_idempotency")) return result([{ attempt: 1 }]);
      if (statement.text.includes("SET status = 'TERMINAL'")) return result([{ attempt: 1 }]);
      return result();
    });
    const executor = { execute: vi.fn(async () => ({
      ok: false as const,
      failure: { httpStatus: 422 },
    })) };
    const body = await queueEnvelope("terminal");
    const message = { id: "cf-5", attempts: 1, body, ack: vi.fn(), retry: vi.fn() };

    await runRuntimeQueue(
      { queue: "runtime", messages: [message] },
      readyEnv(),
      dependencies(database, executor),
    );

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(statements.some((text) => text.includes("status = 'TERMINAL'"))).toBe(true);
    expect(statements.some((text) => text.includes("runtime_execution_log"))).toBe(true);
  });
});
