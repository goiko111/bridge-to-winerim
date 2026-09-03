import { describe, expect, it } from "vitest";

import {
  RUNTIME_CATALOG_EXECUTOR_TIMEOUT_MS,
  RUNTIME_EXECUTOR_TIMEOUT_MS,
  RUNTIME_SALES_EXECUTOR_TIMEOUT_MS,
  runtimeExecutorTimeoutMs,
  runtimeIdempotencyLeaseMinutes,
  runtimeSingleFlightKey,
} from "./executionPolicy";
import { classifyRuntimeFailure } from "./retry";

describe("runtime execution policy", () => {
  it("keeps catalog and sales leases beyond their executor timeouts", () => {
    expect(RUNTIME_EXECUTOR_TIMEOUT_MS).toBe(60_000);
    expect(RUNTIME_CATALOG_EXECUTOR_TIMEOUT_MS).toBe(210_000);
    expect(RUNTIME_SALES_EXECUTOR_TIMEOUT_MS).toBe(300_000);
    expect(runtimeExecutorTimeoutMs("catalog.sync-master")).toBe(210_000);
    expect(runtimeIdempotencyLeaseMinutes("catalog.sync-master") * 60_000)
      .toBeGreaterThan(runtimeExecutorTimeoutMs("catalog.sync-master"));
    expect(runtimeIdempotencyLeaseMinutes("sales.auto-sync") * 60_000)
      .toBeGreaterThan(runtimeExecutorTimeoutMs("sales.auto-sync"));
  });

  it("isolates single-flight keys by connection and job", () => {
    const clinicCatalog = runtimeSingleFlightKey({
      connectionId: "1c5177f1-9459-4ee9-8b6e-4780f8b6b96b",
      job: "catalog.sync-master",
    });
    const clinicSales = runtimeSingleFlightKey({
      connectionId: "1c5177f1-9459-4ee9-8b6e-4780f8b6b96b",
      job: "sales.auto-sync",
    });
    const tallerCatalog = runtimeSingleFlightKey({
      connectionId: "4f6cb49d-d1cd-4426-90d4-623bc359c257",
      job: "catalog.sync-master",
    });

    expect(clinicCatalog).not.toBe(clinicSales);
    expect(clinicCatalog).not.toBe(tallerCatalog);
  });

  it("classifies internal executor timeouts without opening the POS breaker", () => {
    expect(classifyRuntimeFailure({
      profile: "POS_OUTBOUND",
      httpStatus: 408,
      message: "RUNTIME_EXECUTOR_TIMEOUT",
      diagnostic: {
        operation: "runtime.executor",
        route: "service-binding:/v1/execute",
        elapsedMs: 210_000,
        errorCode: "RUNTIME_EXECUTOR_TIMEOUT",
      },
    })).toMatchObject({
      class: "TRANSIENT_UPSTREAM",
      retryable: true,
      countsForCircuitBreaker: false,
      reason: "runtime_executor_timeout",
      diagnostic: {
        elapsedMs: 210_000,
        errorCode: "RUNTIME_EXECUTOR_TIMEOUT",
      },
    });
  });
});
