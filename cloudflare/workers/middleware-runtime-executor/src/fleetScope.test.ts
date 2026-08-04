import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

import type {
  DatabaseAdapter,
  DatabaseTransaction,
  QueryResult,
  SqlStatement,
} from "../../middleware-api/src/db";
import type { RuntimeEnvelopeV1 } from "../../middleware-runtime/src/contracts";
import { sha256Hex } from "../../../canary-failclosed/src/writerFence";
import {
  fleetEnvelopeEventId,
  isEnvelopeInsideActiveFleetScope,
  loadActiveFleetScope,
  resolveFleetWriterFenceMaterial,
  type ActiveFleetScope,
} from "./fleetScope";
import {
  createMiddlewareRuntimeExecutorWorker,
  type MiddlewareRuntimeExecutorEnv,
} from "./worker";

const CONNECTION_A = "11111111-1111-4111-8111-111111111111";
const CONNECTION_B = "22222222-2222-4222-8222-222222222222";
const KEY_VERSION = "v1";
const GRANT_HASH_A = "c".repeat(64);
const GRANT_HASH_B = "d".repeat(64);

function attestation(runId: string, kind: "agora" | "winerim"): string {
  return createHash("sha256").update(`fixture:${runId}:${kind}`).digest("hex");
}

function generation(connectionId: string, runId: string): string {
  return createHash("sha256").update([
    "winerim-runtime-credential-set",
    "1",
    connectionId,
    runId,
    KEY_VERSION,
    attestation(runId, "agora"),
    attestation(runId, "winerim"),
  ].join("|")).digest("hex");
}

const GENERATION_A = generation(CONNECTION_A, "run-fleet-a");
const GENERATION_B = generation(CONNECTION_B, "run-fleet-b");

function scope(
  connectionId: string,
  runId: string,
  credentialSetSha256: string,
  writerFenceGrantSha256 = GRANT_HASH_A,
): ActiveFleetScope {
  return Object.freeze({
    connectionId,
    runId,
    generationMode: "rotate",
    credentialSetSha256,
    writerFenceGrantSha256,
  });
}

function envelope(
  activeScope: ActiveFleetScope,
  overrides: Partial<RuntimeEnvelopeV1> = {},
): RuntimeEnvelopeV1 {
  const messageId = String(overrides.messageId ?? `message-${activeScope.runId}`);
  return {
    name: "winerim.middleware.runtime",
    version: 1,
    messageId,
    idempotencyKey: `idempotency-${activeScope.runId}`,
    connectionId: activeScope.connectionId,
    lane: "sales-import",
    job: "winerim.sales-import-live",
    retryProfile: "WINERIM_MUTATION",
    attempt: 0,
    maxAttempts: 3,
    createdAt: "2026-08-04T10:00:00.000Z",
    availableAt: "2026-08-04T10:00:00.000Z",
    source: {
      kind: "queue",
      eventId: fleetEnvelopeEventId(activeScope, messageId),
    },
    payload: {
      dryRun: true,
      mode: "operational",
      orderId: `order-${activeScope.runId}`,
      soldAt: "2026-08-04T10:00:00.000Z",
      quantity: 1,
      soldStock: { wineId: "42", stockId: 4202, variant: "glass" },
      stockSource: { wineId: "42", stockId: 4201, variant: "bottle" },
    },
    ...overrides,
  };
}

function queryResult<Row extends Record<string, unknown>>(rows: Row[]): QueryResult<Row> {
  return { rows, rowCount: rows.length };
}

function databaseForScopes(scopes: readonly ActiveFleetScope[]) {
  const query = vi.fn(async <Row extends Record<string, unknown>>(statement: SqlStatement) => {
    if (statement.text.includes("FROM public.runtime_canary_connections")) {
      const connectionId = String(statement.values[0] ?? "");
      return queryResult(scopes.filter((item) => item.connectionId === connectionId).map((item) => ({
        connection_id: item.connectionId,
        run_id: item.runId,
        generation_mode: item.generationMode,
        credential_set_sha256: item.credentialSetSha256,
        writer_fence_grant_sha256: item.writerFenceGrantSha256,
      })) as Row[]);
    }
    if (statement.text.includes("FROM public.pos_connections")) {
      const connectionId = String(statement.values[0] ?? "");
      return queryResult(scopes.some((item) => item.connectionId === connectionId) ? [{
        connection_id: connectionId,
        provider: "agora",
        enabled: true,
        base_url: `https://${connectionId.slice(0, 8)}.agora.example`,
      }] as Row[] : []);
    }
    if (statement.text.includes("FROM public.runtime_connection_credentials")) {
      const connectionId = String(statement.values[0] ?? "");
      const runId = String(statement.values[1] ?? "");
      return queryResult(scopes.some((item) => (
        item.connectionId === connectionId && item.runId === runId
      )) ? (["agora", "winerim"] as const).map((kind) => ({
        credential_kind: kind,
        key_version: KEY_VERSION,
        attestation_sha256: attestation(runId, kind),
      })) as Row[] : []);
    }
    return queryResult([] as Row[]);
  });
  const adapter: DatabaseAdapter = {
    query,
    transaction: async <T>(work: (transaction: DatabaseTransaction) => Promise<T>) => work({ query }),
  };
  return { adapter, query };
}

function fleetEnv(): MiddlewareRuntimeExecutorEnv {
  return {
    ENVIRONMENT: "rescue-production",
    RUNTIME_MODE: "fleet-executor",
    RUNTIME_EXECUTION_ENABLED: "true",
    RUNTIME_VAULT_KEY_VERSION: "v1",
    WINERIM_API_BASE_URL: "https://app.winerim.com",
    WINERIM_ALLOWED_HOSTS: "app.winerim.com",
    MIDDLEWARE_DB: { connectionString: "postgres://fixture.invalid/fleet" },
    RUNTIME_VAULT_KEY: { get: async () => "unused-in-dry-run" },
    RUNTIME_FLEET_WRITER_FENCE_BUNDLE: { get: async () => JSON.stringify({ version: 1, entries: [] }) },
    WRITER_FENCE: { fetch: vi.fn() },
  };
}

function executeRequest(runtimeEnvelope: RuntimeEnvelopeV1): Request {
  return new Request("https://executor.example/v1/execute", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ envelope: runtimeEnvelope }),
  });
}

function rawGrant(connectionId: string, runId: string, holderId: string): string {
  return JSON.stringify({
    version: 1,
    connectionId,
    runId,
    holderId,
    proofSha256: "1".repeat(64),
    exclusiveCredentialRef: `runtime-vault://postgres/${connectionId}/agora/winerim`,
    credentialVersion: "2".repeat(64),
    credentialBinding: "3".repeat(64),
    legacyWriter: {
      revokedAt: "2026-08-04T09:00:00.000Z",
      negativeProbeStatus: 401,
      evidenceSha256: "4".repeat(64),
    },
    issuedAt: "2026-08-04T09:01:00.000Z",
    expiresAt: "2026-08-04T10:01:00.000Z",
  });
}

describe("fleet runtime scope", () => {
  it("executes two connections independently in the same fleet worker", async () => {
    const scopeA = scope(CONNECTION_A, "run-fleet-a", GENERATION_A);
    const scopeB = scope(CONNECTION_B, "run-fleet-b", GENERATION_B, GRANT_HASH_B);
    const fake = databaseForScopes([scopeA, scopeB]);
    const worker = createMiddlewareRuntimeExecutorWorker({ database: () => fake.adapter });

    const responseA = await worker.fetch(executeRequest(envelope(scopeA)), fleetEnv());
    const responseB = await worker.fetch(executeRequest(envelope(scopeB)), fleetEnv());

    expect(responseA.status).toBe(200);
    expect(responseB.status).toBe(200);
    await expect(responseA.json()).resolves.toEqual({ ok: true, detail: "stock:dry-run:sales-import" });
    await expect(responseB.json()).resolves.toEqual({ ok: true, detail: "stock:dry-run:sales-import" });
    const scopedLookups = fake.query.mock.calls.filter(([statement]) => (
      statement.text.includes("FROM public.runtime_canary_connections")
    ));
    expect(scopedLookups.map(([statement]) => statement.values[0])).toEqual([CONNECTION_A, CONNECTION_B]);
  });

  it("rejects a message carrying another connection generation before loading the connection", async () => {
    const scopeA = scope(CONNECTION_A, "run-fleet-a", GENERATION_A);
    const scopeB = scope(CONNECTION_B, "run-fleet-b", GENERATION_B, GRANT_HASH_B);
    const fake = databaseForScopes([scopeA, scopeB]);
    const worker = createMiddlewareRuntimeExecutorWorker({ database: () => fake.adapter });
    const crossed = envelope(scopeA, {
      source: {
        kind: "queue",
        eventId: fleetEnvelopeEventId(scopeB, "message-run-fleet-a"),
      },
    });

    const response = await worker.fetch(executeRequest(crossed), fleetEnv());

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      failure: { message: "RUNTIME_FLEET_SCOPE_REJECTED" },
    });
    expect(fake.query.mock.calls.some(([statement]) => (
      statement.text.includes("FROM public.pos_connections")
    ))).toBe(false);
  });

  it("fails closed when more than one active writer scope is returned for a connection", async () => {
    const first = scope(CONNECTION_A, "run-fleet-a", GENERATION_A);
    const second = scope(
      CONNECTION_A,
      "run-fleet-a2",
      generation(CONNECTION_A, "run-fleet-a2"),
      GRANT_HASH_B,
    );
    const fake = databaseForScopes([first, second]);
    const worker = createMiddlewareRuntimeExecutorWorker({ database: () => fake.adapter });

    const response = await worker.fetch(executeRequest(envelope(first)), fleetEnv());

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      failure: { message: "RUNTIME_FLEET_SCOPE_REJECTED" },
    });
  });

  it("binds the writer-fence material to connection, run and credential generation", async () => {
    const grant = rawGrant(CONNECTION_A, "run-fleet-a", "holder-fleet-a");
    const active = scope(CONNECTION_A, "run-fleet-a", GENERATION_A, await sha256Hex(grant));
    const binding = {
      get: async () => JSON.stringify({
        version: 1,
        entries: [{
          connectionId: CONNECTION_A,
          runId: "run-fleet-a",
          generationSha256: GENERATION_A,
          rawGrant: grant,
          proof: "proof".repeat(8),
        }],
      }),
    };

    await expect(resolveFleetWriterFenceMaterial(binding, active)).resolves.toMatchObject({
      rawGrant: grant,
      holderId: "holder-fleet-a",
    });
    await expect(resolveFleetWriterFenceMaterial(binding, {
      ...active,
      credentialSetSha256: GENERATION_B,
    })).rejects.toThrow("RUNTIME_FLEET_FENCE_SCOPE_NOT_FOUND");
  });

  it("rejects duplicate fence entries so two writers cannot share one generation", async () => {
    const grant = rawGrant(CONNECTION_A, "run-fleet-a", "holder-fleet-a");
    const active = scope(CONNECTION_A, "run-fleet-a", GENERATION_A, await sha256Hex(grant));
    const entry = {
      connectionId: CONNECTION_A,
      runId: "run-fleet-a",
      generationSha256: GENERATION_A,
      rawGrant: grant,
      proof: "proof".repeat(8),
    };
    const binding = {
      get: async () => JSON.stringify({ version: 1, entries: [entry, entry] }),
    };

    await expect(resolveFleetWriterFenceMaterial(binding, active)).rejects.toThrow(
      "RUNTIME_FLEET_FENCE_BUNDLE_DUPLICATE",
    );
  });

  it("keeps the pure scope predicate connection and generation exact", () => {
    const active = scope(CONNECTION_A, "run-fleet-a", GENERATION_A);
    const valid = envelope(active);
    expect(isEnvelopeInsideActiveFleetScope(valid, active)).toBe(true);
    expect(isEnvelopeInsideActiveFleetScope({
      ...valid,
      connectionId: CONNECTION_B,
    }, active)).toBe(false);
    expect(isEnvelopeInsideActiveFleetScope({
      ...valid,
      source: { kind: "queue", eventId: `fleet:${active.runId}:${GENERATION_B}:${valid.messageId}` },
    }, active)).toBe(false);
  });

  it("loads exactly one valid active scope and rejects malformed generations", async () => {
    const active = scope(CONNECTION_A, "run-fleet-a", GENERATION_A);
    const fake = databaseForScopes([active]);
    await expect(loadActiveFleetScope(fake.adapter, CONNECTION_A)).resolves.toEqual(active);

    const malformed = databaseForScopes([{ ...active, credentialSetSha256: "not-a-hash" }]);
    await expect(loadActiveFleetScope(malformed.adapter, CONNECTION_A)).resolves.toBeNull();
  });
});
