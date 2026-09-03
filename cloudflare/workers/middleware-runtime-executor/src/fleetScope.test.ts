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
  FLEET_FULL_LANES_RUNTIME_JOB_ALLOWLIST,
  FLEET_SALES_RUNTIME_JOB_ALLOWLIST,
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
    runtimePolicyProfile: "sales-only-v1",
    runtimeJobAllowlist: FLEET_SALES_RUNTIME_JOB_ALLOWLIST,
    runtimeSalesJobAllowlist: FLEET_SALES_RUNTIME_JOB_ALLOWLIST,
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
    lane: "sales-stock",
    job: "sales.auto-sync",
    retryProfile: "POS_OUTBOUND",
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
      businessDay: "2026-08-03",
    },
    runtimeScope: {
      runId: activeScope.runId,
      credentialSetSha256: activeScope.credentialSetSha256,
    },
    ...overrides,
  };
}

function queryResult<Row extends Record<string, unknown>>(rows: Row[]): QueryResult<Row> {
  return { rows, rowCount: rows.length };
}

type FleetPolicyOverrides = Readonly<{
  runtimeSalesJobAllowlist?: readonly string[];
  runtimeFleetProfile?: string;
  runtimeFleetJobAllowlist?: readonly string[];
  runtimeCatalogEnabled?: boolean;
  runtimeStockEnabled?: boolean;
  runtimeOutboundEnabled?: boolean;
  runtimeMaintenanceEnabled?: boolean;
  runtimeSalesCutoverBusinessDay?: string;
  intradaySalesSyncEnabled?: boolean;
  openTicketsSyncEnabled?: boolean;
  openTicketsStockSyncEnabled?: boolean;
  catalogSyncEnabled?: boolean;
  syncMode?: string;
  writeMode?: string;
}>;

function databaseForScopes(
  scopes: readonly ActiveFleetScope[],
  policy: FleetPolicyOverrides = {},
) {
  const query = vi.fn(async (statement: SqlStatement): Promise<QueryResult<Record<string, unknown>>> => {
    if (statement.text.includes("FROM public.runtime_canary_connections")) {
      const connectionId = String(statement.values[0] ?? "");
      return queryResult(scopes.filter((item) => item.connectionId === connectionId).map((item) => ({
        connection_id: item.connectionId,
        run_id: item.runId,
        generation_mode: item.generationMode,
        credential_set_sha256: item.credentialSetSha256,
        writer_fence_grant_sha256: item.writerFenceGrantSha256,
        provider_config: {
          ...(policy.runtimeFleetProfile === undefined ? {} : {
            runtime_fleet_profile: policy.runtimeFleetProfile,
          }),
          ...(policy.runtimeFleetJobAllowlist === undefined ? {} : {
            runtime_fleet_job_allowlist: [...policy.runtimeFleetJobAllowlist],
          }),
          runtime_sales_job_allowlist: policy.runtimeSalesJobAllowlist
            ?? [...item.runtimeSalesJobAllowlist],
          ...(policy.runtimeSalesCutoverBusinessDay === undefined ? {} : {
            runtime_sales_cutover_business_day: policy.runtimeSalesCutoverBusinessDay,
          }),
          intraday_sales_sync_enabled: policy.intradaySalesSyncEnabled ?? true,
          open_tickets_sync_enabled: policy.openTicketsSyncEnabled ?? false,
          open_tickets_stock_sync_enabled: policy.openTicketsStockSyncEnabled ?? false,
          ...(policy.runtimeCatalogEnabled === undefined ? {} : {
            runtime_catalog_enabled: policy.runtimeCatalogEnabled,
          }),
          ...(policy.runtimeStockEnabled === undefined ? {} : {
            runtime_stock_enabled: policy.runtimeStockEnabled,
          }),
          ...(policy.runtimeOutboundEnabled === undefined ? {} : {
            runtime_outbound_enabled: policy.runtimeOutboundEnabled,
          }),
          ...(policy.runtimeMaintenanceEnabled === undefined ? {} : {
            runtime_maintenance_enabled: policy.runtimeMaintenanceEnabled,
          }),
        },
        catalog_sync_enabled: policy.catalogSyncEnabled ?? false,
        sync_mode: policy.syncMode ?? "PULL_ONLY",
        write_mode: policy.writeMode ?? "NONE",
      })));
    }
    if (statement.text.includes("FROM public.pos_connections")) {
      const connectionId = String(statement.values[0] ?? "");
      return queryResult(scopes.some((item) => item.connectionId === connectionId) ? [{
        connection_id: connectionId,
        provider: "agora",
        enabled: true,
        base_url: `https://${connectionId.slice(0, 8)}.agora.example`,
      }] : []);
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
      })) : []);
    }
    return queryResult([]);
  });
  const typedQuery: DatabaseAdapter["query"] = async <Row extends Record<string, unknown>>(
    statement: SqlStatement,
  ) => query(statement) as Promise<QueryResult<Row>>;
  const adapter: DatabaseAdapter = {
    query: typedQuery,
    transaction: async <T>(work: (transaction: DatabaseTransaction) => Promise<T>) => work({
      query: typedQuery,
    }),
  };
  return { adapter, query };
}

function fleetEnv(): MiddlewareRuntimeExecutorEnv {
  return {
    ENVIRONMENT: "rescue-production",
    RUNTIME_MODE: "fleet-executor",
    RUNTIME_EXECUTION_ENABLED: "true",
    RUNTIME_SALES_EXECUTION_ENABLED: "true",
    RUNTIME_SALES_CURSOR_ENABLED: "true",
    RUNTIME_SALES_DLQ_READY: "true",
    RUNTIME_CATALOG_EXECUTION_ENABLED: "false",
    RUNTIME_CATALOG_FETCH_ENABLED: "false",
    RUNTIME_CATALOG_APPLY_ENABLED: "false",
    RUNTIME_OUTBOUND_EXECUTION_ENABLED: "false",
    RUNTIME_OUTBOUND_MUTATION_ENABLED: "false",
    RUNTIME_VAULT_KEY_VERSION: "v1",
    WINERIM_API_BASE_URL: "https://app.winerim.com",
    WINERIM_ALLOWED_HOSTS: "app.winerim.com",
    MIDDLEWARE_DB: { connectionString: "postgres://fixture.invalid/fleet" },
    RUNTIME_VAULT_KEY: { get: async () => "unused-in-dry-run" },
    RUNTIME_FLEET_WRITER_FENCE_BUNDLE: { get: async () => JSON.stringify({ version: 1, entries: [] }) },
    WRITER_FENCE: { fetch: vi.fn() },
  };
}

function fullLanesFleetEnv(): MiddlewareRuntimeExecutorEnv {
  return {
    ...fleetEnv(),
    RUNTIME_CATALOG_EXECUTION_ENABLED: "true",
    RUNTIME_CATALOG_FETCH_ENABLED: "true",
    RUNTIME_CATALOG_APPLY_ENABLED: "true",
    RUNTIME_OUTBOUND_EXECUTION_ENABLED: "true",
    RUNTIME_OUTBOUND_MUTATION_ENABLED: "true",
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
  it("accepts only the exact sales allowlist for independent fleet scopes", async () => {
    const scopeA = scope(CONNECTION_A, "run-fleet-a", GENERATION_A);
    const scopeB = scope(CONNECTION_B, "run-fleet-b", GENERATION_B, GRANT_HASH_B);
    const fake = databaseForScopes([scopeA, scopeB]);

    const loadedA = await loadActiveFleetScope(fake.adapter, CONNECTION_A);
    const loadedB = await loadActiveFleetScope(fake.adapter, CONNECTION_B);
    expect(loadedA?.runtimeSalesJobAllowlist).toEqual(["sales.auto-sync", "sales.sync-intraday"]);
    expect(loadedA?.runtimePolicyProfile).toBe("sales-only-v1");
    expect(loadedA?.runtimeJobAllowlist).toEqual(["sales.auto-sync", "sales.sync-intraday"]);
    expect(loadedB?.runtimeSalesJobAllowlist).toEqual(["sales.auto-sync", "sales.sync-intraday"]);
    expect(isEnvelopeInsideActiveFleetScope(envelope(scopeA), loadedA!)).toBe(true);
    expect(isEnvelopeInsideActiveFleetScope(envelope(scopeB, {
      job: "sales.sync-intraday",
    }), loadedB!)).toBe(true);
  });

  it("accepts full-lanes bootstrap scopes only with the exact reviewed profile", async () => {
    const active = scope(CONNECTION_A, "run-fleet-a", GENERATION_A);
    const fake = databaseForScopes([active], {
      runtimeFleetProfile: "full-lanes-v1",
      runtimeFleetJobAllowlist: FLEET_FULL_LANES_RUNTIME_JOB_ALLOWLIST,
      runtimeSalesJobAllowlist: FLEET_SALES_RUNTIME_JOB_ALLOWLIST,
      runtimeSalesCutoverBusinessDay: "2026-08-05",
      runtimeCatalogEnabled: true,
      runtimeStockEnabled: true,
      runtimeOutboundEnabled: true,
      runtimeMaintenanceEnabled: false,
      catalogSyncEnabled: true,
      syncMode: "BIDIRECTIONAL",
      writeMode: "XML_IMPORT",
    });

    const loaded = await loadActiveFleetScope(fake.adapter, CONNECTION_A);

    expect(loaded?.runtimePolicyProfile).toBe("full-lanes-v1");
    expect(loaded?.runtimeJobAllowlist).toEqual(FLEET_FULL_LANES_RUNTIME_JOB_ALLOWLIST);
    expect(isEnvelopeInsideActiveFleetScope(envelope(active, {
      job: "catalog.sync-master",
      lane: "catalog",
      retryProfile: "POS_OUTBOUND",
    }), loaded!)).toBe(true);
    expect(isEnvelopeInsideActiveFleetScope(envelope(active, {
      job: "outbound.process",
      lane: "outbound-queue",
      retryProfile: "POS_OUTBOUND",
    }), loaded!)).toBe(true);
  });

  it("executes full-lanes outbound dry-run past the runtime execution gate", async () => {
    const active = scope(CONNECTION_A, "run-fleet-a", GENERATION_A);
    const fake = databaseForScopes([active], {
      runtimeFleetProfile: "full-lanes-v1",
      runtimeFleetJobAllowlist: FLEET_FULL_LANES_RUNTIME_JOB_ALLOWLIST,
      runtimeSalesJobAllowlist: FLEET_SALES_RUNTIME_JOB_ALLOWLIST,
      runtimeSalesCutoverBusinessDay: "2026-08-05",
      runtimeCatalogEnabled: true,
      runtimeStockEnabled: true,
      runtimeOutboundEnabled: true,
      runtimeMaintenanceEnabled: false,
      catalogSyncEnabled: true,
      syncMode: "BIDIRECTIONAL",
      writeMode: "XML_IMPORT",
    });
    const worker = createMiddlewareRuntimeExecutorWorker({ database: () => fake.adapter });

    const response = await worker.fetch(executeRequest(envelope(active, {
      job: "outbound.process",
      lane: "outbound-queue",
      retryProfile: "POS_OUTBOUND",
      payload: { dryRun: true },
    })), fullLanesFleetEnv());

    expect(response.status).not.toBe(503);
    await expect(response.json()).resolves.not.toMatchObject({
      failure: { message: "RUNTIME_EXECUTION_DISABLED" },
    });
    expect(fake.query.mock.calls.some(([statement]) => (
      statement.text.includes("FROM public.pos_connections")
    ))).toBe(true);
  });

  it.each([
    ["open tickets", "sales.sync-open-tickets", "sales-stock", "POS_OUTBOUND"],
    ["live stock", "winerim.sales-import-live", "sales-import", "WINERIM_MUTATION"],
    ["catalog", "catalog.sync-master", "catalog", "POS_OUTBOUND"],
    ["outbound", "outbound.process", "outbound-queue", "POS_OUTBOUND"],
  ] as const)("rejects %s outside the fleet sales allowlist before connection execution", async (
    _label,
    job,
    lane,
    retryProfile,
  ) => {
    const active = scope(CONNECTION_A, "run-fleet-a", GENERATION_A);
    const fake = databaseForScopes([active]);
    const worker = createMiddlewareRuntimeExecutorWorker({ database: () => fake.adapter });
    const response = await worker.fetch(executeRequest(envelope(active, {
      job,
      lane,
      retryProfile,
    })), fleetEnv());

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      failure: { message: "RUNTIME_FLEET_SCOPE_REJECTED" },
    });
    expect(fake.query.mock.calls.some(([statement]) => (
      statement.text.includes("FROM public.pos_connections")
    ))).toBe(false);
  });

  it.each([
    ["catalog execution", { RUNTIME_CATALOG_EXECUTION_ENABLED: "true" }],
    ["catalog fetch", { RUNTIME_CATALOG_FETCH_ENABLED: "true" }],
    ["catalog apply", { RUNTIME_CATALOG_APPLY_ENABLED: "true" }],
    ["outbound execution", { RUNTIME_OUTBOUND_EXECUTION_ENABLED: "true" }],
    ["outbound mutation", { RUNTIME_OUTBOUND_MUTATION_ENABLED: "true" }],
    ["open sales switch", { RUNTIME_SALES_EXECUTION_ENABLED: "false" }],
  ])("fails closed when the fleet %s switch drifts", async (_label, override) => {
    const active = scope(CONNECTION_A, "run-fleet-a", GENERATION_A);
    const fake = databaseForScopes([active]);
    const worker = createMiddlewareRuntimeExecutorWorker({ database: () => fake.adapter });
    const response = await worker.fetch(executeRequest(envelope(active)), {
      ...fleetEnv(),
      ...override,
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      failure: { message: "RUNTIME_EXECUTION_DISABLED" },
    });
    expect(fake.query).not.toHaveBeenCalled();
  });

  it("reports only the two approved jobs in fleet readiness", async () => {
    const worker = createMiddlewareRuntimeExecutorWorker();
    const response = await worker.fetch(new Request("https://executor.example/ready"), fleetEnv());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      enabledJobs: ["sales.auto-sync", "sales.sync-intraday"],
      missingBindings: [],
    });
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
    expect(isEnvelopeInsideActiveFleetScope({
      ...valid,
      job: "sales.sync-open-tickets",
    }, active)).toBe(false);
    expect(isEnvelopeInsideActiveFleetScope({
      ...valid,
      runtimeScope: undefined,
    }, active)).toBe(false);
  });

  it("loads exactly one valid active scope and rejects malformed generations", async () => {
    const active = scope(CONNECTION_A, "run-fleet-a", GENERATION_A);
    const fake = databaseForScopes([active]);
    await expect(loadActiveFleetScope(fake.adapter, CONNECTION_A)).resolves.toEqual(active);

    const malformed = databaseForScopes([{ ...active, credentialSetSha256: "not-a-hash" }]);
    await expect(loadActiveFleetScope(malformed.adapter, CONNECTION_A)).resolves.toBeNull();
  });

  it.each([
    ["extra job", { runtimeSalesJobAllowlist: [
      "sales.auto-sync",
      "sales.sync-intraday",
      "sales.sync-open-tickets",
    ] }],
    ["missing job", { runtimeSalesJobAllowlist: ["sales.auto-sync"] }],
    ["reordered jobs", { runtimeSalesJobAllowlist: ["sales.sync-intraday", "sales.auto-sync"] }],
    ["open tickets", { openTicketsSyncEnabled: true }],
    ["open-ticket stock", { openTicketsStockSyncEnabled: true }],
    ["catalog sync", { catalogSyncEnabled: true }],
    ["bidirectional mode", { syncMode: "BIDIRECTIONAL" }],
    ["XML write mode", { writeMode: "XML_IMPORT" }],
  ] satisfies readonly (readonly [string, FleetPolicyOverrides])[])(
    "rejects a fleet scope when provider policy opens %s",
    async (_label, policy) => {
      const active = scope(CONNECTION_A, "run-fleet-a", GENERATION_A);
      const fake = databaseForScopes([active], policy);

      await expect(loadActiveFleetScope(fake.adapter, CONNECTION_A)).resolves.toBeNull();
    },
  );
});
