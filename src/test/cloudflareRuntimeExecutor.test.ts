import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import type { RuntimeEnvelopeV1, RuntimeJob } from "../../cloudflare/workers/middleware-runtime/src/contracts";
import { createProviderNeutralRuntimeExecutor } from "../../cloudflare/workers/middleware-runtime/src/executor";
import type { CatalogPlanningContext } from "../../cloudflare/workers/middleware-runtime/src/handlers/catalog";
import type { OutboundPorts } from "../../cloudflare/workers/middleware-runtime/src/handlers/outbound";
import type { SalesHandlerPorts, SalesLineResolution } from "../../cloudflare/workers/middleware-runtime/src/handlers/sales";
import type {
  WinerimMutationResponse,
  WinerimMutationTransport,
} from "../../cloudflare/workers/middleware-runtime/src/handlers/stock";
import { createRuntimeEnvelope } from "../../cloudflare/workers/middleware-runtime/src/idempotency";
import { classifyRuntimeFailure } from "../../cloudflare/workers/middleware-runtime/src/retry";

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";

async function envelope(
  job: RuntimeJob,
  payload: RuntimeEnvelopeV1["payload"] = {},
): Promise<RuntimeEnvelopeV1> {
  return createRuntimeEnvelope({
    connectionId: CONNECTION_ID,
    job,
    dedupeScope: `executor-test:${job}`,
    payload,
    source: { kind: "api", eventId: `event:${job}` },
    createdAt: "2026-08-02T12:00:00.000Z",
  });
}

function catalogContext(): CatalogPlanningContext {
  return {
    provider: "fixture-pos",
    sourceRevision: "revision-1",
    wines: [{
      winerimId: "42",
      name: "Wine",
      wineType: "red",
      variants: [{ format: "BOTTLE", salePrice: 20 }],
    }],
    existingFamilies: [{ id: "10", name: "RED WINERIM" }],
    existingProducts: [],
    familyRouting: { byWineType: { red: { id: "10", name: "RED WINERIM" } } },
  };
}

function salesPorts(
  resolution: SalesLineResolution = {
    winerimWineId: "42",
    variant: "BOTTLE",
    stockId: "4201",
    stockActive: true,
  },
): SalesHandlerPorts {
  return {
    resolveLine: vi.fn().mockResolvedValue(resolution),
    loadClaims: vi.fn().mockResolvedValue([]),
    persistDocuments: vi.fn().mockResolvedValue(undefined),
    reserveClaim: vi.fn().mockResolvedValue({ state: "ACQUIRED", appliedQuantity: 0 }),
    applyStock: vi.fn().mockResolvedValue({ ok: true, stockMoved: true }),
    importSales: vi.fn().mockResolvedValue({ ok: true, lines: [{ stockApplied: true }] }),
    completeClaim: vi.fn().mockResolvedValue(undefined),
    releaseClaim: vi.fn().mockResolvedValue(undefined),
  };
}

function salesInput() {
  return {
    connectionId: CONNECTION_ID,
    provider: "fixture-pos",
    runKind: "INTRADAY" as const,
    documents: [{
      provider: "fixture-pos",
      documentId: "invoice-1",
      lifecycleId: "sale-cycle-1",
      identitySource: "PROVIDER" as const,
      businessDay: "2026-08-02",
      kind: "DEFINITIVE_INVOICE" as const,
      isRefund: false,
      lines: [{
        lineId: "line-1",
        providerProductId: "provider-product-42",
        productName: "Wine",
        quantity: 1,
        suggestedVariant: "BOTTLE" as const,
      }],
    }],
  };
}

function outboundPorts(): OutboundPorts {
  return {
    clock: { now: () => new Date("2026-08-02T12:00:00.000Z") },
    tasks: {
      claim: vi.fn().mockResolvedValue([]),
      transition: vi.fn().mockResolvedValue(undefined),
    },
    breaker: {
      read: vi.fn().mockResolvedValue({ consecutiveFailures: 0, pausedUntil: null, reason: null }),
      record: vi.fn().mockResolvedValue({ consecutiveFailures: 0, pausedUntil: null, reason: null }),
    },
    limiter: { acquire: vi.fn().mockResolvedValue({ granted: true, waitedMs: 0 }) },
    executor: { execute: vi.fn().mockResolvedValue({ kind: "success" }) },
    logger: { write: vi.fn().mockResolvedValue(undefined) },
  };
}

function transportFor(responses: WinerimMutationResponse[]): WinerimMutationTransport & {
  send: ReturnType<typeof vi.fn>;
  sleep: ReturnType<typeof vi.fn>;
} {
  const queue = [...responses];
  return {
    send: vi.fn(async () => {
      const response = queue.shift();
      if (!response) throw new Error("test response queue exhausted");
      return response;
    }),
    sleep: vi.fn().mockResolvedValue(undefined),
  };
}

describe("provider-neutral Cloudflare runtime executor", () => {
  it("routes catalog work and forces an envelope dry-run without applying the plan", async () => {
    const applyPlan = vi.fn();
    const prepare = vi.fn().mockResolvedValue({
      input: { action: "catalog.apply", connectionId: CONNECTION_ID },
    });
    const loadPlanningContext = vi.fn().mockResolvedValue({ ok: true, context: catalogContext() });
    const executor = createProviderNeutralRuntimeExecutor({
      catalog: { prepare, handler: { loadPlanningContext, applyPlan } },
    });

    const result = await executor.execute(await envelope("catalog.sync-master", { dryRun: true }));

    expect(result).toEqual({ ok: true, detail: "catalog:preview:1" });
    expect(prepare).toHaveBeenCalledOnce();
    expect(loadPlanningContext).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
    expect(applyPlan).not.toHaveBeenCalled();
  });

  it("routes sales work and keeps every mutation port closed in dry-run mode", async () => {
    const handler = salesPorts();
    const prepare = vi.fn().mockResolvedValue({ input: salesInput(), dryRun: true });
    const executor = createProviderNeutralRuntimeExecutor({ sales: { prepare, handler } });

    const result = await executor.execute(await envelope("sales.sync-intraday"));

    expect(result).toMatchObject({ ok: true, detail: "sales:dry-run:1" });
    expect(prepare).toHaveBeenCalledOnce();
    expect(handler.resolveLine).toHaveBeenCalledOnce();
    expect(handler.persistDocuments).not.toHaveBeenCalled();
    expect(handler.reserveClaim).not.toHaveBeenCalled();
    expect(handler.applyStock).not.toHaveBeenCalled();
    expect(handler.importSales).not.toHaveBeenCalled();
    expect(handler.completeClaim).not.toHaveBeenCalled();
    expect(handler.releaseClaim).not.toHaveBeenCalled();
  });

  it("routes stock work, validates the job contract and performs no transport I/O in dry-run", async () => {
    const transport = transportFor([]);
    const prepare = vi.fn().mockResolvedValue({
      dryRun: true,
      input: {
        mode: "operational",
        orderId: "fixture:glass:1",
        soldAt: "2026-08-02T12:00:00.000Z",
        quantity: 1,
        soldStock: { wineId: "42", stockId: 4202, variant: "glass" },
        stockSource: { wineId: "42", stockId: 4201, variant: "bottle" },
      },
    });
    const executor = createProviderNeutralRuntimeExecutor({ stock: { prepare, transport } });

    const result = await executor.execute(await envelope("winerim.sales-import-live"));

    expect(result).toEqual({ ok: true, detail: "stock:dry-run:sales-import" });
    expect(prepare).toHaveBeenCalledOnce();
    expect(transport.send).not.toHaveBeenCalled();
    expect(transport.sleep).not.toHaveBeenCalled();
  });

  it("routes outbound work and does not even inspect mutable ports in dry-run mode", async () => {
    const handler = outboundPorts();
    const prepare = vi.fn().mockResolvedValue({
      input: {
        connectionId: CONNECTION_ID,
        provider: "fixture-pos",
        taskTypes: ["UPSERT_PRODUCT"],
        limit: 2,
      },
    });
    const executor = createProviderNeutralRuntimeExecutor({ outbound: { prepare, handler } });

    const result = await executor.execute(await envelope("outbound.process", { dryRun: true }));

    expect(result).toEqual({ ok: true, detail: "outbound:dry-run:0" });
    expect(prepare).toHaveBeenCalledOnce();
    expect(handler.breaker.read).not.toHaveBeenCalled();
    expect(handler.tasks.claim).not.toHaveBeenCalled();
    expect(handler.tasks.transition).not.toHaveBeenCalled();
    expect(handler.executor.execute).not.toHaveBeenCalled();
  });

  it("uses the existing outbound handler for a live empty batch", async () => {
    const handler = outboundPorts();
    const executor = createProviderNeutralRuntimeExecutor({
      outbound: {
        prepare: async () => ({
          input: { connectionId: CONNECTION_ID, provider: "fixture-pos", taskTypes: ["UPSERT_PRODUCT"] },
        }),
        handler,
      },
    });

    const result = await executor.execute(await envelope("outbound.process"));

    expect(result).toEqual({ ok: true, detail: "outbound:complete:0" });
    expect(handler.breaker.read).toHaveBeenCalledWith(CONNECTION_ID);
    expect(handler.tasks.claim).toHaveBeenCalledOnce();
  });

  it("fails closed for unsupported jobs and classifies the result as terminal", async () => {
    const prepare = vi.fn();
    const executor = createProviderNeutralRuntimeExecutor({
      catalog: {
        prepare,
        handler: { loadPlanningContext: vi.fn() },
      },
    });
    const runtimeEnvelope = await envelope("maintenance.reconcile");

    const result = await executor.execute(runtimeEnvelope);

    expect(result).toEqual({
      ok: false,
      failure: { httpStatus: 422, message: "UNSUPPORTED_RUNTIME_JOB" },
    });
    expect(prepare).not.toHaveBeenCalled();
    if (result.ok) throw new Error("expected a failed execution");
    expect(classifyRuntimeFailure({ ...result.failure, profile: runtimeEnvelope.retryProfile })).toMatchObject({
      class: "BUSINESS_ERROR",
      retryable: false,
    });
  });

  it("classifies absent lane configuration and Winerim conflicts as retryable", async () => {
    const missingEnvelope = await envelope("catalog.fetch-winerim");
    const missing = await createProviderNeutralRuntimeExecutor({}).execute(missingEnvelope);
    if (missing.ok) throw new Error("expected missing lane failure");
    expect(missing.failure).toEqual({ httpStatus: 503, message: "CATALOG_EXECUTOR_NOT_CONFIGURED" });
    expect(classifyRuntimeFailure({ ...missing.failure, profile: missingEnvelope.retryProfile })).toMatchObject({
      class: "TRANSIENT_UPSTREAM",
      retryable: true,
    });

    const transport = transportFor([
      { status: 409 },
      { status: 409 },
      { status: 409 },
    ]);
    const conflictEnvelope = await envelope("winerim.sales-import-live");
    const conflict = await createProviderNeutralRuntimeExecutor({
      stock: {
        prepare: async () => ({
          input: {
            mode: "operational",
            orderId: "fixture:glass:conflict",
            soldAt: "2026-08-02T12:00:00.000Z",
            quantity: 1,
            soldStock: { wineId: "42", stockId: 4202, variant: "glass" },
            stockSource: { wineId: "42", stockId: 4201, variant: "bottle" },
          },
        }),
        transport,
      },
    }).execute(conflictEnvelope);

    if (conflict.ok) throw new Error("expected conflict failure");
    expect(conflict.failure).toEqual({
      httpStatus: 409,
      message: "STOCK_MUTATION_RETRYABLE",
      retryableLine: true,
    });
    expect(classifyRuntimeFailure({ ...conflict.failure, profile: conflictEnvelope.retryProfile })).toMatchObject({
      class: "WINERIM_CONFLICT",
      retryable: true,
    });
    expect(transport.send).toHaveBeenCalledTimes(3);
  });

  it("rejects cross-connection prepared input before invoking a handler", async () => {
    const loadPlanningContext = vi.fn();
    const executor = createProviderNeutralRuntimeExecutor({
      catalog: {
        prepare: async () => ({ input: { action: "catalog.preview", connectionId: "other-connection" } }),
        handler: { loadPlanningContext },
      },
    });

    await expect(executor.execute(await envelope("catalog.fetch-winerim"))).resolves.toEqual({
      ok: false,
      failure: { httpStatus: 422, message: "CATALOG_INPUT_SCOPE_MISMATCH" },
    });
    expect(loadPlanningContext).not.toHaveBeenCalled();
  });

  it("contains no direct network transport or embedded credential handling", () => {
    const files = ["contracts.ts", "executor.ts", "index.ts"];
    const source = files.map((file) => readFileSync(
      `${process.cwd()}/cloudflare/workers/middleware-runtime/src/executor/${file}`,
      "utf8",
    )).join("\n");

    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/authorization|bearer|api[_-]?token|service[_-]?role|client[_-]?secret/i);
  });
});
