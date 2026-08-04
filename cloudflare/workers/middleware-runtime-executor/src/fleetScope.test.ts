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
  FLEET_FULL_RUNTIME_JOB_ALLOWLIST,
  FLEET_SALES_RUNTIME_JOB_ALLOWLIST,
  fleetEnvelopeEventId,
  isEnvelopeInsideActiveFleetScope,
  loadActiveFleetScope,
  resolveFleetWriterFenceMaterial,
  type ActiveFleetScope,
  type FleetRuntimePolicyProfile,
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

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function providerConfig(profile: FleetRuntimePolicyProfile): Record<string, unknown> {
  if (profile === "full-lanes-v1") {
    return {
      runtime_fleet_profile: "full-lanes-v1",
      runtime_fleet_job_allowlist: [...FLEET_FULL_RUNTIME_JOB_ALLOWLIST],
      runtime_sales_job_allowlist: [...FLEET_SALES_RUNTIME_JOB_ALLOWLIST],
      intraday_sales_sync_enabled: true,
      open_tickets_sync_enabled: false,
      open_tickets_stock_sync_enabled: false,
      runtime_catalog_enabled: true,
      runtime_stock_enabled: true,
      runtime_outbound_enabled: true,
      runtime_maintenance_enabled: false,
    };
  }
  return {
    runtime_sales_job_allowlist: [...FLEET_SALES_RUNTIME_JOB_ALLOWLIST],
    intraday_sales_sync_enabled: true,
    open_tickets_sync_enabled: false,
    open_tickets_stock_sync_enabled: false,
  };
}

const GENERATION_A = generation(CONNECTION_A, "run-fleet-a");
const GENERATION_B = generation(CONNECTION_B, "run-fleet-b");

function scope(
  connectionId: string,
  runId: string,
  credentialSetSha256: string,
  writerFenceGrantSha256 = GRANT_HASH_A,
  runtimePolicyProfile: FleetRuntimePolicyProfile = "sales-only-v1",
): ActiveFleetScope {
  const runtimeJobAllowlist = runtimePolicyProfile === "full-lanes-v1"
    ? FLEET_FULL_RUNTIME_JOB_ALLOWLIST
    : FLEET_SALES_RUNTIME_JOB_ALLOWLIST;
  return Object.freeze({
    connectionId,
    runId,
    generationMode: "rotate",
    credentialSetSha256,
    writerFenceGrantSha256,
    runtimePolicyProfile,
    runtimePolicySha256: createHash("sha256")
      .update(canonicalJson(providerConfig(runtimePolicyProfile)))
      .digest("hex"),
    runtimeJobAllowlist,
    runtimeSalesJobAllowlist: runtimeJobAllowlist,
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
  runtimeFleetJobAllowlist?: readonly string[];
  runtimeFleetProfile?: string;
  intradaySalesSyncEnabled?: boolean;
  openTicketsSyncEnabled?: boolean;
  openTicketsStockSyncEnabled?: boolean;
  catalogSyncEnabled?: boolean;
  syncMode?: string;
  writeMode?: string;
  runtimeCatalogEnabled?: boolean;
  runtimeStockEnabled?: boolean;
  runtimeOutboundEnabled?: boolean;
  runtimeMaintenanceEnabled?: boolean;
}>;

function databaseForScopes(
  scopes: readonly ActiveFleetScope[],
  policy: FleetPolicyOverrides = {},
) {
  const query = vi.fn(async (statement: SqlStatement): Promise<QueryResult<Record<string, unknown>>> => {
    if (statement.text.includes("FROM public.runtime_canary_connections")) {
      const connectionId = String(statement.values[0] ?? "");
      return queryResult(scopes.filter((item) => item.connectionId === connectionId).map((item) => {
        const config = providerConfig(item.runtimePolicyProfile);
        if (policy.runtimeSalesJobAllowlist) {
          config.runtime_sales_job_allowlist = [...policy.runtimeSalesJobAllowlist];
        }
        if (policy.runtimeFleetJobAllowlist) {
          config.runtime_fleet_job_allowlist = [...policy.runtimeFleetJobAllowlist];
        }
        if (policy.runtimeFleetProfile !== undefined) {
          config.runtime_fleet_profile = policy.runtimeFleetProfile;
        }
        config.intraday_sales_sync_enabled = policy.intradaySalesSyncEnabled ?? true;
        config.open_tickets_sync_enabled = policy.openTicketsSyncEnabled ?? false;
        config.open_tickets_stock_sync_enabled = policy.openTicketsStockSyncEnabled ?? false;
        if (item.runtimePolicyProfile === "full-lanes-v1") {
          config.runtime_catalog_enabled = policy.runtimeCatalogEnabled ?? true;
          config.runtime_stock_enabled = policy.runtimeStockEnabled ?? true;
          config.runtime_outbound_enabled = policy.runtimeOutboundEnabled ?? true;
          config.runtime_maintenance_enabled = policy.runtimeMaintenanceEnabled ?? false;
        }
        return {
          connection_id: item.connectionId,
          run_id: item.runId,
          generation_mode: item.generationMode,
          credential_set_sha256: item.credentialSetSha256,
          writer_fence_grant_sha256: item.writerFenceGrantSha256,
          provider_config: config,
          catalog_sync_enabled: policy.catalogSyncEnabled
            ?? item.runtimePolicyProfile === "full-lanes-v1",
          sync_mode: policy.syncMode
            ?? (item.runtimePolicyProfile === "full-lanes-v1" ? "BIDIRECTIONAL" : "PULL_ONLY"),
          write_mode: policy.writeMode
            ?? (item.runtimePolicyProfile === "full-lanes-v1" ? "XML_IMPORT" : "NONE"),
        };
      }));
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

function rawAdoptGrant(
  connectionId: string,
  runId: string,
  holderId: string,
  runtimePolicySha256: string,
): string {
  const hash = (character: string) => character.repeat(64);
  return JSON.stringify({
    version: 3,
    grantType: "adopt-existing-sales",
    connectionId,
    runId,
    holderId,
    proofSha256: hash("1"),
    issuedAt: "2026-08-04T09:01:00.000Z",
    expiresAt: "2026-08-04T10:01:00.000Z",
    credentialBundle: {
      version: 1,
      keyVersion: "key-v1",
      generationSha256: hash("2"),
      bundleSha256: hash("3"),
      signatureSha256: hash("4"),
      credentials: Object.fromEntries((["agora", "winerim"] as const).map((kind) => [kind, {
        kind,
        reference: `runtime-vault://postgres/${connectionId}/agora/${kind}`,
        version: hash(kind === "agora" ? "5" : "6"),
        attestationSha256: hash(kind === "agora" ? "5" : "6"),
        binding: hash(kind === "agora" ? "7" : "8"),
      }])),
    },
    writerHistory: {
      mode: "adopt-existing-sales",
      verifiedAt: "2026-08-04T09:03:20.000Z",
      evidenceSha256: hash("9"),
      cloudflareEvidenceSha256: hash("a"),
      externalEvidence: {
        artifactSha256: hash("b"),
        publicKeySha256: hash("c"),
        payloadSha256: hash("d"),
        signatureSha256: hash("e"),
        keyId: "fixture-key-v1",
        projectId: "33333333-3333-4333-8333-333333333333",
        collectorRunId: "fixture-observer-v1",
        fenceMode: "lovable-disabled-no-agora-rotation",
        fenceAppliedAt: "2026-08-04T09:00:00.000Z",
        observedAt: "2026-08-04T09:03:20.000Z",
        readbackObservedAt: [
          "2026-08-04T09:02:10.000Z",
          "2026-08-04T09:03:20.000Z",
        ],
        removedFromLovable: true,
      },
    },
    activationScope: {
      version: 1,
      kind: "adopt-existing-sales",
      adoptionBindingSha256: hash("f"),
      deploymentManifestSha256: hash("1"),
      finalTargetRawSha256: hash("2"),
      externalEvidenceSha256: hash("b"),
      externalEvidencePayloadSha256: hash("d"),
      runtimePolicyProfile: "full-lanes-v1",
      runtimeJobAllowlist: [...FLEET_FULL_RUNTIME_JOB_ALLOWLIST],
      runtimePolicySha256,
      bindingSha256: hash("3"),
      signatureSha256: hash("4"),
    },
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
    expect(loadedB?.runtimeSalesJobAllowlist).toEqual(["sales.auto-sync", "sales.sync-intraday"]);
    expect(isEnvelopeInsideActiveFleetScope(envelope(scopeA), loadedA!)).toBe(true);
    expect(isEnvelopeInsideActiveFleetScope(envelope(scopeB, {
      job: "sales.sync-intraday",
    }), loadedB!)).toBe(true);
  });

  it("accepts the exact configured full-lanes policy and no job outside it", async () => {
    const active = scope(
      CONNECTION_A,
      "run-fleet-a",
      GENERATION_A,
      GRANT_HASH_A,
      "full-lanes-v1",
    );
    const fake = databaseForScopes([active]);
    const loaded = await loadActiveFleetScope(fake.adapter, CONNECTION_A);

    expect(loaded).toMatchObject({
      runtimePolicyProfile: "full-lanes-v1",
      runtimeJobAllowlist: [
        "sales.auto-sync",
        "sales.sync-intraday",
        "catalog.fetch-winerim",
        "catalog.sync-master",
        "outbound.process",
      ],
    });
    for (const [job, lane, retryProfile] of [
      ["sales.auto-sync", "sales-stock", "POS_OUTBOUND"],
      ["sales.sync-intraday", "sales-stock", "POS_OUTBOUND"],
      ["catalog.fetch-winerim", "catalog", "CONTROL_PLANE"],
      ["catalog.sync-master", "catalog", "POS_OUTBOUND"],
      ["outbound.process", "outbound-queue", "POS_OUTBOUND"],
    ] as const) {
      expect(isEnvelopeInsideActiveFleetScope(envelope(active, {
        job,
        lane,
        retryProfile,
      }), loaded!)).toBe(true);
    }
    expect(isEnvelopeInsideActiveFleetScope(envelope(active, {
      job: "sales.sync-open-tickets",
    }), loaded!)).toBe(false);
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

  it("requires a full-lanes grant to bind the exact runtime policy hash", async () => {
    const initial = scope(
      CONNECTION_A,
      "run-fleet-a",
      GENERATION_A,
      GRANT_HASH_A,
      "full-lanes-v1",
    );
    const grant = rawAdoptGrant(
      CONNECTION_A,
      "run-fleet-a",
      "holder-fleet-a",
      initial.runtimePolicySha256,
    );
    const active = { ...initial, writerFenceGrantSha256: await sha256Hex(grant) };
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
      holderId: "holder-fleet-a",
    });

    const driftedGrant = rawAdoptGrant(
      CONNECTION_A,
      "run-fleet-a",
      "holder-fleet-a",
      "0".repeat(64),
    );
    await expect(resolveFleetWriterFenceMaterial({
      get: async () => JSON.stringify({
        version: 1,
        entries: [{
          connectionId: CONNECTION_A,
          runId: "run-fleet-a",
          generationSha256: GENERATION_A,
          rawGrant: driftedGrant,
          proof: "proof".repeat(8),
        }],
      }),
    }, {
      ...active,
      writerFenceGrantSha256: await sha256Hex(driftedGrant),
    })).rejects.toThrow("RUNTIME_FLEET_FENCE_POLICY_BINDING_MISMATCH");

    const driftedJobs = JSON.parse(grant) as Record<string, unknown>;
    (driftedJobs.activationScope as Record<string, unknown>).runtimeJobAllowlist = [
      "sales.auto-sync",
      "sales.sync-intraday",
      "catalog.fetch-winerim",
      "catalog.sync-master",
    ];
    const driftedJobsGrant = JSON.stringify(driftedJobs);
    await expect(resolveFleetWriterFenceMaterial({
      get: async () => JSON.stringify({
        version: 1,
        entries: [{
          connectionId: CONNECTION_A,
          runId: "run-fleet-a",
          generationSha256: GENERATION_A,
          rawGrant: driftedJobsGrant,
          proof: "proof".repeat(8),
        }],
      }),
    }, {
      ...active,
      writerFenceGrantSha256: await sha256Hex(driftedJobsGrant),
    })).rejects.toThrow("RUNTIME_FLEET_FENCE_POLICY_BINDING_MISMATCH");
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

  it.each([
    ["missing catalog job", {
      runtimeFleetJobAllowlist: [
        "sales.auto-sync",
        "sales.sync-intraday",
        "catalog.sync-master",
        "outbound.process",
      ],
    }],
    ["reordered jobs", {
      runtimeFleetJobAllowlist: [
        "sales.auto-sync",
        "sales.sync-intraday",
        "catalog.sync-master",
        "catalog.fetch-winerim",
        "outbound.process",
      ],
    }],
    ["unknown profile", { runtimeFleetProfile: "full-lanes-v2" }],
    ["catalog disabled", { catalogSyncEnabled: false }],
    ["pull-only mode", { syncMode: "PULL_ONLY" }],
    ["write disabled", { writeMode: "NONE" }],
    ["catalog feature disabled", { runtimeCatalogEnabled: false }],
    ["stock feature disabled", { runtimeStockEnabled: false }],
    ["outbound feature disabled", { runtimeOutboundEnabled: false }],
    ["maintenance opened", { runtimeMaintenanceEnabled: true }],
  ] satisfies readonly (readonly [string, FleetPolicyOverrides])[]) (
    "rejects full-lanes policy drift: %s",
    async (_label, policy) => {
      const active = scope(
        CONNECTION_A,
        "run-fleet-a",
        GENERATION_A,
        GRANT_HASH_A,
        "full-lanes-v1",
      );
      const fake = databaseForScopes([active], policy);

      await expect(loadActiveFleetScope(fake.adapter, CONNECTION_A)).resolves.toBeNull();
    },
  );
});
