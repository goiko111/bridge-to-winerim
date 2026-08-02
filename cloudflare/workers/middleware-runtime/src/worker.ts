import { Client } from "pg";

import {
  createHyperdrivePostgresAdapter,
  sql,
  type DatabaseAdapter,
  type DatabaseTransaction,
  type DriverQueryConfig,
  type HyperdriveBinding,
  type PostgresClientFactory,
} from "../../middleware-api/src/db";
import type { RuntimeEnvelopeV1, RuntimeLane } from "./contracts";
import {
  consumeRuntimeQueueBatch,
  type CloudflareMessageBatchLike,
  type RuntimeExecutionResult,
  type RuntimeQueueHooks,
} from "./queue";
import {
  buildScheduledRuntimeMessages,
  DEFAULT_RUNTIME_SCHEDULER_PLAN,
  type RuntimeScheduledConnection,
} from "./scheduler";

const STAGING_ENVIRONMENT = "staging";
const EXECUTION_ENABLED = "true";
const FAIL_CLOSED_RETRY_SECONDS = 300;
const IDEMPOTENCY_LEASE_MINUTES = 2;
const EXECUTOR_TIMEOUT_MS = 15_000;

export type RuntimeQueueSendMessage = {
  body: RuntimeEnvelopeV1;
  delaySeconds?: number;
};

export interface RuntimeQueueProducer {
  sendBatch(messages: RuntimeQueueSendMessage[]): Promise<void>;
}

export interface RuntimeExecutorServiceBinding {
  fetch(request: Request): Promise<Response>;
}

export interface RuntimeExecutor {
  execute(envelope: RuntimeEnvelopeV1): Promise<RuntimeExecutionResult>;
}

export interface MiddlewareRuntimeEnv {
  ENVIRONMENT?: string;
  RELEASE?: string;
  RUNTIME_EXECUTION_ENABLED?: string;
  MIDDLEWARE_DB?: HyperdriveBinding;
  RUNTIME_EXECUTOR?: RuntimeExecutorServiceBinding;
  MIDDLEWARE_CATALOG_QUEUE?: RuntimeQueueProducer;
  MIDDLEWARE_SALES_STOCK_QUEUE?: RuntimeQueueProducer;
  MIDDLEWARE_SALES_IMPORT_QUEUE?: RuntimeQueueProducer;
  MIDDLEWARE_STOCK_SYNC_QUEUE?: RuntimeQueueProducer;
  MIDDLEWARE_OUTBOUND_QUEUE?: RuntimeQueueProducer;
  MIDDLEWARE_MAINTENANCE_QUEUE?: RuntimeQueueProducer;
}

export interface ScheduledControllerLike {
  readonly cron: string;
  readonly scheduledTime: number;
}

export interface RuntimeWorkerDependencies {
  database?: (env: MiddlewareRuntimeEnv) => DatabaseAdapter;
  executor?: (env: MiddlewareRuntimeEnv) => RuntimeExecutor | null;
}

export type RuntimeScheduleDispatchResult = {
  status: "dispatched" | "inactive";
  reason?: "NOT_STAGING" | "RUNTIME_EXECUTOR_NOT_READY" | "RUNTIME_BINDINGS_INCOMPLETE";
  connections: number;
  messages: number;
};

interface ScheduledConnectionRow extends Record<string, unknown> {
  connection_id: string;
  enabled: boolean;
  circuit_breaker_paused_until: string | null;
  intraday_sales_sync_enabled: boolean;
  open_tickets_sync_enabled: boolean;
}

interface RuntimeReservationRow extends Record<string, unknown> {
  status: "RUNNING" | "SUCCESS" | "RETRY" | "TERMINAL";
  attempt: number;
  lease_expired: boolean | null;
}

interface RuntimeAttemptRow extends Record<string, unknown> {
  attempt: number;
}

interface RuntimeReadinessRow extends Record<string, unknown> {
  environment: string | null;
  runtime_idempotency_ready: boolean;
  runtime_execution_log_ready: boolean;
}

const createPostgresClient: PostgresClientFactory = ({ connectionString, applicationName }) => {
  const client = new Client({ connectionString, application_name: applicationName });
  return {
    connect: () => client.connect(),
    query: async <Row extends Record<string, unknown>>(query: string | DriverQueryConfig) => {
      const result = await client.query<Row>(query);
      return { rows: result.rows, rowCount: result.rowCount };
    },
    end: () => client.end(),
  };
};

function defaultDatabase(env: MiddlewareRuntimeEnv): DatabaseAdapter {
  if (!env.MIDDLEWARE_DB) throw new Error("MIDDLEWARE_DB_NOT_CONFIGURED");
  return createHyperdrivePostgresAdapter(env.MIDDLEWARE_DB, {
    createClient: createPostgresClient,
    applicationName: "winerim-middleware-runtime-staging",
  });
}

function safeExecutorMessage(value: unknown): string {
  const normalized = String(value || "RUNTIME_EXECUTOR_FAILED").trim();
  return /^[A-Z][A-Z0-9_]{0,79}$/.test(normalized)
    ? normalized
    : "RUNTIME_EXECUTOR_FAILED";
}

function safeExecutorDetail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  return /^(catalog|sales|stock|outbound):[A-Za-z0-9_.:-]{1,140}$/.test(normalized)
    ? normalized
    : undefined;
}

function defaultExecutor(env: MiddlewareRuntimeEnv): RuntimeExecutor | null {
  const binding = env.RUNTIME_EXECUTOR;
  if (!binding) return null;
  return {
    async execute(envelope): Promise<RuntimeExecutionResult> {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), EXECUTOR_TIMEOUT_MS);
      let response: Response;
      let payload: {
        ok?: unknown;
        detail?: unknown;
        failure?: { httpStatus?: unknown; message?: unknown; retryableLine?: unknown };
      };
      try {
        response = await binding.fetch(new Request("https://runtime-executor.internal/v1/execute", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ envelope }),
          signal: controller.signal,
        }));
        payload = await response.json().catch(() => ({}));
      } catch {
        return {
          ok: false,
          failure: { httpStatus: 503, message: "RUNTIME_EXECUTOR_UNAVAILABLE" },
        };
      } finally {
        clearTimeout(timeout);
      }

      if (response.ok && payload.ok === true) {
        return { ok: true, detail: safeExecutorDetail(payload.detail) };
      }
      const declaredStatus = payload.failure?.httpStatus;
      const httpStatus = typeof declaredStatus === "number"
          && Number.isInteger(declaredStatus)
          && declaredStatus >= 400
          && declaredStatus <= 599
        ? declaredStatus
        : response.status >= 400 && response.status <= 599
        ? response.status
        : 503;
      return {
        ok: false,
        failure: {
          httpStatus,
          message: safeExecutorMessage(payload.failure?.message),
          retryableLine: payload.failure?.retryableLine === true,
        },
      };
    },
  };
}

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function isStaging(env: MiddlewareRuntimeEnv): boolean {
  return env.ENVIRONMENT?.trim().toLowerCase() === STAGING_ENVIRONMENT;
}

function executionGateOpen(env: MiddlewareRuntimeEnv, executor: RuntimeExecutor | null): boolean {
  return isStaging(env)
    && env.RUNTIME_EXECUTION_ENABLED?.trim().toLowerCase() === EXECUTION_ENABLED
    && executor !== null;
}

function queueBindings(env: MiddlewareRuntimeEnv): Record<string, RuntimeQueueProducer | undefined> {
  return {
    MIDDLEWARE_CATALOG_QUEUE: env.MIDDLEWARE_CATALOG_QUEUE,
    MIDDLEWARE_SALES_STOCK_QUEUE: env.MIDDLEWARE_SALES_STOCK_QUEUE,
    MIDDLEWARE_SALES_IMPORT_QUEUE: env.MIDDLEWARE_SALES_IMPORT_QUEUE,
    MIDDLEWARE_STOCK_SYNC_QUEUE: env.MIDDLEWARE_STOCK_SYNC_QUEUE,
    MIDDLEWARE_OUTBOUND_QUEUE: env.MIDDLEWARE_OUTBOUND_QUEUE,
    MIDDLEWARE_MAINTENANCE_QUEUE: env.MIDDLEWARE_MAINTENANCE_QUEUE,
  };
}

function missingBindingNames(env: MiddlewareRuntimeEnv, executor?: RuntimeExecutor | null): string[] {
  const missing = Object.entries(queueBindings(env))
    .filter(([, binding]) => !binding)
    .map(([name]) => name);
  if (!env.MIDDLEWARE_DB) missing.push("MIDDLEWARE_DB");
  if (!env.RUNTIME_EXECUTOR && !executor) missing.push("RUNTIME_EXECUTOR");
  return missing.sort();
}

function queueForLane(env: MiddlewareRuntimeEnv, lane: RuntimeLane): RuntimeQueueProducer | undefined {
  switch (lane) {
    case "catalog":
      return env.MIDDLEWARE_CATALOG_QUEUE;
    case "sales-stock":
      return env.MIDDLEWARE_SALES_STOCK_QUEUE;
    case "sales-import":
      return env.MIDDLEWARE_SALES_IMPORT_QUEUE;
    case "stock-sync":
      return env.MIDDLEWARE_STOCK_SYNC_QUEUE;
    case "outbound-queue":
      return env.MIDDLEWARE_OUTBOUND_QUEUE;
    case "maintenance":
      return env.MIDDLEWARE_MAINTENANCE_QUEUE;
  }
}

function splitBatches<T>(values: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    batches.push(values.slice(index, index + size));
  }
  return batches;
}

function retryBatchFailClosed(batch: CloudflareMessageBatchLike): void {
  for (const message of batch.messages) {
    message.retry({ delaySeconds: FAIL_CLOSED_RETRY_SECONDS });
  }
}

async function insertExecutionLog(
  transaction: DatabaseTransaction,
  envelope: RuntimeEnvelopeV1,
  outcome: "SUCCESS" | "RETRY" | "TERMINAL" | "DUPLICATE" | "BLOCKED",
  attempt: number,
  options: { errorClass?: string | null; detail?: Record<string, unknown> | null } = {},
): Promise<void> {
  await transaction.query(sql`
    INSERT INTO public.runtime_execution_log (
      message_id, idempotency_key, connection_id, job, outcome, attempt,
      error_class, detail
    ) VALUES (
      ${envelope.messageId}, ${envelope.idempotencyKey}, ${envelope.connectionId},
      ${envelope.job}, ${outcome}, ${attempt}, ${options.errorClass ?? null},
      ${JSON.stringify(options.detail ?? {})}::jsonb
    )
  `);
}

export function createPersistentRuntimeQueueHooks(
  database: DatabaseAdapter,
  executor: RuntimeExecutor,
): RuntimeQueueHooks {
  return {
    async reserve(envelope) {
      return database.transaction(async (transaction) => {
        const inserted = await transaction.query<RuntimeAttemptRow>(sql`
          INSERT INTO public.runtime_idempotency (
            idempotency_key, message_id, connection_id, job, status, attempt,
            lease_expires_at, result
          ) VALUES (
            ${envelope.idempotencyKey}, ${envelope.messageId}, ${envelope.connectionId},
            ${envelope.job}, 'RUNNING', 1,
            now() + (${IDEMPOTENCY_LEASE_MINUTES} * interval '1 minute'),
            ${JSON.stringify({ state: "reserved" })}::jsonb
          )
          ON CONFLICT (idempotency_key) DO NOTHING
          RETURNING attempt
        `);
        if (inserted.rowCount === 1) return "acquired" as const;

        const current = await transaction.query<RuntimeReservationRow>(sql`
          SELECT status, attempt,
            CASE WHEN lease_expires_at IS NULL THEN NULL ELSE lease_expires_at <= now() END AS lease_expired
          FROM public.runtime_idempotency
          WHERE idempotency_key = ${envelope.idempotencyKey}
          FOR UPDATE
        `);
        const reservation = current.rows[0];
        if (!reservation) return "busy" as const;

        if (reservation.status === "SUCCESS" || reservation.status === "TERMINAL") {
          await insertExecutionLog(transaction, envelope, "DUPLICATE", reservation.attempt, {
            detail: { reason: `already_${reservation.status.toLowerCase()}` },
          });
          return "duplicate" as const;
        }

        const canAcquire = reservation.status === "RETRY"
          || (reservation.status === "RUNNING" && reservation.lease_expired === true);
        if (!canAcquire) {
          await insertExecutionLog(transaction, envelope, "BLOCKED", reservation.attempt, {
            detail: { reason: "lease_active" },
          });
          return "busy" as const;
        }

        const reacquired = await transaction.query<RuntimeAttemptRow>(sql`
          UPDATE public.runtime_idempotency
          SET status = 'RUNNING', attempt = attempt + 1,
            lease_expires_at = now() + (${IDEMPOTENCY_LEASE_MINUTES} * interval '1 minute'),
            result = ${JSON.stringify({ state: "reserved" })}::jsonb,
            updated_at = now()
          WHERE idempotency_key = ${envelope.idempotencyKey}
            AND (
              status = 'RETRY'
              OR (status = 'RUNNING' AND lease_expires_at <= now())
            )
          RETURNING attempt
        `);
        return reacquired.rowCount === 1 ? "acquired" as const : "busy" as const;
      }, { isolationLevel: "serializable" });
    },

    execute(envelope) {
      return executor.execute(envelope);
    },

    async complete(envelope, result) {
      await database.transaction(async (transaction) => {
        const completed = await transaction.query<RuntimeAttemptRow>(sql`
          UPDATE public.runtime_idempotency
          SET status = 'SUCCESS', lease_expires_at = NULL,
            result = ${JSON.stringify({ detail: safeExecutorDetail(result.detail), state: "completed" })}::jsonb,
            updated_at = now()
          WHERE idempotency_key = ${envelope.idempotencyKey} AND status = 'RUNNING'
          RETURNING attempt
        `);
        const row = completed.rows[0];
        if (!row) throw new Error("RUNTIME_RESERVATION_LOST");
        await insertExecutionLog(transaction, envelope, "SUCCESS", row.attempt, {
          detail: { state: "completed" },
        });
      }, { isolationLevel: "serializable" });
    },

    async releaseForRetry(envelope, disposition) {
      await database.transaction(async (transaction) => {
        const released = await transaction.query<RuntimeAttemptRow>(sql`
          UPDATE public.runtime_idempotency
          SET status = 'RETRY', lease_expires_at = NULL,
            result = ${JSON.stringify({
              delaySeconds: disposition.delaySeconds,
              errorClass: disposition.failure.class,
              reason: disposition.failure.reason,
              state: "retry",
            })}::jsonb,
            updated_at = now()
          WHERE idempotency_key = ${envelope.idempotencyKey} AND status = 'RUNNING'
          RETURNING attempt
        `);
        const row = released.rows[0];
        if (!row) throw new Error("RUNTIME_RESERVATION_LOST");
        await insertExecutionLog(transaction, envelope, "RETRY", row.attempt, {
          errorClass: disposition.failure.class,
          detail: { delaySeconds: disposition.delaySeconds, reason: disposition.failure.reason },
        });
      }, { isolationLevel: "serializable" });
    },

    async recordTerminal(envelope, input) {
      if (!envelope) return;
      await database.transaction(async (transaction) => {
        const terminal = await transaction.query<RuntimeAttemptRow>(sql`
          UPDATE public.runtime_idempotency
          SET status = 'TERMINAL', lease_expires_at = NULL,
            result = ${JSON.stringify({ reason: input.reason, state: "terminal" })}::jsonb,
            updated_at = now()
          WHERE idempotency_key = ${envelope.idempotencyKey} AND status = 'RUNNING'
          RETURNING attempt
        `);
        const row = terminal.rows[0];
        if (!row) throw new Error("RUNTIME_RESERVATION_LOST");
        await insertExecutionLog(transaction, envelope, "TERMINAL", row.attempt, {
          errorClass: input.disposition?.failure.class ?? null,
          detail: { reason: input.reason },
        });
      }, { isolationLevel: "serializable" });
    },
  };
}

async function loadScheduledConnections(database: DatabaseAdapter): Promise<RuntimeScheduledConnection[]> {
  const result = await database.query<ScheduledConnectionRow>(sql`
    SELECT
      id::text AS connection_id,
      enabled,
      circuit_breaker_paused_until,
      lower(coalesce(provider_config->>'intraday_sales_sync_enabled', 'false')) IN ('true', '1', 'yes')
        AS intraday_sales_sync_enabled,
      lower(coalesce(provider_config->>'open_tickets_sync_enabled', 'false')) IN ('true', '1', 'yes')
        AS open_tickets_sync_enabled
    FROM public.pos_connections
    WHERE provider = 'agora' AND enabled = true
    ORDER BY id
  `);
  return result.rows.map((row) => ({
    connectionId: row.connection_id,
    enabled: row.enabled,
    breakerPausedUntil: row.circuit_breaker_paused_until,
    intradaySalesSyncEnabled: row.intraday_sales_sync_enabled,
    openTicketsSyncEnabled: row.open_tickets_sync_enabled,
  }));
}

export async function runRuntimeScheduled(
  controller: ScheduledControllerLike,
  env: MiddlewareRuntimeEnv,
  dependencies: Required<RuntimeWorkerDependencies>,
): Promise<RuntimeScheduleDispatchResult> {
  if (!isStaging(env)) {
    return { status: "inactive", reason: "NOT_STAGING", connections: 0, messages: 0 };
  }
  const executor = dependencies.executor(env);
  if (!executionGateOpen(env, executor)) {
    return { status: "inactive", reason: "RUNTIME_EXECUTOR_NOT_READY", connections: 0, messages: 0 };
  }
  if (missingBindingNames(env, executor).length > 0) {
    return { status: "inactive", reason: "RUNTIME_BINDINGS_INCOMPLETE", connections: 0, messages: 0 };
  }

  const connections = await loadScheduledConnections(dependencies.database(env));
  const messages = await buildScheduledRuntimeMessages({
    cron: controller.cron,
    scheduledTimeMs: controller.scheduledTime,
    connections,
  });
  const messagesByLane = new Map<RuntimeLane, RuntimeQueueSendMessage[]>();
  for (const message of messages) {
    const laneMessages = messagesByLane.get(message.envelope.lane) ?? [];
    laneMessages.push({ body: message.envelope, delaySeconds: message.delaySeconds });
    messagesByLane.set(message.envelope.lane, laneMessages);
  }

  for (const [lane, laneMessages] of messagesByLane) {
    const queue = queueForLane(env, lane);
    if (!queue) throw new Error("RUNTIME_QUEUE_BINDING_MISSING");
    for (const batch of splitBatches(laneMessages, DEFAULT_RUNTIME_SCHEDULER_PLAN.batchSize)) {
      await queue.sendBatch(batch);
    }
  }
  return { status: "dispatched", connections: connections.length, messages: messages.length };
}

export async function runRuntimeQueue(
  batch: CloudflareMessageBatchLike,
  env: MiddlewareRuntimeEnv,
  dependencies: Required<RuntimeWorkerDependencies>,
): Promise<void> {
  const executor = dependencies.executor(env);
  if (!executionGateOpen(env, executor) || !env.MIDDLEWARE_DB) {
    retryBatchFailClosed(batch);
    return;
  }
  await consumeRuntimeQueueBatch(
    batch,
    createPersistentRuntimeQueueHooks(dependencies.database(env), executor),
  );
}

async function readiness(
  env: MiddlewareRuntimeEnv,
  dependencies: Required<RuntimeWorkerDependencies>,
): Promise<Response> {
  const executor = dependencies.executor(env);
  const missingBindings = missingBindingNames(env, executor);
  const executionEnabled = env.RUNTIME_EXECUTION_ENABLED?.trim().toLowerCase() === EXECUTION_ENABLED;
  if (!isStaging(env) || !env.MIDDLEWARE_DB) {
    return json({
      ok: false,
      environment: env.ENVIRONMENT ?? null,
      release: env.RELEASE ?? null,
      stagingOnly: true,
      executionEnabled,
      executorBound: executor !== null,
      missingBindings,
      reason: !isStaging(env) ? "NOT_STAGING" : "DATABASE_BINDING_MISSING",
    }, 503);
  }

  try {
    const result = await dependencies.database(env).query<RuntimeReadinessRow>(sql`
      SELECT
        (SELECT value FROM public.infrastructure_metadata WHERE key = 'environment') AS environment,
        to_regclass('public.runtime_idempotency') IS NOT NULL AS runtime_idempotency_ready,
        to_regclass('public.runtime_execution_log') IS NOT NULL AS runtime_execution_log_ready
    `);
    const row = result.rows[0];
    const schemaReady = row?.environment === STAGING_ENVIRONMENT
      && row.runtime_idempotency_ready === true
      && row.runtime_execution_log_ready === true;
    const ready = schemaReady && missingBindings.length === 0 && executionEnabled && executor !== null;
    return json({
      ok: ready,
      environment: env.ENVIRONMENT ?? null,
      release: env.RELEASE ?? null,
      stagingOnly: true,
      executionEnabled,
      executorBound: executor !== null,
      missingBindings,
      database: schemaReady ? "ready" : "schema_not_ready",
      reason: ready ? null : "RUNTIME_NOT_READY",
    }, ready ? 200 : 503);
  } catch {
    return json({
      ok: false,
      environment: env.ENVIRONMENT ?? null,
      release: env.RELEASE ?? null,
      stagingOnly: true,
      executionEnabled,
      executorBound: executor !== null,
      missingBindings,
      database: "unavailable",
      reason: "DATABASE_NOT_READY",
    }, 503);
  }
}

function normalizedDependencies(
  dependencies: RuntimeWorkerDependencies,
): Required<RuntimeWorkerDependencies> {
  return {
    database: dependencies.database ?? defaultDatabase,
    executor: dependencies.executor ?? defaultExecutor,
  };
}

export function createMiddlewareRuntimeWorker(dependencies: RuntimeWorkerDependencies = {}) {
  const resolved = normalizedDependencies(dependencies);
  return {
    async fetch(request: Request, env: MiddlewareRuntimeEnv): Promise<Response> {
      if (request.method !== "GET") return json({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405);
      const path = new URL(request.url).pathname;
      if (path === "/health") {
        const executionEnabled = env.RUNTIME_EXECUTION_ENABLED?.trim().toLowerCase() === EXECUTION_ENABLED;
        return json({
          ok: true,
          service: "winerim-middleware-runtime",
          environment: env.ENVIRONMENT ?? null,
          release: env.RELEASE ?? null,
          stagingOnly: true,
          executionEnabled,
          externalWrites: executionEnabled,
        });
      }
      if (path === "/ready") return readiness(env, resolved);
      return json({ ok: false, error: "NOT_FOUND" }, 404);
    },

    async scheduled(controller: ScheduledControllerLike, env: MiddlewareRuntimeEnv): Promise<void> {
      await runRuntimeScheduled(controller, env, resolved);
    },

    async queue(batch: CloudflareMessageBatchLike, env: MiddlewareRuntimeEnv): Promise<void> {
      await runRuntimeQueue(batch, env, resolved);
    },
  };
}

export default createMiddlewareRuntimeWorker();
