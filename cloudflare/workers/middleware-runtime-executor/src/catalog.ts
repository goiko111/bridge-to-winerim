import type { DatabaseAdapter } from "../../middleware-api/src/db";
import {
  createPostgresCatalogAdapter,
  type PostgresCatalogAdapterFactory,
  type PostgresCatalogAdapterOptions,
} from "../../middleware-runtime/src/adapters/catalog";
import type { SecretTextPort } from "../../middleware-runtime/src/adapters/http";
import {
  isRuntimeEnvelope,
  type RuntimeEnvelopeV1,
  type RuntimeJob,
} from "../../middleware-runtime/src/contracts";
import type {
  RuntimeConnectionConfiguration,
  RuntimeConnectionConfigurationPort,
  RuntimeCredentialAccessPort,
} from "../../middleware-runtime/src/executor";
import { handleCatalogRequest } from "../../middleware-runtime/src/handlers/catalog";
import type { RuntimeExecutionResult } from "../../middleware-runtime/src/queue";

type BooleanSwitch = boolean | string | null | undefined;
type JsonRecord = Record<string, unknown>;

const CATALOG_JOBS = Object.freeze([
  "catalog.fetch-winerim",
  "catalog.sync-master",
] as const satisfies readonly RuntimeJob[]);
const CATALOG_JOB_SET = new Set<RuntimeJob>(CATALOG_JOBS);

export const PRIVATE_CATALOG_SAFETY_CONTRACT = Object.freeze({
  enabledByDefault: false,
  queueClaim: "runtime_idempotency",
  planClaim: "runtime_idempotency/catalog.plan.db",
  deadLetter: "cloudflare-queue/max-attempts",
  applyIsSeparateGate: true,
});

export type PrivateCatalogSwitches = Readonly<{
  executionEnabled?: BooleanSwitch;
  fetchEnabled?: BooleanSwitch;
  applyEnabled?: BooleanSwitch;
}>;

export type CatalogRefreshResult =
  | Readonly<{ ok: true; outcome: "complete" | "duplicate"; changed: number }>
  | Readonly<{
      ok: false;
      httpStatus: number;
      message: string;
      retryableLine?: boolean;
    }>;

/**
 * The current shared catalog adapter owns planning and atomic DB claims, but it
 * intentionally does not own the Winerim HTTP list/detail refresh. Keeping the
 * refresh behind this explicit port prevents a future worker integration from
 * silently treating a DB-only plan as a successful remote catalog fetch.
 */
export type WinerimCatalogRefreshPort = Readonly<{
  refresh(input: Readonly<{
    connectionId: string;
    messageId: string;
    idempotencyKey: string;
    dryRun: boolean;
    credential: SecretTextPort;
  }>): Promise<CatalogRefreshResult>;
}>;

export type PrivateCatalogCompositionOptions = Readonly<{
  allowedConnectionId: string;
  switches?: PrivateCatalogSwitches;
  database: DatabaseAdapter;
  connections: RuntimeConnectionConfigurationPort;
  credentials: RuntimeCredentialAccessPort;
  adapterOptions?: PostgresCatalogAdapterOptions;
  adapterFactory?: PostgresCatalogAdapterFactory;
  refresh?: WinerimCatalogRefreshPort;
}>;

export type PrivateCatalogLaneExecutor = Readonly<{
  execute(envelope: RuntimeEnvelopeV1): Promise<RuntimeExecutionResult>;
}>;

function enabled(value: BooleanSwitch): boolean {
  return value === true || String(value ?? "").trim().toLowerCase() === "true";
}

function failure(
  httpStatus: number,
  message: string,
  retryableLine = false,
): RuntimeExecutionResult {
  return {
    ok: false,
    failure: {
      httpStatus,
      message,
      ...(retryableLine ? { retryableLine: true } : {}),
    },
  };
}

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function dryRunRequested(envelope: RuntimeEnvelopeV1): boolean {
  return record(envelope.payload).dryRun === true;
}

function validConnection(
  envelope: RuntimeEnvelopeV1,
  connection: RuntimeConnectionConfiguration | null,
): connection is RuntimeConnectionConfiguration {
  return !!connection
    && connection.connectionId === envelope.connectionId
    && connection.provider.trim().toLowerCase() === "agora"
    && connection.enabled === true;
}

async function scopedConnection(
  envelope: RuntimeEnvelopeV1,
  options: PrivateCatalogCompositionOptions,
): Promise<RuntimeConnectionConfiguration | RuntimeExecutionResult> {
  if (envelope.connectionId !== options.allowedConnectionId.trim()) {
    return failure(422, "CATALOG_CONNECTION_REJECTED");
  }
  let connection: RuntimeConnectionConfiguration | null;
  try {
    connection = await options.connections.load(envelope.connectionId);
  } catch {
    return failure(503, "CATALOG_CONNECTION_UNAVAILABLE");
  }
  return validConnection(envelope, connection)
    ? connection
    : failure(422, "CATALOG_CONNECTION_SCOPE_REJECTED");
}

function isFailure(value: RuntimeConnectionConfiguration | RuntimeExecutionResult): value is RuntimeExecutionResult {
  return "ok" in value;
}

async function credential(
  envelope: RuntimeEnvelopeV1,
  connection: RuntimeConnectionConfiguration,
  options: PrivateCatalogCompositionOptions,
  kind: "agora" | "winerim",
): Promise<SecretTextPort | null> {
  try {
    const opened = await options.credentials.open({
      connectionId: envelope.connectionId,
      provider: connection.provider,
      kind,
    });
    return opened && typeof opened.read === "function" ? opened : null;
  } catch {
    return null;
  }
}

function selectionPayload(payload: JsonRecord): Record<string, unknown> {
  const formatTypes = payload.formatTypes ?? payload.formats;
  const winerimWineIds = payload.winerimWineIds ?? payload.wineIds;
  return {
    ...(formatTypes === undefined ? {} : { formatTypes }),
    ...(winerimWineIds === undefined ? {} : { winerimWineIds }),
  };
}

async function executeRefresh(
  envelope: RuntimeEnvelopeV1,
  connection: RuntimeConnectionConfiguration,
  options: PrivateCatalogCompositionOptions,
): Promise<RuntimeExecutionResult> {
  if (!enabled(options.switches?.fetchEnabled)) return failure(503, "CATALOG_FETCH_DISABLED");
  if (!options.refresh) return failure(503, "CATALOG_FETCH_PORT_NOT_CONFIGURED");
  const winerim = await credential(envelope, connection, options, "winerim");
  if (!winerim) return failure(503, "CATALOG_WINERIM_CREDENTIAL_UNAVAILABLE");

  let result: CatalogRefreshResult;
  try {
    result = await options.refresh.refresh({
      connectionId: envelope.connectionId,
      messageId: envelope.messageId,
      idempotencyKey: envelope.idempotencyKey,
      dryRun: dryRunRequested(envelope),
      credential: winerim,
    });
  } catch {
    return failure(503, "CATALOG_FETCH_UNAVAILABLE");
  }
  const changed = result.ok && Number.isFinite(result.changed)
    ? Math.max(0, Math.floor(result.changed))
    : 0;
  return result.ok
    ? { ok: true, detail: `catalog:fetch:${result.outcome}:${changed}` }
    : failure(
      result.httpStatus,
      [400, 401, 403, 404, 409, 422].includes(result.httpStatus)
        ? "CATALOG_FETCH_REJECTED"
        : "CATALOG_FETCH_UNAVAILABLE",
      result.retryableLine === true,
    );
}

async function executePlan(
  envelope: RuntimeEnvelopeV1,
  connection: RuntimeConnectionConfiguration,
  options: PrivateCatalogCompositionOptions,
): Promise<RuntimeExecutionResult> {
  const payload = record(envelope.payload);
  const dryRun = dryRunRequested(envelope);
  if (!dryRun && !enabled(options.switches?.applyEnabled)) {
    return failure(503, "CATALOG_APPLY_DISABLED");
  }
  if (!dryRun) {
    const agora = await credential(envelope, connection, options, "agora");
    if (!agora) return failure(503, "CATALOG_AGORA_CREDENTIAL_UNAVAILABLE");
  }

  const adapterFactory = options.adapterFactory ?? createPostgresCatalogAdapter;
  const adapter = adapterFactory(options.database, options.adapterOptions);
  const result = await handleCatalogRequest({
    action: dryRun ? "catalog.preview" : "catalog.apply",
    connectionId: envelope.connectionId,
    dryRun,
    ...selectionPayload(payload),
  }, {
    loadPlanningContext: adapter.loadPlanningContext,
    ...(!dryRun && enabled(options.switches?.applyEnabled)
      ? { applyPlan: adapter.applyPlan }
      : {}),
  });

  if (!result.ok) return failure(result.status, `CATALOG_${result.error.code}`);
  return {
    ok: true,
    detail: `catalog:${result.mode}:${result.plan.operations.length}:${result.plan.idempotency.key}`,
  };
}

export function privateCatalogEnabledJobs(
  switches: PrivateCatalogSwitches | undefined,
): readonly RuntimeJob[] {
  if (!enabled(switches?.executionEnabled)) return [];
  return CATALOG_JOBS.filter((job) =>
    job === "catalog.fetch-winerim" ? enabled(switches?.fetchEnabled) : true
  );
}

export function createPrivateCatalogLaneExecutor(
  options: PrivateCatalogCompositionOptions,
): PrivateCatalogLaneExecutor {
  return Object.freeze({
    async execute(envelope): Promise<RuntimeExecutionResult> {
      if (!isRuntimeEnvelope(envelope) || !CATALOG_JOB_SET.has(envelope.job)) {
        return failure(422, "CATALOG_ENVELOPE_REJECTED");
      }
      if (!enabled(options.switches?.executionEnabled)) return failure(503, "CATALOG_EXECUTION_DISABLED");

      const connection = await scopedConnection(envelope, options);
      if (isFailure(connection)) return connection;
      return envelope.job === "catalog.fetch-winerim"
        ? executeRefresh(envelope, connection, options)
        : executePlan(envelope, connection, options);
    },
  });
}
