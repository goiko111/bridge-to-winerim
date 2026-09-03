import { isRuntimeEnvelope, type RuntimeEnvelopeV1 } from "../contracts";
import { handleCatalogRequest } from "../handlers/catalog";
import { processOutboundTasks } from "../handlers/outbound";
import { handleSalesRun, type SalesHandlerInput } from "../handlers/sales";
import {
  executeWinerimMutationPlan,
  planWinerimStockMutation,
  WinerimMutationPlanError,
  type WinerimStockMutationInput,
} from "../handlers/stock";
import { HttpAdapterError, type HttpAdapterErrorCode } from "../adapters/http";
import type { RuntimeExecutionResult } from "../queue";
import type {
  ProviderNeutralRuntimeExecutorPorts,
  RuntimeExecutorPreparedInput,
} from "./contracts";

type RuntimeExecutor = Readonly<{
  execute(envelope: RuntimeEnvelopeV1): Promise<RuntimeExecutionResult>;
}>;

type JsonRecord = Record<string, unknown>;

const CATALOG_JOBS = new Set<RuntimeEnvelopeV1["job"]>([
  "catalog.fetch-winerim",
  "catalog.sync-master",
]);
const SALES_JOBS = new Set<RuntimeEnvelopeV1["job"]>([
  "sales.auto-sync",
  "sales.sync-intraday",
  "sales.sync-open-tickets",
]);
const STOCK_JOBS = new Set<RuntimeEnvelopeV1["job"]>([
  "winerim.sales-import-live",
  "winerim.sales-import-historical",
  "winerim.stock-apply",
]);

function success(detail: string): RuntimeExecutionResult {
  return { ok: true, detail };
}

function failure(
  httpStatus: number,
  message: string,
  retryableLine = false,
): RuntimeExecutionResult {
  return {
    ok: false,
    failure: {
      httpStatus,
      message,
      ...(retryableLine ? { retryableLine: true } : {}),
    },
  };
}

function httpAdapterFailureStatus(code: HttpAdapterErrorCode): number {
  if (code === "HTTP_TIMEOUT") return 408;
  if (code === "HTTP_CREDENTIAL_UNAVAILABLE") return 401;
  if (code === "HTTP_INVALID_BASE_URL" || code === "HTTP_BASE_URL_NOT_ALLOWLISTED" ||
      code === "HTTP_INVALID_REQUEST_PATH" || code.startsWith("AGORA_INVALID_")) {
    return 422;
  }
  return 503;
}

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function envelopeRequestsDryRun(envelope: RuntimeEnvelopeV1): boolean {
  return asRecord(envelope.payload)?.dryRun === true;
}

function scopedInput<T extends { connectionId: string }>(
  envelope: RuntimeEnvelopeV1,
  input: T,
): T | null {
  return input.connectionId === envelope.connectionId ? input : null;
}

function effectiveDryRun<T>(
  envelope: RuntimeEnvelopeV1,
  prepared: RuntimeExecutorPreparedInput<T>,
): boolean {
  return prepared.dryRun === true || envelopeRequestsDryRun(envelope);
}

async function executeCatalog(
  envelope: RuntimeEnvelopeV1,
  ports: NonNullable<ProviderNeutralRuntimeExecutorPorts["catalog"]>,
): Promise<RuntimeExecutionResult> {
  const prepared = await ports.prepare(envelope);
  const input = asRecord(prepared.input);
  if (!input || scopedInput(envelope, input as { connectionId: string }) === null) {
    return failure(422, "CATALOG_INPUT_SCOPE_MISMATCH");
  }
  const routedInput = effectiveDryRun(envelope, prepared)
    ? { ...input, dryRun: true }
    : input;
  const result = await handleCatalogRequest(routedInput, ports.handler);
  if (!result.ok) return failure(result.status, `CATALOG_${result.error.code}`);
  return success(`catalog:${result.mode}:${result.plan.operations.length}`);
}

async function executeSales(
  envelope: RuntimeEnvelopeV1,
  ports: NonNullable<ProviderNeutralRuntimeExecutorPorts["sales"]>,
): Promise<RuntimeExecutionResult> {
  const prepared = await ports.prepare(envelope);
  const scoped = scopedInput(envelope, prepared.input);
  if (!scoped) return failure(422, "SALES_INPUT_SCOPE_MISMATCH");
  const input: SalesHandlerInput = effectiveDryRun(envelope, prepared)
    ? { ...scoped, dryRun: true }
    : scoped;
  const result = await handleSalesRun(input, ports.handler);
  const failed = result.execution.items.filter((item) => item.status === "FAILED");
  if (failed.length > 0) {
    const retryable = failed.some((item) => item.retryable === true);
    return failure(retryable ? 503 : 422, "SALES_EXECUTION_FAILED", retryable);
  }
  if (result.execution.items.some((item) => item.status === "BUSY")) {
    return failure(503, "SALES_CLAIM_BUSY");
  }
  if (result.plan.blocked.length > 0) {
    return failure(422, "SALES_PLAN_BLOCKED");
  }
  return success(`sales:${result.execution.dryRun ? "dry-run" : "complete"}:${result.execution.items.length}`);
}

function stockInputMatchesJob(
  job: RuntimeEnvelopeV1["job"],
  input: WinerimStockMutationInput,
): boolean {
  if (job === "winerim.sales-import-historical") return input.mode === "historical";
  if (job === "winerim.sales-import-live") {
    return input.mode === "operational" && input.soldStock.variant === "glass";
  }
  if (job === "winerim.stock-apply") {
    return input.mode === "operational" && input.soldStock.variant !== "glass";
  }
  return false;
}

async function executeStock(
  envelope: RuntimeEnvelopeV1,
  ports: NonNullable<ProviderNeutralRuntimeExecutorPorts["stock"]>,
): Promise<RuntimeExecutionResult> {
  const prepared = await ports.prepare(envelope);
  if (!stockInputMatchesJob(envelope.job, prepared.input)) {
    return failure(422, "STOCK_JOB_INPUT_MISMATCH");
  }

  let plan;
  try {
    plan = planWinerimStockMutation(prepared.input);
  } catch (error) {
    if (error instanceof WinerimMutationPlanError) {
      return failure(422, `STOCK_${error.code}`);
    }
    throw error;
  }

  if (effectiveDryRun(envelope, prepared)) {
    return success(`stock:dry-run:${plan.request.kind}`);
  }

  const result = await executeWinerimMutationPlan(plan, ports.transport);
  if (result.ok) return success(`stock:complete:${result.reason}`);
  const lastAttempt = result.attempts[result.attempts.length - 1];
  const status = lastAttempt?.response?.status ?? (result.retryable ? 503 : 422);
  return failure(status, result.retryable ? "STOCK_MUTATION_RETRYABLE" : "STOCK_MUTATION_TERMINAL", result.retryable);
}

async function executeOutbound(
  envelope: RuntimeEnvelopeV1,
  ports: NonNullable<ProviderNeutralRuntimeExecutorPorts["outbound"]>,
): Promise<RuntimeExecutionResult> {
  const prepared = await ports.prepare(envelope);
  const scoped = scopedInput(envelope, prepared.input);
  if (!scoped) return failure(422, "OUTBOUND_INPUT_SCOPE_MISMATCH");
  if (effectiveDryRun(envelope, prepared)) return success("outbound:dry-run:0");
  const summary = await processOutboundTasks(scoped, ports.handler);
  return success(`outbound:complete:${summary.claimed}`);
}

export function createProviderNeutralRuntimeExecutor(
  ports: ProviderNeutralRuntimeExecutorPorts,
): RuntimeExecutor {
  return {
    async execute(envelope): Promise<RuntimeExecutionResult> {
      if (!isRuntimeEnvelope(envelope)) return failure(422, "INVALID_RUNTIME_ENVELOPE");
      try {
        if (CATALOG_JOBS.has(envelope.job)) {
          return ports.catalog
            ? executeCatalog(envelope, ports.catalog)
            : failure(503, "CATALOG_EXECUTOR_NOT_CONFIGURED");
        }
        if (SALES_JOBS.has(envelope.job)) {
          return ports.sales
            ? executeSales(envelope, ports.sales)
            : failure(503, "SALES_EXECUTOR_NOT_CONFIGURED");
        }
        if (STOCK_JOBS.has(envelope.job)) {
          return ports.stock
            ? executeStock(envelope, ports.stock)
            : failure(503, "STOCK_EXECUTOR_NOT_CONFIGURED");
        }
        if (envelope.job === "outbound.process") {
          return ports.outbound
            ? executeOutbound(envelope, ports.outbound)
            : failure(503, "OUTBOUND_EXECUTOR_NOT_CONFIGURED");
        }
        return failure(422, "UNSUPPORTED_RUNTIME_JOB");
      } catch (error) {
        if (error instanceof HttpAdapterError) {
          return failure(httpAdapterFailureStatus(error.code), error.code);
        }
        return failure(503, "RUNTIME_HANDLER_UNAVAILABLE");
      }
    },
  };
}
