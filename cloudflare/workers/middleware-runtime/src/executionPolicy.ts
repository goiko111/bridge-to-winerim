import type { RuntimeEnvelopeV1 } from "./contracts";

export const RUNTIME_EXECUTOR_TIMEOUT_MS = 60_000;
export const RUNTIME_CATALOG_EXECUTOR_TIMEOUT_MS = 210_000;
export const RUNTIME_SALES_EXECUTOR_TIMEOUT_MS = 300_000;

export function runtimeExecutorTimeoutMs(job: RuntimeEnvelopeV1["job"]): number {
  if (job === "catalog.sync-master") return RUNTIME_CATALOG_EXECUTOR_TIMEOUT_MS;
  return job === "sales.auto-sync"
    || job === "sales.sync-intraday"
    || job === "sales.sync-open-tickets"
    ? RUNTIME_SALES_EXECUTOR_TIMEOUT_MS
    : RUNTIME_EXECUTOR_TIMEOUT_MS;
}

export function runtimeIdempotencyLeaseMinutes(job: RuntimeEnvelopeV1["job"]): number {
  if (job === "catalog.sync-master") return 5;
  return job === "sales.auto-sync"
    || job === "sales.sync-intraday"
    || job === "sales.sync-open-tickets"
    ? 6
    : 2;
}

export function runtimeSingleFlightKey(envelope: Pick<RuntimeEnvelopeV1, "connectionId" | "job">): string {
  return `runtime-singleflight:${envelope.connectionId}:${envelope.job}`;
}
