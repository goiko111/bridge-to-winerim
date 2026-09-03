import {
  sql,
  type DatabaseAdapter,
  type DatabaseTransaction,
} from "../../../../middleware-api/src/db";
import type { JsonValue } from "../../contracts";
import { canonicalJson, sha256Hex } from "../../idempotency";
import {
  executeWinerimMutationPlan,
  planWinerimStockMutation,
  type WinerimMutationExecutionResult,
  type WinerimMutationPlan,
  type WinerimStockVariant,
} from "../../handlers/stock";
import type {
  PostgresStockAdapter,
  PostgresStockAdapterOptions,
  StockClaimReadback,
  StockClaimState,
  StockExecutionReadback,
  StockMutationAuditReadback,
  StockMutationContext,
  StockMutationRunResult,
  StockSyncReadback,
} from "./types";

type ClaimRow = {
  idempotency_key: unknown;
  message_id: unknown;
  connection_id: unknown;
  job: unknown;
  status: unknown;
  attempt: unknown;
  lease_expires_at: unknown;
  lease_expired?: unknown;
  payload_sha256?: unknown;
  lease_token?: unknown;
  result: unknown;
  created_at: unknown;
  updated_at: unknown;
};

type ExecutionRow = {
  id: unknown;
  message_id: unknown;
  idempotency_key: unknown;
  outcome: unknown;
  attempt: unknown;
  duration_ms: unknown;
  error_class: unknown;
  detail: unknown;
  created_at: unknown;
};

type StockRow = {
  id: unknown;
  sales_event_id: unknown;
  sales_line_item_id: unknown;
  provider_product_id: unknown;
  winerim_product_id: unknown;
  product_name: unknown;
  quantity: unknown;
  status: unknown;
  variant: unknown;
  stock_id: unknown;
  idempotency_key: unknown;
  error_message: unknown;
  winerim_response: unknown;
  created_at: unknown;
  synced_at: unknown;
};

type ClaimReservation = Readonly<{
  state: "ACQUIRED";
  attempt: number;
  writesPerformed: boolean;
  reason: string;
  leaseToken: string;
}> | Readonly<{
  state: Exclude<StockClaimState, "ACQUIRED">;
  attempt: number;
  writesPerformed: boolean;
  reason: string;
}>;

const CLAIM_JOB = "stock.mutation";
const DEFAULT_CLAIM_LEASE_SECONDS = 120;
const AUDIT_LIMIT = 20;

export class PostgresStockAdapterInvariantError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "PostgresStockAdapterInvariantError";
  }
}

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function nullableText(value: unknown): string | null {
  const normalized = text(value);
  return normalized || null;
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function boolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  return ["true", "1", "yes"].includes(text(value).toLowerCase());
}

function jsonRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

function claimLeaseSeconds(value: number | undefined): number {
  if (value === undefined) return DEFAULT_CLAIM_LEASE_SECONDS;
  if (!Number.isInteger(value) || value < 15 || value > 900) {
    throw new PostgresStockAdapterInvariantError("STOCK_ADAPTER_INVALID_CLAIM_LEASE");
  }
  return value;
}

function assertContext(input: StockMutationContext): void {
  if (!String(input.idempotencyKey || "").trim()) {
    throw new PostgresStockAdapterInvariantError("STOCK_ADAPTER_INVALID_IDEMPOTENCY_KEY");
  }
  if (!String(input.productName || "").trim()) {
    throw new PostgresStockAdapterInvariantError("STOCK_ADAPTER_INVALID_PRODUCT_NAME");
  }
}

function stockLogVariant(variant: WinerimStockVariant): "copa" | "botella" | "magnum" {
  if (variant === "glass") return "copa";
  if (variant === "bottle") return "botella";
  return "magnum";
}

function claimMetadata(
  input: StockMutationContext,
  plan: WinerimMutationPlan,
  payloadHash: string,
): Record<string, unknown> {
  const sourceStockBefore = Number.isInteger(input.mutation.currentSourceStock)
    ? Number(input.mutation.currentSourceStock)
    : null;
  const targetStock = plan.request.kind === "stock-put" ? plan.request.body.stock : null;
  return {
    adapter: "postgres-stock-v1",
    payloadHash,
    orderId: input.mutation.orderId,
    mode: plan.mode,
    quantity: input.mutation.quantity,
    sourceStockBefore,
    targetStock,
    stockShortfall: sourceStockBefore !== null && sourceStockBefore < input.mutation.quantity,
    soldStock: plan.soldStock,
    stockSource: plan.stockSource ?? null,
    request: plan.request,
    productName: input.productName,
    providerProductId: input.providerProductId ?? null,
    salesEventId: input.salesEventId ?? null,
    salesLineItemId: input.salesLineItemId ?? null,
  };
}

function executionDetail(
  execution: WinerimMutationExecutionResult,
  payloadHash: string,
): Record<string, unknown> {
  return {
    payloadHash,
    mode: execution.plan.mode,
    soldStock: execution.plan.soldStock,
    stockSource: execution.plan.stockSource ?? null,
    requestKind: execution.plan.request.kind,
    reason: execution.reason,
    retryable: execution.retryable,
    certifiedOrderIds: execution.certifiedOrderIds,
    terminalOrderIds: execution.terminalOrderIds,
    pendingOrderIds: execution.pendingOrderIds,
    attempts: execution.attempts.map((attempt) => ({
      number: attempt.number,
      status: attempt.response?.status ?? null,
      action: attempt.decision?.action ?? null,
      reason: attempt.decision?.reason ?? null,
      error: attempt.error ?? null,
    })),
  };
}

function mapClaim(row: ClaimRow): StockClaimReadback {
  return {
    idempotencyKey: text(row.idempotency_key),
    orderId: text(row.message_id),
    connectionId: text(row.connection_id),
    job: text(row.job),
    status: text(row.status),
    attempt: number(row.attempt),
    leaseExpiresAt: nullableText(row.lease_expires_at),
    result: jsonRecord(row.result),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

function mapExecution(row: ExecutionRow): StockExecutionReadback {
  return {
    id: text(row.id),
    orderId: text(row.message_id),
    idempotencyKey: text(row.idempotency_key),
    outcome: text(row.outcome),
    attempt: number(row.attempt),
    durationMs: row.duration_ms === null || row.duration_ms === undefined
      ? null
      : number(row.duration_ms),
    errorClass: nullableText(row.error_class),
    detail: jsonRecord(row.detail),
    createdAt: text(row.created_at),
  };
}

function mapStockLog(row: StockRow): StockSyncReadback {
  return {
    id: text(row.id),
    salesEventId: nullableText(row.sales_event_id),
    salesLineItemId: nullableText(row.sales_line_item_id),
    providerProductId: nullableText(row.provider_product_id),
    winerimProductId: nullableText(row.winerim_product_id),
    productName: text(row.product_name),
    quantity: number(row.quantity),
    status: text(row.status),
    variant: nullableText(row.variant),
    stockId: nullableText(row.stock_id),
    idempotencyKey: nullableText(row.idempotency_key),
    errorMessage: nullableText(row.error_message),
    winerimResponse: jsonRecord(row.winerim_response),
    createdAt: text(row.created_at),
    syncedAt: nullableText(row.synced_at),
  };
}

export async function buildStockMutationPayloadHash(
  input: StockMutationContext,
  plan: WinerimMutationPlan = planWinerimStockMutation(input.mutation),
): Promise<string> {
  const payload = canonicalJson({
    orderId: input.mutation.orderId,
    mode: plan.mode,
    quantity: input.mutation.quantity,
    soldAt: input.mutation.soldAt,
    soldStock: plan.soldStock,
    stockSource: plan.stockSource ?? null,
    request: plan.request,
  } as unknown as JsonValue);
  return sha256Hex(payload);
}

async function readExistingStockClaim(
  transaction: DatabaseTransaction,
  connectionId: string,
  idempotencyKey: string,
): Promise<StockRow | null> {
  const result = await transaction.query<StockRow>(sql`
    SELECT
      id,
      sales_event_id,
      sales_line_item_id,
      provider_product_id,
      winerim_product_id,
      product_name,
      quantity,
      status,
      variant,
      stock_id,
      idempotency_key,
      error_message,
      winerim_response,
      created_at,
      synced_at
    FROM public.stock_sync_log
    WHERE connection_id = ${connectionId}::uuid
    AND idempotency_key = ${idempotencyKey}
    AND status IN ('PENDING', 'SUCCESS')
    ORDER BY created_at DESC
    LIMIT 1
  `);
  return result.rows[0] ?? null;
}

async function reserveClaim(
  database: DatabaseAdapter,
  options: PostgresStockAdapterOptions,
  input: StockMutationContext,
  plan: WinerimMutationPlan,
  payloadHash: string,
  leaseSeconds: number,
): Promise<ClaimReservation> {
  const leaseToken = crypto.randomUUID();
  return database.transaction(async (transaction) => {
    const legacyClaim = await readExistingStockClaim(
      transaction,
      options.connectionId,
      input.idempotencyKey,
    );
    if (legacyClaim?.status === "SUCCESS") {
      return {
        state: "DUPLICATE",
        attempt: 0,
        writesPerformed: false,
        reason: "stock_sync_log_already_successful",
      };
    }
    if (legacyClaim?.status === "PENDING") {
      return {
        state: "BUSY",
        attempt: 0,
        writesPerformed: false,
        reason: "stock_sync_log_claim_pending",
      };
    }

    const metadata = JSON.stringify(claimMetadata(input, plan, payloadHash));
    const inserted = await transaction.query<ClaimRow>(sql`
      INSERT INTO public.runtime_idempotency (
        idempotency_key,
        message_id,
        connection_id,
        job,
        status,
        attempt,
        lease_expires_at,
        payload_sha256,
        lease_token,
        result
      ) VALUES (
        ${input.idempotencyKey},
        ${input.mutation.orderId},
        ${options.connectionId}::uuid,
        ${CLAIM_JOB},
        'RUNNING',
        1,
        now() + (${leaseSeconds} * interval '1 second'),
        ${payloadHash},
        ${leaseToken}::uuid,
        ${metadata}::jsonb
      )
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING
        idempotency_key,
        message_id,
        connection_id,
        job,
        status,
        attempt,
        lease_expires_at,
        false AS lease_expired,
        payload_sha256,
        lease_token,
        result,
        created_at,
        updated_at
    `);
    if (inserted.rowCount === 1) {
      return {
        state: "ACQUIRED",
        attempt: 1,
        writesPerformed: true,
        reason: "stock_claim_acquired",
        leaseToken,
      };
    }

    const selected = await transaction.query<ClaimRow>(sql`
      SELECT
        idempotency_key,
        message_id,
        connection_id,
        job,
        status,
        attempt,
        lease_expires_at,
        COALESCE(lease_expires_at <= now(), true) AS lease_expired,
        payload_sha256,
        lease_token,
        result,
        created_at,
        updated_at
      FROM public.runtime_idempotency
      WHERE idempotency_key = ${input.idempotencyKey}
      FOR UPDATE
    `);
    const current = selected.rows[0];
    if (!current) {
      throw new PostgresStockAdapterInvariantError("STOCK_CLAIM_CONFLICT_NOT_FOUND");
    }

    const currentMetadata = jsonRecord(current.result);
    const sameScope = text(current.connection_id) === options.connectionId &&
      text(current.job) === CLAIM_JOB;
    const sameOrder = text(current.message_id) === input.mutation.orderId &&
      text(currentMetadata.orderId) === input.mutation.orderId;
    const relationalPayloadHash = text(current.payload_sha256);
    const samePayload = text(currentMetadata.payloadHash) === payloadHash
      && (!relationalPayloadHash || relationalPayloadHash === payloadHash);
    if (!sameScope || !sameOrder || !samePayload) {
      return {
        state: "CONFLICT",
        attempt: number(current.attempt),
        writesPerformed: false,
        reason: "idempotency_key_order_or_payload_mismatch",
      };
    }

    if (current.status === "SUCCESS") {
      return {
        state: "DUPLICATE",
        attempt: number(current.attempt),
        writesPerformed: false,
        reason: "stock_claim_already_successful",
      };
    }
    if (current.status === "TERMINAL") {
      return {
        state: "TERMINAL",
        attempt: number(current.attempt),
        writesPerformed: false,
        reason: "stock_claim_terminal",
      };
    }
    if (current.status === "RUNNING" && !boolean(current.lease_expired)) {
      return {
        state: "BUSY",
        attempt: number(current.attempt),
        writesPerformed: false,
        reason: "stock_claim_lease_active",
      };
    }

    const reacquired = await transaction.query<ClaimRow>(sql`
      UPDATE public.runtime_idempotency
      SET
        status = 'RUNNING',
        attempt = attempt + 1,
        lease_expires_at = now() + (${leaseSeconds} * interval '1 second'),
        payload_sha256 = ${payloadHash},
        lease_token = ${leaseToken}::uuid,
        result = COALESCE(result, '{}'::jsonb) || ${metadata}::jsonb,
        updated_at = now()
      WHERE idempotency_key = ${input.idempotencyKey}
        AND connection_id = ${options.connectionId}::uuid
        AND job = ${CLAIM_JOB}
        AND message_id = ${input.mutation.orderId}
        AND result ->> 'payloadHash' = ${payloadHash}
        AND (
          status = 'RETRY'
          OR (status = 'RUNNING' AND COALESCE(lease_expires_at <= now(), true))
        )
      RETURNING
        idempotency_key,
        message_id,
        connection_id,
        job,
        status,
        attempt,
        lease_expires_at,
        false AS lease_expired,
        payload_sha256,
        lease_token,
        result,
        created_at,
        updated_at
    `);
    if (reacquired.rowCount !== 1) {
      throw new PostgresStockAdapterInvariantError("STOCK_CLAIM_REACQUIRE_FAILED");
    }
    return {
      state: "ACQUIRED",
      attempt: number(reacquired.rows[0].attempt),
      writesPerformed: true,
      reason: "stock_claim_reacquired_same_order_and_payload",
      leaseToken,
    };
  }, { isolationLevel: "serializable", readOnly: false });
}

function outcome(execution: WinerimMutationExecutionResult): "SUCCESS" | "RETRY" | "TERMINAL" {
  if (execution.ok) return "SUCCESS";
  return execution.retryable ? "RETRY" : "TERMINAL";
}

async function finalizeClaim(
  database: DatabaseAdapter,
  options: PostgresStockAdapterOptions,
  input: StockMutationContext,
  plan: WinerimMutationPlan,
  payloadHash: string,
  leaseToken: string,
  attempt: number,
  durationMs: number,
  execution: WinerimMutationExecutionResult,
): Promise<void> {
  const finalOutcome = outcome(execution);
  const detail = executionDetail(execution, payloadHash);
  const serializedDetail = JSON.stringify(detail);
  const stockStatus = execution.ok ? "SUCCESS" : "FAILED";
  const errorClass = execution.ok
    ? null
    : execution.retryable ? "WINERIM_RETRYABLE" : "WINERIM_TERMINAL";

  await database.transaction(async (transaction) => {
    const updated = await transaction.query(sql`
      UPDATE public.runtime_idempotency
      SET
        status = ${finalOutcome},
        lease_expires_at = NULL,
        result = COALESCE(result, '{}'::jsonb) || ${serializedDetail}::jsonb,
        updated_at = now()
      WHERE idempotency_key = ${input.idempotencyKey}
        AND connection_id = ${options.connectionId}::uuid
        AND job = ${CLAIM_JOB}
        AND status = 'RUNNING'
        AND message_id = ${input.mutation.orderId}
        AND payload_sha256 = ${payloadHash}
        AND lease_token = ${leaseToken}::uuid
      RETURNING idempotency_key
    `);
    if (updated.rowCount !== 1) {
      throw new PostgresStockAdapterInvariantError("STOCK_CLAIM_FINALIZE_NOT_OWNED");
    }

    await transaction.query(sql`
      INSERT INTO public.stock_sync_log (
        connection_id,
        sales_event_id,
        sales_line_item_id,
        provider_product_id,
        winerim_product_id,
        product_name,
        quantity,
        status,
        error_message,
        winerim_response,
        variant,
        stock_id,
        idempotency_key,
        synced_at
      ) VALUES (
        ${options.connectionId}::uuid,
        ${input.salesEventId ?? null}::uuid,
        ${input.salesLineItemId ?? null}::uuid,
        ${input.providerProductId ?? null},
        ${plan.soldStock.wineId},
        ${input.productName},
        ${input.mutation.quantity},
        ${stockStatus},
        ${execution.ok ? null : execution.reason},
        ${serializedDetail}::jsonb,
        ${stockLogVariant(plan.soldStock.variant)},
        ${plan.soldStock.stockId},
        ${input.idempotencyKey},
        ${execution.ok ? new Date(options.now?.() ?? Date.now()).toISOString() : null}::timestamptz
      )
      ON CONFLICT (connection_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL AND status IN ('PENDING', 'SUCCESS')
      DO NOTHING
    `);

    await transaction.query(sql`
      INSERT INTO public.runtime_execution_log (
        message_id,
        idempotency_key,
        connection_id,
        job,
        outcome,
        attempt,
        duration_ms,
        error_class,
        detail
      ) VALUES (
        ${input.mutation.orderId},
        ${input.idempotencyKey},
        ${options.connectionId}::uuid,
        ${CLAIM_JOB},
        ${finalOutcome},
        ${attempt},
        ${durationMs},
        ${errorClass},
        ${serializedDetail}::jsonb
      )
    `);
  }, { isolationLevel: "serializable", readOnly: false });
}

export function createPostgresStockAdapter(
  database: DatabaseAdapter,
  options: PostgresStockAdapterOptions,
): PostgresStockAdapter {
  if (!String(options.connectionId || "").trim()) {
    throw new PostgresStockAdapterInvariantError("STOCK_ADAPTER_INVALID_CONNECTION_ID");
  }
  if (!options.transport || typeof options.transport.send !== "function" ||
      typeof options.transport.sleep !== "function") {
    throw new PostgresStockAdapterInvariantError("STOCK_ADAPTER_INVALID_TRANSPORT");
  }
  const leaseSeconds = claimLeaseSeconds(options.claimLeaseSeconds);
  const now = options.now ?? Date.now;

  const readAudit = async (idempotencyKey: string): Promise<StockMutationAuditReadback> => {
    if (!String(idempotencyKey || "").trim()) {
      throw new PostgresStockAdapterInvariantError("STOCK_ADAPTER_INVALID_IDEMPOTENCY_KEY");
    }
    return database.transaction(async (transaction) => {
      const claim = await transaction.query<ClaimRow>(sql`
        SELECT
          idempotency_key,
          message_id,
          connection_id,
          job,
          status,
          attempt,
          lease_expires_at,
          result,
          created_at,
          updated_at
        FROM public.runtime_idempotency
        WHERE idempotency_key = ${idempotencyKey}
          AND connection_id = ${options.connectionId}::uuid
          AND job = ${CLAIM_JOB}
        LIMIT 1
      `);
      const executions = await transaction.query<ExecutionRow>(sql`
        SELECT
          id,
          message_id,
          idempotency_key,
          outcome,
          attempt,
          duration_ms,
          error_class,
          detail,
          created_at
        FROM public.runtime_execution_log
        WHERE idempotency_key = ${idempotencyKey}
          AND connection_id = ${options.connectionId}::uuid
          AND job = ${CLAIM_JOB}
        ORDER BY created_at DESC
        LIMIT ${AUDIT_LIMIT}
      `);
      const stockLogs = await transaction.query<StockRow>(sql`
        SELECT
          id,
          sales_event_id,
          sales_line_item_id,
          provider_product_id,
          winerim_product_id,
          product_name,
          quantity,
          status,
          variant,
          stock_id,
          idempotency_key,
          error_message,
          winerim_response,
          created_at,
          synced_at
        FROM public.stock_sync_log
        WHERE connection_id = ${options.connectionId}::uuid
          AND idempotency_key = ${idempotencyKey}
        ORDER BY created_at DESC
        LIMIT ${AUDIT_LIMIT}
      `);
      return {
        claim: claim.rows[0] ? mapClaim(claim.rows[0]) : null,
        executions: executions.rows.map(mapExecution),
        stockLogs: stockLogs.rows.map(mapStockLog),
      };
    }, { isolationLevel: "repeatable-read", readOnly: true });
  };

  const execute = async (input: StockMutationContext): Promise<StockMutationRunResult> => {
    assertContext(input);
    const plan = planWinerimStockMutation(input.mutation);
    const payloadHash = await buildStockMutationPayloadHash(input, plan);
    const base = {
      connectionId: options.connectionId,
      idempotencyKey: input.idempotencyKey,
      orderId: input.mutation.orderId,
      payloadHash,
      plan,
    };

    if (input.dryRun === true) {
      return {
        ...base,
        state: "DRY_RUN",
        writesPerformed: false,
        reason: "dry_run_no_database_or_external_writes",
        execution: null,
        audit: null,
      };
    }
    if (plan.mode === "historical") {
      return {
        ...base,
        state: "HISTORICAL_BLOCKED",
        writesPerformed: false,
        reason: "historical_mutation_outside_stock_adapter_scope",
        execution: null,
        audit: null,
      };
    }

    const reservation = await reserveClaim(
      database,
      options,
      input,
      plan,
      payloadHash,
      leaseSeconds,
    );
    if (reservation.state !== "ACQUIRED") {
      const state = reservation.state === "CONFLICT"
        ? "IDEMPOTENCY_CONFLICT"
        : reservation.state;
      return {
        ...base,
        state,
        writesPerformed: reservation.writesPerformed,
        reason: reservation.reason,
        execution: null,
        audit: await readAudit(input.idempotencyKey),
      };
    }

    const startedAt = now();
    const execution = await executeWinerimMutationPlan(plan, options.transport);
    const durationMs = Math.max(0, Math.trunc(now() - startedAt));
    await finalizeClaim(
      database,
      options,
      input,
      plan,
      payloadHash,
      reservation.leaseToken,
      reservation.attempt,
      durationMs,
      execution,
    );

    return {
      ...base,
      state: execution.ok ? "APPLIED" : execution.retryable ? "RETRY" : "TERMINAL",
      writesPerformed: true,
      reason: execution.reason,
      execution,
      audit: await readAudit(input.idempotencyKey),
    };
  };

  return { execute, readAudit };
}
