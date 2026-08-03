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
import {
  isDeployableRuntimeCanaryConnectionId,
  type RuntimeEnvelopeV1,
  type RuntimeLane,
} from "./contracts";
import {
  consumeRuntimeQueueBatch,
  type CloudflareMessageBatchLike,
  type RuntimeExecutionResult,
  type RuntimeQueueHooks,
} from "./queue";
import { canonicalJson, sha256Hex } from "./idempotency";
import {
  buildScheduledRuntimeMessages,
  DEFAULT_RUNTIME_SCHEDULER_PLAN,
  type RuntimeScheduledConnection,
} from "./scheduler";
import {
  guardExclusiveCanaryBatch,
  type ExclusiveCanaryScope,
} from "../../../canary-failclosed/src/exclusiveScope";
import {
  acquireExclusiveWriterFence,
  type WriterFenceClientEnvironment,
} from "../../../canary-failclosed/src/writerFence";

const STAGING_ENVIRONMENT = "staging";
const RESCUE_PRODUCTION_ENVIRONMENT = "rescue-production";
const EXECUTION_ENABLED = "true";
const FAIL_CLOSED_RETRY_SECONDS = 300;
const IDEMPOTENCY_LEASE_MINUTES = 2;
const EXECUTOR_TIMEOUT_MS = 15_000;
const LEGACY_CANARY_CONSUMER_MODE = "canary-consumer";
const EXCLUSIVE_CANARY_CONSUMER_MODE = "exclusive-canary-consumer";
const CANARY_RUNTIME_JOB = "winerim.sales-import-live";
const CANARY_RUNTIME_LANE = "sales-import";
const CANARY_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

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

export interface MiddlewareRuntimeEnv extends WriterFenceClientEnvironment {
  ENVIRONMENT?: string;
  RELEASE?: string;
  RUNTIME_EXECUTION_ENABLED?: string;
  RUNTIME_MODE?: string;
  RUNTIME_CANARY_CONNECTION_ID?: string;
  CANARY_RUN_ID?: string;
  CANARY_EXCLUSIVE_QUEUE_NAME?: string;
  CANARY_MESSAGE_ID?: string;
  CANARY_IDEMPOTENCY_KEY?: string;
  CANARY_PAYLOAD_SHA256?: string;
  WRITER_FENCE_HOLDER_ID?: string;
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
  message_id: string;
  connection_id: string;
  job: string;
  payload_sha256: string | null;
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
  runtime_canary_scope_ready: boolean;
  runtime_credentials_ready: boolean;
}

function isCanaryConsumer(env: MiddlewareRuntimeEnv): boolean {
  const mode = env.RUNTIME_MODE?.trim().toLowerCase();
  return mode === LEGACY_CANARY_CONSUMER_MODE || mode === EXCLUSIVE_CANARY_CONSUMER_MODE;
}

function isExclusiveCanaryConsumer(env: MiddlewareRuntimeEnv): boolean {
  return env.RUNTIME_MODE?.trim().toLowerCase() === EXCLUSIVE_CANARY_CONSUMER_MODE;
}

function canaryConnectionId(env: MiddlewareRuntimeEnv): string | null {
  const value = String(env.RUNTIME_CANARY_CONNECTION_ID ?? "").trim();
  return isDeployableRuntimeCanaryConnectionId(value) ? value : null;
}

function canaryIdentifier(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return CANARY_IDENTIFIER_PATTERN.test(normalized) ? normalized : null;
}

function exclusiveCanaryScope(env: MiddlewareRuntimeEnv): ExclusiveCanaryScope | null {
  const connectionId = canaryConnectionId(env);
  const runId = canaryIdentifier(env.CANARY_RUN_ID);
  const queueName = canaryIdentifier(env.CANARY_EXCLUSIVE_QUEUE_NAME);
  const messageId = canaryIdentifier(env.CANARY_MESSAGE_ID);
  const idempotencyKey = canaryIdentifier(env.CANARY_IDEMPOTENCY_KEY);
  const payloadSha256 = String(env.CANARY_PAYLOAD_SHA256 ?? "").trim().toLowerCase();
  if (!connectionId || !runId || !queueName || !messageId || !idempotencyKey
    || !SHA256_PATTERN.test(payloadSha256)) return null;
  return {
    queueName,
    connectionId,
    runId,
    messageId,
    idempotencyKey,
    payloadSha256,
    job: CANARY_RUNTIME_JOB,
    lane: CANARY_RUNTIME_LANE,
  };
}

function executionEnvironmentAllowed(env: MiddlewareRuntimeEnv): boolean {
  const environment = env.ENVIRONMENT?.trim().toLowerCase();
  if (environment === STAGING_ENVIRONMENT) {
    return env.RUNTIME_MODE?.trim().toLowerCase() !== LEGACY_CANARY_CONSUMER_MODE;
  }
  return environment === RESCUE_PRODUCTION_ENVIRONMENT && isExclusiveCanaryConsumer(env);
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
  return executionEnvironmentAllowed(env)
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
  const missing = isCanaryConsumer(env)
    ? []
    : Object.entries(queueBindings(env))
      .filter(([, binding]) => !binding)
      .map(([name]) => name);
  if (!env.MIDDLEWARE_DB) missing.push("MIDDLEWARE_DB");
  if (!env.RUNTIME_EXECUTOR && !executor) missing.push("RUNTIME_EXECUTOR");
  if (isCanaryConsumer(env) && !canaryConnectionId(env)) {
    missing.push("RUNTIME_CANARY_CONNECTION_ID");
  }
  if (isCanaryConsumer(env) && !isExclusiveCanaryConsumer(env)) {
    missing.push("RUNTIME_MODE_EXCLUSIVE_CANARY_REQUIRED");
  }
  if (isExclusiveCanaryConsumer(env)) {
    if (!canaryIdentifier(env.CANARY_RUN_ID)) missing.push("CANARY_RUN_ID");
    if (!canaryIdentifier(env.CANARY_EXCLUSIVE_QUEUE_NAME)) {
      missing.push("CANARY_EXCLUSIVE_QUEUE_NAME");
    }
    if (!canaryIdentifier(env.CANARY_MESSAGE_ID)) missing.push("CANARY_MESSAGE_ID");
    if (!canaryIdentifier(env.CANARY_IDEMPOTENCY_KEY)) missing.push("CANARY_IDEMPOTENCY_KEY");
    if (!SHA256_PATTERN.test(String(env.CANARY_PAYLOAD_SHA256 ?? "").trim().toLowerCase())) {
      missing.push("CANARY_PAYLOAD_SHA256");
    }
    if (!canaryIdentifier(env.WRITER_FENCE_HOLDER_ID)) missing.push("WRITER_FENCE_HOLDER_ID");
    if (!env.WRITER_FENCE || typeof env.WRITER_FENCE.fetch !== "function") {
      missing.push("WRITER_FENCE");
    }
    if (!env.CANARY_WRITER_FENCE_PROOF
      || typeof env.CANARY_WRITER_FENCE_PROOF.get !== "function") {
      missing.push("CANARY_WRITER_FENCE_PROOF");
    }
  }
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
  const leases = new WeakMap<RuntimeEnvelopeV1, Readonly<{
    token: string;
    payloadSha256: string;
  }>>();

  const acquiredLease = (envelope: RuntimeEnvelopeV1) => {
    const lease = leases.get(envelope);
    if (!lease) throw new Error("RUNTIME_RESERVATION_LOST");
    return lease;
  };

  const matchesReservationIdentity = (
    reservation: RuntimeReservationRow,
    envelope: RuntimeEnvelopeV1,
    payloadSha256: string,
  ) => reservation.message_id === envelope.messageId
    && reservation.connection_id === envelope.connectionId
    && reservation.job === envelope.job
    && reservation.payload_sha256 === payloadSha256;

  return {
    async reserve(envelope) {
      const payloadSha256 = await sha256Hex(canonicalJson(envelope.payload));
      const leaseToken = crypto.randomUUID();
      return database.transaction(async (transaction) => {
        const inserted = await transaction.query<RuntimeAttemptRow>(sql`
          INSERT INTO public.runtime_idempotency (
            idempotency_key, message_id, connection_id, job, status, attempt,
            lease_expires_at, payload_sha256, lease_token, result
          ) VALUES (
            ${envelope.idempotencyKey}, ${envelope.messageId}, ${envelope.connectionId},
            ${envelope.job}, 'RUNNING', 1,
            now() + (${IDEMPOTENCY_LEASE_MINUTES} * interval '1 minute'),
            ${payloadSha256}, ${leaseToken}::uuid,
            ${JSON.stringify({ state: "reserved" })}::jsonb
          )
          ON CONFLICT (idempotency_key) DO NOTHING
          RETURNING attempt
        `);
        if (inserted.rowCount === 1) {
          leases.set(envelope, { token: leaseToken, payloadSha256 });
          return "acquired" as const;
        }

        const current = await transaction.query<RuntimeReservationRow>(sql`
          SELECT message_id, connection_id::text, job, payload_sha256, status, attempt,
            CASE WHEN lease_expires_at IS NULL THEN NULL ELSE lease_expires_at <= now() END AS lease_expired
          FROM public.runtime_idempotency
          WHERE idempotency_key = ${envelope.idempotencyKey}
          FOR UPDATE
        `);
        const reservation = current.rows[0];
        if (!reservation) return "busy" as const;

        if (!matchesReservationIdentity(reservation, envelope, payloadSha256)) {
          await insertExecutionLog(transaction, envelope, "BLOCKED", reservation.attempt, {
            detail: { reason: "idempotency_identity_mismatch" },
          });
          return "conflict" as const;
        }

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
            lease_token = ${leaseToken}::uuid,
            result = ${JSON.stringify({ state: "reserved" })}::jsonb,
            updated_at = now()
          WHERE idempotency_key = ${envelope.idempotencyKey}
            AND (
              status = 'RETRY'
              OR (status = 'RUNNING' AND lease_expires_at <= now())
            )
          RETURNING attempt
        `);
        if (reacquired.rowCount === 1) {
          leases.set(envelope, { token: leaseToken, payloadSha256 });
          return "acquired" as const;
        }
        return "busy" as const;
      }, { isolationLevel: "serializable" });
    },

    execute(envelope) {
      return executor.execute(envelope);
    },

    async complete(envelope, result) {
      const lease = acquiredLease(envelope);
      await database.transaction(async (transaction) => {
        const completed = await transaction.query<RuntimeAttemptRow>(sql`
          UPDATE public.runtime_idempotency
          SET status = 'SUCCESS', lease_expires_at = NULL,
            result = ${JSON.stringify({ detail: safeExecutorDetail(result.detail), state: "completed" })}::jsonb,
            updated_at = now()
          WHERE idempotency_key = ${envelope.idempotencyKey}
            AND message_id = ${envelope.messageId}
            AND connection_id = ${envelope.connectionId}::uuid
            AND job = ${envelope.job}
            AND payload_sha256 = ${lease.payloadSha256}
            AND lease_token = ${lease.token}::uuid
            AND status = 'RUNNING'
          RETURNING attempt
        `);
        const row = completed.rows[0];
        if (!row) throw new Error("RUNTIME_RESERVATION_LOST");
        await insertExecutionLog(transaction, envelope, "SUCCESS", row.attempt, {
          detail: { state: "completed" },
        });
      }, { isolationLevel: "serializable" });
      leases.delete(envelope);
    },

    async releaseForRetry(envelope, disposition) {
      const lease = acquiredLease(envelope);
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
          WHERE idempotency_key = ${envelope.idempotencyKey}
            AND message_id = ${envelope.messageId}
            AND connection_id = ${envelope.connectionId}::uuid
            AND job = ${envelope.job}
            AND payload_sha256 = ${lease.payloadSha256}
            AND lease_token = ${lease.token}::uuid
            AND status = 'RUNNING'
          RETURNING attempt
        `);
        const row = released.rows[0];
        if (!row) throw new Error("RUNTIME_RESERVATION_LOST");
        await insertExecutionLog(transaction, envelope, "RETRY", row.attempt, {
          errorClass: disposition.failure.class,
          detail: { delaySeconds: disposition.delaySeconds, reason: disposition.failure.reason },
        });
      }, { isolationLevel: "serializable" });
      leases.delete(envelope);
    },

    async releaseForDeadLetter(envelope, input) {
      const lease = acquiredLease(envelope);
      await database.transaction(async (transaction) => {
        const released = await transaction.query<RuntimeAttemptRow>(sql`
          UPDATE public.runtime_idempotency
          SET status = 'RETRY', lease_expires_at = NULL,
            result = ${JSON.stringify({
              errorClass: input.disposition.failure.class,
              reason: input.reason,
              state: "dead_letter_pending",
            })}::jsonb,
            updated_at = now()
          WHERE idempotency_key = ${envelope.idempotencyKey}
            AND message_id = ${envelope.messageId}
            AND connection_id = ${envelope.connectionId}::uuid
            AND job = ${envelope.job}
            AND payload_sha256 = ${lease.payloadSha256}
            AND lease_token = ${lease.token}::uuid
            AND status = 'RUNNING'
          RETURNING attempt
        `);
        const row = released.rows[0];
        if (!row) throw new Error("RUNTIME_RESERVATION_LOST");
        await insertExecutionLog(transaction, envelope, "BLOCKED", row.attempt, {
          errorClass: input.disposition.failure.class,
          detail: { reason: input.reason, state: "dead_letter_pending" },
        });
      }, { isolationLevel: "serializable" });
      leases.delete(envelope);
    },

    async recordTerminal(envelope, input) {
      if (!envelope) return;
      const lease = acquiredLease(envelope);
      await database.transaction(async (transaction) => {
        const terminal = await transaction.query<RuntimeAttemptRow>(sql`
          UPDATE public.runtime_idempotency
          SET status = 'TERMINAL', lease_expires_at = NULL,
            result = ${JSON.stringify({ reason: input.reason, state: "terminal" })}::jsonb,
            updated_at = now()
          WHERE idempotency_key = ${envelope.idempotencyKey}
            AND message_id = ${envelope.messageId}
            AND connection_id = ${envelope.connectionId}::uuid
            AND job = ${envelope.job}
            AND payload_sha256 = ${lease.payloadSha256}
            AND lease_token = ${lease.token}::uuid
            AND status = 'RUNNING'
          RETURNING attempt
        `);
        const row = terminal.rows[0];
        if (!row) throw new Error("RUNTIME_RESERVATION_LOST");
        await insertExecutionLog(transaction, envelope, "TERMINAL", row.attempt, {
          errorClass: input.disposition?.failure.class ?? null,
          detail: { reason: input.reason },
        });
      }, { isolationLevel: "serializable" });
      leases.delete(envelope);
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
  if (isCanaryConsumer(env) && !isExclusiveCanaryConsumer(env)) {
    retryBatchFailClosed(batch);
    return;
  }

  const executor = dependencies.executor(env);
  if (!executionGateOpen(env, executor) || !env.MIDDLEWARE_DB) {
    retryBatchFailClosed(batch);
    return;
  }

  let scopedBatch = batch;
  if (isExclusiveCanaryConsumer(env)) {
    const scope = exclusiveCanaryScope(env);
    const holderId = canaryIdentifier(env.WRITER_FENCE_HOLDER_ID);
    if (!scope || !holderId) {
      retryBatchFailClosed(batch);
      return;
    }
    const guarded = await guardExclusiveCanaryBatch(batch, scope);
    const fencedMessages: CloudflareMessageBatchLike["messages"][number][] = [];
    for (const message of guarded.accepted) {
      try {
        await acquireExclusiveWriterFence({
          env,
          connectionId: scope.connectionId,
          runId: scope.runId,
          holderId,
        });
        fencedMessages.push(message);
      } catch {
        message.retry({ delaySeconds: FAIL_CLOSED_RETRY_SECONDS });
      }
    }
    if (fencedMessages.length === 0) return;
    scopedBatch = { queue: batch.queue, messages: fencedMessages };
  }

  await consumeRuntimeQueueBatch(
    scopedBatch,
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
  const canaryConsumer = isCanaryConsumer(env);
  if (!executionEnvironmentAllowed(env) || !env.MIDDLEWARE_DB) {
    return json({
      ok: false,
      environment: env.ENVIRONMENT ?? null,
      release: env.RELEASE ?? null,
      stagingOnly: isStaging(env),
      executionScope: isExclusiveCanaryConsumer(env) ? "exclusive-canary" : "staging",
      executionEnabled,
      canaryConsumer,
      executorBound: executor !== null,
      missingBindings,
      reason: !executionEnvironmentAllowed(env) ? "EXECUTION_ENVIRONMENT_REJECTED" : "DATABASE_BINDING_MISSING",
    }, 503);
  }

  try {
    const reviewedConnectionId = canaryConnectionId(env);
    const reviewedRunId = canaryIdentifier(env.CANARY_RUN_ID);
    const result = await dependencies.database(env).query<RuntimeReadinessRow>(sql`
      SELECT
        (SELECT value FROM public.infrastructure_metadata WHERE key = 'environment') AS environment,
        to_regclass('public.runtime_idempotency') IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM pg_attribute
            WHERE attrelid = to_regclass('public.runtime_idempotency')
              AND attname = 'payload_sha256' AND attnum > 0 AND NOT attisdropped
          )
          AND EXISTS (
            SELECT 1 FROM pg_attribute
            WHERE attrelid = to_regclass('public.runtime_idempotency')
              AND attname = 'lease_token' AND attnum > 0 AND NOT attisdropped
          )
          AND EXISTS (
            SELECT 1 FROM pg_attribute
            WHERE attrelid = to_regclass('public.runtime_idempotency')
              AND attname = 'sales_claim_identity' AND attnum > 0 AND NOT attisdropped
          )
          AND EXISTS (
            SELECT 1
            FROM pg_index index_contract
            JOIN pg_class index_class ON index_class.oid = index_contract.indexrelid
            JOIN pg_namespace index_namespace ON index_namespace.oid = index_class.relnamespace
            JOIN pg_class table_class ON table_class.oid = index_contract.indrelid
            JOIN pg_attribute identity_column
              ON identity_column.attrelid = table_class.oid
              AND identity_column.attname = 'sales_claim_identity'
              AND identity_column.attnum > 0
              AND NOT identity_column.attisdropped
            WHERE index_namespace.nspname = 'public'
              AND table_class.relname = 'runtime_idempotency'
              AND index_class.relname = 'uq_runtime_sales_claim_identity'
              AND index_contract.indisunique
              AND index_contract.indisvalid
              AND index_contract.indisready
              AND index_contract.indnkeyatts = 1
              AND index_contract.indnatts = 1
              AND index_contract.indkey::text = identity_column.attnum::text
              AND pg_get_expr(index_contract.indpred, index_contract.indrelid)
                = '((job = ''sales.claim''::text) AND (sales_claim_identity IS NOT NULL))'
          )
          AND EXISTS (
            SELECT 1
            FROM pg_constraint constraint_contract
            WHERE constraint_contract.conrelid = 'public.runtime_idempotency'::regclass
              AND constraint_contract.conname = 'runtime_idempotency_sales_claim_identity_scope'
              AND constraint_contract.contype = 'c'
              AND constraint_contract.convalidated
              AND pg_get_constraintdef(constraint_contract.oid)
                = 'CHECK (((job = ''sales.claim''::text) OR (sales_claim_identity IS NULL)))'
          )
          AND EXISTS (
            SELECT 1
            FROM pg_trigger trigger_contract
            JOIN pg_class table_class ON table_class.oid = trigger_contract.tgrelid
            JOIN pg_namespace table_namespace ON table_namespace.oid = table_class.relnamespace
            JOIN pg_proc trigger_function ON trigger_function.oid = trigger_contract.tgfoid
            JOIN pg_namespace function_namespace ON function_namespace.oid = trigger_function.pronamespace
            WHERE table_namespace.nspname = 'public'
              AND table_class.relname = 'runtime_idempotency'
              AND trigger_contract.tgname = 'runtime_bind_sales_claim_identity'
              AND NOT trigger_contract.tgisinternal
              AND trigger_contract.tgenabled IN ('O', 'A')
              AND trigger_contract.tgtype = 23
              AND function_namespace.nspname = 'public'
              AND trigger_function.proname = 'runtime_bind_sales_claim_identity'
              AND position('RUNTIME_SALES_CLAIM_IDENTITY_IMMUTABLE' IN trigger_function.prosrc) > 0
              AND position('NEW.sales_claim_identity := derived_identity' IN trigger_function.prosrc) > 0
              AND (
                SELECT count(*)
                FROM unnest(trigger_contract.tgattr) trigger_attribute(attnum)
              ) = 4
              AND (
                SELECT count(DISTINCT table_attribute.attname)
                FROM unnest(trigger_contract.tgattr) trigger_attribute(attnum)
                JOIN pg_attribute table_attribute
                  ON table_attribute.attrelid = table_class.oid
                  AND table_attribute.attnum = trigger_attribute.attnum
                WHERE table_attribute.attname IN ('connection_id', 'job', 'result', 'sales_claim_identity')
              ) = 4
          )
          AND NOT has_table_privilege('middleware_runtime', 'public.runtime_idempotency', 'UPDATE')
          AND NOT has_column_privilege(
            'middleware_runtime',
            'public.runtime_idempotency',
            'sales_claim_identity',
            'UPDATE'
          )
          AND (
            SELECT count(*) = 8
              AND count(DISTINCT column_name) = 8
              AND array_agg(column_name::text ORDER BY column_name) = ARRAY[
                'attempt', 'lease_expires_at', 'lease_token', 'message_id',
                'payload_sha256', 'result', 'status', 'updated_at'
              ]::text[]
            FROM information_schema.column_privileges
            WHERE table_schema = 'public'
              AND table_name = 'runtime_idempotency'
              AND grantee = 'middleware_runtime'
              AND privilege_type = 'UPDATE'
          )
          AND NOT EXISTS (
            SELECT 1
            FROM information_schema.table_privileges
            WHERE table_schema = 'public'
              AND table_name = 'runtime_idempotency'
              AND grantee = 'middleware_runtime_login'
              AND privilege_type = 'UPDATE'
          )
          AND NOT EXISTS (
            SELECT 1
            FROM information_schema.column_privileges
            WHERE table_schema = 'public'
              AND table_name = 'runtime_idempotency'
              AND grantee = 'middleware_runtime_login'
              AND privilege_type = 'UPDATE'
          ) AS runtime_idempotency_ready,
        to_regclass('public.runtime_execution_log') IS NOT NULL AS runtime_execution_log_ready,
        CASE
          WHEN ${canaryConsumer} = false THEN true
          WHEN ${reviewedConnectionId}::uuid IS NULL OR ${reviewedRunId}::text IS NULL THEN false
          ELSE (
            SELECT count(*) = 1
            FROM public.runtime_canary_connections scope
            WHERE scope.connection_id = ${reviewedConnectionId}::uuid
              AND scope.run_id = ${reviewedRunId}
              AND scope.status = 'ACTIVE'
              AND scope.active = true
              AND scope.approved_at IS NOT NULL
              AND scope.approved_at <= now()
              AND scope.expires_at IS NOT NULL
              AND scope.expires_at > now()
          )
        END AS runtime_canary_scope_ready
        ,CASE
          WHEN ${canaryConsumer} = false THEN true
          WHEN ${reviewedConnectionId}::uuid IS NULL OR ${reviewedRunId}::text IS NULL THEN false
          ELSE (
            SELECT count(*) = 2
              AND count(DISTINCT credentials.credential_kind) = 2
              AND bool_and(credentials.provider = 'agora')
            FROM public.runtime_connection_credentials credentials
            JOIN public.runtime_canary_connections scope
              ON scope.connection_id = credentials.connection_id
             AND scope.run_id = credentials.run_id
            WHERE credentials.connection_id = ${reviewedConnectionId}::uuid
              AND credentials.run_id = ${reviewedRunId}
              AND credentials.active = true
              AND credentials.credential_kind IN ('agora', 'winerim')
              AND scope.status = 'ACTIVE'
              AND scope.active = true
              AND scope.approved_at <= now()
              AND scope.expires_at > now()
          )
        END AS runtime_credentials_ready
    `);
    const row = result.rows[0];
    const schemaReady = row?.environment === env.ENVIRONMENT?.trim().toLowerCase()
      && row.runtime_idempotency_ready === true
      && row.runtime_execution_log_ready === true
      && row.runtime_canary_scope_ready === true
      && row.runtime_credentials_ready === true;
    let executorReadinessReady = !canaryConsumer;
    if (canaryConsumer && schemaReady && missingBindings.length === 0 && env.RUNTIME_EXECUTOR) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);
      try {
        const executorResponse = await env.RUNTIME_EXECUTOR.fetch(new Request(
          "https://runtime-executor.internal/ready",
          { signal: controller.signal },
        ));
        const executorBody = await executorResponse.json() as {
          ok?: unknown;
          credentials?: unknown;
          connectionId?: unknown;
        };
        executorReadinessReady = executorResponse.ok
          && executorBody.ok === true
          && executorBody.credentials === "ready"
          && executorBody.connectionId === reviewedConnectionId;
      } catch {
        executorReadinessReady = false;
      } finally {
        clearTimeout(timeout);
      }
    }
    const ready = schemaReady
      && missingBindings.length === 0
      && executionEnabled
      && executor !== null
      && executorReadinessReady;
    return json({
      ok: ready,
      environment: env.ENVIRONMENT ?? null,
      release: env.RELEASE ?? null,
      stagingOnly: isStaging(env),
      executionScope: isExclusiveCanaryConsumer(env) ? "exclusive-canary" : "staging",
      executionEnabled,
      canaryConsumer,
      executorBound: executor !== null,
      missingBindings,
      canaryScope: row?.runtime_canary_scope_ready === true ? "ready" : "not_ready",
      credentials: row?.runtime_credentials_ready === true ? "ready" : "not_ready",
      executorReadiness: executorReadinessReady ? "ready" : "not_ready",
      database: schemaReady ? "ready" : "schema_not_ready",
      reason: ready ? null : "RUNTIME_NOT_READY",
    }, ready ? 200 : 503);
  } catch {
    return json({
      ok: false,
      environment: env.ENVIRONMENT ?? null,
      release: env.RELEASE ?? null,
      stagingOnly: isStaging(env),
      executionScope: isExclusiveCanaryConsumer(env) ? "exclusive-canary" : "staging",
      executionEnabled,
      canaryConsumer,
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
          stagingOnly: isStaging(env),
          executionScope: isExclusiveCanaryConsumer(env) ? "exclusive-canary" : "staging",
          executionEnabled,
          canaryConsumer: isCanaryConsumer(env),
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
