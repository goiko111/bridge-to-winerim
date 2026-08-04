import { describe, expect, it, vi } from "vitest";

import type {
  DatabaseAdapter,
  DatabaseTransaction,
  QueryResult,
  SqlStatement,
} from "../../cloudflare/workers/middleware-api/src/db";
import type { RuntimeJob } from "../../cloudflare/workers/middleware-runtime/src/contracts";
import type { PostgresCatalogAdapterFactory } from "../../cloudflare/workers/middleware-runtime/src/adapters/catalog";
import type {
  CatalogPlan,
  CatalogPlanningContext,
} from "../../cloudflare/workers/middleware-runtime/src/handlers/catalog";
import { createRuntimeEnvelope } from "../../cloudflare/workers/middleware-runtime/src/idempotency";
import {
  catalogProductCanonicalFingerprint,
  type AgoraCatalogApplyAndReadbackPort,
} from "../../cloudflare/workers/middleware-runtime-executor/src/catalog";
import {
  createMiddlewareRuntimeExecutorWorker,
  parseLiveGlassCanaryInput,
  type MiddlewareRuntimeExecutorEnv,
} from "../../cloudflare/workers/middleware-runtime-executor/src/worker";
import {
  createPostgresEncryptedCredentialPort,
  runtimeCredentialAttestation,
} from "../../cloudflare/workers/middleware-runtime/src/executor";
import {
  runtimePayloadSha256,
} from "../../cloudflare/canary-failclosed/src/exclusiveScope";
import {
  sha256Hex,
  writerFenceCredentialBinding,
} from "../../cloudflare/canary-failclosed/src/writerFence";

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const KEY_VERSION = "v1";
const AGORA_BASE_URL = "https://agora.example.test";

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

function readinessDatabase(
  rows: Partial<Record<"agora" | "winerim", Record<string, unknown>>>,
  activeGrantSha256?: string,
) {
  const query = vi.fn(async <Row extends Record<string, unknown>>(statement: SqlStatement) => {
    if (statement.text.includes("FROM public.runtime_canary_connections")) {
      return result((activeGrantSha256 ? [{
        connection_id: CONNECTION_ID,
        run_id: "run-20260803-a",
        writer_fence_grant_sha256: activeGrantSha256,
      }] : []) as Row[]);
    }
    if (statement.text.includes("FROM public.pos_connections")) {
      return result([{
        connection_id: CONNECTION_ID,
        provider: "agora",
        enabled: true,
        base_url: AGORA_BASE_URL,
      }] as Row[]);
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

async function rescueEnvelope(payload: Record<string, unknown>): Promise<RuntimeEnvelopeV1> {
  const candidate = await envelope("winerim.sales-import-live", payload);
  return {
    ...candidate,
    source: { kind: "queue", eventId: `canary:run-20260803-a:${candidate.messageId}` },
  };
}

async function rescueCatalogEnvelope(payload: Record<string, unknown>): Promise<RuntimeEnvelopeV1> {
  const candidate = await envelope("catalog.sync-master", payload);
  return {
    ...candidate,
    source: { kind: "queue", eventId: `canary:run-20260803-a:${candidate.messageId}` },
  };
}

function enabledEnv(overrides: Partial<MiddlewareRuntimeExecutorEnv> = {}): MiddlewareRuntimeExecutorEnv {
  return {
    ENVIRONMENT: "staging",
    RELEASE: "fixture",
    RUNTIME_EXECUTION_ENABLED: "true",
    RUNTIME_CANARY_CONNECTION_ID: CONNECTION_ID,
    CANARY_RUN_ID: "run-20260803-a",
    CANARY_MESSAGE_ID: "message-rescue-a",
    CANARY_IDEMPOTENCY_KEY: "idempotency-rescue-a",
    CANARY_PAYLOAD_SHA256: "a".repeat(64),
    RUNTIME_VAULT_KEY_VERSION: "v1",
    WINERIM_API_BASE_URL: "https://app.winerim.com",
    WINERIM_ALLOWED_HOSTS: "app.winerim.com",
    MIDDLEWARE_DB: { connectionString: "postgres://fixture.invalid/staging" },
    RUNTIME_VAULT_KEY: { get: vi.fn(async () => "unused-for-dry-run") },
    ...overrides,
  };
}

async function rescueCanaryEnvFor(
  envelope: RuntimeEnvelopeV1,
  overrides: Partial<MiddlewareRuntimeExecutorEnv> = {},
): Promise<MiddlewareRuntimeExecutorEnv> {
  return rescueCanaryEnv({
    CANARY_MESSAGE_ID: envelope.messageId,
    CANARY_IDEMPOTENCY_KEY: envelope.idempotencyKey,
    CANARY_PAYLOAD_SHA256: await runtimePayloadSha256(envelope.payload),
    ...overrides,
  });
}

function rescueCanaryEnv(overrides: Partial<MiddlewareRuntimeExecutorEnv> = {}): MiddlewareRuntimeExecutorEnv {
  return enabledEnv({
    ENVIRONMENT: "rescue-production",
    RUNTIME_MODE: "exclusive-canary-executor",
    CANARY_RUN_ID: "run-20260803-a",
    WRITER_FENCE_HOLDER_ID: "deployment-a",
    WRITER_FENCE: { fetch: vi.fn() },
    CANARY_WRITER_FENCE_PROOF: { get: vi.fn(async () => "x".repeat(40)) },
    CANARY_WRITER_FENCE_GRANT: { get: vi.fn(async () => "{}") },
    CANARY_EXCLUSIVE_CREDENTIAL_VERSION: "b".repeat(64),
    RUNTIME_AGORA_CREDENTIAL_MODE: "shared-read-only",
    ...overrides,
  });
}

function fencedCatalogEnv(overrides: Partial<MiddlewareRuntimeExecutorEnv> = {}): MiddlewareRuntimeExecutorEnv {
  return enabledEnv({
    WRITER_FENCE_HOLDER_ID: "deployment-a",
    WRITER_FENCE: { fetch: vi.fn() },
    CANARY_WRITER_FENCE_PROOF: { get: vi.fn(async () => "x".repeat(40)) },
    ...overrides,
  });
}

async function credentialFenceFor(
  fixture: Awaited<ReturnType<typeof encryptedCredentialRow>>,
  kind: "agora" | "winerim" = "winerim",
): Promise<{
  attestation: ReturnType<typeof runtimeCredentialAttestation>;
  binding: string;
}> {
  const credential = await createPostgresEncryptedCredentialPort(
    readinessDatabase({ [kind]: fixture.row }).adapter,
    {
      masterKey: { get: async () => fixture.master },
      keyVersion: KEY_VERSION,
      runId: "run-20260803-a",
    },
  ).open({ connectionId: CONNECTION_ID, provider: "agora", kind });
  const attestation = runtimeCredentialAttestation(credential!);
  return {
    attestation,
    binding: await writerFenceCredentialBinding(attestation),
  };
}

async function activeGrantFor(
  credentialFence: Awaited<ReturnType<typeof credentialFenceFor>>,
) {
  const proof = "active-writer-fence-proof-for-runtime-tests-123456";
  const now = Date.now();
  const rawGrant = JSON.stringify({
    version: 1,
    connectionId: CONNECTION_ID,
    runId: "run-20260803-a",
    holderId: "deployment-a",
    proofSha256: await sha256Hex(proof),
    exclusiveCredentialRef: credentialFence.attestation.reference,
    credentialVersion: credentialFence.attestation.version,
    credentialBinding: credentialFence.binding,
    legacyWriter: {
      revokedAt: new Date(now - 120_000).toISOString(),
      negativeProbeStatus: 401,
      evidenceSha256: "d".repeat(64),
    },
    issuedAt: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now + 60 * 60_000).toISOString(),
  });
  return {
    proof,
    rawGrant,
    grantSha256: await sha256Hex(rawGrant),
    credentialVersion: credentialFence.attestation.version,
  };
}

function catalogPlanningContext(wines = 1): CatalogPlanningContext {
  return {
    provider: "agora",
    sourceRevision: "worker-catalog-fixture-v1",
    wines: Array.from({ length: wines }, (_, index) => ({
      winerimId: String(index + 1),
      name: `Fixture ${index + 1}`,
      active: true,
      wineType: "tinto",
      variants: [{ format: "BOTTLE" as const, salePrice: 20 + index }],
    })),
    existingFamilies: [{ id: "10", name: "TINTOS WINERIM" }],
    existingProducts: [],
    familyRouting: { byWineType: { tinto: { id: "10", name: "TINTOS WINERIM" } } },
  };
}

function catalogAdapter(
  order?: string[],
  wines = 1,
): PostgresCatalogAdapterFactory {
  return vi.fn(() => ({
    loadPlanningContext: vi.fn(async () => ({
      ok: true as const,
      context: catalogPlanningContext(wines),
    })),
    applyPlan: vi.fn(async ({ plan }: { plan: CatalogPlan }) => {
      order?.push("persist");
      return {
        ok: true as const,
        receipt: {
          status: "applied" as const,
          appliedProductIds: plan.operations.map((operation) => operation.desired.productId),
        },
      };
    }),
  })) as unknown as PostgresCatalogAdapterFactory;
}

function catalogTransportProfile(): string {
  return JSON.stringify({
    vatId: "1",
    priceListIds: ["1"],
    warehouseIds: ["1"],
    colorByFormat: {
      BOTTLE: "#8B0000",
      GLASS: "#F5F5DC",
      MAGNUM: "#333333",
    },
    preparationTypeId: "",
    preparationOrderId: "",
    orderByProductId: { "500001": "1" },
  });
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
    const canary = await rescueEnvelope(
      { dryRun: true, orderId: "rescue-canary-1", mode: "operational", quantity: 1,
        soldAt: "2026-08-03T08:00:00.000Z",
        soldStock: { wineId: "42", stockId: 4202, variant: "glass" },
        stockSource: { wineId: "42", stockId: 4201, variant: "bottle" } },
    );
    const response = await worker.fetch(executeRequest(canary), await rescueCanaryEnvFor(canary));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
  });

  it.each([
    ["messageId", (value: RuntimeEnvelopeV1) => ({ ...value, messageId: `${value.messageId}-drift` })],
    ["idempotencyKey", (value: RuntimeEnvelopeV1) => ({
      ...value,
      idempotencyKey: `${value.idempotencyKey}-drift`,
    })],
    ["source", (value: RuntimeEnvelopeV1) => ({
      ...value,
      source: { ...value.source, eventId: "canary:another-run:another-message" },
    })],
    ["payload", (value: RuntimeEnvelopeV1) => ({
      ...value,
      payload: { ...(value.payload as Record<string, unknown>), quantity: 2 },
    })],
    ["lane", (value: RuntimeEnvelopeV1) => ({ ...value, lane: "stock-sync" as const })],
  ])("rejects rescue %s drift before database or credentials", async (_field, mutate) => {
    const database = vi.fn();
    const worker = createMiddlewareRuntimeExecutorWorker({ database });
    const approved = await rescueEnvelope({
      dryRun: true,
      mode: "operational",
      orderId: "rescue-scope-fixture",
      soldAt: "2026-08-03T08:00:00.000Z",
      quantity: 1,
      soldStock: { wineId: "42", stockId: 4202, variant: "glass" },
      stockSource: { wineId: "42", stockId: 4201, variant: "bottle" },
    });
    const response = await worker.fetch(
      executeRequest(mutate(approved)),
      await rescueCanaryEnvFor(approved),
    );

    expect(response.status).toBe(422);
    expect(database).not.toHaveBeenCalled();
  });

  it("rejects an oversized rescue request before database or credentials", async () => {
    const database = vi.fn();
    const worker = createMiddlewareRuntimeExecutorWorker({ database });
    const response = await worker.fetch(new Request("https://runtime-executor.internal/v1/execute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat((64 * 1024) + 1),
    }), rescueCanaryEnv());

    expect(response.status).toBe(413);
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
      enabledJobs: [],
      missingBindings: expect.arrayContaining([
        "MIDDLEWARE_DB",
        "RUNTIME_VAULT_KEY",
        "RUNTIME_VAULT_KEY_VERSION",
        "RUNTIME_CANARY_CONNECTION_ID",
        "CANARY_RUN_ID",
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

  it("advertises open-ticket shadow execution without opening the definitive cursor gate", async () => {
    const agora = await encryptedCredentialRow("agora");
    const winerim = await encryptedCredentialRow("winerim");
    const fake = readinessDatabase({ agora: agora.row, winerim: winerim.row });
    const response = await createMiddlewareRuntimeExecutorWorker({ database: () => fake.adapter }).fetch(
      new Request("https://runtime-executor.internal/ready"),
      enabledEnv({
        RUNTIME_VAULT_KEY: { get: async () => agora.master },
        RUNTIME_SALES_EXECUTION_ENABLED: "true",
        RUNTIME_SALES_CURSOR_ENABLED: "false",
        RUNTIME_SALES_DLQ_READY: "true",
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json() as { enabledJobs: string[] };
    expect(body.enabledJobs).toContain("sales.sync-open-tickets");
    expect(body.enabledJobs).not.toContain("sales.auto-sync");
    expect(body.enabledJobs).not.toContain("sales.sync-intraday");
  });

  it("accepts a shared Agora credential only while every Agora mutation lane is closed", async () => {
    const agora = await encryptedCredentialRow("agora");
    const winerim = await encryptedCredentialRow("winerim");
    const credentialFence = await credentialFenceFor(winerim);
    const proof = "p".repeat(40);
    const now = Date.parse("2026-08-03T12:00:00.000Z");
    const grant = JSON.stringify({
      version: 1,
      connectionId: CONNECTION_ID,
      runId: "run-20260803-a",
      holderId: "deployment-a",
      proofSha256: await sha256Hex(proof),
      exclusiveCredentialRef: credentialFence.attestation.reference,
      credentialVersion: credentialFence.attestation.version,
      credentialBinding: credentialFence.binding,
      legacyWriter: {
        revokedAt: "2026-08-03T11:50:00.000Z",
        negativeProbeStatus: 401,
        evidenceSha256: "d".repeat(64),
      },
      issuedAt: "2026-08-03T11:55:00.000Z",
      expiresAt: "2026-08-03T13:00:00.000Z",
    });
    const fake = readinessDatabase(
      { agora: agora.row, winerim: winerim.row },
      await sha256Hex(grant),
    );
    const response = await createMiddlewareRuntimeExecutorWorker({
      database: () => fake.adapter,
      now: () => now,
    }).fetch(
      new Request("https://runtime-executor.internal/ready"),
      rescueCanaryEnv({
        RUNTIME_VAULT_KEY: { get: async () => agora.master },
        CANARY_EXCLUSIVE_CREDENTIAL_VERSION: credentialFence.attestation.version,
        CANARY_WRITER_FENCE_PROOF: { get: async () => proof },
        CANARY_WRITER_FENCE_GRANT: { get: async () => grant },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      agoraCredentialMode: "shared-read-only",
      agoraReadOnlyPolicyOpen: true,
      writerFenceReady: true,
      enabledJobs: expect.not.arrayContaining(["catalog.sync-master", "outbound.process"]),
    });
  });

  it("rejects readiness when the reviewed fence grant targets another Winerim credential version", async () => {
    const agora = await encryptedCredentialRow("agora");
    const winerim = await encryptedCredentialRow("winerim");
    const credentialFence = await credentialFenceFor(winerim);
    const proof = "p".repeat(40);
    const driftedVersion = "e".repeat(64);
    const driftedBinding = await writerFenceCredentialBinding({
      reference: credentialFence.attestation.reference,
      version: driftedVersion,
    });
    const grant = JSON.stringify({
      version: 1,
      connectionId: CONNECTION_ID,
      runId: "run-20260803-a",
      holderId: "deployment-a",
      proofSha256: await sha256Hex(proof),
      exclusiveCredentialRef: credentialFence.attestation.reference,
      credentialVersion: driftedVersion,
      credentialBinding: driftedBinding,
      legacyWriter: {
        revokedAt: "2026-08-03T11:50:00.000Z",
        negativeProbeStatus: 401,
        evidenceSha256: "d".repeat(64),
      },
      issuedAt: "2026-08-03T11:55:00.000Z",
      expiresAt: "2026-08-03T13:00:00.000Z",
    });
    const fake = readinessDatabase({ agora: agora.row, winerim: winerim.row });
    const response = await createMiddlewareRuntimeExecutorWorker({
      database: () => fake.adapter,
      now: () => Date.parse("2026-08-03T12:00:00.000Z"),
    }).fetch(new Request("https://runtime-executor.internal/ready"), rescueCanaryEnv({
      RUNTIME_VAULT_KEY: { get: async () => agora.master },
      CANARY_EXCLUSIVE_CREDENTIAL_VERSION: credentialFence.attestation.version,
      CANARY_WRITER_FENCE_PROOF: { get: async () => proof },
      CANARY_WRITER_FENCE_GRANT: { get: async () => grant },
    }));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, writerFenceReady: false });
  });

  it("keeps readiness at 503 when the grant secret differs from active scope evidence", async () => {
    const agora = await encryptedCredentialRow("agora");
    const winerim = await encryptedCredentialRow("winerim");
    const credentialFence = await credentialFenceFor(winerim);
    const activeFence = await activeGrantFor(credentialFence);
    const swappedGrant = JSON.stringify({
      ...JSON.parse(activeFence.rawGrant),
      legacyWriter: {
        ...JSON.parse(activeFence.rawGrant).legacyWriter,
        evidenceSha256: "e".repeat(64),
      },
    });
    const fake = readinessDatabase(
      { agora: agora.row, winerim: winerim.row },
      activeFence.grantSha256,
    );
    const response = await createMiddlewareRuntimeExecutorWorker({ database: () => fake.adapter }).fetch(
      new Request("https://runtime-executor.internal/ready"),
      rescueCanaryEnv({
        RUNTIME_VAULT_KEY: { get: async () => agora.master },
        CANARY_EXCLUSIVE_CREDENTIAL_VERSION: activeFence.credentialVersion,
        CANARY_WRITER_FENCE_PROOF: { get: async () => activeFence.proof },
        CANARY_WRITER_FENCE_GRANT: { get: async () => swappedGrant },
      }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, writerFenceReady: false });
  });

  it.each([undefined, "", "exclusive-writer"])(
    "rejects rescue Agora credential mode %s before database access",
    async (mode) => {
      const fake = fakeDatabase();
      const worker = createMiddlewareRuntimeExecutorWorker({ database: () => fake.adapter });
      const env = rescueCanaryEnv({ RUNTIME_AGORA_CREDENTIAL_MODE: mode });
      const response = await worker.fetch(executeRequest(await envelope(
        "winerim.sales-import-live",
        { dryRun: true },
      )), env);

      expect(response.status).toBe(503);
      expect(fake.query).not.toHaveBeenCalled();
    },
  );

  it("fails closed before database access when a shared Agora credential enables a mutation lane", async () => {
    const fake = fakeDatabase();
    const remote = { applyAndReadback: vi.fn() } satisfies AgoraCatalogApplyAndReadbackPort;
    const worker = createMiddlewareRuntimeExecutorWorker({
      database: () => fake.adapter,
      catalogApply: () => remote,
    });
    const env = rescueCanaryEnv({
      RUNTIME_CATALOG_EXECUTION_ENABLED: "true",
      RUNTIME_CATALOG_APPLY_ENABLED: "true",
    });
    const ready = await worker.fetch(new Request("https://runtime-executor.internal/ready"), env);
    const execute = await worker.fetch(executeRequest(await envelope(
      "catalog.sync-master",
      { winerimWineIds: ["1"], formatTypes: ["BOTTLE"] },
    )), env);

    expect(ready.status).toBe(503);
    expect(await ready.json()).toMatchObject({
      ok: false,
      agoraCredentialMode: "shared-read-only",
      agoraReadOnlyPolicyOpen: false,
      enabledJobs: [],
      missingBindings: expect.arrayContaining(["RUNTIME_CANARY_POLICY"]),
    });
    expect(execute.status).toBe(503);
    expect(await execute.json()).toMatchObject({
      failure: { message: "RUNTIME_EXECUTION_DISABLED" },
    });
    expect(fake.query).not.toHaveBeenCalled();
    expect(remote.applyAndReadback).not.toHaveBeenCalled();
  });

  it.each([
    "RUNTIME_CATALOG_EXECUTION_ENABLED",
    "RUNTIME_CATALOG_FETCH_ENABLED",
    "RUNTIME_CATALOG_APPLY_ENABLED",
    "RUNTIME_OUTBOUND_EXECUTION_ENABLED",
    "RUNTIME_OUTBOUND_MUTATION_ENABLED",
  ] as const)("rejects shared Agora mode when %s is enabled", async (flag) => {
    const fake = fakeDatabase();
    const worker = createMiddlewareRuntimeExecutorWorker({ database: () => fake.adapter });
    const response = await worker.fetch(executeRequest(await envelope(
      "winerim.sales-import-live",
      { dryRun: true },
    )), rescueCanaryEnv({ [flag]: "true" }));

    expect(response.status).toBe(503);
    expect(fake.query).not.toHaveBeenCalled();
  });

  it("reports catalog flags truthfully and keeps outbound unready without its limiter binding", async () => {
    const agora = await encryptedCredentialRow("agora");
    const winerim = await encryptedCredentialRow("winerim");
    const fake = readinessDatabase({ agora: agora.row, winerim: winerim.row });
    const response = await createMiddlewareRuntimeExecutorWorker({ database: () => fake.adapter }).fetch(
      new Request("https://runtime-executor.internal/ready"),
      fencedCatalogEnv({
        RUNTIME_VAULT_KEY: { get: async () => agora.master },
        RUNTIME_CATALOG_EXECUTION_ENABLED: "true",
        RUNTIME_CATALOG_APPLY_ENABLED: "true",
        RUNTIME_AGORA_CATALOG_BASE_URL: AGORA_BASE_URL,
        RUNTIME_AGORA_CATALOG_ALLOWED_HOSTS: "agora.example.test",
        RUNTIME_AGORA_CATALOG_PROFILE_JSON: catalogTransportProfile(),
        RUNTIME_OUTBOUND_EXECUTION_ENABLED: "true",
        RUNTIME_OUTBOUND_MUTATION_ENABLED: "true",
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json() as {
      enabledJobs: string[];
      catalog: Record<string, unknown>;
      outbound: Record<string, unknown>;
    };
    expect(body.enabledJobs).toContain("catalog.sync-master");
    expect(body.enabledJobs).not.toContain("outbound.process");
    expect(body.catalog).toMatchObject({
      executionEnabled: true,
      fetchRequested: false,
      fetchEnabled: false,
      fetchConnected: false,
      applyEnabled: true,
      transportReady: true,
      dryRunReady: true,
      applyReady: true,
    });
    expect(body.outbound).toEqual({
      executionRequested: true,
      mutationRequested: true,
      connected: false,
      ready: false,
      reason: "OUTBOUND_RATE_LIMITER_NOT_CONFIGURED",
    });
  });

  it("reports catalog dry-run readiness without requiring an Agora credential row", async () => {
    const fake = readinessDatabase({});
    const response = await createMiddlewareRuntimeExecutorWorker({ database: () => fake.adapter }).fetch(
      new Request("https://runtime-executor.internal/ready"),
      enabledEnv({ RUNTIME_CATALOG_EXECUTION_ENABLED: "true" }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      ok: false,
      catalog: {
        executionEnabled: true,
        dryRunReady: true,
        applyReady: false,
      },
      credentialReadiness: { agora: "not_ready", winerim: "not_ready" },
    });
  });

  it("reports catalog apply ready with its scoped Agora credential even if stock is not ready", async () => {
    const agora = await encryptedCredentialRow("agora");
    const fake = readinessDatabase({ agora: agora.row });
    const response = await createMiddlewareRuntimeExecutorWorker({ database: () => fake.adapter }).fetch(
      new Request("https://runtime-executor.internal/ready"),
      fencedCatalogEnv({
        RUNTIME_VAULT_KEY: { get: async () => agora.master },
        RUNTIME_CATALOG_EXECUTION_ENABLED: "true",
        RUNTIME_CATALOG_APPLY_ENABLED: "true",
        RUNTIME_AGORA_CATALOG_BASE_URL: AGORA_BASE_URL,
        RUNTIME_AGORA_CATALOG_ALLOWED_HOSTS: "agora.example.test",
        RUNTIME_AGORA_CATALOG_PROFILE_JSON: catalogTransportProfile(),
      }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      ok: false,
      catalog: { applyReady: true },
      credentialReadiness: { agora: "ready", winerim: "not_ready" },
    });
  });

  it("runs a catalog dry-run without opening an Agora credential or a transport", async () => {
    const fake = readinessDatabase({});
    const vaultGet = vi.fn(async () => "not-read-by-catalog-preview");
    const catalogApply = vi.fn(() => null);
    const worker = createMiddlewareRuntimeExecutorWorker({
      database: () => fake.adapter,
      catalogAdapterFactory: catalogAdapter(),
      catalogApply,
    });
    const response = await worker.fetch(executeRequest(await envelope(
      "catalog.sync-master",
      { dryRun: true, winerimWineIds: ["1"], formatTypes: ["BOTTLE"] },
    )), enabledEnv({
      RUNTIME_VAULT_KEY: { get: vaultGet },
      RUNTIME_CATALOG_EXECUTION_ENABLED: "true",
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      detail: expect.stringMatching(/^catalog:preview:1:/),
    });
    expect(vaultGet).not.toHaveBeenCalled();
    expect(catalogApply).not.toHaveBeenCalled();
  });

  it("requires the separate catalog apply flag before credential or transport access", async () => {
    const fake = readinessDatabase({});
    const vaultGet = vi.fn(async () => "must-not-be-read");
    const remote = { applyAndReadback: vi.fn() } satisfies AgoraCatalogApplyAndReadbackPort;
    const worker = createMiddlewareRuntimeExecutorWorker({
      database: () => fake.adapter,
      catalogAdapterFactory: catalogAdapter(),
      catalogApply: () => remote,
    });
    const response = await worker.fetch(executeRequest(await envelope(
      "catalog.sync-master",
      { winerimWineIds: ["1"], formatTypes: ["BOTTLE"] },
    )), enabledEnv({
      RUNTIME_VAULT_KEY: { get: vaultGet },
      RUNTIME_CATALOG_EXECUTION_ENABLED: "true",
      RUNTIME_CATALOG_APPLY_ENABLED: "false",
    }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      failure: { message: "CATALOG_APPLY_DISABLED" },
    });
    expect(vaultGet).not.toHaveBeenCalled();
    expect(remote.applyAndReadback).not.toHaveBeenCalled();
  });

  it("fences an exact rescue canary before the single-product Agora apply and DB persistence", async () => {
    const agora = await encryptedCredentialRow("agora");
    const credentialFence = await credentialFenceFor(agora, "agora");
    const fake = readinessDatabase({ agora: agora.row });
    const order: string[] = [];
    const remote: AgoraCatalogApplyAndReadbackPort = {
      applyAndReadback: vi.fn(async ({ plan }) => {
        order.push("post");
        const fingerprints = Object.fromEntries(await Promise.all(plan.operations.map(async (operation) => [
          operation.desired.productId,
          await catalogProductCanonicalFingerprint(operation.desired),
        ])));
        return {
          ok: true as const,
          receipt: {
            status: "applied" as const,
            appliedProductIds: plan.operations.map((operation) => operation.desired.productId),
            canonicalProductFingerprints: fingerprints,
          },
        };
      }),
    };
    const fence = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      order.push("fence");
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        connectionId: string;
        runId: string;
        holderId: string;
      };
      return Response.json({
        ...body,
        fencingToken: 12,
        credentialReference: credentialFence.attestation.reference,
        credentialVersion: credentialFence.attestation.version,
        credentialBinding: credentialFence.binding,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
    });
    const worker = createMiddlewareRuntimeExecutorWorker({
      database: () => fake.adapter,
      catalogAdapterFactory: catalogAdapter(order),
      catalogApply: () => remote,
    });
    const response = await worker.fetch(executeRequest(await envelope(
      "catalog.sync-master",
      { winerimWineIds: ["1"], formatTypes: ["BOTTLE"] },
    )), fencedCatalogEnv({
      RUNTIME_VAULT_KEY: { get: async () => agora.master },
      RUNTIME_CATALOG_EXECUTION_ENABLED: "true",
      RUNTIME_CATALOG_APPLY_ENABLED: "true",
      WRITER_FENCE: { fetch: fence },
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      detail: expect.stringMatching(/^catalog:applied:1:/),
    });
    expect(order).toEqual(["fence", "post", "persist"]);
    expect(fence).toHaveBeenCalledOnce();
    expect(remote.applyAndReadback).toHaveBeenCalledOnce();
  });

  it("runs one exact rescue catalog product with the exclusive Agora fence and exact readback", async () => {
    const agora = await encryptedCredentialRow("agora");
    const credentialFence = await credentialFenceFor(agora, "agora");
    const activeFence = await activeGrantFor(credentialFence);
    const fake = readinessDatabase({ agora: agora.row }, activeFence.grantSha256);
    const order: string[] = [];
    const remote: AgoraCatalogApplyAndReadbackPort = {
      applyAndReadback: vi.fn(async ({ plan }) => ({
        ok: true as const,
        receipt: {
          status: "applied" as const,
          appliedProductIds: [plan.operations[0]!.desired.productId],
          canonicalProductFingerprints: {
            [plan.operations[0]!.desired.productId]: await catalogProductCanonicalFingerprint(
              plan.operations[0]!.desired,
            ),
          },
        },
      })),
    };
    const canary = await rescueCatalogEnvelope({
      winerimWineIds: ["1"],
      formatTypes: ["BOTTLE"],
    });
    const worker = createMiddlewareRuntimeExecutorWorker({
      database: () => fake.adapter,
      catalogAdapterFactory: catalogAdapter(order),
      catalogApply: () => remote,
    });
    const response = await worker.fetch(executeRequest(canary), await rescueCanaryEnvFor(canary, {
      CANARY_RUNTIME_JOB: "catalog.sync-master",
      CANARY_RUNTIME_LANE: "catalog",
      CANARY_CATALOG_PRODUCT_ID: "500001",
      RUNTIME_AGORA_CREDENTIAL_MODE: "exclusive-writer",
      RUNTIME_CATALOG_EXECUTION_ENABLED: "true",
      RUNTIME_CATALOG_APPLY_ENABLED: "true",
      RUNTIME_AGORA_CATALOG_BASE_URL: AGORA_BASE_URL,
      RUNTIME_AGORA_CATALOG_ALLOWED_HOSTS: "agora.example.test",
      RUNTIME_AGORA_CATALOG_PROFILE_JSON: catalogTransportProfile(),
      RUNTIME_VAULT_KEY: { get: async () => agora.master },
      CANARY_EXCLUSIVE_CREDENTIAL_VERSION: activeFence.credentialVersion,
      CANARY_WRITER_FENCE_PROOF: { get: async () => activeFence.proof },
      CANARY_WRITER_FENCE_GRANT: { get: async () => activeFence.rawGrant },
      WRITER_FENCE: {
        fetch: async (_input, init) => {
          const body = JSON.parse(String(init?.body ?? "{}"));
          return Response.json({
            ...body,
            fencingToken: 21,
            credentialReference: credentialFence.attestation.reference,
            credentialVersion: credentialFence.attestation.version,
            credentialBinding: credentialFence.binding,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          });
        },
      },
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      detail: expect.stringMatching(/^catalog:applied:1:/),
    });
    expect(order).toEqual(["persist"]);
    expect(remote.applyAndReadback).toHaveBeenCalledOnce();
  });

  it("rejects a rescue catalog plan for a product outside the exact canary scope", async () => {
    const agora = await encryptedCredentialRow("agora");
    const credentialFence = await credentialFenceFor(agora, "agora");
    const activeFence = await activeGrantFor(credentialFence);
    const fake = readinessDatabase({ agora: agora.row }, activeFence.grantSha256);
    const remote = { applyAndReadback: vi.fn() } satisfies AgoraCatalogApplyAndReadbackPort;
    const canary = await rescueCatalogEnvelope({
      winerimWineIds: ["1"],
      formatTypes: ["BOTTLE"],
    });
    const worker = createMiddlewareRuntimeExecutorWorker({
      database: () => fake.adapter,
      catalogAdapterFactory: catalogAdapter(),
      catalogApply: () => remote,
    });
    const response = await worker.fetch(executeRequest(canary), await rescueCanaryEnvFor(canary, {
      CANARY_RUNTIME_JOB: "catalog.sync-master",
      CANARY_RUNTIME_LANE: "catalog",
      CANARY_CATALOG_PRODUCT_ID: "500002",
      RUNTIME_AGORA_CREDENTIAL_MODE: "exclusive-writer",
      RUNTIME_CATALOG_EXECUTION_ENABLED: "true",
      RUNTIME_CATALOG_APPLY_ENABLED: "true",
      RUNTIME_AGORA_CATALOG_BASE_URL: AGORA_BASE_URL,
      RUNTIME_AGORA_CATALOG_ALLOWED_HOSTS: "agora.example.test",
      RUNTIME_AGORA_CATALOG_PROFILE_JSON: catalogTransportProfile(),
      RUNTIME_VAULT_KEY: { get: async () => agora.master },
      CANARY_EXCLUSIVE_CREDENTIAL_VERSION: activeFence.credentialVersion,
      CANARY_WRITER_FENCE_PROOF: { get: async () => activeFence.proof },
      CANARY_WRITER_FENCE_GRANT: { get: async () => activeFence.rawGrant },
    }));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      failure: { message: "CATALOG_APPLY_REJECTED" },
    });
    expect(remote.applyAndReadback).not.toHaveBeenCalled();
  });

  it("wires the reviewed Agora transport behind the fence and exact readback", async () => {
    const agora = await encryptedCredentialRow("agora");
    const credentialFence = await credentialFenceFor(agora, "agora");
    const fake = readinessDatabase({ agora: agora.row });
    const order: string[] = [];
    let importedProduct = "";
    const request = vi.fn<typeof fetch>(async (_target, init) => {
      if (init?.method === "POST") {
        order.push("post");
        importedProduct = String(init.body ?? "").match(/<Product\b[\s\S]*<\/Product>/)?.[0] ?? "";
        return new Response('<ImportResult Success="true" />', { status: 200 });
      }
      order.push("read");
      return new Response(
        `<?xml version="1.0"?><Export><Products>${importedProduct}</Products></Export>`,
        { status: 200, headers: { "content-type": "application/xml" } },
      );
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
        fencingToken: 13,
        credentialReference: credentialFence.attestation.reference,
        credentialVersion: credentialFence.attestation.version,
        credentialBinding: credentialFence.binding,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
    });
    const worker = createMiddlewareRuntimeExecutorWorker({
      database: () => fake.adapter,
      catalogAdapterFactory: catalogAdapter(order),
      request,
    });
    const response = await worker.fetch(executeRequest(await envelope(
      "catalog.sync-master",
      { winerimWineIds: ["1"], formatTypes: ["BOTTLE"] },
    )), fencedCatalogEnv({
      RUNTIME_VAULT_KEY: { get: async () => agora.master },
      RUNTIME_CATALOG_EXECUTION_ENABLED: "true",
      RUNTIME_CATALOG_APPLY_ENABLED: "true",
      RUNTIME_AGORA_CATALOG_BASE_URL: AGORA_BASE_URL,
      RUNTIME_AGORA_CATALOG_ALLOWED_HOSTS: "agora.example.test",
      RUNTIME_AGORA_CATALOG_PROFILE_JSON: catalogTransportProfile(),
      WRITER_FENCE: { fetch: fence },
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
    expect(order).toEqual(["fence", "read", "post", "read", "persist"]);
    expect(importedProduct).toContain('Id="500001"');
    expect(importedProduct).toContain('FamilyId="10"');
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("rejects catalog apply when the configured target differs from the connection base URL", async () => {
    const agora = await encryptedCredentialRow("agora");
    const fake = readinessDatabase({ agora: agora.row });
    const request = vi.fn<typeof fetch>();
    const fence = vi.fn();
    const worker = createMiddlewareRuntimeExecutorWorker({
      database: () => fake.adapter,
      catalogAdapterFactory: catalogAdapter(),
      request,
    });

    const response = await worker.fetch(executeRequest(await envelope(
      "catalog.sync-master",
      { winerimWineIds: ["1"], formatTypes: ["BOTTLE"] },
    )), fencedCatalogEnv({
      RUNTIME_VAULT_KEY: { get: async () => agora.master },
      RUNTIME_CATALOG_EXECUTION_ENABLED: "true",
      RUNTIME_CATALOG_APPLY_ENABLED: "true",
      RUNTIME_AGORA_CATALOG_BASE_URL: "https://wrong-agora.example.test",
      RUNTIME_AGORA_CATALOG_ALLOWED_HOSTS: "wrong-agora.example.test",
      RUNTIME_AGORA_CATALOG_PROFILE_JSON: catalogTransportProfile(),
      WRITER_FENCE: { fetch: fence },
    }));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      failure: { message: "CATALOG_APPLY_REJECTED" },
    });
    expect(fence).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects a multi-product catalog apply before the remote transport", async () => {
    const agora = await encryptedCredentialRow("agora");
    const fake = readinessDatabase({ agora: agora.row });
    const remote = { applyAndReadback: vi.fn() } satisfies AgoraCatalogApplyAndReadbackPort;
    const worker = createMiddlewareRuntimeExecutorWorker({
      database: () => fake.adapter,
      catalogAdapterFactory: catalogAdapter(undefined, 2),
      catalogApply: () => remote,
    });
    const response = await worker.fetch(executeRequest(await envelope(
      "catalog.sync-master",
      { winerimWineIds: ["1", "2"], formatTypes: ["BOTTLE"] },
    )), enabledEnv({
      RUNTIME_VAULT_KEY: { get: async () => agora.master },
      RUNTIME_CATALOG_EXECUTION_ENABLED: "true",
      RUNTIME_CATALOG_APPLY_ENABLED: "true",
    }));

    expect(response.status).toBe(422);
    expect(remote.applyAndReadback).not.toHaveBeenCalled();
  });

  it("rejects outbound when the loaded connection lacks the exact full-lanes scope", async () => {
    const fake = fakeDatabase();
    const response = await createMiddlewareRuntimeExecutorWorker({ database: () => fake.adapter }).fetch(
      executeRequest(await envelope("outbound.process", { dryRun: true })),
      enabledEnv({
        RUNTIME_OUTBOUND_EXECUTION_ENABLED: "true",
        RUNTIME_OUTBOUND_MUTATION_ENABLED: "true",
      }),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      failure: { httpStatus: 422, message: "OUTBOUND_CONNECTION_SCOPE_REJECTED" },
    });
    expect(fake.query).toHaveBeenCalled();
  });

  it("keeps the catalog lane closed by default before database access", async () => {
    const fake = fakeDatabase();
    const worker = createMiddlewareRuntimeExecutorWorker({ database: () => fake.adapter });
    const response = await worker.fetch(executeRequest(await envelope(
      "catalog.fetch-winerim",
      { dryRun: true },
    )), enabledEnv());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      failure: { httpStatus: 503, message: "CATALOG_EXECUTION_DISABLED" },
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
    const activeFence = await activeGrantFor(credentialFence);
    const fake = readinessDatabase({ winerim: winerim.row }, activeFence.grantSha256);
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
    const canary = await rescueEnvelope(
      {
        mode: "operational",
        orderId: "rescue-live-order-1",
        soldAt: "2026-08-03T08:00:00.000Z",
        quantity: 1,
        soldStock: { wineId: "42", stockId: 4202, variant: "glass" },
        stockSource: { wineId: "42", stockId: 4201, variant: "bottle" },
      },
    );
    const response = await worker.fetch(executeRequest(canary), await rescueCanaryEnvFor(canary, {
      RUNTIME_VAULT_KEY: { get: async () => winerim.master },
      CANARY_EXCLUSIVE_CREDENTIAL_VERSION: activeFence.credentialVersion,
      CANARY_WRITER_FENCE_PROOF: { get: async () => activeFence.proof },
      CANARY_WRITER_FENCE_GRANT: { get: async () => activeFence.rawGrant },
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

  it("rejects swapped active evidence with 403 before lease or provider calls", async () => {
    const winerim = await encryptedCredentialRow("winerim");
    const credentialFence = await credentialFenceFor(winerim);
    const activeFence = await activeGrantFor(credentialFence);
    const swappedGrant = JSON.stringify({
      ...JSON.parse(activeFence.rawGrant),
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    });
    const fake = readinessDatabase({ winerim: winerim.row }, activeFence.grantSha256);
    const provider = vi.fn<typeof fetch>();
    const lease = vi.fn();
    const worker = createMiddlewareRuntimeExecutorWorker({
      database: () => fake.adapter,
      request: provider,
    });
    const canary = await rescueEnvelope({
      mode: "operational",
      orderId: "rescue-live-order-swapped-evidence",
      soldAt: "2026-08-03T08:00:00.000Z",
      quantity: 1,
      soldStock: { wineId: "42", stockId: 4202, variant: "glass" },
      stockSource: { wineId: "42", stockId: 4201, variant: "bottle" },
    });
    const response = await worker.fetch(executeRequest(canary), await rescueCanaryEnvFor(canary, {
      RUNTIME_VAULT_KEY: { get: async () => winerim.master },
      CANARY_EXCLUSIVE_CREDENTIAL_VERSION: activeFence.credentialVersion,
      CANARY_WRITER_FENCE_PROOF: { get: async () => activeFence.proof },
      CANARY_WRITER_FENCE_GRANT: { get: async () => swappedGrant },
      WRITER_FENCE: { fetch: lease },
    }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      failure: { httpStatus: 403, message: "WRITER_FENCE_ACTIVE_SCOPE_EVIDENCE_REJECTED" },
    });
    expect(lease).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
  });

  it("blocks the mutation when the writer-fence credential version drifts", async () => {
    const winerim = await encryptedCredentialRow("winerim");
    const credentialFence = await credentialFenceFor(winerim);
    const activeFence = await activeGrantFor(credentialFence);
    const driftedVersion = "d".repeat(64);
    const driftedBinding = await writerFenceCredentialBinding({
      reference: credentialFence.attestation.reference,
      version: driftedVersion,
    });
    const fake = readinessDatabase({ winerim: winerim.row }, activeFence.grantSha256);
    const request = vi.fn<typeof fetch>();
    const worker = createMiddlewareRuntimeExecutorWorker({ database: () => fake.adapter, request });
    const canary = await rescueEnvelope(
      {
        mode: "operational",
        orderId: "rescue-live-order-drift",
        soldAt: "2026-08-03T08:00:00.000Z",
        quantity: 1,
        soldStock: { wineId: "42", stockId: 4202, variant: "glass" },
        stockSource: { wineId: "42", stockId: 4201, variant: "bottle" },
      },
    );
    const response = await worker.fetch(executeRequest(canary), await rescueCanaryEnvFor(canary, {
      RUNTIME_VAULT_KEY: { get: async () => winerim.master },
      CANARY_EXCLUSIVE_CREDENTIAL_VERSION: activeFence.credentialVersion,
      CANARY_WRITER_FENCE_PROOF: { get: async () => activeFence.proof },
      CANARY_WRITER_FENCE_GRANT: { get: async () => activeFence.rawGrant },
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
    const activeFence = await activeGrantFor(credentialFence);
    const fake = readinessDatabase({ winerim: winerim.row }, activeFence.grantSha256);
    const request = vi.fn<typeof fetch>();
    const worker = createMiddlewareRuntimeExecutorWorker({ database: () => fake.adapter, request });
    const canary = await rescueEnvelope(
      {
        mode: "operational",
        orderId: "rescue-live-order-expiring",
        soldAt: "2026-08-03T08:00:00.000Z",
        quantity: 1,
        soldStock: { wineId: "42", stockId: 4202, variant: "glass" },
        stockSource: { wineId: "42", stockId: 4201, variant: "bottle" },
      },
    );
    const response = await worker.fetch(executeRequest(canary), await rescueCanaryEnvFor(canary, {
      RUNTIME_VAULT_KEY: { get: async () => winerim.master },
      CANARY_EXCLUSIVE_CREDENTIAL_VERSION: activeFence.credentialVersion,
      CANARY_WRITER_FENCE_PROOF: { get: async () => activeFence.proof },
      CANARY_WRITER_FENCE_GRANT: { get: async () => activeFence.rawGrant },
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
