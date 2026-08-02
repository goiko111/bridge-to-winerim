import { describe, expect, it, vi } from "vitest";

import type {
  DatabaseAdapter,
  DatabaseTransaction,
  QueryResult,
  SqlStatement,
} from "../../cloudflare/workers/middleware-api/src/db";
import type { RuntimeJob } from "../../cloudflare/workers/middleware-runtime/src/contracts";
import { createRuntimeEnvelope } from "../../cloudflare/workers/middleware-runtime/src/idempotency";
import {
  createMiddlewareRuntimeExecutorWorker,
  type MiddlewareRuntimeExecutorEnv,
} from "../../cloudflare/workers/middleware-runtime-executor/src/worker";

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";

function result<Row extends Record<string, unknown>>(rows: Row[]): QueryResult<Row> {
  return { rows, rowCount: rows.length };
}

function fakeDatabase(rows: Record<string, unknown>[] = []) {
  const query = vi.fn(async <Row extends Record<string, unknown>>(_statement: SqlStatement) => (
    result(rows as Row[])
  ));
  const adapter: DatabaseAdapter = {
    query,
    transaction: async <T>(work: (transaction: DatabaseTransaction) => Promise<T>) => work({ query }),
  };
  return { adapter, query };
}

async function envelope(job: RuntimeJob, payload: Record<string, unknown>) {
  return createRuntimeEnvelope({
    connectionId: CONNECTION_ID,
    job,
    dedupeScope: `private-executor:${job}:fixture`,
    payload,
    source: { kind: "queue", eventId: `private-executor:${job}` },
    createdAt: "2026-08-02T12:00:00.000Z",
  });
}

function enabledEnv(overrides: Partial<MiddlewareRuntimeExecutorEnv> = {}): MiddlewareRuntimeExecutorEnv {
  return {
    ENVIRONMENT: "staging",
    RELEASE: "fixture",
    RUNTIME_EXECUTION_ENABLED: "true",
    RUNTIME_VAULT_KEY_VERSION: "v1",
    WINERIM_API_BASE_URL: "https://app.winerim.com",
    WINERIM_ALLOWED_HOSTS: "app.winerim.com",
    MIDDLEWARE_DB: { connectionString: "postgres://fixture.invalid/staging" },
    RUNTIME_VAULT_KEY: { get: vi.fn(async () => "unused-for-dry-run") },
    ...overrides,
  };
}

function executeRequest(runtimeEnvelope: unknown) {
  return new Request("https://runtime-executor.internal/v1/execute", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ envelope: runtimeEnvelope }),
  });
}

describe("private runtime executor Worker", () => {
  it("stays disabled by default without opening PostgreSQL or the vault", async () => {
    const database = vi.fn();
    const worker = createMiddlewareRuntimeExecutorWorker({ database });
    const response = await worker.fetch(executeRequest(await envelope(
      "winerim.sales-import-live",
      { dryRun: true },
    )), { ENVIRONMENT: "staging", RUNTIME_EXECUTION_ENABLED: "false" });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      failure: { httpStatus: 503, message: "RUNTIME_EXECUTION_DISABLED" },
    });
    expect(database).not.toHaveBeenCalled();
  });

  it("advertises missing private bindings without reading secret values", async () => {
    const worker = createMiddlewareRuntimeExecutorWorker();
    const response = await worker.fetch(new Request("https://runtime-executor.internal/ready"), {
      ENVIRONMENT: "staging",
      RUNTIME_EXECUTION_ENABLED: "false",
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      stagingOnly: true,
      executionEnabled: false,
      missingBindings: expect.arrayContaining([
        "MIDDLEWARE_DB",
        "RUNTIME_VAULT_KEY",
        "RUNTIME_VAULT_KEY_VERSION",
      ]),
    });
  });

  it("allows only the narrow stock mutation job set", async () => {
    const fake = fakeDatabase();
    const worker = createMiddlewareRuntimeExecutorWorker({ database: () => fake.adapter });
    const response = await worker.fetch(executeRequest(await envelope(
      "catalog.fetch-winerim",
      { dryRun: true },
    )), enabledEnv());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      failure: { httpStatus: 503, message: "RUNTIME_JOB_NOT_ENABLED" },
    });
    expect(fake.query).not.toHaveBeenCalled();
  });

  it("executes a stock dry-run without reading a credential or making HTTP requests", async () => {
    const fake = fakeDatabase([{
      connection_id: CONNECTION_ID,
      provider: "agora",
      enabled: true,
    }]);
    const request = vi.fn<typeof fetch>();
    const env = enabledEnv();
    const worker = createMiddlewareRuntimeExecutorWorker({
      database: () => fake.adapter,
      request,
      sleep: vi.fn(async () => undefined),
    });
    const response = await worker.fetch(executeRequest(await envelope(
      "winerim.sales-import-live",
      {
        dryRun: true,
        mode: "operational",
        orderId: "fixture-order-1",
        soldAt: "2026-08-02T12:00:00.000Z",
        quantity: 1,
        soldStock: { wineId: "42", stockId: 4202, variant: "glass" },
        stockSource: { wineId: "42", stockId: 4201, variant: "bottle" },
      },
    )), env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, detail: "stock:dry-run:sales-import" });
    expect(request).not.toHaveBeenCalled();
    expect(env.RUNTIME_VAULT_KEY?.get).not.toHaveBeenCalled();
    expect(fake.query).toHaveBeenCalledOnce();
  });

  it("rejects secret-bearing envelopes before database or vault access", async () => {
    const fake = fakeDatabase();
    const env = enabledEnv();
    const worker = createMiddlewareRuntimeExecutorWorker({ database: () => fake.adapter });
    const runtimeEnvelope = await envelope("winerim.sales-import-live", {
      dryRun: true,
      nested: { api_token: "not-allowed" },
    });
    const response = await worker.fetch(executeRequest(runtimeEnvelope), env);

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      failure: { message: "SENSITIVE_RUNTIME_PAYLOAD_REJECTED" },
    });
    expect(fake.query).not.toHaveBeenCalled();
    expect(env.RUNTIME_VAULT_KEY?.get).not.toHaveBeenCalled();
  });
});
