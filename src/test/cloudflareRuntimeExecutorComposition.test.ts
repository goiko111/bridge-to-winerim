import { describe, expect, it, vi } from "vitest";

import type { RuntimeJob } from "../../cloudflare/workers/middleware-runtime/src/contracts";
import {
  createConnectionScopedRuntimeExecutor,
  createRuntimeExecutorService,
  type RuntimeCredentialKind,
  type RuntimeExecutorCompositionOptions,
} from "../../cloudflare/workers/middleware-runtime/src/executor";
import { createRuntimeEnvelope } from "../../cloudflare/workers/middleware-runtime/src/idempotency";

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_CONNECTION_ID = "22222222-2222-4222-8222-222222222222";
const ALL_RUNTIME_JOBS: readonly RuntimeJob[] = [
  "catalog.fetch-winerim",
  "catalog.sync-master",
  "sales.auto-sync",
  "sales.sync-intraday",
  "sales.sync-open-tickets",
  "outbound.process",
  "winerim.sales-import-live",
  "winerim.sales-import-historical",
  "winerim.stock-apply",
  "maintenance.reconcile",
];

async function envelope(job: RuntimeJob, dryRun = false) {
  return createRuntimeEnvelope({
    connectionId: CONNECTION_ID,
    job,
    dedupeScope: `composition:${job}:${dryRun}`,
    payload: dryRun ? { dryRun: true } : {},
    source: { kind: "queue", eventId: `composition:${job}` },
    createdAt: "2026-08-02T12:00:00.000Z",
  });
}

function options(overrides: Partial<RuntimeExecutorCompositionOptions> = {}) {
  const open = vi.fn(async ({ kind }: { kind: RuntimeCredentialKind }) => ({
    read: vi.fn(async () => `${kind}-fixture-value`),
  }));
  const create = vi.fn(async (context) => ({
    stock: {
      prepare: async () => ({
        dryRun: true,
        input: {
          mode: "operational" as const,
          orderId: context.envelope.idempotencyKey,
          soldAt: "2026-08-02T12:00:00.000Z",
          quantity: 1,
          soldStock: { wineId: "42", stockId: 4202, variant: "glass" as const },
          stockSource: { wineId: "42", stockId: 4201, variant: "bottle" as const },
        },
      }),
      transport: {
        send: vi.fn(async () => ({ status: 200 })),
        sleep: vi.fn(async () => undefined),
      },
    },
  }));
  const base: RuntimeExecutorCompositionOptions = {
    environment: "staging",
    executionEnabled: true,
    allowedConnectionId: CONNECTION_ID,
    enabledJobs: ALL_RUNTIME_JOBS,
    connections: {
      load: vi.fn(async (connectionId) => ({ connectionId, provider: "agora", enabled: true })),
    },
    credentials: { open },
    ports: { create },
  };
  return {
    value: { ...base, ...overrides } as RuntimeExecutorCompositionOptions,
    open,
    create,
  };
}

describe("connection-scoped runtime executor composition", () => {
  it("keeps execution disabled by default without loading configuration or secrets", async () => {
    const fixture = options({ executionEnabled: undefined });
    const runtime = createConnectionScopedRuntimeExecutor(fixture.value);

    await expect(runtime.execute(await envelope("winerim.sales-import-live", true))).resolves.toEqual({
      ok: false,
      failure: { httpStatus: 503, message: "RUNTIME_EXECUTION_DISABLED" },
    });
    expect(fixture.value.connections.load).not.toHaveBeenCalled();
    expect(fixture.open).not.toHaveBeenCalled();
    expect(fixture.create).not.toHaveBeenCalled();
  });

  it("fails closed outside staging even when the execution flag is true", async () => {
    const fixture = options({ environment: "production" });
    const runtime = createConnectionScopedRuntimeExecutor(fixture.value);

    await expect(runtime.execute(await envelope("winerim.sales-import-live", true))).resolves.toMatchObject({
      ok: false,
      failure: { message: "RUNTIME_EXECUTION_DISABLED" },
    });
    expect(fixture.open).not.toHaveBeenCalled();
  });

  it("fails closed when the deployment does not explicitly allowlist the job", async () => {
    const fixture = options({ enabledJobs: [] });
    await expect(createConnectionScopedRuntimeExecutor(fixture.value).execute(
      await envelope("winerim.sales-import-live", true),
    )).resolves.toEqual({
      ok: false,
      failure: { httpStatus: 503, message: "RUNTIME_JOB_NOT_ENABLED" },
    });
    expect(fixture.value.connections.load).not.toHaveBeenCalled();
    expect(fixture.open).not.toHaveBeenCalled();
  });

  it("rejects an envelope outside the single canary connection before database access", async () => {
    const fixture = options({ allowedConnectionId: SECOND_CONNECTION_ID });
    await expect(createConnectionScopedRuntimeExecutor(fixture.value).execute(
      await envelope("winerim.sales-import-live", true),
    )).resolves.toEqual({
      ok: false,
      failure: { httpStatus: 422, message: "RUNTIME_CANARY_CONNECTION_REJECTED" },
    });
    expect(fixture.value.connections.load).not.toHaveBeenCalled();
    expect(fixture.open).not.toHaveBeenCalled();
  });

  it("rejects a cross-connection configuration before opening any credential", async () => {
    const fixture = options({
      connections: {
        load: vi.fn(async () => ({
          connectionId: SECOND_CONNECTION_ID,
          provider: "agora",
          enabled: true,
        })),
      },
    });

    await expect(createConnectionScopedRuntimeExecutor(fixture.value).execute(
      await envelope("sales.sync-intraday"),
    )).resolves.toEqual({
      ok: false,
      failure: { httpStatus: 422, message: "RUNTIME_CONNECTION_SCOPE_REJECTED" },
    });
    expect(fixture.open).not.toHaveBeenCalled();
    expect(fixture.create).not.toHaveBeenCalled();
  });

  it("opens only the Winerim secret port needed by a live stock job", async () => {
    const fixture = options();
    const runtimeEnvelope = await envelope("winerim.sales-import-live");
    const runtime = createConnectionScopedRuntimeExecutor(fixture.value);

    await runtime.execute(runtimeEnvelope);

    expect(fixture.open).toHaveBeenCalledTimes(1);
    expect(fixture.open).toHaveBeenCalledWith({
      connectionId: CONNECTION_ID,
      provider: "agora",
      kind: "winerim",
    });
    const context = fixture.create.mock.calls[0][0];
    expect(context.credentials).toEqual({ winerim: expect.objectContaining({ read: expect.any(Function) }) });
    expect(context.envelope.idempotencyKey).toBe(runtimeEnvelope.idempotencyKey);
    expect(context.envelope).not.toBe(runtimeEnvelope);
  });

  it("does not open mutation credentials for stock or outbound dry-runs", async () => {
    const fixture = options();
    await createConnectionScopedRuntimeExecutor(fixture.value).execute(
      await envelope("winerim.sales-import-live", true),
    );
    expect(fixture.open).not.toHaveBeenCalled();
  });

  it("opens Agora and Winerim ports for live sales and Agora only for sales dry-run", async () => {
    const live = options({ ports: { create: vi.fn(async () => ({})) } });
    await createConnectionScopedRuntimeExecutor(live.value).execute(
      await envelope("sales.sync-intraday"),
    );
    expect(live.open.mock.calls.map(([input]) => input.kind)).toEqual(["agora", "winerim"]);

    const dryRun = options({ ports: { create: vi.fn(async () => ({})) } });
    await createConnectionScopedRuntimeExecutor(dryRun.value).execute(
      await envelope("sales.sync-intraday", true),
    );
    expect(dryRun.open.mock.calls.map(([input]) => input.kind)).toEqual(["agora"]);
  });

  it("fails closed when a required credential port is unavailable", async () => {
    const fixture = options({
      credentials: { open: vi.fn(async () => null) },
    });

    await expect(createConnectionScopedRuntimeExecutor(fixture.value).execute(
      await envelope("winerim.sales-import-live"),
    )).resolves.toEqual({
      ok: false,
      failure: { httpStatus: 503, message: "RUNTIME_CREDENTIAL_UNAVAILABLE" },
    });
    expect(fixture.create).not.toHaveBeenCalled();
  });

  it("never propagates secret-bearing errors from secure ports", async () => {
    const fixture = options({
      credentials: {
        open: vi.fn(async () => {
          throw new Error("vault failure contained sensitive fixture material");
        }),
      },
    });

    const result = await createConnectionScopedRuntimeExecutor(fixture.value).execute(
      await envelope("winerim.sales-import-live"),
    );
    expect(result).toEqual({
      ok: false,
      failure: { httpStatus: 503, message: "RUNTIME_COMPOSITION_UNAVAILABLE" },
    });
    expect(JSON.stringify(result)).not.toContain("sensitive fixture material");
  });

  it("freezes the detached envelope before a provider factory can alter dry-run or idempotency", async () => {
    const fixture = options({
      ports: {
        create: vi.fn(async ({ envelope: scopedEnvelope }) => {
          (scopedEnvelope.payload as { dryRun?: boolean }).dryRun = false;
          return {};
        }),
      },
    });
    const original = await envelope("winerim.sales-import-live", true);

    await expect(createConnectionScopedRuntimeExecutor(fixture.value).execute(original)).resolves.toEqual({
      ok: false,
      failure: { httpStatus: 503, message: "RUNTIME_COMPOSITION_UNAVAILABLE" },
    });
    expect(original.payload).toEqual({ dryRun: true });
  });

  it("is directly composable behind the private executor service route", async () => {
    const fixture = options();
    const service = createRuntimeExecutorService(createConnectionScopedRuntimeExecutor(fixture.value));
    const response = await service.fetch(new Request("https://executor.internal/v1/execute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ envelope: await envelope("winerim.sales-import-live", true) }),
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, detail: "stock:dry-run:sales-import" });
  });

  it("rejects secret-shaped fields before loading configuration or opening the vault", async () => {
    const fixture = options();
    const runtimeEnvelope = await envelope("winerim.sales-import-live", true);
    runtimeEnvelope.payload = { dryRun: true, nested: { api_token: "must-not-enter-queue" } };
    const service = createRuntimeExecutorService(createConnectionScopedRuntimeExecutor(fixture.value));
    const response = await service.fetch(new Request("https://executor.internal/v1/execute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ envelope: runtimeEnvelope }),
    }));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      failure: { httpStatus: 422, message: "SENSITIVE_RUNTIME_PAYLOAD_REJECTED" },
    });
    expect(fixture.value.connections.load).not.toHaveBeenCalled();
    expect(fixture.open).not.toHaveBeenCalled();
  });
});
