import { describe, expect, it, vi } from "vitest";

import type { DatabaseAdapter } from "../../cloudflare/workers/middleware-api/src/db";
import {
  catalogProductCanonicalFingerprint,
  createPrivateCatalogLaneExecutor,
  privateCatalogEnabledJobs,
  PRIVATE_CATALOG_SAFETY_CONTRACT,
  type PrivateCatalogCompositionOptions,
} from "../../cloudflare/workers/middleware-runtime-executor/src/catalog";
import type { PostgresCatalogAdapterFactory } from "../../cloudflare/workers/middleware-runtime/src/adapters/catalog";
import type { RuntimeJob } from "../../cloudflare/workers/middleware-runtime/src/contracts";
import { createRuntimeEnvelope } from "../../cloudflare/workers/middleware-runtime/src/idempotency";
import { consumeRuntimeQueueBatch } from "../../cloudflare/workers/middleware-runtime/src/queue";
import type {
  CatalogPlan,
  CatalogPlanningContext,
} from "../../cloudflare/workers/middleware-runtime/src/handlers/catalog";

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";

function database(): DatabaseAdapter {
  return {
    query: vi.fn(),
    transaction: vi.fn(),
  } as unknown as DatabaseAdapter;
}

async function envelope(
  job: Extract<RuntimeJob, `catalog.${string}`>,
  payload: Record<string, unknown> = {},
) {
  return createRuntimeEnvelope({
    connectionId: CONNECTION_ID,
    job,
    dedupeScope: `catalog-composition:${job}`,
    payload,
    source: { kind: "queue", eventId: `catalog-composition:${job}` },
    createdAt: "2026-08-03T08:00:00.000Z",
  });
}

function planningContext(): CatalogPlanningContext {
  return {
    provider: "agora",
    sourceRevision: "fixture-revision",
    wines: [{
      winerimId: "1",
      name: "Fixture",
      active: true,
      wineType: "tinto",
      variants: [{ format: "BOTTLE", salePrice: 20 }],
    }],
    existingFamilies: [{ id: "10", name: "TINTOS WINERIM" }],
    existingProducts: [],
    familyRouting: { byWineType: { tinto: { id: "10", name: "TINTOS WINERIM" } } },
  };
}

function fixture(overrides: Partial<PrivateCatalogCompositionOptions> = {}) {
  const load = vi.fn(async () => ({
    connectionId: CONNECTION_ID,
    provider: "agora",
    enabled: true,
  }));
  const open = vi.fn(async () => ({ read: vi.fn(async () => "fixture-credential") }));
  const loadPlanningContext = vi.fn(async () => ({ ok: true as const, context: planningContext() }));
  const applyPlan = vi.fn(async ({ plan }: { plan: { operations: { desired: { productId: string } }[] } }) => ({
    ok: true as const,
    receipt: {
      status: "applied" as const,
      appliedProductIds: plan.operations.map((operation) => operation.desired.productId),
    },
  }));
  const applyAndReadback = vi.fn(async ({ plan }: { plan: CatalogPlan }) => ({
    ok: true as const,
    receipt: {
      status: "applied" as const,
      appliedProductIds: plan.operations.map((operation) => operation.desired.productId),
      canonicalProductFingerprints: Object.fromEntries(await Promise.all(plan.operations.map(async (operation) => [
        operation.desired.productId,
        await catalogProductCanonicalFingerprint(operation.desired),
      ]))),
    },
  }));
  const adapterFactory = vi.fn(() => ({ loadPlanningContext, applyPlan })) as unknown as PostgresCatalogAdapterFactory;
  const value: PrivateCatalogCompositionOptions = {
    allowedConnectionId: CONNECTION_ID,
    database: database(),
    connections: { load },
    credentials: { open },
    adapterFactory,
    agoraApply: { applyAndReadback },
    ...overrides,
  };
  return { value, load, open, adapterFactory, loadPlanningContext, applyPlan, applyAndReadback };
}

describe("private catalog executor composition", () => {
  it("keeps every catalog job disabled by default before DB or vault access", async () => {
    const configured = fixture();
    const result = await createPrivateCatalogLaneExecutor(configured.value).execute(
      await envelope("catalog.sync-master", { dryRun: true }),
    );

    expect(result).toEqual({
      ok: false,
      failure: { httpStatus: 503, message: "CATALOG_EXECUTION_DISABLED" },
    });
    expect(privateCatalogEnabledJobs(undefined)).toEqual([]);
    expect(configured.load).not.toHaveBeenCalled();
    expect(configured.open).not.toHaveBeenCalled();
    expect(configured.adapterFactory).not.toHaveBeenCalled();
  });

  it("runs sync-master dry-run read-only without opening credentials or applying a plan", async () => {
    const configured = fixture({ switches: { executionEnabled: true } });
    const result = await createPrivateCatalogLaneExecutor(configured.value).execute(
      await envelope("catalog.sync-master", {
        dryRun: true,
        formatTypes: ["BOTTLE"],
        winerimWineIds: ["1"],
      }),
    );

    expect(result).toMatchObject({ ok: true, detail: expect.stringMatching(/^catalog:preview:1:/) });
    expect(configured.open).not.toHaveBeenCalled();
    expect(configured.loadPlanningContext).toHaveBeenCalledOnce();
    expect(configured.applyPlan).not.toHaveBeenCalled();
  });

  it("requires the separate apply switch and Agora credential before the atomic DB plan claim", async () => {
    const blocked = fixture({ switches: { executionEnabled: true } });
    await expect(createPrivateCatalogLaneExecutor(blocked.value).execute(
      await envelope("catalog.sync-master", { formatTypes: ["BOTTLE"], winerimWineIds: ["1"] }),
    )).resolves.toEqual({
      ok: false,
      failure: { httpStatus: 503, message: "CATALOG_APPLY_DISABLED" },
    });
    expect(blocked.open).not.toHaveBeenCalled();

    const enabled = fixture({ switches: { executionEnabled: true, applyEnabled: true } });
    const result = await createPrivateCatalogLaneExecutor(enabled.value).execute(
      await envelope("catalog.sync-master", { formatTypes: ["BOTTLE"], winerimWineIds: ["1"] }),
    );

    expect(result).toMatchObject({ ok: true, detail: expect.stringMatching(/^catalog:applied:1:/) });
    expect(enabled.open).toHaveBeenCalledWith({
      connectionId: CONNECTION_ID,
      provider: "agora",
      kind: "agora",
    });
    expect(enabled.applyAndReadback).toHaveBeenCalledOnce();
    expect(enabled.applyPlan).toHaveBeenCalledOnce();
    expect(enabled.applyAndReadback.mock.invocationCallOrder[0])
      .toBeLessThan(enabled.applyPlan.mock.invocationCallOrder[0]);
    expect(privateCatalogEnabledJobs(enabled.value.switches)).toEqual(["catalog.sync-master"]);
  });

  it("claims differential catalog changes and applies each format as a one-product mutation", async () => {
    const change = {
      connectionId: CONNECTION_ID,
      winerimWineId: "1",
      format: "BOTTLE" as const,
      sourceFingerprint: "a".repeat(64),
      attempt: 1,
    };
    const claim = vi.fn(async () => [change]);
    const settle = vi.fn(async () => true);
    const peek = vi.fn();
    const configured = fixture({
      switches: { executionEnabled: true, applyEnabled: true },
      changes: { claim, settle, peek },
    });

    const result = await createPrivateCatalogLaneExecutor(configured.value).execute(
      await envelope("catalog.sync-master", { scheduled: true }),
    );

    expect(result).toEqual({ ok: true, detail: "catalog:queue:complete:1:blocked=0" });
    expect(claim).toHaveBeenCalledWith({ connectionId: CONNECTION_ID, limit: 5 });
    expect(configured.loadPlanningContext).toHaveBeenCalledWith(expect.objectContaining({
      wineSelection: expect.objectContaining({ kind: "ids" }),
      formats: ["BOTTLE"],
    }));
    expect(configured.applyAndReadback).toHaveBeenCalledOnce();
    expect(settle).toHaveBeenCalledWith(change, { status: "SUCCESS" });
  });

  it("peeks but never claims or settles the differential queue during dry-run", async () => {
    const peek = vi.fn(async () => []);
    const claim = vi.fn();
    const settle = vi.fn();
    const configured = fixture({
      switches: { executionEnabled: true },
      changes: { claim, settle, peek },
    });

    await expect(createPrivateCatalogLaneExecutor(configured.value).execute(
      await envelope("catalog.sync-master", { scheduled: true, dryRun: true }),
    )).resolves.toEqual({ ok: true, detail: "catalog:queue:idle:0" });
    expect(peek).toHaveBeenCalledOnce();
    expect(claim).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });

  it("fails closed before DB persistence when Agora readback is incomplete", async () => {
    const applyAndReadback = vi.fn(async () => ({
      ok: true as const,
      receipt: {
        status: "applied" as const,
        appliedProductIds: [],
        canonicalProductFingerprints: {},
      },
    }));
    const configured = fixture({
      switches: { executionEnabled: true, applyEnabled: true },
      agoraApply: { applyAndReadback },
    });

    const result = await createPrivateCatalogLaneExecutor(configured.value).execute(
      await envelope("catalog.sync-master", { formatTypes: ["BOTTLE"], winerimWineIds: ["1"] }),
    );

    expect(result).toMatchObject({
      ok: false,
      failure: { httpStatus: 409, message: "CATALOG_APPLY_CONFLICT" },
    });
    expect(applyAndReadback).toHaveBeenCalledOnce();
    expect(configured.applyPlan).not.toHaveBeenCalled();
  });

  it("keeps Winerim refresh behind its own port, credential and idempotency identity", async () => {
    const refresh = vi.fn(async () => ({ ok: true as const, outcome: "duplicate" as const, changed: 0 }));
    const configured = fixture({
      switches: { executionEnabled: true, fetchEnabled: true },
      refresh: { refresh },
    });
    const runtimeEnvelope = await envelope("catalog.fetch-winerim");
    const result = await createPrivateCatalogLaneExecutor(configured.value).execute(runtimeEnvelope);

    expect(result).toEqual({ ok: true, detail: "catalog:fetch:duplicate:0" });
    expect(refresh).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: CONNECTION_ID,
      messageId: runtimeEnvelope.messageId,
      idempotencyKey: runtimeEnvelope.idempotencyKey,
      dryRun: false,
      credential: expect.objectContaining({ read: expect.any(Function) }),
    }));
    expect(privateCatalogEnabledJobs(configured.value.switches)).toEqual([
      "catalog.fetch-winerim",
      "catalog.sync-master",
    ]);
  });

  it("produces a retryable result that the existing queue contract hands to DLQ at max attempts", async () => {
    const configured = fixture({
      switches: { executionEnabled: true, fetchEnabled: true },
      refresh: { refresh: vi.fn(async () => { throw new Error("sensitive upstream detail"); }) },
    });
    const runtimeEnvelope = await envelope("catalog.fetch-winerim");
    const message = {
      id: "catalog-message",
      attempts: runtimeEnvelope.maxAttempts,
      body: runtimeEnvelope,
      ack: vi.fn(),
      retry: vi.fn(),
    };
    const releaseForDeadLetter = vi.fn(async () => undefined);

    const summary = await consumeRuntimeQueueBatch({ queue: "catalog", messages: [message] }, {
      reserve: vi.fn(async () => "acquired" as const),
      execute: createPrivateCatalogLaneExecutor(configured.value).execute,
      complete: vi.fn(async () => undefined),
      releaseForRetry: vi.fn(async () => undefined),
      releaseForDeadLetter,
      recordTerminal: vi.fn(async () => undefined),
    });

    expect(summary).toMatchObject({ retried: 1, acknowledged: 0 });
    expect(releaseForDeadLetter).toHaveBeenCalledWith(runtimeEnvelope, expect.objectContaining({
      reason: "attempts_exhausted",
    }));
    expect(message.retry).toHaveBeenCalledOnce();
    expect(JSON.stringify(releaseForDeadLetter.mock.calls)).not.toContain("sensitive upstream detail");
    expect(PRIVATE_CATALOG_SAFETY_CONTRACT.deadLetter).toBe("cloudflare-queue/max-attempts");
  });

  it("does not expose provider diagnostics returned by the refresh port", async () => {
    const configured = fixture({
      switches: { executionEnabled: true, fetchEnabled: true },
      refresh: {
        refresh: vi.fn(async () => ({
          ok: false as const,
          httpStatus: 503,
          message: "Authorization: Bearer sensitive-refresh-token",
        })),
      },
    });

    const result = await createPrivateCatalogLaneExecutor(configured.value).execute(
      await envelope("catalog.fetch-winerim"),
    );

    expect(result).toEqual({
      ok: false,
      failure: { httpStatus: 503, message: "CATALOG_FETCH_UNAVAILABLE" },
    });
    expect(JSON.stringify(result)).not.toContain("sensitive-refresh-token");
  });
});
