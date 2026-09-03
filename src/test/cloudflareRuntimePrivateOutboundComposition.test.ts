import { describe, expect, it, vi } from "vitest";

import type { DatabaseAdapter } from "../../cloudflare/workers/middleware-api/src/db";
import {
  createPrivateOutboundLaneExecutor,
  privateOutboundEnabledJobs,
  PRIVATE_OUTBOUND_SAFETY_CONTRACT,
  PRIVATE_OUTBOUND_TASK_TYPES,
  type PrivateOutboundCompositionOptions,
} from "../../cloudflare/workers/middleware-runtime-executor/src/outbound";
import type {
  PostgresOutboundAdapter,
  PostgresOutboundProcessResult,
} from "../../cloudflare/workers/middleware-runtime/src/adapters/outbound";
import { createRuntimeEnvelope } from "../../cloudflare/workers/middleware-runtime/src/idempotency";
import { consumeRuntimeQueueBatch } from "../../cloudflare/workers/middleware-runtime/src/queue";

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";

function database(): DatabaseAdapter {
  return {
    query: vi.fn(),
    transaction: vi.fn(),
  } as unknown as DatabaseAdapter;
}

async function envelope(payload: Record<string, unknown> = {}) {
  return createRuntimeEnvelope({
    connectionId: CONNECTION_ID,
    job: "outbound.process",
    dedupeScope: "outbound-composition",
    payload,
    source: { kind: "queue", eventId: "outbound-composition" },
    createdAt: "2026-08-03T08:00:00.000Z",
  });
}

function processResult(overrides: Partial<PostgresOutboundProcessResult> = {}): PostgresOutboundProcessResult {
  return {
    dryRun: false,
    lockAcquired: true,
    summary: {
      claimed: 1,
      completed: 1,
      superseded: 0,
      retried: 0,
      terminal: 0,
      blocked: 0,
      deferred: 0,
      invalidClaims: 0,
      skippedByBreaker: false,
    },
    journal: { claimedTaskIds: [], transitions: [], logs: [] },
    ...overrides,
  };
}

function fixture(overrides: Partial<PrivateOutboundCompositionOptions> = {}) {
  const load = vi.fn(async () => ({
    connectionId: CONNECTION_ID,
    provider: "agora",
    enabled: true,
  }));
  const open = vi.fn(async () => ({ read: vi.fn(async () => "fixture-credential") }));
  const transportExecute = vi.fn();
  const transport = vi.fn(async () => ({ execute: transportExecute }));
  const process = vi.fn(async () => processResult());
  const adapterFactory = vi.fn(() => ({ process } as PostgresOutboundAdapter));
  const limiter = { acquire: vi.fn(async () => ({ granted: true as const, waitedMs: 0 })) };
  const value: PrivateOutboundCompositionOptions = {
    allowedConnectionId: CONNECTION_ID,
    database: database(),
    connections: { load },
    credentials: { open },
    transport,
    limiter,
    adapterFactory,
    ...overrides,
  };
  return { value, load, open, transport, transportExecute, process, adapterFactory, limiter };
}

describe("private outbound executor composition", () => {
  it("stays entirely disabled by default before connection, vault or task claim", async () => {
    const configured = fixture();
    const result = await createPrivateOutboundLaneExecutor(configured.value).execute(await envelope());

    expect(result).toEqual({
      ok: false,
      failure: { httpStatus: 503, message: "OUTBOUND_EXECUTION_DISABLED" },
    });
    expect(privateOutboundEnabledJobs(undefined)).toEqual([]);
    expect(configured.load).not.toHaveBeenCalled();
    expect(configured.open).not.toHaveBeenCalled();
    expect(configured.adapterFactory).not.toHaveBeenCalled();
  });

  it("allows a read-only dry-run without mutation switch, credential, limiter or transport", async () => {
    const configured = fixture({ switches: { executionEnabled: true } });
    configured.process.mockResolvedValue(processResult({ dryRun: true }));
    const result = await createPrivateOutboundLaneExecutor(configured.value).execute(await envelope({
      dryRun: true,
      taskTypes: ["AGORA_XML_UPSERT_PRODUCT"],
      limit: 2,
    }));

    expect(result).toMatchObject({ ok: true, detail: expect.stringContaining("outbound:dry-run:claimed=1") });
    expect(configured.open).not.toHaveBeenCalled();
    expect(configured.transport).not.toHaveBeenCalled();
    expect(configured.process).toHaveBeenCalledWith({
      taskTypes: ["AGORA_XML_UPSERT_PRODUCT"],
      limit: 2,
    });
    expect(configured.adapterFactory).toHaveBeenCalledWith(
      configured.value.database,
      expect.objectContaining({ execute: expect.any(Function) }),
      expect.objectContaining({ dryRun: true, connectionId: CONNECTION_ID, provider: "agora" }),
    );
    expect(privateOutboundEnabledJobs(configured.value.switches)).toEqual(["outbound.process"]);
  });

  it("requires a separate mutation switch before opening the Agora credential", async () => {
    const configured = fixture({ switches: { executionEnabled: true } });
    const result = await createPrivateOutboundLaneExecutor(configured.value).execute(await envelope());

    expect(result).toEqual({
      ok: false,
      failure: { httpStatus: 503, message: "OUTBOUND_MUTATION_DISABLED" },
    });
    expect(configured.open).not.toHaveBeenCalled();
    expect(configured.process).not.toHaveBeenCalled();
  });

  it("claims only the fixed Agora task allowlist through the shared PostgreSQL adapter", async () => {
    const configured = fixture({
      switches: { executionEnabled: true, mutationEnabled: true },
      maxBatchSize: 4,
    });
    const result = await createPrivateOutboundLaneExecutor(configured.value).execute(await envelope({ limit: 100 }));

    expect(result).toMatchObject({ ok: true, detail: expect.stringContaining("outbound:complete:claimed=1") });
    expect(configured.open).toHaveBeenCalledWith({
      connectionId: CONNECTION_ID,
      provider: "agora",
      kind: "agora",
    });
    expect(configured.transport).toHaveBeenCalledOnce();
    expect(configured.process).toHaveBeenCalledWith({
      taskTypes: PRIVATE_OUTBOUND_TASK_TYPES,
      limit: 4,
    });
    expect(privateOutboundEnabledJobs(configured.value.switches)).toEqual(["outbound.process"]);
    expect(PRIVATE_OUTBOUND_SAFETY_CONTRACT.taskClaim).toContain("SKIP_LOCKED");
  });

  it("rejects unknown or duplicate task types before connection or DB access", async () => {
    const configured = fixture({ switches: { executionEnabled: true, mutationEnabled: true } });

    await expect(createPrivateOutboundLaneExecutor(configured.value).execute(await envelope({
      taskTypes: ["AGORA_XML_UPSERT_PRODUCT", "NOT_ALLOWED"],
    }))).resolves.toEqual({
      ok: false,
      failure: { httpStatus: 422, message: "OUTBOUND_TASK_TYPES_REJECTED" },
    });
    expect(configured.load).not.toHaveBeenCalled();
    expect(configured.open).not.toHaveBeenCalled();
    expect(configured.adapterFactory).not.toHaveBeenCalled();
  });

  it("routes a busy dispatch claim to the existing Cloudflare DLQ contract at max attempts", async () => {
    const configured = fixture({ switches: { executionEnabled: true, mutationEnabled: true } });
    configured.process.mockResolvedValue(processResult({
      lockAcquired: false,
      summary: { ...processResult().summary, claimed: 0, completed: 0 },
    }));
    const runtimeEnvelope = await envelope();
    const message = {
      id: "outbound-message",
      attempts: runtimeEnvelope.maxAttempts,
      body: runtimeEnvelope,
      ack: vi.fn(),
      retry: vi.fn(),
    };
    const releaseForDeadLetter = vi.fn(async () => undefined);

    const summary = await consumeRuntimeQueueBatch({ queue: "outbound", messages: [message] }, {
      reserve: vi.fn(async () => "acquired" as const),
      execute: createPrivateOutboundLaneExecutor(configured.value).execute,
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
    expect(PRIVATE_OUTBOUND_SAFETY_CONTRACT.deadLetter).toBe("cloudflare-queue/max-attempts");
  });

  it("returns bounded diagnostics when the PostgreSQL outbound adapter fails before settlement", async () => {
    const configured = fixture({ switches: { executionEnabled: true, mutationEnabled: true } });
    configured.process.mockRejectedValue(new Error("postgres statement timeout while claiming outbound"));

    const result = await createPrivateOutboundLaneExecutor(configured.value).execute(await envelope());

    expect(result).toEqual({
      ok: false,
      failure: {
        httpStatus: 503,
        message: "OUTBOUND_PROCESS_UNAVAILABLE",
        diagnostic: {
          operation: "outbound.process",
          errorCode: "OUTBOUND_PROCESS_UNAVAILABLE",
          bodySample: "postgres statement timeout while claiming outbound",
        },
      },
    });
  });
});
