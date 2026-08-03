import { Client } from "pg";

import {
  createHyperdrivePostgresAdapter,
  type DatabaseAdapter,
  type DriverQueryConfig,
  type HyperdriveBinding,
  type PostgresClientFactory,
} from "../../middleware-api/src/db";
import { createWinerimMutationTransport, type SecretTextPort } from "../../middleware-runtime/src/adapters/http";
import {
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
  executeAgoraSalesEnvelope,
  isSalesLaneJob,
  salesLaneFlags,
  salesLaneGateFailure,
} from "./sales";
import {
  acquireExclusiveWriterFence,
  authorizeWriterFenceMutation,
  type WriterFenceClientEnvironment,
  type WriterFenceMutationAuthorization,
} from "../../../canary-failclosed/src/writerFence";

const STAGING_ENVIRONMENT = "staging";
const RESCUE_PRODUCTION_ENVIRONMENT = "rescue-production";
const EXCLUSIVE_CANARY_EXECUTOR_MODE = "exclusive-canary-executor";
const ENABLED_STOCK_JOBS = Object.freeze([
  "winerim.sales-import-live",
] as const satisfies readonly RuntimeJob[]);
const SALES_JOBS = Object.freeze([
  "sales.auto-sync",
  "sales.sync-intraday",
] as const satisfies readonly RuntimeJob[]);

export interface MiddlewareRuntimeExecutorEnv extends WriterFenceClientEnvironment {
  ENVIRONMENT?: string;
  RUNTIME_MODE?: string;
  RELEASE?: string;
  RUNTIME_EXECUTION_ENABLED?: string;
  RUNTIME_SALES_EXECUTION_ENABLED?: string;
  RUNTIME_SALES_CURSOR_ENABLED?: string;
  RUNTIME_SALES_DLQ_READY?: string;
  RUNTIME_SALES_MAX_CLOSED_DAYS_PER_RUN?: string;
  RUNTIME_CANARY_CONNECTION_ID?: string;
  CANARY_RUN_ID?: string;
  WRITER_FENCE_HOLDER_ID?: string;
  RUNTIME_VAULT_KEY_VERSION?: string;
  WINERIM_API_BASE_URL?: string;
  WINERIM_ALLOWED_HOSTS?: string;
  MIDDLEWARE_DB?: HyperdriveBinding;
  RUNTIME_VAULT_KEY?: RuntimeVaultSecretBinding;
}

const CANARY_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;

function canaryIdentifier(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return CANARY_IDENTIFIER_PATTERN.test(normalized) ? normalized : null;
}

async function assertExclusiveWriterFence(
  env: MiddlewareRuntimeExecutorEnv,
  connectionId: string,
  credential: SecretTextPort,
  now: () => number,
): Promise<WriterFenceMutationAuthorization | null> {
  if (String(env.ENVIRONMENT ?? "").trim().toLowerCase() !== RESCUE_PRODUCTION_ENVIRONMENT) return null;
  const runId = canaryIdentifier(env.CANARY_RUN_ID);
  const holderId = canaryIdentifier(env.WRITER_FENCE_HOLDER_ID);
  if (!runId || !holderId) {
    throw new Error("WRITER_FENCE_EXECUTOR_SCOPE_MISSING");
  }
  const attestation = runtimeCredentialAttestation(credential);
  if (
    attestation.connectionId !== connectionId
    || attestation.provider !== "agora"
    || attestation.kind !== "winerim"
  ) {
    throw new Error("WRITER_FENCE_CREDENTIAL_SCOPE_MISMATCH");
  }
  const lease = await acquireExclusiveWriterFence({ env, connectionId, runId, holderId });
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
    && String(env.RUNTIME_MODE ?? "").trim().toLowerCase() === EXCLUSIVE_CANARY_EXECUTOR_MODE;
}

export interface RuntimeExecutorWorkerDependencies {
  database?: (env: MiddlewareRuntimeExecutorEnv) => DatabaseAdapter;
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
  dependencies: Required<Pick<RuntimeExecutorWorkerDependencies, "request" | "now" | "sleep">>,
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
            context.envelope.connectionId,
            credential,
            dependencies.now,
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

function enabledJobs(env: MiddlewareRuntimeExecutorEnv): readonly RuntimeJob[] {
  const flags = salesLaneFlags(env);
  return flags.executionEnabled && flags.cursorEnabled && flags.dlqReady
    ? [...ENABLED_STOCK_JOBS, ...SALES_JOBS]
    : ENABLED_STOCK_JOBS;
}

function normalizedDependencies(
  dependencies: RuntimeExecutorWorkerDependencies,
): Required<RuntimeExecutorWorkerDependencies> {
  return {
    database: dependencies.database ?? defaultDatabase,
    request: dependencies.request ?? fetch,
    now: dependencies.now ?? Date.now,
    sleep: dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
  };
}

async function readiness(
  env: MiddlewareRuntimeExecutorEnv,
  dependencies: Required<RuntimeExecutorWorkerDependencies>,
): Promise<Response> {
  const environment = String(env.ENVIRONMENT ?? "").trim().toLowerCase();
  const executionEnabled = String(env.RUNTIME_EXECUTION_ENABLED ?? "").trim().toLowerCase() === "true";
  const salesFlags = salesLaneFlags(env);
  const missingBindings = [
    !env.MIDDLEWARE_DB ? "MIDDLEWARE_DB" : null,
    typeof env.RUNTIME_VAULT_KEY?.get !== "function" ? "RUNTIME_VAULT_KEY" : null,
    !String(env.RUNTIME_VAULT_KEY_VERSION ?? "").trim() ? "RUNTIME_VAULT_KEY_VERSION" : null,
    !String(env.WINERIM_API_BASE_URL ?? "").trim() ? "WINERIM_API_BASE_URL" : null,
    !String(env.WINERIM_ALLOWED_HOSTS ?? "").trim() ? "WINERIM_ALLOWED_HOSTS" : null,
    !isDeployableRuntimeCanaryConnectionId(env.RUNTIME_CANARY_CONNECTION_ID)
      ? "RUNTIME_CANARY_CONNECTION_ID"
      : null,
    environment === RESCUE_PRODUCTION_ENVIRONMENT && !canaryIdentifier(env.CANARY_RUN_ID)
      ? "CANARY_RUN_ID"
      : null,
    environment === RESCUE_PRODUCTION_ENVIRONMENT && !canaryIdentifier(env.WRITER_FENCE_HOLDER_ID)
      ? "WRITER_FENCE_HOLDER_ID"
      : null,
    environment === RESCUE_PRODUCTION_ENVIRONMENT
      && (!env.WRITER_FENCE || typeof env.WRITER_FENCE.fetch !== "function")
      ? "WRITER_FENCE"
      : null,
    environment === RESCUE_PRODUCTION_ENVIRONMENT
      && (!env.CANARY_WRITER_FENCE_PROOF || typeof env.CANARY_WRITER_FENCE_PROOF.get !== "function")
      ? "CANARY_WRITER_FENCE_PROOF"
      : null,
  ].filter((value): value is string => !!value);
  let credentialsReady = false;
  if (executionEnvironmentAllowed(env) && executionEnabled && missingBindings.length === 0) {
    try {
      const database = dependencies.database(env);
      const connectionId = String(env.RUNTIME_CANARY_CONNECTION_ID ?? "").trim();
      const connection = await createPostgresRuntimeConnectionPort(database).load(connectionId);
      if (connection?.enabled === true && connection.provider.toLowerCase() === "agora") {
        const credentials = createPostgresEncryptedCredentialPort(database, {
          masterKey: env.RUNTIME_VAULT_KEY!,
          keyVersion: String(env.RUNTIME_VAULT_KEY_VERSION ?? "").trim(),
        });
        const agora = await credentials.open({ connectionId, provider: "agora", kind: "agora" });
        const winerim = await credentials.open({ connectionId, provider: "agora", kind: "winerim" });
        credentialsReady = Boolean(await agora?.read()) && Boolean(await winerim?.read());
        if (credentialsReady && environment === RESCUE_PRODUCTION_ENVIRONMENT && winerim) {
          const attestation = runtimeCredentialAttestation(winerim);
          credentialsReady = attestation.connectionId === connectionId
            && attestation.provider === "agora"
            && attestation.kind === "winerim";
        }
      }
    } catch {
      credentialsReady = false;
    }
  }
  const ready = executionEnvironmentAllowed(env)
    && executionEnabled
    && missingBindings.length === 0
    && credentialsReady;
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
    missingBindings,
    credentials: credentialsReady ? "ready" : "not_ready",
    reason: ready ? null : "RUNTIME_EXECUTOR_NOT_READY",
  }, ready ? 200 : 503);
}

function executionGateOpen(env: MiddlewareRuntimeExecutorEnv): boolean {
  const rescueFenceReady = String(env.ENVIRONMENT ?? "").trim().toLowerCase() !== RESCUE_PRODUCTION_ENVIRONMENT
    || (
      canaryIdentifier(env.CANARY_RUN_ID) !== null
      && canaryIdentifier(env.WRITER_FENCE_HOLDER_ID) !== null
      && !!env.WRITER_FENCE
      && typeof env.WRITER_FENCE.fetch === "function"
      && !!env.CANARY_WRITER_FENCE_PROOF
      && typeof env.CANARY_WRITER_FENCE_PROOF.get === "function"
    );
  return executionEnvironmentAllowed(env)
    && rescueFenceReady
    && String(env.RUNTIME_EXECUTION_ENABLED ?? "").trim().toLowerCase() === "true"
    && isDeployableRuntimeCanaryConnectionId(env.RUNTIME_CANARY_CONNECTION_ID)
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

      let database: DatabaseAdapter;
      try {
        database = resolved.database(env);
      } catch {
        return json({ ok: false, failure: { httpStatus: 503, message: "RUNTIME_DATABASE_UNAVAILABLE" } }, 503);
      }
      if (typeof env.RUNTIME_VAULT_KEY?.get !== "function") {
        return json({ ok: false, failure: { httpStatus: 503, message: "RUNTIME_VAULT_UNAVAILABLE" } }, 503);
      }
      const options: RuntimeExecutorCompositionOptions = {
        environment: env.ENVIRONMENT,
        executionScope: String(env.ENVIRONMENT ?? "").trim().toLowerCase() === RESCUE_PRODUCTION_ENVIRONMENT
          ? "exclusive-canary"
          : "staging",
        executionEnabled: env.RUNTIME_EXECUTION_ENABLED,
        allowedConnectionId: String(env.RUNTIME_CANARY_CONNECTION_ID ?? "").trim(),
        enabledJobs: ENABLED_STOCK_JOBS,
        connections: createPostgresRuntimeConnectionPort(database),
        credentials: createPostgresEncryptedCredentialPort(database, {
          masterKey: env.RUNTIME_VAULT_KEY,
          keyVersion: String(env.RUNTIME_VAULT_KEY_VERSION ?? "").trim(),
        }),
        ports: {
          create: (context) => createStockPorts(context, env, resolved),
        },
      };
      const stockExecutor = createConnectionScopedRuntimeExecutor(options);
      const scopedConnections = createPostgresRuntimeConnectionPort(database);
      const scopedCredentials = createPostgresEncryptedCredentialPort(database, {
        masterKey: env.RUNTIME_VAULT_KEY,
        keyVersion: String(env.RUNTIME_VAULT_KEY_VERSION ?? "").trim(),
      });
      return createRuntimeExecutorService({
        async execute(envelope): Promise<RuntimeExecutionResult> {
          if (!isSalesLaneJob(envelope.job)) return stockExecutor.execute(envelope);
          if (envelope.connectionId !== String(env.RUNTIME_CANARY_CONNECTION_ID ?? "").trim()) {
            return failure(422, "RUNTIME_CANARY_CONNECTION_REJECTED");
          }
          const flags = salesLaneFlags(env);
          const salesGate = salesLaneGateFailure(flags, envelopeDryRun(envelope));
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
                envelope.connectionId,
                winerim,
                resolved.now,
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
