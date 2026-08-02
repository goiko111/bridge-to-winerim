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
  parseLiveGlassCanaryInput,
  type MiddlewareRuntimeExecutorEnv,
} from "../../cloudflare/workers/middleware-runtime-executor/src/worker";

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const KEY_VERSION = "v1";

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function credentialAad(kind: "agora" | "winerim"): Uint8Array {
  return new TextEncoder().encode([
    "winerim-runtime-credential", "1", CONNECTION_ID, "agora", kind, KEY_VERSION,
  ].join("|"));
}

async function encryptedCredentialRow(kind: "agora" | "winerim", secret = `fixture-${kind}`) {
  const master = new Uint8Array(32).fill(7);
  const nonce = new Uint8Array(12).fill(kind === "agora" ? 3 : 4);
  const key = await crypto.subtle.importKey("raw", master, { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertext = await crypto.subtle.encrypt({
    name: "AES-GCM",
    iv: nonce,
    additionalData: credentialAad(kind),
    tagLength: 128,
  }, key, new TextEncoder().encode(secret));
  return {
    master: base64(master),
    row: {
      connection_id: CONNECTION_ID,
      provider: "agora",
      credential_kind: kind,
      algorithm: "AES-256-GCM",
      key_version: KEY_VERSION,
      aad_version: 1,
      ciphertext_base64: base64(new Uint8Array(ciphertext)),
      nonce_base64: base64(nonce),
      active: true,
    },
  };
}

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

function readinessDatabase(rows: Partial<Record<"agora" | "winerim", Record<string, unknown>>>) {
  const query = vi.fn(async <Row extends Record<string, unknown>>(statement: SqlStatement) => {
    if (statement.text.includes("FROM public.pos_connections")) {
      return result([{ connection_id: CONNECTION_ID, provider: "agora", enabled: true }] as Row[]);
    }
    const kind = [...statement.values].reverse().find((value) => value === "agora" || value === "winerim") as
      | "agora"
      | "winerim"
      | undefined;
    return result((kind && rows[kind] ? [rows[kind]] : []) as Row[]);
  });
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
    RUNTIME_CANARY_CONNECTION_ID: CONNECTION_ID,
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
        "RUNTIME_CANARY_CONNECTION_ID",
      ]),
    });
  });

  it("rejects placeholder connection ids and string Worker secrets in readiness", async () => {
    const worker = createMiddlewareRuntimeExecutorWorker();
    const response = await worker.fetch(new Request("https://runtime-executor.internal/ready"), enabledEnv({
      RUNTIME_CANARY_CONNECTION_ID: "00000000-0000-4000-8000-000000000000",
      RUNTIME_VAULT_KEY: "worker-secret-strings-are-not-secret-store-bindings" as never,
    }));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      ok: false,
      missingBindings: expect.arrayContaining([
        "RUNTIME_CANARY_CONNECTION_ID",
        "RUNTIME_VAULT_KEY",
      ]),
    });
  });

  it("rejects a placeholder canary before opening PostgreSQL", async () => {
    const database = vi.fn();
    const worker = createMiddlewareRuntimeExecutorWorker({ database });
    const response = await worker.fetch(executeRequest(await envelope(
      "winerim.sales-import-live",
      { dryRun: true },
    )), enabledEnv({
      RUNTIME_CANARY_CONNECTION_ID: "00000000-0000-4000-8000-000000000000",
    }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      failure: { message: "RUNTIME_EXECUTION_DISABLED" },
    });
    expect(database).not.toHaveBeenCalled();
  });

  it("keeps readiness closed when one required credential row is missing", async () => {
    const agora = await encryptedCredentialRow("agora");
    const fake = readinessDatabase({ agora: agora.row });
    const response = await createMiddlewareRuntimeExecutorWorker({ database: () => fake.adapter }).fetch(
      new Request("https://runtime-executor.internal/ready"),
      enabledEnv({ RUNTIME_VAULT_KEY: { get: async () => agora.master } }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      ok: false,
      credentials: "not_ready",
      reason: "RUNTIME_EXECUTOR_NOT_READY",
    });
  });

  it("sanitizes a Secrets Store read failure during readiness", async () => {
    const agora = await encryptedCredentialRow("agora");
    const winerim = await encryptedCredentialRow("winerim");
    const fake = readinessDatabase({ agora: agora.row, winerim: winerim.row });
    const response = await createMiddlewareRuntimeExecutorWorker({ database: () => fake.adapter }).fetch(
      new Request("https://runtime-executor.internal/ready"),
      enabledEnv({ RUNTIME_VAULT_KEY: { get: async () => { throw new Error("sensitive store diagnostic"); } } }),
    );

    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("sensitive store diagnostic");
  });

  it("rejects invalid ciphertext during readiness without exposing it", async () => {
    const agora = await encryptedCredentialRow("agora");
    const winerim = await encryptedCredentialRow("winerim");
    const fake = readinessDatabase({
      agora: { ...agora.row, ciphertext_base64: "not-base64!" },
      winerim: winerim.row,
    });
    const response = await createMiddlewareRuntimeExecutorWorker({ database: () => fake.adapter }).fetch(
      new Request("https://runtime-executor.internal/ready"),
      enabledEnv({ RUNTIME_VAULT_KEY: { get: async () => agora.master } }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ credentials: "not_ready" });
  });

  it("certifies readiness only when both scoped credentials decrypt", async () => {
    const agora = await encryptedCredentialRow("agora");
    const winerim = await encryptedCredentialRow("winerim");
    const fake = readinessDatabase({ agora: agora.row, winerim: winerim.row });
    const vaultGet = vi.fn(async () => agora.master);
    const response = await createMiddlewareRuntimeExecutorWorker({ database: () => fake.adapter }).fetch(
      new Request("https://runtime-executor.internal/ready"),
      enabledEnv({ RUNTIME_VAULT_KEY: { get: vaultGet } }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, credentials: "ready", reason: null });
    expect(vaultGet).toHaveBeenCalledTimes(2);
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

  it.each(["winerim.sales-import-historical", "winerim.stock-apply"] as const)(
    "rejects non-live canary job %s before database access",
    async (job) => {
      const fake = fakeDatabase();
      const worker = createMiddlewareRuntimeExecutorWorker({ database: () => fake.adapter });
      const response = await worker.fetch(executeRequest(await envelope(job, { dryRun: true })), enabledEnv());

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        failure: { httpStatus: 503, message: "RUNTIME_JOB_NOT_ENABLED" },
      });
      expect(fake.query).not.toHaveBeenCalled();
    },
  );

  it("rejects a different connection before database or vault access", async () => {
    const fake = fakeDatabase();
    const worker = createMiddlewareRuntimeExecutorWorker({ database: () => fake.adapter });
    const runtimeEnvelope = await envelope("winerim.sales-import-live", { dryRun: true });
    const response = await worker.fetch(executeRequest(runtimeEnvelope), enabledEnv({
      RUNTIME_CANARY_CONNECTION_ID: "22222222-2222-4222-8222-222222222222",
    }));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      failure: { message: "RUNTIME_CANARY_CONNECTION_REJECTED" },
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

  it("derives the remote orderId from queue idempotency and ignores caller drift", async () => {
    const runtimeEnvelope = await envelope("winerim.sales-import-live", {
      mode: "operational",
      orderId: "caller-controlled-order",
      soldAt: "2026-08-02T12:00:00.000Z",
      quantity: 1,
      soldStock: { wineId: "42", stockId: 4202, variant: "glass" },
      stockSource: { wineId: "42", stockId: 4201, variant: "bottle" },
    });

    expect(parseLiveGlassCanaryInput(runtimeEnvelope)).toMatchObject({
      orderId: runtimeEnvelope.idempotencyKey,
      mode: "operational",
      soldStock: { variant: "glass" },
      stockSource: { variant: "bottle" },
    });
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
