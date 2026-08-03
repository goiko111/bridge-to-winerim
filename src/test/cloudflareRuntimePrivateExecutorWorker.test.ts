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
import {
  createPostgresEncryptedCredentialPort,
  runtimeCredentialAttestation,
} from "../../cloudflare/workers/middleware-runtime/src/executor";
import { writerFenceCredentialBinding } from "../../cloudflare/canary-failclosed/src/writerFence";

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

function rescueCanaryEnv(overrides: Partial<MiddlewareRuntimeExecutorEnv> = {}): MiddlewareRuntimeExecutorEnv {
  return enabledEnv({
    ENVIRONMENT: "rescue-production",
    RUNTIME_MODE: "exclusive-canary-executor",
    CANARY_RUN_ID: "run-20260803-a",
    WRITER_FENCE_HOLDER_ID: "deployment-a",
    WRITER_FENCE: { fetch: vi.fn() },
    CANARY_WRITER_FENCE_PROOF: { get: vi.fn(async () => "x".repeat(40)) },
    ...overrides,
  });
}

async function credentialFenceFor(
  fixture: Awaited<ReturnType<typeof encryptedCredentialRow>>,
): Promise<{
  attestation: ReturnType<typeof runtimeCredentialAttestation>;
  binding: string;
}> {
  const credential = await createPostgresEncryptedCredentialPort(
    readinessDatabase({ winerim: fixture.row }).adapter,
    { masterKey: { get: async () => fixture.master }, keyVersion: KEY_VERSION },
  ).open({ connectionId: CONNECTION_ID, provider: "agora", kind: "winerim" });
  const attestation = runtimeCredentialAttestation(credential!);
  return {
    attestation,
    binding: await writerFenceCredentialBinding(attestation),
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

  it("keeps rescue production closed without the exclusive-canary executor mode", async () => {
    const database = vi.fn();
    const worker = createMiddlewareRuntimeExecutorWorker({ database });
    const response = await worker.fetch(executeRequest(await envelope(
      "winerim.sales-import-live",
      { dryRun: true },
    )), enabledEnv({ ENVIRONMENT: "rescue-production" }));

    expect(response.status).toBe(503);
    expect(database).not.toHaveBeenCalled();
  });

  it("opens the rescue execution gate only in exclusive-canary mode", async () => {
    const fake = fakeDatabase([{
      connection_id: CONNECTION_ID,
      provider: "agora",
      enabled: true,
    }]);
    const worker = createMiddlewareRuntimeExecutorWorker({ database: () => fake.adapter });
    const response = await worker.fetch(executeRequest(await envelope(
      "winerim.sales-import-live",
      { dryRun: true, orderId: "rescue-canary-1", mode: "operational", quantity: 1,
        soldAt: "2026-08-03T08:00:00.000Z",
        soldStock: { wineId: "42", stockId: 4202, variant: "glass" },
        stockSource: { wineId: "42", stockId: 4201, variant: "bottle" } },
    )), rescueCanaryEnv());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
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
    expect(await response.json()).toMatchObject({
      ok: true,
      credentials: "ready",
      connectionId: CONNECTION_ID,
      reason: null,
    });
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

  it("renews the rescue writer fence immediately before a live Winerim mutation", async () => {
    const winerim = await encryptedCredentialRow("winerim");
    const credentialFence = await credentialFenceFor(winerim);
    const fake = readinessDatabase({ winerim: winerim.row });
    const order: string[] = [];
    const audit = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const request = vi.fn<typeof fetch>(async () => {
      order.push("mutation");
      return Response.json({
        sales: [{ orderId: "rescue-live-order-1", stockApplied: true }],
      });
    });
    const fence = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      order.push("fence");
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        connectionId: string;
        runId: string;
        holderId: string;
      };
      return Response.json({
        ...body,
        fencingToken: 9,
        credentialReference: credentialFence.attestation.reference,
        credentialVersion: credentialFence.attestation.version,
        credentialBinding: credentialFence.binding,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
    });
    const worker = createMiddlewareRuntimeExecutorWorker({
      database: () => fake.adapter,
      request,
      sleep: vi.fn(async () => undefined),
    });
    const response = await worker.fetch(executeRequest(await envelope(
      "winerim.sales-import-live",
      {
        mode: "operational",
        orderId: "rescue-live-order-1",
        soldAt: "2026-08-03T08:00:00.000Z",
        quantity: 1,
        soldStock: { wineId: "42", stockId: 4202, variant: "glass" },
        stockSource: { wineId: "42", stockId: 4201, variant: "bottle" },
      },
    )), rescueCanaryEnv({
      RUNTIME_VAULT_KEY: { get: async () => winerim.master },
      WRITER_FENCE: { fetch: fence },
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
    expect(order).toEqual(["fence", "mutation"]);
    expect(fence).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(expect.stringContaining('"fencingToken":9'));
    expect(audit).toHaveBeenCalledWith(expect.stringContaining('"credentialReference":"runtime-vault://postgres/'));
    expect(audit).toHaveBeenCalledWith(expect.stringContaining(
      `"credentialVersion":"${credentialFence.attestation.version}"`,
    ));
    expect(audit).toHaveBeenCalledWith(expect.stringContaining(
      `"credentialBinding":"${credentialFence.binding}"`,
    ));
    audit.mockRestore();
  });

  it("blocks the mutation when the writer-fence credential version drifts", async () => {
    const winerim = await encryptedCredentialRow("winerim");
    const credentialFence = await credentialFenceFor(winerim);
    const driftedVersion = "d".repeat(64);
    const driftedBinding = await writerFenceCredentialBinding({
      reference: credentialFence.attestation.reference,
      version: driftedVersion,
    });
    const fake = readinessDatabase({ winerim: winerim.row });
    const request = vi.fn<typeof fetch>();
    const worker = createMiddlewareRuntimeExecutorWorker({ database: () => fake.adapter, request });
    const response = await worker.fetch(executeRequest(await envelope(
      "winerim.sales-import-live",
      {
        mode: "operational",
        orderId: "rescue-live-order-drift",
        soldAt: "2026-08-03T08:00:00.000Z",
        quantity: 1,
        soldStock: { wineId: "42", stockId: 4202, variant: "glass" },
        stockSource: { wineId: "42", stockId: 4201, variant: "bottle" },
      },
    )), rescueCanaryEnv({
      RUNTIME_VAULT_KEY: { get: async () => winerim.master },
      WRITER_FENCE: {
        fetch: async (_input, init) => {
          const body = JSON.parse(String(init?.body ?? "{}"));
          return Response.json({
            ...body,
            fencingToken: 10,
            credentialReference: credentialFence.attestation.reference,
            credentialVersion: driftedVersion,
            credentialBinding: driftedBinding,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          });
        },
      },
    }));

    expect(response.status).toBe(503);
    expect(request).not.toHaveBeenCalled();
  });

  it("blocks the mutation when the reacquired lease is too close to expiry", async () => {
    const winerim = await encryptedCredentialRow("winerim");
    const credentialFence = await credentialFenceFor(winerim);
    const fake = readinessDatabase({ winerim: winerim.row });
    const request = vi.fn<typeof fetch>();
    const worker = createMiddlewareRuntimeExecutorWorker({ database: () => fake.adapter, request });
    const response = await worker.fetch(executeRequest(await envelope(
      "winerim.sales-import-live",
      {
        mode: "operational",
        orderId: "rescue-live-order-expiring",
        soldAt: "2026-08-03T08:00:00.000Z",
        quantity: 1,
        soldStock: { wineId: "42", stockId: 4202, variant: "glass" },
        stockSource: { wineId: "42", stockId: 4201, variant: "bottle" },
      },
    )), rescueCanaryEnv({
      RUNTIME_VAULT_KEY: { get: async () => winerim.master },
      WRITER_FENCE: {
        fetch: async (_input, init) => {
          const body = JSON.parse(String(init?.body ?? "{}"));
          return Response.json({
            ...body,
            fencingToken: 11,
            credentialReference: credentialFence.attestation.reference,
            credentialVersion: credentialFence.attestation.version,
            credentialBinding: credentialFence.binding,
            expiresAt: new Date(Date.now() + 1_000).toISOString(),
          });
        },
      },
    }));

    expect(response.status).toBe(503);
    expect(request).not.toHaveBeenCalled();
  });

  it("preserves the reviewed remote orderId while queue idempotency owns the local claim", async () => {
    const runtimeEnvelope = await envelope("winerim.sales-import-live", {
      mode: "operational",
      orderId: "caller-controlled-order",
      soldAt: "2026-08-02T12:00:00.000Z",
      quantity: 1,
      soldStock: { wineId: "42", stockId: 4202, variant: "glass" },
      stockSource: { wineId: "42", stockId: 4201, variant: "bottle" },
    });

    expect(parseLiveGlassCanaryInput(runtimeEnvelope)).toMatchObject({
      orderId: "caller-controlled-order",
      mode: "operational",
      soldStock: { variant: "glass" },
      stockSource: { variant: "bottle" },
    });
  });

  it("rejects a missing remote orderId before a stock canary can run", async () => {
    const runtimeEnvelope = await envelope("winerim.sales-import-live", {
      mode: "operational",
      soldAt: "2026-08-02T12:00:00.000Z",
      quantity: 1,
      soldStock: { wineId: "42", stockId: 4202, variant: "glass" },
    });
    expect(() => parseLiveGlassCanaryInput(runtimeEnvelope)).toThrow("RUNTIME_STOCK_ORDER_ID_INVALID");
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
