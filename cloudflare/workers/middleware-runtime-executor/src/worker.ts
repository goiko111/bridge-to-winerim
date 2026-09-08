import { Client } from "pg";

import {
  createHyperdrivePostgresAdapter,
  sql,
  type DatabaseAdapter,
  type DriverQueryConfig,
  type HyperdriveBinding,
  type PostgresClientFactory,
} from "../../middleware-api/src/db";
import {
  createWinerimMutationTransport,
  type HttpRequestPort,
  type SecretTextPort,
} from "../../middleware-runtime/src/adapters/http";
import type { PostgresCatalogAdapterFactory } from "../../middleware-runtime/src/adapters/catalog";
import {
  isRuntimeEnvelope,
  isDeployableRuntimeCanaryConnectionId,
  type RuntimeEnvelopeV1,
  type RuntimeJob,
} from "../../middleware-runtime/src/contracts";
import {
  createConnectionScopedRuntimeExecutor,
  createPostgresEncryptedCredentialPort,
  createPostgresRuntimeConnectionPort,
  createRuntimeExecutorService,
  runtimeCredentialAttestation,
  type ProviderNeutralRuntimeExecutorPorts,
  type RuntimeConnectionExecutorContext,
  type RuntimeExecutorCompositionOptions,
  type RuntimeVaultSecretBinding,
} from "../../middleware-runtime/src/executor";
import type { WinerimStockMutationInput, WinerimStockIdentity } from "../../middleware-runtime/src/handlers/stock";
import type { RuntimeExecutionResult } from "../../middleware-runtime/src/queue";
import {
  createAgoraCatalogPlanApplyAndReadbackPort,
  createPrivateCatalogLaneExecutor,
  privateCatalogEnabledJobs,
  type AgoraCatalogApplyAndReadbackPort,
  type AgoraCatalogXmlProfile,
  type PrivateCatalogSwitches,
} from "./catalog";
import {
  executeAgoraSalesEnvelope,
  isSalesLaneJob,
  salesLaneFlags,
  salesLaneGateFailure,
} from "./sales";
import {
  isEnvelopeInsideExclusiveCanaryScope,
  resolveExclusiveCanaryJobLane,
  type ExclusiveCanaryJob,
  type ExclusiveCanaryScope,
} from "../../../canary-failclosed/src/exclusiveScope";
import {
  acquireExclusiveWriterFence,
  authorizeWriterFenceMutation,
  validateActiveWriterFenceGrant,
  writerFenceCredentialBinding,
  writerFenceFleetCredentialBinding,
  type WriterFenceActiveScopeEvidence,
  type WriterFenceClientEnvironment,
  type WriterFenceCredentialAttestation,
  type WriterFenceCredentialKind,
  type WriterFenceGrant,
  type WriterFenceMutationAuthorization,
} from "../../../canary-failclosed/src/writerFence";
import {
  FLEET_EXECUTOR_MODE,
  FLEET_SALES_RUNTIME_JOB_ALLOWLIST,
  isEnvelopeInsideActiveFleetScope,
  loadActiveFleetScope,
  resolveFleetWriterFenceMaterial,
  type ActiveFleetScope,
} from "./fleetScope";

const STAGING_ENVIRONMENT = "staging";
const RESCUE_PRODUCTION_ENVIRONMENT = "rescue-production";
const EXCLUSIVE_CANARY_EXECUTOR_MODE = "exclusive-canary-executor";
const ENABLED_STOCK_JOBS = Object.freeze([
  "winerim.sales-import-live",
] as const satisfies readonly RuntimeJob[]);
const CURSORED_SALES_JOBS = Object.freeze([
  "sales.auto-sync",
  "sales.sync-intraday",
] as const satisfies readonly RuntimeJob[]);
const CATALOG_JOBS = new Set<RuntimeJob>([
  "catalog.fetch-winerim",
  "catalog.sync-master",
]);

export interface MiddlewareRuntimeExecutorEnv extends WriterFenceClientEnvironment {
  ENVIRONMENT?: string;
  RUNTIME_MODE?: string;
  RELEASE?: string;
  RUNTIME_EXECUTION_ENABLED?: string;
  RUNTIME_SALES_EXECUTION_ENABLED?: string;
  RUNTIME_SALES_CURSOR_ENABLED?: string;
  RUNTIME_SALES_DLQ_READY?: string;
  RUNTIME_SALES_MAX_CLOSED_DAYS_PER_RUN?: string;
  RUNTIME_CATALOG_EXECUTION_ENABLED?: string;
  RUNTIME_CATALOG_FETCH_ENABLED?: string;
  RUNTIME_CATALOG_APPLY_ENABLED?: string;
  RUNTIME_OUTBOUND_EXECUTION_ENABLED?: string;
  RUNTIME_OUTBOUND_MUTATION_ENABLED?: string;
  RUNTIME_AGORA_CREDENTIAL_MODE?: string;
  CANARY_RUNTIME_JOB?: string;
  CANARY_RUNTIME_LANE?: string;
  CANARY_CATALOG_PRODUCT_ID?: string;
  CANARY_EXCLUSIVE_CREDENTIAL_VERSION?: string;
  RUNTIME_AGORA_CATALOG_BASE_URL?: string;
  RUNTIME_AGORA_CATALOG_ALLOWED_HOSTS?: string;
  RUNTIME_AGORA_CATALOG_PROFILE_JSON?: string;
  RUNTIME_FLEET_CATALOG_PROFILES_JSON?: string;
  RUNTIME_CANARY_CONNECTION_ID?: string;
  CANARY_RUN_ID?: string;
  CANARY_MESSAGE_ID?: string;
  CANARY_IDEMPOTENCY_KEY?: string;
  CANARY_PAYLOAD_SHA256?: string;
  WRITER_FENCE_HOLDER_ID?: string;
  RUNTIME_VAULT_KEY_VERSION?: string;
  WINERIM_API_BASE_URL?: string;
  WINERIM_ALLOWED_HOSTS?: string;
  MIDDLEWARE_DB?: HyperdriveBinding;
  RUNTIME_VAULT_KEY?: RuntimeVaultSecretBinding;
  CANARY_WRITER_FENCE_GRANT?: RuntimeVaultSecretBinding;
  RUNTIME_FLEET_WRITER_FENCE_BUNDLE?: RuntimeVaultSecretBinding;
}

const CANARY_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const MAX_EXECUTOR_SCOPE_REQUEST_BYTES = 64 * 1024;

function canaryIdentifier(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return CANARY_IDENTIFIER_PATTERN.test(normalized) ? normalized : null;
}

function rescueExecutorScope(env: MiddlewareRuntimeExecutorEnv): ExclusiveCanaryScope | null {
  const connectionId = String(env.RUNTIME_CANARY_CONNECTION_ID ?? "").trim();
  const runId = canaryIdentifier(env.CANARY_RUN_ID);
  const messageId = canaryIdentifier(env.CANARY_MESSAGE_ID);
  const idempotencyKey = canaryIdentifier(env.CANARY_IDEMPOTENCY_KEY);
  const payloadSha256 = String(env.CANARY_PAYLOAD_SHA256 ?? "").trim().toLowerCase();
  const configuredScope = resolveExclusiveCanaryJobLane(
    env.CANARY_RUNTIME_JOB,
    env.CANARY_RUNTIME_LANE,
  );
  if (
    !isDeployableRuntimeCanaryConnectionId(connectionId)
    || !runId
    || !messageId
    || !idempotencyKey
    || !/^[a-f0-9]{64}$/.test(payloadSha256)
    || !configuredScope
  ) return null;
  return {
    queueName: `winerim-rescue-prod-canary-${runId}`,
    connectionId,
    runId,
    messageId,
    idempotencyKey,
    payloadSha256,
    ...configuredScope,
  };
}

function runtimeMode(env: MiddlewareRuntimeExecutorEnv): string {
  return String(env.RUNTIME_MODE ?? "").trim().toLowerCase();
}

function rescueCanaryMode(env: MiddlewareRuntimeExecutorEnv): boolean {
  return runtimeMode(env) === EXCLUSIVE_CANARY_EXECUTOR_MODE;
}

function fleetMode(env: MiddlewareRuntimeExecutorEnv): boolean {
  return runtimeMode(env) === FLEET_EXECUTOR_MODE;
}

export type WriterFenceExecutionScope = Readonly<{
  connectionId: string;
  runId: string;
  holderId: string;
  credentialSetSha256?: string;
  env: MiddlewareRuntimeExecutorEnv;
}>;

type ResolvedRuntimeScope = Readonly<{
  connectionId: string;
  runId: string;
  fleet: ActiveFleetScope | null;
}>;

async function rescueRequestEnvelope(request: Request): Promise<unknown> {
  const declaredLength = Number(request.headers.get("content-length") || "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_EXECUTOR_SCOPE_REQUEST_BYTES) return null;
  try {
    const body = await request.clone().text();
    if (new TextEncoder().encode(body).byteLength > MAX_EXECUTOR_SCOPE_REQUEST_BYTES) return null;
    return (JSON.parse(body) as { envelope?: unknown }).envelope;
  } catch {
    return null;
  }
}

interface ActiveWriterFenceScopeRow extends Record<string, unknown> {
  connection_id: string;
  run_id: string;
  writer_fence_grant_sha256: string;
  credential_set_sha256: string | null;
}

async function loadActiveWriterFenceEvidence(
  database: DatabaseAdapter,
  connectionId: string,
  runId: string,
): Promise<WriterFenceActiveScopeEvidence | null> {
  const result = await database.query<ActiveWriterFenceScopeRow>(sql`
    SELECT
      scope.connection_id::text AS connection_id,
      scope.run_id,
      scope.writer_fence_grant_sha256,
      scope.credential_set_sha256
    FROM public.runtime_canary_connections scope
    WHERE scope.connection_id = ${connectionId}::uuid
      AND scope.run_id = ${runId}
      AND scope.active = true
      AND scope.status = 'ACTIVE'
      AND scope.approved_at <= now()
      AND scope.expires_at > now()
      AND scope.writer_fence_grant_sha256 IS NOT NULL
    LIMIT 2
  `);
  if (result.rowCount !== 1 || result.rows.length !== 1) return null;
  const row = result.rows[0];
  return {
    connectionId: String(row.connection_id),
    runId: String(row.run_id),
    writerFenceGrantSha256: String(row.writer_fence_grant_sha256),
    ...(row.credential_set_sha256 == null
      ? {}
      : { credentialSetSha256: String(row.credential_set_sha256) }),
  };
}

async function resolveRuntimeScope(
  env: MiddlewareRuntimeExecutorEnv,
  database: DatabaseAdapter,
  envelope: RuntimeEnvelopeV1,
): Promise<ResolvedRuntimeScope | null> {
  const environment = String(env.ENVIRONMENT ?? "").trim().toLowerCase();
  if (environment !== RESCUE_PRODUCTION_ENVIRONMENT) {
    const connectionId = String(env.RUNTIME_CANARY_CONNECTION_ID ?? "").trim();
    const runId = canaryIdentifier(env.CANARY_RUN_ID);
    return connectionId === envelope.connectionId && runId
      ? Object.freeze({ connectionId, runId, fleet: null })
      : null;
  }
  if (rescueCanaryMode(env)) {
    const scope = rescueExecutorScope(env);
    return scope && await isEnvelopeInsideExclusiveCanaryScope(envelope, scope)
      ? Object.freeze({ connectionId: scope.connectionId, runId: scope.runId, fleet: null })
      : null;
  }
  if (!fleetMode(env)) return null;
  const scope = await loadActiveFleetScope(database, envelope.connectionId);
  return scope && isEnvelopeInsideActiveFleetScope(envelope, scope)
    ? Object.freeze({ connectionId: scope.connectionId, runId: scope.runId, fleet: scope })
    : null;
}

async function writerFenceExecutionScope(
  env: MiddlewareRuntimeExecutorEnv,
  scope: ResolvedRuntimeScope,
): Promise<WriterFenceExecutionScope> {
  if (scope.fleet) {
    if (typeof env.RUNTIME_FLEET_WRITER_FENCE_BUNDLE?.get !== "function") {
      throw new Error("RUNTIME_FLEET_FENCE_BUNDLE_MISSING");
    }
    const material = await resolveFleetWriterFenceMaterial(
      env.RUNTIME_FLEET_WRITER_FENCE_BUNDLE,
      scope.fleet,
    );
    return Object.freeze({
      connectionId: scope.connectionId,
      runId: scope.runId,
      holderId: material.holderId,
      credentialSetSha256: scope.fleet.credentialSetSha256,
      env: {
        ...env,
        CANARY_WRITER_FENCE_GRANT: { get: async () => material.rawGrant },
        CANARY_WRITER_FENCE_PROOF: { get: async () => material.proof },
      },
    });
  }
  const holderId = canaryIdentifier(env.WRITER_FENCE_HOLDER_ID);
  if (!holderId) throw new Error("WRITER_FENCE_EXECUTOR_SCOPE_MISSING");
  return Object.freeze({
    connectionId: scope.connectionId,
    runId: scope.runId,
    holderId,
    env,
  });
}

async function activeWriterFenceGrant(input: {
  env: MiddlewareRuntimeExecutorEnv;
  database: DatabaseAdapter;
  connectionId: string;
  runId: string;
  holderId: string;
  nowMs: number;
  expectedCredentialSetSha256?: string;
}) {
  if (
    typeof input.env.CANARY_WRITER_FENCE_PROOF?.get !== "function"
    || typeof input.env.CANARY_WRITER_FENCE_GRANT?.get !== "function"
  ) {
    throw new Error("WRITER_FENCE_ACTIVE_EVIDENCE_BINDING_MISSING");
  }
  const evidence = await loadActiveWriterFenceEvidence(
    input.database,
    input.connectionId,
    input.runId,
  );
  if (!evidence) throw new Error("WRITER_FENCE_ACTIVE_SCOPE_NOT_FOUND");
  if (
    input.expectedCredentialSetSha256 !== undefined
    && evidence.credentialSetSha256 !== input.expectedCredentialSetSha256
  ) {
    throw new Error("WRITER_FENCE_ACTIVE_CREDENTIAL_SET_MISMATCH");
  }
  const rawGrant = await input.env.CANARY_WRITER_FENCE_GRANT.get();
  const proof = await input.env.CANARY_WRITER_FENCE_PROOF.get();
  return validateActiveWriterFenceGrant({
    rawGrant,
    proof,
    evidence,
    connectionId: input.connectionId,
    runId: input.runId,
    holderId: input.holderId,
    nowMs: input.nowMs,
  });
}

function scopedFleetAttestation(
  attestation: ReturnType<typeof runtimeCredentialAttestation>,
  connectionId: string,
  runId: string,
  expectedCredentialKind: WriterFenceCredentialKind,
): WriterFenceCredentialAttestation {
  if (
    attestation.connectionId !== connectionId
    || attestation.provider !== "agora"
    || attestation.kind !== expectedCredentialKind
  ) {
    throw new Error("WRITER_FENCE_CREDENTIAL_SCOPE_MISMATCH");
  }
  return Object.freeze({ ...attestation, runId });
}

async function assertCredentialSelectedByGrant(input: {
  grant: WriterFenceGrant;
  attestation: WriterFenceCredentialAttestation;
  expectedCredentialKind: WriterFenceCredentialKind;
  credentialSetSha256?: string;
}): Promise<void> {
  if (input.grant.version === 3) {
    if (
      input.credentialSetSha256 === undefined
      || input.grant.credentialBundle.generationSha256 !== input.credentialSetSha256
    ) {
      throw new Error("WRITER_FENCE_ACTIVE_CREDENTIAL_SET_MISMATCH");
    }
    const selected = input.grant.credentialBundle.credentials[input.expectedCredentialKind];
    if (
      selected.kind !== input.expectedCredentialKind
      || selected.reference !== input.attestation.reference
      || selected.version !== input.attestation.version
      || selected.attestationSha256 !== input.attestation.version
      || selected.binding !== await writerFenceFleetCredentialBinding({
        credential: input.attestation,
        connectionId: input.grant.connectionId,
        runId: input.grant.runId,
      })
    ) {
      throw new Error("WRITER_FENCE_ACTIVE_CREDENTIAL_MISMATCH");
    }
    return;
  }
  if (input.credentialSetSha256 !== undefined) {
    throw new Error("WRITER_FENCE_FLEET_GRANT_V3_REQUIRED");
  }
  if (
    input.grant.exclusiveCredentialRef !== input.attestation.reference
    || input.grant.credentialVersion !== input.attestation.version
    || input.grant.credentialBinding !== await writerFenceCredentialBinding(input.attestation)
  ) {
    throw new Error("WRITER_FENCE_ACTIVE_CREDENTIAL_MISMATCH");
  }
}

export async function assertExclusiveWriterFence(
  env: MiddlewareRuntimeExecutorEnv,
  database: DatabaseAdapter,
  connectionId: string,
  credential: SecretTextPort,
  now: () => number,
  expectedCredentialKind: "agora" | "winerim" = "winerim",
  requireFence = false,
  executionScope?: WriterFenceExecutionScope,
): Promise<WriterFenceMutationAuthorization | null> {
  if (
    !requireFence
    && String(env.ENVIRONMENT ?? "").trim().toLowerCase() !== RESCUE_PRODUCTION_ENVIRONMENT
  ) return null;
  const runId = executionScope?.runId ?? canaryIdentifier(env.CANARY_RUN_ID);
  const holderId = executionScope?.holderId ?? canaryIdentifier(env.WRITER_FENCE_HOLDER_ID);
  const fenceEnv = executionScope?.env ?? env;
  if (!runId || !holderId || (executionScope && executionScope.connectionId !== connectionId)) {
    throw new Error("WRITER_FENCE_EXECUTOR_SCOPE_MISSING");
  }
  const rescueProduction = String(env.ENVIRONMENT ?? "").trim().toLowerCase()
    === RESCUE_PRODUCTION_ENVIRONMENT;
  const grant = rescueProduction
    ? await activeWriterFenceGrant({
      env: fenceEnv,
      database,
      connectionId,
      runId,
      holderId,
      nowMs: now(),
      ...(executionScope?.credentialSetSha256 === undefined
        ? {}
        : { expectedCredentialSetSha256: executionScope.credentialSetSha256 }),
    })
    : null;
  const attestation = scopedFleetAttestation(
    runtimeCredentialAttestation(credential),
    connectionId,
    runId,
    expectedCredentialKind,
  );
  if (grant) {
    await assertCredentialSelectedByGrant({
      grant,
      attestation,
      expectedCredentialKind,
      ...(executionScope?.credentialSetSha256 === undefined
        ? {}
        : { credentialSetSha256: executionScope.credentialSetSha256 }),
    });
  }
  const lease = await acquireExclusiveWriterFence({
    env: fenceEnv,
    connectionId,
    runId,
    holderId,
    ...(grant?.version === 3 ? { credential: attestation } : {}),
  });
  const authorization = await authorizeWriterFenceMutation({
    lease,
    credential: attestation,
    nowMs: now(),
  });
  console.info(JSON.stringify({ event: "writer_fence.mutation_authorized", ...authorization }));
  return authorization;
}

function executionEnvironmentAllowed(env: MiddlewareRuntimeExecutorEnv): boolean {
  const environment = String(env.ENVIRONMENT ?? "").trim().toLowerCase();
  if (environment === STAGING_ENVIRONMENT) return true;
  return environment === RESCUE_PRODUCTION_ENVIRONMENT
    && [EXCLUSIVE_CANARY_EXECUTOR_MODE, FLEET_EXECUTOR_MODE].includes(runtimeMode(env));
}

export interface RuntimeExecutorWorkerDependencies {
  database?: (env: MiddlewareRuntimeExecutorEnv) => DatabaseAdapter;
  catalogAdapterFactory?: PostgresCatalogAdapterFactory;
  catalogApply?: (input: Readonly<{
    env: MiddlewareRuntimeExecutorEnv;
    connectionId: string;
    baseUrl: string;
    request: HttpRequestPort;
  }>) => AgoraCatalogApplyAndReadbackPort | null;
  request?: typeof fetch;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

type JsonRecord = Record<string, unknown>;

const createPostgresClient: PostgresClientFactory = ({ connectionString, applicationName }) => {
  const client = new Client({ connectionString, application_name: applicationName });
  return {
    connect: async () => {
      await client.connect();
    },
    query: async <Row extends Record<string, unknown>>(query: string | DriverQueryConfig) => {
      const result = await client.query<Row>(query);
      return { rows: result.rows, rowCount: result.rowCount };
    },
    end: () => client.end(),
  };
};

function defaultDatabase(env: MiddlewareRuntimeExecutorEnv): DatabaseAdapter {
  if (!env.MIDDLEWARE_DB) throw new Error("MIDDLEWARE_DB_NOT_CONFIGURED");
  return createHyperdrivePostgresAdapter(env.MIDDLEWARE_DB, {
    createClient: createPostgresClient,
    applicationName: "winerim-middleware-runtime-executor-staging",
  });
}

function object(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function stockIdentity(value: unknown): WinerimStockIdentity {
  const identity = object(value);
  if (!identity) throw new Error("RUNTIME_STOCK_INPUT_INVALID");
  return {
    wineId: String(identity.wineId ?? ""),
    stockId: Number(identity.stockId),
    variant: String(identity.variant ?? "") as WinerimStockIdentity["variant"],
  };
}

export function parseLiveGlassCanaryInput(envelope: RuntimeEnvelopeV1): WinerimStockMutationInput {
  const payload = object(envelope.payload);
  if (!payload) throw new Error("RUNTIME_STOCK_INPUT_INVALID");
  const soldStock = stockIdentity(payload.soldStock);
  const orderId = String(payload.orderId ?? "").trim();
  if (!orderId || orderId.length > 200 || /[\r\n]/.test(orderId)) {
    throw new Error("RUNTIME_STOCK_ORDER_ID_INVALID");
  }
  return {
    mode: String(payload.mode ?? "") as WinerimStockMutationInput["mode"],
    // The remote order identity is preserved across infrastructure cutover.
    // The queue idempotency key still owns the local claim and payload hash.
    orderId,
    soldAt: String(payload.soldAt ?? ""),
    quantity: Number(payload.quantity),
    soldStock,
    ...(payload.stockSource ? { stockSource: stockIdentity(payload.stockSource) } : {}),
    ...(payload.currentSourceStock === undefined
      ? {}
      : { currentSourceStock: Number(payload.currentSourceStock) }),
  };
}

function unavailableCredential(): SecretTextPort {
  return Object.freeze({
    read: async () => {
      throw new Error("RUNTIME_CREDENTIAL_UNAVAILABLE");
    },
  });
}

function allowedWinerimTarget(env: MiddlewareRuntimeExecutorEnv): {
  baseUrl: string;
  allowedHosts: string[];
} {
  const baseUrl = String(env.WINERIM_API_BASE_URL ?? "").trim();
  const allowedHosts = String(env.WINERIM_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("WINERIM_TARGET_NOT_CONFIGURED");
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || (parsed.pathname !== "/" && parsed.pathname !== "")
    || !allowedHosts.includes(parsed.hostname.toLowerCase())
  ) {
    throw new Error("WINERIM_TARGET_NOT_ALLOWLISTED");
  }
  return { baseUrl, allowedHosts };
}

function createStockPorts(
  context: RuntimeConnectionExecutorContext,
  env: MiddlewareRuntimeExecutorEnv,
  database: DatabaseAdapter,
  dependencies: Required<Pick<RuntimeExecutorWorkerDependencies, "request" | "now" | "sleep">>,
  executionScope?: WriterFenceExecutionScope,
): ProviderNeutralRuntimeExecutorPorts {
  const target = allowedWinerimTarget(env);
  const credential = context.credentials.winerim ?? unavailableCredential();
  const transport = createWinerimMutationTransport({
    ...target,
    credential,
    request: { request: (url, init) => dependencies.request(url, init) },
    timer: {
      now: dependencies.now,
      schedule: (callback, milliseconds) => setTimeout(callback, milliseconds),
      cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
    sleep: dependencies.sleep,
  });
  return {
    stock: {
      prepare: async (envelope) => ({
        input: parseLiveGlassCanaryInput(envelope),
        dryRun: object(envelope.payload)?.dryRun === true,
      }),
      transport: {
        async send(request) {
          await assertExclusiveWriterFence(
            env,
            database,
            context.envelope.connectionId,
            credential,
            dependencies.now,
            "winerim",
            false,
            executionScope,
          );
          return transport.send(request);
        },
        sleep: transport.sleep,
      },
    },
  };
}

function json(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function failure(httpStatus: number, message: string, retryableLine = false): RuntimeExecutionResult {
  return {
    ok: false,
    failure: {
      httpStatus,
      message,
      ...(retryableLine ? { retryableLine: true } : {}),
    },
  };
}

function envelopeDryRun(envelope: RuntimeEnvelopeV1): boolean {
  return object(envelope.payload)?.dryRun === true;
}

function maxClosedDays(env: MiddlewareRuntimeExecutorEnv): number | undefined {
  const value = String(env.RUNTIME_SALES_MAX_CLOSED_DAYS_PER_RUN ?? "").trim();
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : Number.NaN;
}

function switchEnabled(value: unknown): boolean {
  return String(value ?? "").trim().toLowerCase() === "true";
}

const SHARED_READ_ONLY_AGORA_CREDENTIAL_MODE = "shared-read-only";
const EXCLUSIVE_WRITER_AGORA_CREDENTIAL_MODE = "exclusive-writer";

type RescueCanaryPolicy = Readonly<{
  job: ExclusiveCanaryJob;
  exclusiveCredentialKind: "agora" | "winerim";
  agoraCredentialMode: typeof SHARED_READ_ONLY_AGORA_CREDENTIAL_MODE
    | typeof EXCLUSIVE_WRITER_AGORA_CREDENTIAL_MODE;
  catalogApply: boolean;
  winerimMutation: boolean;
}>;

function agoraCredentialMode(env: MiddlewareRuntimeExecutorEnv): string {
  return String(env.RUNTIME_AGORA_CREDENTIAL_MODE ?? "").trim().toLowerCase();
}

function configuredCatalogProductId(env: MiddlewareRuntimeExecutorEnv): string | null {
  const value = String(env.CANARY_CATALOG_PRODUCT_ID ?? "").trim();
  return /^\d+$/.test(value) ? value : null;
}

function rescueCanaryPolicy(env: MiddlewareRuntimeExecutorEnv): RescueCanaryPolicy | null {
  const scope = resolveExclusiveCanaryJobLane(env.CANARY_RUNTIME_JOB, env.CANARY_RUNTIME_LANE);
  if (!scope) return null;
  const outboundClosed = !switchEnabled(env.RUNTIME_OUTBOUND_EXECUTION_ENABLED)
    && !switchEnabled(env.RUNTIME_OUTBOUND_MUTATION_ENABLED);
  if (!outboundClosed || switchEnabled(env.RUNTIME_CATALOG_FETCH_ENABLED)) return null;

  if (scope.job === "winerim.sales-import-live") {
    if (
      agoraCredentialMode(env) !== SHARED_READ_ONLY_AGORA_CREDENTIAL_MODE
      || switchEnabled(env.RUNTIME_CATALOG_EXECUTION_ENABLED)
      || switchEnabled(env.RUNTIME_CATALOG_APPLY_ENABLED)
      || String(env.CANARY_CATALOG_PRODUCT_ID ?? "").trim()
    ) return null;
    return {
      job: scope.job,
      exclusiveCredentialKind: "winerim",
      agoraCredentialMode: SHARED_READ_ONLY_AGORA_CREDENTIAL_MODE,
      catalogApply: false,
      winerimMutation: true,
    };
  }

  if (
    agoraCredentialMode(env) !== EXCLUSIVE_WRITER_AGORA_CREDENTIAL_MODE
    || !switchEnabled(env.RUNTIME_CATALOG_EXECUTION_ENABLED)
    || !switchEnabled(env.RUNTIME_CATALOG_APPLY_ENABLED)
    || !configuredCatalogProductId(env)
  ) return null;
  return {
    job: scope.job,
    exclusiveCredentialKind: "agora",
    agoraCredentialMode: EXCLUSIVE_WRITER_AGORA_CREDENTIAL_MODE,
    catalogApply: true,
    winerimMutation: false,
  };
}

async function validateWriterFenceReadiness(
  env: MiddlewareRuntimeExecutorEnv,
  database: DatabaseAdapter,
  connectionId: string,
  credential: SecretTextPort,
  nowMs: number,
  expectedCredentialKind: "agora" | "winerim",
): Promise<boolean> {
  const runId = canaryIdentifier(env.CANARY_RUN_ID);
  const holderId = canaryIdentifier(env.WRITER_FENCE_HOLDER_ID);
  const expectedVersion = String(env.CANARY_EXCLUSIVE_CREDENTIAL_VERSION ?? "").trim().toLowerCase();
  if (
    !runId
    || !holderId
    || !/^[a-f0-9]{64}$/.test(expectedVersion)
    || typeof env.CANARY_WRITER_FENCE_PROOF?.get !== "function"
    || typeof env.CANARY_WRITER_FENCE_GRANT?.get !== "function"
  ) return false;
  const attestation = runtimeCredentialAttestation(credential);
  if (
    attestation.connectionId !== connectionId
    || attestation.provider !== "agora"
    || attestation.kind !== expectedCredentialKind
    || attestation.version !== expectedVersion
  ) return false;
  const grant = await activeWriterFenceGrant({
    env,
    database,
    connectionId,
    runId,
    holderId,
    nowMs,
  });
  return grant.exclusiveCredentialRef === attestation.reference
    && grant.credentialVersion === attestation.version
    && grant.credentialBinding === await writerFenceCredentialBinding(attestation);
}

function catalogSwitches(env: MiddlewareRuntimeExecutorEnv): PrivateCatalogSwitches {
  return {
    executionEnabled: switchEnabled(env.RUNTIME_CATALOG_EXECUTION_ENABLED),
    // The Winerim refresh port is not connected in this Worker yet.
    fetchEnabled: false,
    applyEnabled: switchEnabled(env.RUNTIME_CATALOG_APPLY_ENABLED),
  };
}

function catalogProfile(value: unknown): AgoraCatalogXmlProfile | null {
  if (typeof value !== "string" || !value.trim()) return null;
  let parsed: JsonRecord;
  try {
    const candidate = JSON.parse(value);
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
    parsed = candidate as JsonRecord;
  } catch {
    return null;
  }
  const colorByFormat = object(parsed.colorByFormat);
  const orderByProductId = object(parsed.orderByProductId);
  const priceListIds = Array.isArray(parsed.priceListIds)
    ? parsed.priceListIds.map(String).map((item) => item.trim()).filter(Boolean)
    : [];
  const warehouseIds = Array.isArray(parsed.warehouseIds)
    ? parsed.warehouseIds.map(String).map((item) => item.trim()).filter(Boolean)
    : [];
  if (
    !colorByFormat
    || !orderByProductId
    || priceListIds.length === 0
    || warehouseIds.length === 0
    || !String(parsed.vatId ?? "").trim()
    || !String(colorByFormat.BOTTLE ?? "").trim()
    || !String(colorByFormat.GLASS ?? "").trim()
    || !String(colorByFormat.MAGNUM ?? "").trim()
  ) return null;
  const preparationTypeId = String(parsed.preparationTypeId ?? "").trim();
  const preparationOrderId = String(parsed.preparationOrderId ?? "").trim();
  if (Boolean(preparationTypeId) !== Boolean(preparationOrderId)) return null;
  return {
    vatId: String(parsed.vatId).trim(),
    priceListIds,
    warehouseIds,
    colorByFormat: {
      BOTTLE: String(colorByFormat.BOTTLE).trim(),
      GLASS: String(colorByFormat.GLASS).trim(),
      MAGNUM: String(colorByFormat.MAGNUM).trim(),
    },
    preparationTypeId,
    preparationOrderId,
    orderByProductId: Object.fromEntries(Object.entries(orderByProductId).map(([key, item]) => [
      key.trim(),
      typeof item === "number" ? item : String(item ?? "").trim(),
    ])),
  };
}

function fleetCatalogProfiles(value: unknown): Readonly<Record<string, AgoraCatalogXmlProfile>> | null {
  if (typeof value !== "string" || !value.trim()) return null;
  let candidate: unknown;
  try {
    candidate = JSON.parse(value);
  } catch {
    return null;
  }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const profiles: Record<string, AgoraCatalogXmlProfile> = {};
  for (const [connectionId, profileValue] of Object.entries(candidate as Record<string, unknown>)) {
    if (!isDeployableRuntimeCanaryConnectionId(connectionId)) return null;
    const profile = catalogProfile(JSON.stringify(profileValue));
    if (!profile) return null;
    profiles[connectionId] = profile;
  }
  return Object.keys(profiles).length > 0 ? Object.freeze(profiles) : null;
}

function catalogProfileForConnection(
  env: MiddlewareRuntimeExecutorEnv,
  connectionId: string,
): AgoraCatalogXmlProfile | null {
  if (!fleetMode(env)) return catalogProfile(env.RUNTIME_AGORA_CATALOG_PROFILE_JSON);
  return fleetCatalogProfiles(env.RUNTIME_FLEET_CATALOG_PROFILES_JSON)?.[connectionId] ?? null;
}

function catalogTransportConfigurationReady(
  env: MiddlewareRuntimeExecutorEnv,
  connectionBaseUrl?: string,
  connectionId?: string,
): boolean {
  const expectedBaseUrl = String(connectionBaseUrl ?? "").trim();
  const baseUrl = fleetMode(env)
    ? expectedBaseUrl
    : String(env.RUNTIME_AGORA_CATALOG_BASE_URL ?? "").trim();
  const allowedHosts = String(env.RUNTIME_AGORA_CATALOG_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  try {
    const parsed = new URL(baseUrl);
    const expected = new URL(expectedBaseUrl);
    return ["http:", "https:"].includes(parsed.protocol)
      && parsed.toString() === expected.toString()
      && !parsed.username
      && !parsed.password
      && !parsed.search
      && !parsed.hash
      && (parsed.pathname === "/" || parsed.pathname === "")
      && allowedHosts.includes(parsed.host.toLowerCase())
      && catalogProfileForConnection(env, String(connectionId ?? "").trim()) !== null;
  } catch {
    return false;
  }
}

function defaultCatalogApply(input: Readonly<{
  env: MiddlewareRuntimeExecutorEnv;
  connectionId: string;
  baseUrl: string;
  request: HttpRequestPort;
}>): AgoraCatalogApplyAndReadbackPort | null {
  const profile = catalogProfileForConnection(input.env, input.connectionId);
  if (!profile || !catalogTransportConfigurationReady(input.env, input.baseUrl, input.connectionId)) return null;
  return createAgoraCatalogPlanApplyAndReadbackPort({
    enabled: input.env.RUNTIME_CATALOG_APPLY_ENABLED,
    connectionId: input.connectionId,
    baseUrl: input.baseUrl,
    allowedHosts: String(input.env.RUNTIME_AGORA_CATALOG_ALLOWED_HOSTS)
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
    request: input.request,
    profile,
  });
}

function enabledJobs(env: MiddlewareRuntimeExecutorEnv): readonly RuntimeJob[] {
  if (!executionGateOpen(env)) return [];
  if (
    String(env.ENVIRONMENT ?? "").trim().toLowerCase() === RESCUE_PRODUCTION_ENVIRONMENT
    && rescueCanaryMode(env)
  ) {
    const scope = rescueExecutorScope(env);
    return scope ? [scope.job] : [];
  }
  if (fleetMode(env)) return FLEET_SALES_RUNTIME_JOB_ALLOWLIST;
  const flags = salesLaneFlags(env);
  return [
    ...ENABLED_STOCK_JOBS,
    ...privateCatalogEnabledJobs(catalogSwitches(env)),
    ...(flags.executionEnabled && flags.dlqReady ? ["sales.sync-open-tickets" as const] : []),
    ...(flags.executionEnabled && flags.cursorEnabled && flags.dlqReady ? CURSORED_SALES_JOBS : []),
  ];
}

function fleetSalesOnlySwitchesOpen(env: MiddlewareRuntimeExecutorEnv): boolean {
  const sales = salesLaneFlags(env);
  return sales.executionEnabled
    && sales.cursorEnabled
    && sales.dlqReady
    && !switchEnabled(env.RUNTIME_CATALOG_EXECUTION_ENABLED)
    && !switchEnabled(env.RUNTIME_CATALOG_FETCH_ENABLED)
    && !switchEnabled(env.RUNTIME_CATALOG_APPLY_ENABLED)
    && !switchEnabled(env.RUNTIME_OUTBOUND_EXECUTION_ENABLED)
    && !switchEnabled(env.RUNTIME_OUTBOUND_MUTATION_ENABLED);
}

type NormalizedWorkerDependencies = Readonly<{
  database: (env: MiddlewareRuntimeExecutorEnv) => DatabaseAdapter;
  catalogAdapterFactory?: PostgresCatalogAdapterFactory;
  catalogApply: NonNullable<RuntimeExecutorWorkerDependencies["catalogApply"]>;
  request: typeof fetch;
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
}>;

function normalizedDependencies(
  dependencies: RuntimeExecutorWorkerDependencies,
): NormalizedWorkerDependencies {
  return {
    database: dependencies.database ?? defaultDatabase,
    ...(dependencies.catalogAdapterFactory
      ? { catalogAdapterFactory: dependencies.catalogAdapterFactory }
      : {}),
    catalogApply: dependencies.catalogApply ?? defaultCatalogApply,
    request: dependencies.request ?? fetch,
    now: dependencies.now ?? Date.now,
    sleep: dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
  };
}

function fleetReadiness(env: MiddlewareRuntimeExecutorEnv): Response {
  const catalogApplyRequested = switchEnabled(env.RUNTIME_CATALOG_APPLY_ENABLED);
  const missingBindings = [
    !env.MIDDLEWARE_DB ? "MIDDLEWARE_DB" : null,
    typeof env.RUNTIME_VAULT_KEY?.get !== "function" ? "RUNTIME_VAULT_KEY" : null,
    !String(env.RUNTIME_VAULT_KEY_VERSION ?? "").trim() ? "RUNTIME_VAULT_KEY_VERSION" : null,
    !String(env.WINERIM_API_BASE_URL ?? "").trim() ? "WINERIM_API_BASE_URL" : null,
    !String(env.WINERIM_ALLOWED_HOSTS ?? "").trim() ? "WINERIM_ALLOWED_HOSTS" : null,
    !env.WRITER_FENCE || typeof env.WRITER_FENCE.fetch !== "function" ? "WRITER_FENCE" : null,
    typeof env.RUNTIME_FLEET_WRITER_FENCE_BUNDLE?.get !== "function"
      ? "RUNTIME_FLEET_WRITER_FENCE_BUNDLE"
      : null,
    catalogApplyRequested && !String(env.RUNTIME_AGORA_CATALOG_ALLOWED_HOSTS ?? "").trim()
      ? "RUNTIME_AGORA_CATALOG_ALLOWED_HOSTS"
      : null,
    catalogApplyRequested && fleetCatalogProfiles(env.RUNTIME_FLEET_CATALOG_PROFILES_JSON) === null
      ? "RUNTIME_FLEET_CATALOG_PROFILES_JSON"
      : null,
  ].filter((value): value is string => !!value);
  try {
    allowedWinerimTarget(env);
  } catch {
    if (!missingBindings.includes("WINERIM_API_TARGET")) missingBindings.push("WINERIM_API_TARGET");
  }
  const executionEnabled = switchEnabled(env.RUNTIME_EXECUTION_ENABLED);
  const fleetPolicyOpen = fleetSalesOnlySwitchesOpen(env);
  if (!fleetPolicyOpen) missingBindings.push("RUNTIME_FLEET_SALES_ONLY_POLICY");
  const ready = executionEnvironmentAllowed(env)
    && executionEnabled
    && fleetPolicyOpen
    && missingBindings.length === 0;
  return json({
    ok: ready,
    service: "winerim-middleware-runtime-executor",
    connectionId: null,
    environment: env.ENVIRONMENT ?? null,
    release: env.RELEASE ?? null,
    stagingOnly: false,
    executionScope: "fleet-per-message",
    scopeBinding: "connectionId+runId+credentialSetSha256",
    writerFenceReady: ready,
    exactCanaryScopeReady: false,
    fleetScopeReady: ready,
    executionEnabled,
    enabledJobs: enabledJobs(env),
    missingBindings,
    credentials: "validated-per-message",
    reason: ready ? null : "RUNTIME_EXECUTOR_NOT_READY",
  }, ready ? 200 : 503);
}

async function readiness(
  env: MiddlewareRuntimeExecutorEnv,
  dependencies: NormalizedWorkerDependencies,
): Promise<Response> {
  const environment = String(env.ENVIRONMENT ?? "").trim().toLowerCase();
  if (environment === RESCUE_PRODUCTION_ENVIRONMENT && fleetMode(env)) {
    return fleetReadiness(env);
  }
  const executionEnabled = String(env.RUNTIME_EXECUTION_ENABLED ?? "").trim().toLowerCase() === "true";
  const salesFlags = salesLaneFlags(env);
  const catalogFlags = catalogSwitches(env);
  const catalogApplyRequested = switchEnabled(catalogFlags.applyEnabled);
  const catalogFetchRequested = switchEnabled(env.RUNTIME_CATALOG_FETCH_ENABLED);
  let catalogTransportReady = !catalogApplyRequested;
  const outboundExecutionRequested = switchEnabled(env.RUNTIME_OUTBOUND_EXECUTION_ENABLED);
  const outboundMutationRequested = switchEnabled(env.RUNTIME_OUTBOUND_MUTATION_ENABLED);
  const writerFenceRequired = environment === RESCUE_PRODUCTION_ENVIRONMENT || catalogApplyRequested;
  const policy = environment === RESCUE_PRODUCTION_ENVIRONMENT ? rescueCanaryPolicy(env) : null;
  const canaryPolicyOpen = environment !== RESCUE_PRODUCTION_ENVIRONMENT || policy !== null;
  const winerimTargetRequired = environment !== RESCUE_PRODUCTION_ENVIRONMENT
    || policy?.winerimMutation === true;
  const missingBindings = [
    !env.MIDDLEWARE_DB ? "MIDDLEWARE_DB" : null,
    typeof env.RUNTIME_VAULT_KEY?.get !== "function" ? "RUNTIME_VAULT_KEY" : null,
    !String(env.RUNTIME_VAULT_KEY_VERSION ?? "").trim() ? "RUNTIME_VAULT_KEY_VERSION" : null,
    winerimTargetRequired && !String(env.WINERIM_API_BASE_URL ?? "").trim()
      ? "WINERIM_API_BASE_URL"
      : null,
    winerimTargetRequired && !String(env.WINERIM_ALLOWED_HOSTS ?? "").trim()
      ? "WINERIM_ALLOWED_HOSTS"
      : null,
    !isDeployableRuntimeCanaryConnectionId(env.RUNTIME_CANARY_CONNECTION_ID)
      ? "RUNTIME_CANARY_CONNECTION_ID"
      : null,
    !canaryIdentifier(env.CANARY_RUN_ID) ? "CANARY_RUN_ID" : null,
    writerFenceRequired && !canaryIdentifier(env.WRITER_FENCE_HOLDER_ID)
      ? "WRITER_FENCE_HOLDER_ID"
      : null,
    writerFenceRequired
      && (!env.WRITER_FENCE || typeof env.WRITER_FENCE.fetch !== "function")
      ? "WRITER_FENCE"
      : null,
    writerFenceRequired
      && (!env.CANARY_WRITER_FENCE_PROOF || typeof env.CANARY_WRITER_FENCE_PROOF.get !== "function")
      ? "CANARY_WRITER_FENCE_PROOF"
      : null,
    environment === RESCUE_PRODUCTION_ENVIRONMENT
      && (!env.CANARY_WRITER_FENCE_GRANT || typeof env.CANARY_WRITER_FENCE_GRANT.get !== "function")
      ? "CANARY_WRITER_FENCE_GRANT"
      : null,
    environment === RESCUE_PRODUCTION_ENVIRONMENT
      && !/^[a-f0-9]{64}$/.test(String(env.CANARY_EXCLUSIVE_CREDENTIAL_VERSION ?? "").trim().toLowerCase())
      ? "CANARY_EXCLUSIVE_CREDENTIAL_VERSION"
      : null,
    environment === RESCUE_PRODUCTION_ENVIRONMENT && !policy
      ? "RUNTIME_CANARY_POLICY"
      : null,
    environment === RESCUE_PRODUCTION_ENVIRONMENT
      && !canaryIdentifier(env.CANARY_MESSAGE_ID)
      ? "CANARY_MESSAGE_ID"
      : null,
    environment === RESCUE_PRODUCTION_ENVIRONMENT
      && !canaryIdentifier(env.CANARY_IDEMPOTENCY_KEY)
      ? "CANARY_IDEMPOTENCY_KEY"
      : null,
    environment === RESCUE_PRODUCTION_ENVIRONMENT
      && !/^[a-f0-9]{64}$/.test(String(env.CANARY_PAYLOAD_SHA256 ?? "").trim().toLowerCase())
      ? "CANARY_PAYLOAD_SHA256"
      : null,
  ].filter((value): value is string => !!value);
  let agoraCredentialReady = false;
  let winerimCredentialReady = false;
  let writerFenceReady = environment !== RESCUE_PRODUCTION_ENVIRONMENT;
  let credentialsReady = false;
  if (executionEnvironmentAllowed(env) && executionEnabled && missingBindings.length === 0) {
    try {
      const database = dependencies.database(env);
      const connectionId = String(env.RUNTIME_CANARY_CONNECTION_ID ?? "").trim();
      const connection = await createPostgresRuntimeConnectionPort(database).load(connectionId);
      if (connection?.enabled === true && connection.provider.toLowerCase() === "agora") {
        catalogTransportReady = !catalogApplyRequested
          || catalogTransportConfigurationReady(env, connection.baseUrl);
        const credentials = createPostgresEncryptedCredentialPort(database, {
          masterKey: env.RUNTIME_VAULT_KEY!,
          keyVersion: String(env.RUNTIME_VAULT_KEY_VERSION ?? "").trim(),
          runId: String(env.CANARY_RUN_ID ?? "").trim(),
        });
        const requireAgora = environment !== RESCUE_PRODUCTION_ENVIRONMENT
          || policy?.exclusiveCredentialKind === "agora"
          || policy?.agoraCredentialMode === SHARED_READ_ONLY_AGORA_CREDENTIAL_MODE;
        const requireWinerim = environment !== RESCUE_PRODUCTION_ENVIRONMENT
          || policy?.exclusiveCredentialKind === "winerim";
        const agora = requireAgora
          ? await credentials.open({ connectionId, provider: "agora", kind: "agora" })
          : null;
        const winerim = requireWinerim
          ? await credentials.open({ connectionId, provider: "agora", kind: "winerim" })
          : null;
        agoraCredentialReady = !requireAgora || Boolean(await agora?.read());
        winerimCredentialReady = !requireWinerim || Boolean(await winerim?.read());
        if (environment === RESCUE_PRODUCTION_ENVIRONMENT) {
          if (requireAgora && agoraCredentialReady && agora) {
            const attestation = runtimeCredentialAttestation(agora);
            agoraCredentialReady = attestation.connectionId === connectionId
              && attestation.provider === "agora"
              && attestation.kind === "agora";
          }
          if (requireWinerim && winerimCredentialReady && winerim) {
            const attestation = runtimeCredentialAttestation(winerim);
            winerimCredentialReady = attestation.connectionId === connectionId
              && attestation.provider === "agora"
              && attestation.kind === "winerim";
          }
          const exclusiveCredential = policy?.exclusiveCredentialKind === "agora" ? agora : winerim;
          if (policy && exclusiveCredential) {
            writerFenceReady = await validateWriterFenceReadiness(
              env,
              database,
              connectionId,
              exclusiveCredential,
              dependencies.now(),
              policy.exclusiveCredentialKind,
            );
          }
        }
        credentialsReady = agoraCredentialReady && winerimCredentialReady;
      }
    } catch {
      agoraCredentialReady = false;
      winerimCredentialReady = false;
      writerFenceReady = false;
      credentialsReady = false;
    }
  }
  if (catalogApplyRequested && !catalogTransportReady) {
    missingBindings.push("RUNTIME_AGORA_CATALOG_TRANSPORT");
  }
  const ready = executionEnvironmentAllowed(env)
    && executionEnabled
    && missingBindings.length === 0
      && credentialsReady
      && writerFenceReady
      && catalogTransportReady;
  return json({
    ok: ready,
    service: "winerim-middleware-runtime-executor",
    connectionId: isDeployableRuntimeCanaryConnectionId(env.RUNTIME_CANARY_CONNECTION_ID)
      ? String(env.RUNTIME_CANARY_CONNECTION_ID).trim()
      : null,
    environment: env.ENVIRONMENT ?? null,
    release: env.RELEASE ?? null,
    stagingOnly: environment === STAGING_ENVIRONMENT,
    executionScope: environment === RESCUE_PRODUCTION_ENVIRONMENT ? "exclusive-canary" : "staging",
    agoraCredentialMode: agoraCredentialMode(env),
    agoraReadOnlyPolicyOpen: canaryPolicyOpen,
    canaryPolicyOpen,
    writerFenceReady,
    exactCanaryScopeReady: environment !== RESCUE_PRODUCTION_ENVIRONMENT || rescueExecutorScope(env) !== null,
    executionEnabled,
    enabledJobs: enabledJobs(env),
    sales: {
      executionEnabled: salesFlags.executionEnabled,
      cursorEnabled: salesFlags.cursorEnabled,
      dlqReady: salesFlags.dlqReady,
      ready: executionEnabled
        && salesFlags.executionEnabled
        && salesFlags.cursorEnabled
        && salesFlags.dlqReady
        && credentialsReady,
    },
    catalog: {
      executionEnabled: switchEnabled(catalogFlags.executionEnabled),
      fetchRequested: catalogFetchRequested,
      fetchEnabled: false,
      fetchConnected: false,
      applyEnabled: catalogApplyRequested,
      transportReady: catalogTransportReady,
      dryRunReady: executionEnabled
        && switchEnabled(catalogFlags.executionEnabled)
        && missingBindings.filter((binding) => binding !== "RUNTIME_AGORA_CATALOG_TRANSPORT").length === 0,
      applyReady: executionEnabled
        && switchEnabled(catalogFlags.executionEnabled)
        && catalogApplyRequested
        && catalogTransportReady
        && agoraCredentialReady
        && writerFenceReady,
    },
    outbound: {
      executionRequested: outboundExecutionRequested,
      mutationRequested: outboundMutationRequested,
      connected: false,
      ready: false,
      reason: "OUTBOUND_EXCLUSIVE_QUEUE_NOT_CONFIGURED",
    },
    missingBindings,
    credentials: credentialsReady ? "ready" : "not_ready",
    credentialReadiness: {
      agora: agoraCredentialReady ? "ready" : "not_ready",
      winerim: winerimCredentialReady ? "ready" : "not_ready",
    },
    reason: ready ? null : "RUNTIME_EXECUTOR_NOT_READY",
  }, ready ? 200 : 503);
}

function executionGateOpen(env: MiddlewareRuntimeExecutorEnv): boolean {
  const rescueProduction = String(env.ENVIRONMENT ?? "").trim().toLowerCase()
    === RESCUE_PRODUCTION_ENVIRONMENT;
  const fleet = rescueProduction && fleetMode(env);
  const rescueFenceReady = String(env.ENVIRONMENT ?? "").trim().toLowerCase() !== RESCUE_PRODUCTION_ENVIRONMENT
    || (
      !!env.WRITER_FENCE
      && typeof env.WRITER_FENCE.fetch === "function"
      && (fleet
        ? typeof env.RUNTIME_FLEET_WRITER_FENCE_BUNDLE?.get === "function"
        : (
          canaryIdentifier(env.CANARY_RUN_ID) !== null
          && canaryIdentifier(env.WRITER_FENCE_HOLDER_ID) !== null
          && typeof env.CANARY_WRITER_FENCE_PROOF?.get === "function"
          && typeof env.CANARY_WRITER_FENCE_GRANT?.get === "function"
          && /^[a-f0-9]{64}$/.test(
            String(env.CANARY_EXCLUSIVE_CREDENTIAL_VERSION ?? "").trim().toLowerCase(),
          )
        ))
    );
  return executionEnvironmentAllowed(env)
    && rescueFenceReady
    && (!fleet || fleetSalesOnlySwitchesOpen(env))
    && (!rescueProduction || fleet || rescueExecutorScope(env) !== null)
    && (!rescueProduction || fleet || rescueCanaryPolicy(env) !== null)
    && String(env.RUNTIME_EXECUTION_ENABLED ?? "").trim().toLowerCase() === "true"
    && (fleet || isDeployableRuntimeCanaryConnectionId(env.RUNTIME_CANARY_CONNECTION_ID))
    && typeof env.RUNTIME_VAULT_KEY?.get === "function";
}

export function createMiddlewareRuntimeExecutorWorker(
  dependencies: RuntimeExecutorWorkerDependencies = {},
) {
  const resolved = normalizedDependencies(dependencies);
  return {
    async fetch(request: Request, env: MiddlewareRuntimeExecutorEnv): Promise<Response> {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/ready") return readiness(env, resolved);
      if (!executionGateOpen(env)) {
        return createRuntimeExecutorService({
          execute: async () => ({
            ok: false,
            failure: { httpStatus: 503, message: "RUNTIME_EXECUTION_DISABLED" },
          }),
        }).fetch(request);
      }

      if (
        String(env.ENVIRONMENT ?? "").trim().toLowerCase() === RESCUE_PRODUCTION_ENVIRONMENT
        && rescueCanaryMode(env)
      ) {
        const scope = rescueExecutorScope(env);
        const envelope = await rescueRequestEnvelope(request);
        if (!scope || !isRuntimeEnvelope(envelope)
          || !await isEnvelopeInsideExclusiveCanaryScope(envelope, scope)) {
          return createRuntimeExecutorService({
            execute: async () => failure(422, "RUNTIME_CANARY_SCOPE_REJECTED"),
          }).fetch(request);
        }
      }

      let database: DatabaseAdapter;
      try {
        database = resolved.database(env);
      } catch {
        return json({ ok: false, failure: { httpStatus: 503, message: "RUNTIME_DATABASE_UNAVAILABLE" } }, 503);
      }
      if (typeof env.RUNTIME_VAULT_KEY?.get !== "function") {
        return json({ ok: false, failure: { httpStatus: 503, message: "RUNTIME_VAULT_UNAVAILABLE" } }, 503);
      }
      return createRuntimeExecutorService({
        async execute(envelope): Promise<RuntimeExecutionResult> {
          let runtimeScope: ResolvedRuntimeScope | null;
          try {
            runtimeScope = await resolveRuntimeScope(env, database, envelope);
          } catch {
            return failure(503, "RUNTIME_SCOPE_LOOKUP_UNAVAILABLE", true);
          }
          if (!runtimeScope) {
            const configuredConnectionId = String(env.RUNTIME_CANARY_CONNECTION_ID ?? "").trim();
            return failure(422, fleetMode(env)
              ? "RUNTIME_FLEET_SCOPE_REJECTED"
              : configuredConnectionId !== envelope.connectionId
                ? "RUNTIME_CANARY_CONNECTION_REJECTED"
                : "RUNTIME_CANARY_SCOPE_REJECTED");
          }

          const scopedConnections = createPostgresRuntimeConnectionPort(database);
          const scopedCredentials = createPostgresEncryptedCredentialPort(database, {
            masterKey: env.RUNTIME_VAULT_KEY!,
            keyVersion: String(env.RUNTIME_VAULT_KEY_VERSION ?? "").trim(),
            runId: runtimeScope.runId,
          });
          let fenceScope: WriterFenceExecutionScope | undefined;
          if (
            String(env.ENVIRONMENT ?? "").trim().toLowerCase() === RESCUE_PRODUCTION_ENVIRONMENT
            && !envelopeDryRun(envelope)
          ) {
            try {
              fenceScope = await writerFenceExecutionScope(env, runtimeScope);
              await activeWriterFenceGrant({
                env: fenceScope.env,
                database,
                connectionId: envelope.connectionId,
                runId: fenceScope.runId,
                holderId: fenceScope.holderId,
                nowMs: resolved.now(),
                ...(fenceScope.credentialSetSha256 === undefined
                  ? {}
                  : { expectedCredentialSetSha256: fenceScope.credentialSetSha256 }),
              });
            } catch {
              return failure(403, "WRITER_FENCE_ACTIVE_SCOPE_EVIDENCE_REJECTED");
            }
          }

          const options: RuntimeExecutorCompositionOptions = {
            environment: env.ENVIRONMENT,
            executionScope: String(env.ENVIRONMENT ?? "").trim().toLowerCase()
              === RESCUE_PRODUCTION_ENVIRONMENT
              ? "exclusive-canary"
              : "staging",
            executionEnabled: env.RUNTIME_EXECUTION_ENABLED,
            allowedConnectionId: runtimeScope.connectionId,
            enabledJobs: runtimeScope.fleet?.runtimeSalesJobAllowlist ?? enabledJobs(env),
            connections: scopedConnections,
            credentials: scopedCredentials,
            ports: {
              create: (context) => createStockPorts(
                context,
                env,
                database,
                resolved,
                fenceScope,
              ),
            },
          };
          const stockExecutor = createConnectionScopedRuntimeExecutor(options);
          const guardedCatalogApply: AgoraCatalogApplyAndReadbackPort = {
            async applyAndReadback(input) {
              const expectedProductId = rescueCanaryMode(env)
                ? configuredCatalogProductId(env)
                : input.plan.operations[0]?.desired.productId ?? null;
              if (
                input.connectionId !== runtimeScope.connectionId
                || input.plan.operations.length !== 1
                || !expectedProductId
                || input.plan.operations[0]?.desired.productId !== expectedProductId
              ) {
                return { ok: false, code: "APPLY_REJECTED" };
              }
              const connection = await scopedConnections.load(input.connectionId);
              if (!connection || connection.connectionId !== input.connectionId) {
                return { ok: false, code: "APPLY_REJECTED" };
              }
              if (
                String(env.ENVIRONMENT ?? "").trim().toLowerCase() === RESCUE_PRODUCTION_ENVIRONMENT
                && !catalogTransportConfigurationReady(env, connection.baseUrl, input.connectionId)
              ) {
                return { ok: false, code: "APPLY_REJECTED" };
              }
              const rawCatalogApply = resolved.catalogApply({
                env,
                connectionId: input.connectionId,
                baseUrl: connection.baseUrl,
                request: { request: (target, init) => resolved.request(target, init) },
              });
              if (!rawCatalogApply) return { ok: false, code: "APPLY_REJECTED" };
              await assertExclusiveWriterFence(
                env,
                database,
                input.connectionId,
                input.credential,
                resolved.now,
                "agora",
                true,
                fenceScope,
              );
              return rawCatalogApply.applyAndReadback(input);
            },
          };
          const catalogExecutor = createPrivateCatalogLaneExecutor({
            allowedConnectionId: runtimeScope.connectionId,
            switches: catalogSwitches(env),
            database,
            connections: scopedConnections,
            credentials: scopedCredentials,
            ...(resolved.catalogAdapterFactory
              ? { adapterFactory: resolved.catalogAdapterFactory }
              : {}),
            agoraApply: guardedCatalogApply,
          });

          if (CATALOG_JOBS.has(envelope.job)) return catalogExecutor.execute(envelope);
          if (envelope.job === "outbound.process") {
            return failure(503, "OUTBOUND_EXCLUSIVE_QUEUE_NOT_CONFIGURED");
          }
          if (!isSalesLaneJob(envelope.job)) return stockExecutor.execute(envelope);
          const flags = salesLaneFlags(env);
          const salesGate = salesLaneGateFailure(flags, envelopeDryRun(envelope), envelope.job);
          if (salesGate) return failure(503, salesGate, true);

          try {
            const connection = await scopedConnections.load(envelope.connectionId);
            if (!connection || connection.provider.toLowerCase() !== "agora" || connection.enabled !== true) {
              return failure(422, "RUNTIME_CONNECTION_SCOPE_REJECTED");
            }
            const agora = await scopedCredentials.open({
              connectionId: envelope.connectionId,
              provider: connection.provider,
              kind: "agora",
            });
            const winerim = envelopeDryRun(envelope)
              ? unavailableCredential()
              : await scopedCredentials.open({
                connectionId: envelope.connectionId,
                provider: connection.provider,
                kind: "winerim",
              });
            if (!agora || !winerim) return failure(503, "RUNTIME_CREDENTIAL_UNAVAILABLE", true);
            const target = allowedWinerimTarget(env);
            return executeAgoraSalesEnvelope(envelope, flags, {
              database,
              agoraCredential: agora,
              winerimCredential: winerim,
              winerimBaseUrl: target.baseUrl,
              winerimAllowedHosts: target.allowedHosts,
              request: resolved.request,
              now: resolved.now,
              sleep: resolved.sleep,
              maxClosedDaysPerRun: maxClosedDays(env),
              beforeMutation: () => assertExclusiveWriterFence(
                env,
                database,
                envelope.connectionId,
                winerim,
                resolved.now,
                "winerim",
                false,
                fenceScope,
              ).then(() => undefined),
            });
          } catch {
            return failure(503, "RUNTIME_SALES_COMPOSITION_UNAVAILABLE", true);
          }
        },
      }).fetch(request);
    },
  };
}

export default createMiddlewareRuntimeExecutorWorker();
