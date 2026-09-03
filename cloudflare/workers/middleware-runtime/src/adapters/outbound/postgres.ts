import {
  sql,
  type DatabaseAdapter,
  type DatabaseTransaction,
} from "../../../../middleware-api/src/db";
import type { JsonValue } from "../../contracts";
import {
  processOutboundTasks,
  reduceOutboundBreaker,
  sanitizeOutboundLog,
  sanitizeOutboundText,
  sanitizeOutboundValue,
  type OutboundBatchSummary,
  type OutboundBreakerEvent,
  type OutboundBreakerPolicy,
  type OutboundBreakerState,
  type OutboundExecutionLog,
  type OutboundExecutionResult,
  type OutboundPorts,
  type OutboundTask,
  type OutboundTaskDecision,
} from "../../handlers/outbound";
import type {
  OutboundDryRunJournal,
  PosOutboundTransport,
  PostgresOutboundAdapter,
  PostgresOutboundAdapterOptions,
  PostgresOutboundProcessResult,
} from "./types";

type OutboundTaskRow = Record<string, unknown> & {
  id: unknown;
  connection_id: unknown;
  provider: unknown;
  task_type: unknown;
  payload_json: unknown;
  status: unknown;
  attempts: unknown;
  max_attempts: unknown;
  created_at: unknown;
  updated_at: unknown;
  external_id: unknown;
};

type BreakerRow = Record<string, unknown> & {
  consecutive_failures: unknown;
  circuit_breaker_paused_until: unknown;
  circuit_breaker_reason: unknown;
  revision: unknown;
};

type BooleanRow = Record<string, unknown> & { value: unknown };
type IdRow = Record<string, unknown> & { id: unknown };

type PendingBreaker = {
  event: OutboundBreakerEvent;
  occurredAt: string;
  policy: OutboundBreakerPolicy;
};

type PendingTransition = {
  task: OutboundTask;
  decision: OutboundTaskDecision;
  breaker: PendingBreaker | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_LOCK_TTL_SECONDS = 540;
const MIN_LOCK_TTL_SECONDS = 30;
const MAX_LOCK_TTL_SECONDS = 1_800;

export class PostgresOutboundAdapterInvariantError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "PostgresOutboundAdapterInvariantError";
  }
}

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function nullableText(value: unknown): string | null {
  const normalized = text(value).trim();
  return normalized || null;
}

function integer(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function boolean(value: unknown): boolean {
  return value === true || ["true", "1", "yes", "t"].includes(text(value).toLowerCase());
}

function requireUuid(value: string, code: string): string {
  const normalized = value.trim();
  if (!UUID.test(normalized)) throw new PostgresOutboundAdapterInvariantError(code);
  return normalized;
}

function requireProvider(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{1,31}$/.test(normalized)) {
    throw new PostgresOutboundAdapterInvariantError("OUTBOUND_ADAPTER_PROVIDER_INVALID");
  }
  return normalized;
}

function lockTtlSeconds(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LOCK_TTL_SECONDS;
  if (!Number.isInteger(value) || value < MIN_LOCK_TTL_SECONDS || value > MAX_LOCK_TTL_SECONDS) {
    throw new PostgresOutboundAdapterInvariantError("OUTBOUND_ADAPTER_LOCK_TTL_INVALID");
  }
  return value;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || ["string", "boolean"].includes(typeof value)) return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value === "object") return Object.values(value as Record<string, unknown>).every(isJsonValue);
  return false;
}

function jsonValue(value: unknown): JsonValue {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      throw new PostgresOutboundAdapterInvariantError("OUTBOUND_TASK_PAYLOAD_INVALID");
    }
  }
  if (!isJsonValue(candidate)) {
    throw new PostgresOutboundAdapterInvariantError("OUTBOUND_TASK_PAYLOAD_INVALID");
  }
  return candidate;
}

function mapTask(row: OutboundTaskRow): OutboundTask {
  const status = text(row.status);
  if (status !== "RUNNING") {
    throw new PostgresOutboundAdapterInvariantError("OUTBOUND_CLAIM_STATUS_INVALID");
  }
  const attempts = integer(row.attempts, -1);
  const maxAttempts = integer(row.max_attempts, -1);
  if (attempts < 1 || maxAttempts < 1) {
    throw new PostgresOutboundAdapterInvariantError("OUTBOUND_CLAIM_ATTEMPTS_INVALID");
  }
  const payload = jsonValue(row.payload_json);
  const payloadRecord = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, JsonValue>
    : {};
  return {
    id: requireUuid(text(row.id), "OUTBOUND_TASK_ID_INVALID"),
    connectionId: requireUuid(text(row.connection_id), "OUTBOUND_TASK_CONNECTION_ID_INVALID"),
    provider: requireProvider(text(row.provider)),
    taskType: text(row.task_type),
    payload,
    status: "RUNNING",
    attempts,
    maxAttempts,
    createdAt: text(row.created_at),
    updatedAt: nullableText(row.updated_at) ?? undefined,
    idempotencyKey: nullableText(payloadRecord._idempotency_key),
    externalId: nullableText(row.external_id),
  };
}

function mapBreaker(row: BreakerRow | undefined): OutboundBreakerState {
  if (!row) throw new PostgresOutboundAdapterInvariantError("OUTBOUND_CONNECTION_NOT_FOUND");
  return {
    consecutiveFailures: Math.max(0, integer(row.consecutive_failures)),
    pausedUntil: nullableText(row.circuit_breaker_paused_until),
    reason: nullableText(row.circuit_breaker_reason),
    revision: nullableText(row.revision) ?? undefined,
  };
}

function emptySummary(): OutboundBatchSummary {
  return {
    claimed: 0,
    completed: 0,
    superseded: 0,
    retried: 0,
    terminal: 0,
    blocked: 0,
    deferred: 0,
    invalidClaims: 0,
    skippedByBreaker: false,
  };
}

function safeExecutionResult(result: OutboundExecutionResult): OutboundExecutionResult {
  if (result.kind === "success") {
    return {
      kind: "success",
      externalId: result.externalId ? sanitizeOutboundText(result.externalId, 160) : undefined,
      detail: result.detail ? sanitizeOutboundText(result.detail) : undefined,
    };
  }
  if (result.kind === "failure") {
    return {
      kind: "failure",
      failure: {
        httpStatus: result.failure.httpStatus,
        message: result.failure.message === undefined
          ? undefined
          : sanitizeOutboundText(result.failure.message),
        retryableLine: result.failure.retryableLine === true,
        diagnostic: result.failure.diagnostic === undefined
          ? undefined
          : sanitizeOutboundValue(result.failure.diagnostic),
      },
    };
  }
  if (result.kind === "blocked") {
    return {
      kind: "blocked",
      reason: sanitizeOutboundText(result.reason),
      detail: result.detail ? sanitizeOutboundText(result.detail) : undefined,
    };
  }
  return {
    kind: "superseded",
    evidence: {
      ...result.evidence,
      detail: result.evidence.detail ? sanitizeOutboundText(result.evidence.detail) : undefined,
    },
  };
}

function payloadTrackingScope(task: OutboundTask): { wineId: string; formats: string[] } | null {
  if (!task.payload || typeof task.payload !== "object" || Array.isArray(task.payload)) return null;
  const payload = task.payload as Record<string, JsonValue>;
  const wineId = nullableText(payload._winerim_wine_id);
  const rawFormats = Array.isArray(payload._format_types)
    ? payload._format_types
    : payload._format_type
    ? [payload._format_type]
    : [];
  const formats = [...new Set(rawFormats.map((value) => text(value).trim().toUpperCase()).filter((value) =>
    ["BOTTLE", "GLASS", "MAGNUM"].includes(value)
  ))].sort();
  return wineId && formats.length > 0 ? { wineId, formats } : null;
}

function decisionValues(task: OutboundTask, decision: OutboundTaskDecision) {
  const lastError = decision.action === "complete" ? null : sanitizeOutboundText(decision.lastError);
  return {
    status: decision.status,
    restoreAttempt: decision.action === "defer" && decision.restoreClaimedAttempt,
    nextRetryAt: decision.action === "retry" || decision.action === "defer"
      ? decision.nextRetryAt
      : null,
    lastError,
    blockedReason: decision.action === "terminal" && decision.status === "BLOCKED"
      ? decision.terminalReason
      : null,
    setExternalId: decision.action === "complete" && !!decision.externalId,
    externalId: decision.action === "complete" && decision.externalId
      ? sanitizeOutboundText(decision.externalId, 160)
      : null,
    taskId: task.id,
  };
}

function logOutcome(record: OutboundExecutionLog): "SUCCESS" | "RETRY" | "TERMINAL" | "BLOCKED" {
  if (["complete", "superseded"].includes(record.outcome)) return "SUCCESS";
  if (record.outcome === "retry") return "RETRY";
  if (["defer", "breaker_open"].includes(record.outcome)) return "BLOCKED";
  return "TERMINAL";
}

async function lockConnection(transaction: DatabaseTransaction, connectionId: string): Promise<void> {
  await transaction.query(sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${connectionId}, 0))
  `);
}

async function readBreakerRow(
  database: DatabaseTransaction,
  connectionId: string,
  provider: string,
  forUpdate: boolean,
): Promise<OutboundBreakerState> {
  const result = forUpdate
    ? await database.query<BreakerRow>(sql`
        SELECT
          consecutive_failures,
          circuit_breaker_paused_until,
          circuit_breaker_reason,
          updated_at::text AS revision
        FROM public.pos_connections
        WHERE id = ${connectionId}::uuid AND provider = ${provider}
        FOR UPDATE
      `)
    : await database.query<BreakerRow>(sql`
        SELECT
          consecutive_failures,
          circuit_breaker_paused_until,
          circuit_breaker_reason,
          updated_at::text AS revision
        FROM public.pos_connections
        WHERE id = ${connectionId}::uuid AND provider = ${provider}
      `);
  return mapBreaker(result.rows[0]);
}

async function persistTracking(
  transaction: DatabaseTransaction,
  task: OutboundTask,
  decision: OutboundTaskDecision,
): Promise<number> {
  const scope = payloadTrackingScope(task);
  if (!scope || decision.action === "defer") return 0;

  const status = decision.action === "complete"
    ? "VERIFIED"
    : decision.action === "retry"
    ? "QUEUED"
    : "FAILED";
  const lastError = decision.action === "complete" ? null : sanitizeOutboundText(decision.lastError);
  const result = await transaction.query(sql`
    UPDATE public.winerim_push_tracking
    SET
      sync_status = CASE
        WHEN ${status} = 'QUEUED' AND sync_status IN ('VERIFIED', 'PUSHED', 'HIDDEN') THEN sync_status
        ELSE ${status}
      END,
      task_id = ${task.id}::uuid,
      last_error = ${lastError},
      pushed_at = CASE WHEN ${status} = 'VERIFIED' THEN now() ELSE pushed_at END,
      verified_at = CASE WHEN ${status} = 'VERIFIED' THEN now() ELSE verified_at END,
      updated_at = now()
    WHERE connection_id = ${task.connectionId}::uuid
      AND winerim_wine_id = ${scope.wineId}
      AND upper(format) = ANY(${scope.formats}::text[])
  `);
  return result.rowCount;
}

async function insertExecutionLog(
  transaction: DatabaseTransaction,
  connectionId: string,
  task: OutboundTask | null,
  record: OutboundExecutionLog,
  trackingUpdated: number,
): Promise<void> {
  const sanitized = sanitizeOutboundLog(record);
  const detail = sanitizeOutboundValue({ ...sanitized, trackingUpdated });
  const messageId = task?.id ?? `outbound-batch:${connectionId}:${sanitized.at}`;
  const idempotencyKey = task
    ? `outbound-task:${task.id}`
    : `outbound-batch:${connectionId}:${sanitized.at}`;
  await transaction.query(sql`
    INSERT INTO public.runtime_execution_log (
      message_id, idempotency_key, connection_id, job, outcome, attempt,
      duration_ms, error_class, detail
    ) VALUES (
      ${messageId}, ${idempotencyKey}, ${connectionId}::uuid, 'outbound.process',
      ${logOutcome(sanitized)}, ${Math.max(0, task?.attempts ?? 0)},
      ${sanitized.durationMs ?? null}, ${sanitized.failureClass ?? null},
      ${JSON.stringify(detail)}::jsonb
    )
  `);
}

async function settleTransition(
  database: DatabaseAdapter,
  connectionId: string,
  provider: string,
  pending: PendingTransition,
  record: OutboundExecutionLog,
): Promise<OutboundBreakerState | null> {
  return database.transaction(async (transaction) => {
    await lockConnection(transaction, connectionId);
    let breaker: OutboundBreakerState | null = null;
    if (pending.breaker) {
      const current = await readBreakerRow(transaction, connectionId, provider, true);
      breaker = reduceOutboundBreaker(
        current,
        pending.breaker.event,
        pending.breaker.occurredAt,
        pending.breaker.policy,
      ).next;
      await transaction.query(sql`
        UPDATE public.pos_connections
        SET
          consecutive_failures = ${breaker.consecutiveFailures},
          circuit_breaker_paused_until = ${breaker.pausedUntil}::timestamptz,
          circuit_breaker_reason = ${breaker.reason},
          updated_at = now()
        WHERE id = ${connectionId}::uuid AND provider = ${provider}
      `);
    }

    const values = decisionValues(pending.task, pending.decision);
    const transitioned = await transaction.query<IdRow>(sql`
      UPDATE public.outbound_tasks
      SET
        status = ${values.status},
        attempts = CASE WHEN ${values.restoreAttempt} THEN greatest(attempts - 1, 0) ELSE attempts END,
        next_retry_at = ${values.nextRetryAt}::timestamptz,
        last_error = ${values.lastError},
        blocked_reason = ${values.blockedReason},
        external_id = CASE WHEN ${values.setExternalId} THEN ${values.externalId} ELSE external_id END,
        updated_at = now()
      WHERE id = ${values.taskId}::uuid
        AND connection_id = ${connectionId}::uuid
        AND status = 'RUNNING'
        AND attempts = ${pending.task.attempts}
      RETURNING id
    `);
    if (transitioned.rowCount !== 1) {
      throw new PostgresOutboundAdapterInvariantError("OUTBOUND_TASK_TRANSITION_CONFLICT");
    }

    const trackingUpdated = await persistTracking(transaction, pending.task, pending.decision);
    await insertExecutionLog(transaction, connectionId, pending.task, record, trackingUpdated);
    return breaker;
  }, { isolationLevel: "serializable", readOnly: false });
}

async function writeStandaloneLog(
  database: DatabaseAdapter,
  connectionId: string,
  record: OutboundExecutionLog,
): Promise<void> {
  await database.transaction(async (transaction) => {
    await lockConnection(transaction, connectionId);
    await insertExecutionLog(transaction, connectionId, null, record, 0);
  }, { isolationLevel: "serializable", readOnly: false });
}

async function claimTasks(
  database: DatabaseAdapter,
  connectionId: string,
  provider: string,
  plan: Parameters<OutboundPorts["tasks"]["claim"]>[0],
  dryRun: boolean,
): Promise<OutboundTask[]> {
  if (plan.connectionId !== connectionId || (plan.provider && plan.provider !== provider)) {
    throw new PostgresOutboundAdapterInvariantError("OUTBOUND_CLAIM_SCOPE_MISMATCH");
  }

  if (dryRun) {
    return database.transaction(async (transaction) => {
      const result = await transaction.query<OutboundTaskRow>(sql`
        SELECT
          t.id,
          t.connection_id,
          c.provider,
          t.task_type,
          t.payload_json,
          'RUNNING'::text AS status,
          COALESCE(t.attempts, 0) + 1 AS attempts,
          t.max_attempts,
          t.created_at,
          t.updated_at,
          t.external_id
        FROM public.outbound_tasks t
        JOIN public.pos_connections c ON c.id = t.connection_id
        WHERE t.connection_id = ${connectionId}::uuid
          AND c.provider = ${provider}
          AND t.status = 'QUEUED'
          AND t.task_type = ANY(${plan.taskTypes}::text[])
          AND (t.next_retry_at IS NULL OR t.next_retry_at <= ${plan.readyAt}::timestamptz)
        ORDER BY COALESCE(t.next_retry_at, '-infinity'::timestamptz), t.created_at, t.id
        LIMIT ${plan.limit}
      `);
      return result.rows.map(mapTask);
    }, { isolationLevel: "repeatable-read", readOnly: true });
  }

  return database.transaction(async (transaction) => {
    await lockConnection(transaction, connectionId);
    const result = await transaction.query<OutboundTaskRow>(sql`
      WITH picked AS (
        SELECT t.id, c.provider
        FROM public.outbound_tasks t
        JOIN public.pos_connections c ON c.id = t.connection_id
        WHERE t.connection_id = ${connectionId}::uuid
          AND c.provider = ${provider}
          AND t.status = 'QUEUED'
          AND t.task_type = ANY(${plan.taskTypes}::text[])
          AND (t.next_retry_at IS NULL OR t.next_retry_at <= ${plan.readyAt}::timestamptz)
        ORDER BY COALESCE(t.next_retry_at, '-infinity'::timestamptz), t.created_at, t.id
        FOR UPDATE OF t SKIP LOCKED
        LIMIT ${plan.limit}
      )
      UPDATE public.outbound_tasks t
      SET
        status = 'RUNNING',
        attempts = COALESCE(t.attempts, 0) + 1,
        updated_at = now()
      FROM picked
      WHERE t.id = picked.id AND t.connection_id = ${connectionId}::uuid
      RETURNING
        t.id,
        t.connection_id,
        picked.provider,
        t.task_type,
        t.payload_json,
        t.status,
        t.attempts,
        t.max_attempts,
        t.created_at,
        t.updated_at,
        t.external_id
    `);
    return result.rows.map(mapTask);
  }, { isolationLevel: "serializable", readOnly: false });
}

async function acquireDispatchLock(
  database: DatabaseAdapter,
  connectionId: string,
  token: string,
  ttlSeconds: number,
): Promise<boolean> {
  return database.transaction(async (transaction) => {
    const result = await transaction.query<BooleanRow>(sql`
      SELECT public.acquire_agora_dispatch_lock(
        ${connectionId}::uuid,
        'outbound-queue',
        ${token},
        ${ttlSeconds}
      ) AS value
    `);
    return boolean(result.rows[0]?.value);
  }, { isolationLevel: "serializable", readOnly: false });
}

async function releaseDispatchLock(
  database: DatabaseAdapter,
  connectionId: string,
  token: string,
): Promise<void> {
  const released = await database.transaction(async (transaction) => {
    const result = await transaction.query<BooleanRow>(sql`
      SELECT public.release_agora_dispatch_lock(
        ${connectionId}::uuid,
        'outbound-queue',
        ${token}
      ) AS value
    `);
    return boolean(result.rows[0]?.value);
  }, { isolationLevel: "serializable", readOnly: false });
  if (!released) throw new PostgresOutboundAdapterInvariantError("OUTBOUND_DISPATCH_LOCK_RELEASE_FAILED");
}

function defaultLockToken(): string {
  return `outbound-${crypto.randomUUID()}`;
}

export function createPostgresOutboundAdapter(
  database: DatabaseAdapter,
  transport: PosOutboundTransport,
  options: PostgresOutboundAdapterOptions,
): PostgresOutboundAdapter {
  const connectionId = requireUuid(options.connectionId, "OUTBOUND_ADAPTER_CONNECTION_ID_INVALID");
  const provider = requireProvider(options.provider);
  const dryRun = options.dryRun === true;
  const ttlSeconds = lockTtlSeconds(options.lockTtlSeconds);
  const clock = options.clock ?? { now: () => new Date() };
  const lockTokenFactory = options.lockTokenFactory ?? defaultLockToken;
  let running = false;

  const process = async (input: { taskTypes: readonly string[]; limit?: number }): Promise<PostgresOutboundProcessResult> => {
    if (running) throw new PostgresOutboundAdapterInvariantError("OUTBOUND_ADAPTER_ALREADY_RUNNING");
    running = true;
    const journal: {
      claimedTaskIds: string[];
      transitions: Array<{ taskId: string; decision: OutboundTaskDecision }>;
      logs: OutboundExecutionLog[];
    } = { claimedTaskIds: [], transitions: [], logs: [] };
    const pendingTransitions = new Map<string, PendingTransition>();
    let pendingBreaker: PendingBreaker | null = null;
    let cachedBreaker: OutboundBreakerState | null = null;
    let lockAcquired = dryRun;
    let lockToken = "";
    let result: PostgresOutboundProcessResult | undefined;
    let failure: unknown;

    const ports: OutboundPorts = {
      clock,
      tasks: {
        claim: async (plan) => {
          const tasks = await claimTasks(database, connectionId, provider, plan, dryRun);
          journal.claimedTaskIds.push(...tasks.map((task) => task.id));
          return tasks;
        },
        transition: async (task, decision) => {
          if (task.connectionId !== connectionId || task.provider !== provider) {
            throw new PostgresOutboundAdapterInvariantError("OUTBOUND_TRANSITION_SCOPE_MISMATCH");
          }
          const sanitizedDecision = sanitizeOutboundValue(decision) as unknown as OutboundTaskDecision;
          if (!dryRun) {
            pendingTransitions.set(task.id, { task, decision: sanitizedDecision, breaker: pendingBreaker });
          }
          pendingBreaker = null;
          journal.transitions.push({ taskId: task.id, decision: sanitizedDecision });
        },
      },
      breaker: {
        read: async (requestedConnectionId) => {
          if (requestedConnectionId !== connectionId) {
            throw new PostgresOutboundAdapterInvariantError("OUTBOUND_BREAKER_SCOPE_MISMATCH");
          }
          cachedBreaker = await database.transaction(
            (transaction) => readBreakerRow(transaction, connectionId, provider, false),
            { isolationLevel: "repeatable-read", readOnly: true },
          );
          return cachedBreaker;
        },
        record: async (event) => {
          if (event.connectionId !== connectionId || !cachedBreaker) {
            throw new PostgresOutboundAdapterInvariantError("OUTBOUND_BREAKER_STATE_MISSING");
          }
          if (!dryRun) {
            pendingBreaker = {
              event: event.event,
              occurredAt: event.occurredAt,
              policy: event.policy,
            };
          }
          cachedBreaker = reduceOutboundBreaker(
            cachedBreaker,
            event.event,
            event.occurredAt,
            event.policy,
          ).next;
          return cachedBreaker;
        },
      },
      limiter: {
        acquire: (request) => dryRun
          ? Promise.resolve({ granted: true, waitedMs: 0 })
          : options.limiter.acquire(request),
      },
      executor: {
        execute: async (task, context) => {
          if (dryRun) return { kind: "success", detail: "dry_run_no_transport" };
          try {
            return safeExecutionResult(await transport.execute({ task, context }));
          } catch (error) {
            return {
              kind: "failure",
              failure: {
                message: sanitizeOutboundText(error),
                diagnostic: {
                  operation: "outbound.transport",
                  errorCode: "OUTBOUND_TRANSPORT_THROW",
                  bodySample: sanitizeOutboundText(error, 256),
                },
              },
            };
          }
        },
      },
      logger: {
        write: async (record) => {
          const sanitized = sanitizeOutboundLog(record);
          journal.logs.push(sanitized);
          if (dryRun) return;

          const taskId = sanitized.taskId;
          if (!taskId) {
            await writeStandaloneLog(database, connectionId, sanitized);
            return;
          }
          const pending = pendingTransitions.get(taskId);
          if (!pending) {
            throw new PostgresOutboundAdapterInvariantError("OUTBOUND_TRANSITION_LOG_PAIR_MISSING");
          }
          const persistedBreaker = await settleTransition(
            database,
            connectionId,
            provider,
            pending,
            sanitized,
          );
          if (persistedBreaker) cachedBreaker = persistedBreaker;
          pendingTransitions.delete(taskId);
        },
      },
    };

    try {
      if (!dryRun) {
        lockToken = sanitizeOutboundText(lockTokenFactory(), 160);
        if (!lockToken.trim()) {
          throw new PostgresOutboundAdapterInvariantError("OUTBOUND_DISPATCH_LOCK_TOKEN_INVALID");
        }
        lockAcquired = await acquireDispatchLock(database, connectionId, lockToken, ttlSeconds);
      }
      if (!lockAcquired) {
        result = { dryRun, lockAcquired: false, summary: emptySummary(), journal };
      } else {
        const summary = await processOutboundTasks({
          connectionId,
          provider,
          taskTypes: input.taskTypes,
          limit: input.limit,
        }, ports);
        if (pendingTransitions.size > 0 || pendingBreaker) {
          throw new PostgresOutboundAdapterInvariantError("OUTBOUND_PENDING_ATOMIC_SETTLEMENT");
        }
        result = { dryRun, lockAcquired: true, summary, journal };
      }
    } catch (error) {
      failure = error;
    }

    if (!dryRun && lockAcquired) {
      try {
        await releaseDispatchLock(database, connectionId, lockToken);
      } catch (error) {
        if (!failure) failure = error;
      }
    }
    running = false;
    if (failure) throw failure;
    return result as PostgresOutboundProcessResult;
  };

  return { process };
}
