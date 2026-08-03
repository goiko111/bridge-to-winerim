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
import { writerFenceCredentialBinding } from "../../cloudflare/canary-failclosed/src/writerFence";

type StatementLike = { text: string; values: readonly unknown[] };
const CANARY_CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const CANARY_RUN_ID = "run-20260803-a";
const CANARY_QUEUE_NAME = `winerim-rescue-prod-canary-${CANARY_RUN_ID}`;
const CANARY_HOLDER_ID = "deployment-a";
const DRY_RUN_PAYLOAD_SHA256 = "e59f1698ce59234efe2e872cfe891a303dc5993d05a87ca5476decaa7dfde3f7";

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

function exclusiveCanaryBindings(
  connectionId = CANARY_CONNECTION_ID,
  reviewed?: Readonly<{ messageId: string; idempotencyKey: string }>,
): Pick<MiddlewareRuntimeEnv,
  | "RUNTIME_MODE"
  | "RUNTIME_CANARY_CONNECTION_ID"
  | "CANARY_RUN_ID"
  | "CANARY_EXCLUSIVE_QUEUE_NAME"
  | "CANARY_MESSAGE_ID"
  | "CANARY_IDEMPOTENCY_KEY"
  | "CANARY_PAYLOAD_SHA256"
  | "WRITER_FENCE_HOLDER_ID"
  | "WRITER_FENCE"
  | "CANARY_WRITER_FENCE_PROOF"
> {
  return {
    RUNTIME_MODE: "exclusive-canary-consumer",
    RUNTIME_CANARY_CONNECTION_ID: connectionId,
    CANARY_RUN_ID,
    CANARY_EXCLUSIVE_QUEUE_NAME: CANARY_QUEUE_NAME,
    CANARY_MESSAGE_ID: reviewed?.messageId ?? "reviewed-message",
    CANARY_IDEMPOTENCY_KEY: reviewed?.idempotencyKey ?? "reviewed-idempotency",
    CANARY_PAYLOAD_SHA256: DRY_RUN_PAYLOAD_SHA256,
    WRITER_FENCE_HOLDER_ID: CANARY_HOLDER_ID,
    WRITER_FENCE: {
      fetch: vi.fn(async (_input, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          connectionId?: string;
          runId?: string;
          holderId?: string;
        };
        const credential = {
          reference: `runtime-vault://postgres/${connectionId}/agora/winerim`,
          version: "a".repeat(64),
        };
        return Response.json({
          connectionId: body.connectionId,
          runId: body.runId,
          holderId: body.holderId,
          fencingToken: 1,
          credentialReference: credential.reference,
          credentialVersion: credential.version,
          credentialBinding: await writerFenceCredentialBinding(credential),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
      }),
    },
    CANARY_WRITER_FENCE_PROOF: { get: vi.fn(async () => "x".repeat(40)) },
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

async function queueEnvelope(
  scope: string,
  connectionId = "11111111-1111-4111-8111-111111111111",
) {
  return createRuntimeEnvelope({
    connectionId,
    job: "outbound.process",
    dedupeScope: scope,
    source: { kind: "queue", eventId: scope },
    payload: { taskId: scope },
    createdAt: "2026-08-02T10:00:00.000Z",
  });
}

async function liveCanaryEnvelope(scope: string) {
  const created = await createRuntimeEnvelope({
    connectionId: "11111111-1111-4111-8111-111111111111",
    job: "winerim.sales-import-live",
    dedupeScope: scope,
    source: { kind: "queue", eventId: `pending:${scope}` },
    payload: { dryRun: true },
    createdAt: "2026-08-02T10:00:00.000Z",
  });
  return {
    ...created,
    source: { kind: "queue" as const, eventId: `canary:${CANARY_RUN_ID}:${created.messageId}` },
  };
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
      runtime_canary_scope_ready: true,
      runtime_credentials_ready: true,
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
      runtime_canary_scope_ready: true,
      runtime_credentials_ready: true,
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

  it("reports a dedicated canary consumer ready without producer bindings", async () => {
    const query = vi.fn(async () => result([{
      environment: "staging",
      runtime_idempotency_ready: true,
      runtime_execution_log_ready: true,
      runtime_canary_scope_ready: true,
      runtime_credentials_ready: true,
    }]));
    const database = fakeDatabase(query);
    const env: MiddlewareRuntimeEnv = {
      ENVIRONMENT: "staging",
      RELEASE: "canary-fixture",
      RUNTIME_EXECUTION_ENABLED: "true",
      ...exclusiveCanaryBindings(),
      MIDDLEWARE_DB: { connectionString: "postgres://runtime.invalid/staging" },
      RUNTIME_EXECUTOR: {
        fetch: vi.fn(async () => new Response(JSON.stringify({
          ok: true,
          credentials: "ready",
          connectionId: "11111111-1111-4111-8111-111111111111",
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })),
      },
    };

    const response = await createMiddlewareRuntimeWorker(dependencies(database)).fetch(
      new Request("https://runtime.invalid/ready"),
      env,
    );

    const responseBody = await response.json();
    expect(response.status, JSON.stringify(responseBody)).toBe(200);
    expect(responseBody).toMatchObject({
      ok: true,
      canaryConsumer: true,
      missingBindings: [],
      executorReadiness: "ready",
    });
  });

  it("keeps canary readiness closed when the private executor cannot decrypt credentials", async () => {
    const database = fakeDatabase(() => result([{
      environment: "staging",
      runtime_idempotency_ready: true,
      runtime_execution_log_ready: true,
      runtime_canary_scope_ready: true,
      runtime_credentials_ready: true,
    }]));
    const response = await createMiddlewareRuntimeWorker(dependencies(database)).fetch(
      new Request("https://runtime.invalid/ready"),
      {
        ENVIRONMENT: "staging",
        RUNTIME_EXECUTION_ENABLED: "true",
        ...exclusiveCanaryBindings(),
        MIDDLEWARE_DB: { connectionString: "postgres://runtime.invalid/staging" },
        RUNTIME_EXECUTOR: {
          fetch: vi.fn(async () => new Response(JSON.stringify({
            ok: false,
            credentials: "not_ready",
          }), { status: 503, headers: { "content-type": "application/json" } })),
        },
      },
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      ok: false,
      credentials: "ready",
      executorReadiness: "not_ready",
    });
  });

  it("keeps canary readiness closed when the private executor is scoped to another connection", async () => {
    const database = fakeDatabase(() => result([{
      environment: "staging",
      runtime_idempotency_ready: true,
      runtime_execution_log_ready: true,
      runtime_canary_scope_ready: true,
      runtime_credentials_ready: true,
    }]));
    const response = await createMiddlewareRuntimeWorker(dependencies(database)).fetch(
      new Request("https://runtime.invalid/ready"),
      {
        ENVIRONMENT: "staging",
        RUNTIME_EXECUTION_ENABLED: "true",
        ...exclusiveCanaryBindings(),
        MIDDLEWARE_DB: { connectionString: "postgres://runtime.invalid/staging" },
        RUNTIME_EXECUTOR: {
          fetch: vi.fn(async () => new Response(JSON.stringify({
            ok: true,
            credentials: "ready",
            connectionId: "22222222-2222-4222-8222-222222222222",
          }), { status: 200, headers: { "content-type": "application/json" } })),
        },
      },
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      ok: false,
      credentials: "ready",
      executorReadiness: "not_ready",
    });
  });

  it("keeps canary readiness closed until the approved database scope exists", async () => {
    const database = fakeDatabase(() => result([{
      environment: "staging",
      runtime_idempotency_ready: true,
      runtime_execution_log_ready: true,
      runtime_canary_scope_ready: false,
      runtime_credentials_ready: true,
    }]));
    const response = await createMiddlewareRuntimeWorker(dependencies(database)).fetch(
      new Request("https://runtime.invalid/ready"),
      {
        ENVIRONMENT: "staging",
        RUNTIME_EXECUTION_ENABLED: "true",
        ...exclusiveCanaryBindings(),
        MIDDLEWARE_DB: { connectionString: "postgres://runtime.invalid/staging" },
        RUNTIME_EXECUTOR: { fetch: vi.fn() },
      },
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      ok: false,
      canaryScope: "not_ready",
      database: "schema_not_ready",
    });
  });

  it("keeps canary readiness closed until both active credential rows exist", async () => {
    const database = fakeDatabase(() => result([{
      environment: "staging",
      runtime_idempotency_ready: true,
      runtime_execution_log_ready: true,
      runtime_canary_scope_ready: true,
      runtime_credentials_ready: false,
    }]));
    const response = await createMiddlewareRuntimeWorker(dependencies(database)).fetch(
      new Request("https://runtime.invalid/ready"),
      {
        ENVIRONMENT: "staging",
        RUNTIME_EXECUTION_ENABLED: "true",
        ...exclusiveCanaryBindings(),
        MIDDLEWARE_DB: { connectionString: "postgres://runtime.invalid/staging" },
        RUNTIME_EXECUTOR: { fetch: vi.fn() },
      },
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      ok: false,
      credentials: "not_ready",
      database: "schema_not_ready",
    });
  });

  it("fails canary readiness when the connection id is still the placeholder", async () => {
    const database = fakeDatabase(() => result([{
      environment: "staging",
      runtime_idempotency_ready: true,
      runtime_execution_log_ready: true,
      runtime_canary_scope_ready: true,
      runtime_credentials_ready: true,
    }]));
    const response = await createMiddlewareRuntimeWorker(dependencies(database)).fetch(
      new Request("https://runtime.invalid/ready"),
      {
        ENVIRONMENT: "staging",
        RUNTIME_EXECUTION_ENABLED: "true",
        ...exclusiveCanaryBindings("00000000-0000-4000-8000-000000000000"),
        MIDDLEWARE_DB: { connectionString: "postgres://runtime.invalid/staging" },
        RUNTIME_EXECUTOR: { fetch: vi.fn() },
      },
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      ok: false,
      missingBindings: ["RUNTIME_CANARY_CONNECTION_ID"],
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

  it("retries an out-of-scope canary message before database reservation", async () => {
    const body = await queueEnvelope(
      "wrong-canary-connection",
      "22222222-2222-4222-8222-222222222222",
    );
    const message = { id: "cf-scope-rejected", attempts: 1, body, ack: vi.fn(), retry: vi.fn() };
    const databaseFactory = vi.fn(() => fakeDatabase(() => result()));
    const executor = { execute: vi.fn(async () => ({ ok: true as const })) };
    const env = readyEnv();
    Object.assign(env, exclusiveCanaryBindings());

    await runRuntimeQueue(
      { queue: CANARY_QUEUE_NAME, messages: [message] },
      env,
      { database: databaseFactory, executor: () => executor },
    );

    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 300 });
    expect(databaseFactory).not.toHaveBeenCalled();
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it("retries a non-live job for the canary connection before database reservation", async () => {
    const body = await queueEnvelope("wrong-canary-job");
    const message = { id: "cf-job-rejected", attempts: 1, body, ack: vi.fn(), retry: vi.fn() };
    const databaseFactory = vi.fn(() => fakeDatabase(() => result()));
    const env = readyEnv();
    Object.assign(env, exclusiveCanaryBindings());

    await runRuntimeQueue(
      { queue: CANARY_QUEUE_NAME, messages: [message] },
      env,
      { database: databaseFactory, executor: () => successfulExecutor },
    );

    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 300 });
    expect(databaseFactory).not.toHaveBeenCalled();
  });

  it("rejects the deprecated canary mode before the database or executor", async () => {
    const body = await liveCanaryEnvelope("legacy-mode");
    const message = { id: "cf-legacy-mode", attempts: 1, body, ack: vi.fn(), retry: vi.fn() };
    const databaseFactory = vi.fn(() => fakeDatabase(() => result()));
    const executor = { execute: vi.fn(async () => ({ ok: true as const })) };
    const env = readyEnv();
    env.RUNTIME_MODE = "canary-consumer";
    env.RUNTIME_CANARY_CONNECTION_ID = body.connectionId;

    await runRuntimeQueue(
      { queue: CANARY_QUEUE_NAME, messages: [message] },
      env,
      { database: databaseFactory, executor: () => executor },
    );

    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 300 });
    expect(message.ack).not.toHaveBeenCalled();
    expect(databaseFactory).not.toHaveBeenCalled();
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it("retries a valid scoped message when the writer fence lease is denied", async () => {
    const body = await liveCanaryEnvelope("lease-denied");
    const message = { id: "cf-fence-denied", attempts: 1, body, ack: vi.fn(), retry: vi.fn() };
    const databaseFactory = vi.fn(() => fakeDatabase(() => result()));
    const executor = { execute: vi.fn(async () => ({ ok: true as const })) };
    const env = readyEnv();
    Object.assign(env, exclusiveCanaryBindings(body.connectionId, body));
    env.WRITER_FENCE = { fetch: vi.fn(async () => new Response("held", { status: 409 })) };

    await runRuntimeQueue(
      { queue: CANARY_QUEUE_NAME, messages: [message] },
      env,
      { database: databaseFactory, executor: () => executor },
    );

    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 300 });
    expect(message.ack).not.toHaveBeenCalled();
    expect(databaseFactory).not.toHaveBeenCalled();
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it("allows only the reviewed live-import envelope through to reservation", async () => {
    const statements: string[] = [];
    const database = fakeDatabase((statement) => {
      statements.push(statement.text);
      if (statement.text.includes("INSERT INTO public.runtime_idempotency")) return result([{ attempt: 1 }]);
      if (statement.text.includes("SET status = 'SUCCESS'")) return result([{ attempt: 1 }]);
      return result();
    });
    const executor = { execute: vi.fn(async () => ({ ok: true as const, detail: "completed" })) };
    const body = await liveCanaryEnvelope("reviewed-live-import");
    const message = { id: "cf-canary-live", attempts: 1, body, ack: vi.fn(), retry: vi.fn() };
    const env = readyEnv();
    env.ENVIRONMENT = "rescue-production";
    Object.assign(env, exclusiveCanaryBindings(body.connectionId, body));

    await runRuntimeQueue(
      { queue: CANARY_QUEUE_NAME, messages: [message] },
      env,
      dependencies(database, executor),
    );

    expect(executor.execute).toHaveBeenCalledOnce();
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(statements.some((statement) => statement.includes("runtime_idempotency"))).toBe(true);
  });

  it("fails closed without database access when the canary id is a placeholder", async () => {
    const body = await queueEnvelope("placeholder-canary");
    const message = { id: "cf-placeholder", attempts: 1, body, ack: vi.fn(), retry: vi.fn() };
    const databaseFactory = vi.fn(() => fakeDatabase(() => result()));
    const env = readyEnv();
    Object.assign(env, exclusiveCanaryBindings("00000000-0000-4000-8000-000000000000"));

    await runRuntimeQueue(
      { queue: CANARY_QUEUE_NAME, messages: [message] },
      env,
      { database: databaseFactory, executor: () => successfulExecutor },
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

  it("persists the DLQ handoff before the final platform retry", async () => {
    const statements: Array<{ text: string; values: readonly unknown[] }> = [];
    const database = fakeDatabase((statement) => {
      statements.push(statement);
      if (statement.text.includes("INSERT INTO public.runtime_idempotency")) return result([{ attempt: 3 }]);
      if (statement.text.includes("SET status = 'RETRY'")) return result([{ attempt: 3 }]);
      return result();
    });
    const executor = { execute: vi.fn(async () => ({
      ok: false as const,
      failure: { httpStatus: 503 },
    })) };
    const body = await queueEnvelope("dlq-handoff");
    body.maxAttempts = 3;
    const message = { id: "cf-dlq", attempts: 3, body, ack: vi.fn(), retry: vi.fn() };

    await runRuntimeQueue(
      { queue: "winerim-staging-sales", messages: [message] },
      readyEnv(),
      dependencies(database, executor),
    );

    expect(message.retry).toHaveBeenCalledWith();
    expect(message.ack).not.toHaveBeenCalled();
    expect(statements.some((statement) => statement.text.includes("SET status = 'RETRY'"))).toBe(true);
    expect(statements.some((statement) => statement.values.some((value) =>
      typeof value === "string" && value.includes("dead_letter_pending")
    ))).toBe(true);
    expect(statements.some((statement) => statement.values.includes("BLOCKED"))).toBe(true);
  });
});
