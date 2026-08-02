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
  type ProviderNeutralRuntimeExecutorPorts,
  type RuntimeConnectionExecutorContext,
  type RuntimeExecutorCompositionOptions,
  type RuntimeVaultSecretBinding,
} from "../../middleware-runtime/src/executor";
import type { WinerimStockMutationInput, WinerimStockIdentity } from "../../middleware-runtime/src/handlers/stock";

const STAGING_ENVIRONMENT = "staging";
const ENABLED_STOCK_JOBS = Object.freeze([
  "winerim.sales-import-live",
] as const satisfies readonly RuntimeJob[]);

export interface MiddlewareRuntimeExecutorEnv {
  ENVIRONMENT?: string;
  RELEASE?: string;
  RUNTIME_EXECUTION_ENABLED?: string;
  RUNTIME_CANARY_CONNECTION_ID?: string;
  RUNTIME_VAULT_KEY_VERSION?: string;
  WINERIM_API_BASE_URL?: string;
  WINERIM_ALLOWED_HOSTS?: string;
  MIDDLEWARE_DB?: HyperdriveBinding;
  RUNTIME_VAULT_KEY?: RuntimeVaultSecretBinding;
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
    connect: () => client.connect(),
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
  return {
    mode: String(payload.mode ?? "") as WinerimStockMutationInput["mode"],
    // Queue identity is the remote order identity. Caller-provided order IDs
    // are intentionally ignored so every retry sends the exact same value.
    orderId: envelope.idempotencyKey,
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
  return {
    stock: {
      prepare: async (envelope) => ({
        input: parseLiveGlassCanaryInput(envelope),
        dryRun: object(envelope.payload)?.dryRun === true,
      }),
      transport: createWinerimMutationTransport({
        ...target,
        credential,
        request: { request: (url, init) => dependencies.request(url, init) },
        timer: {
          now: dependencies.now,
          schedule: (callback, milliseconds) => setTimeout(callback, milliseconds),
          cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
        },
        sleep: dependencies.sleep,
      }),
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
  const missingBindings = [
    !env.MIDDLEWARE_DB ? "MIDDLEWARE_DB" : null,
    typeof env.RUNTIME_VAULT_KEY?.get !== "function" ? "RUNTIME_VAULT_KEY" : null,
    !String(env.RUNTIME_VAULT_KEY_VERSION ?? "").trim() ? "RUNTIME_VAULT_KEY_VERSION" : null,
    !String(env.WINERIM_API_BASE_URL ?? "").trim() ? "WINERIM_API_BASE_URL" : null,
    !String(env.WINERIM_ALLOWED_HOSTS ?? "").trim() ? "WINERIM_ALLOWED_HOSTS" : null,
    !isDeployableRuntimeCanaryConnectionId(env.RUNTIME_CANARY_CONNECTION_ID)
      ? "RUNTIME_CANARY_CONNECTION_ID"
      : null,
  ].filter((value): value is string => !!value);
  let credentialsReady = false;
  if (environment === STAGING_ENVIRONMENT && executionEnabled && missingBindings.length === 0) {
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
      }
    } catch {
      credentialsReady = false;
    }
  }
  const ready = environment === STAGING_ENVIRONMENT
    && executionEnabled
    && missingBindings.length === 0
    && credentialsReady;
  return json({
    ok: ready,
    service: "winerim-middleware-runtime-executor",
    environment: env.ENVIRONMENT ?? null,
    release: env.RELEASE ?? null,
    stagingOnly: true,
    executionEnabled,
    enabledJobs: ENABLED_STOCK_JOBS,
    missingBindings,
    credentials: credentialsReady ? "ready" : "not_ready",
    reason: ready ? null : "RUNTIME_EXECUTOR_NOT_READY",
  }, ready ? 200 : 503);
}

function executionGateOpen(env: MiddlewareRuntimeExecutorEnv): boolean {
  return String(env.ENVIRONMENT ?? "").trim().toLowerCase() === STAGING_ENVIRONMENT
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
      return createRuntimeExecutorService(createConnectionScopedRuntimeExecutor(options)).fetch(request);
    },
  };
}

export default createMiddlewareRuntimeExecutorWorker();
