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
  createWinerimCatalogClient,
  type WinerimCatalogClient,
  type WinerimCatalogFormat,
} from "../../middleware-runtime/src/adapters/http/winerim-catalog";
import type {
  HttpRequestPort,
  HttpTimerPort,
  SecretTextPort,
} from "../../middleware-runtime/src/adapters/http/contracts";
import {
  isDeployableRuntimeCanaryConnectionId,
  type JsonValue,
  type RuntimeEnvelopeV1,
} from "../../middleware-runtime/src/contracts";
import { createRuntimeEnvelope } from "../../middleware-runtime/src/idempotency";

export const CATALOG_PRODUCER_CRON = "* * * * *" as const;
const RESCUE_PRODUCTION_ENVIRONMENT = "rescue-production";
const PRODUCER_ENABLED = "true";
const CANARY_RUN_PATTERN = /^[a-z0-9][a-z0-9-]{2,31}$/;
const NUMERIC_ID_PATTERN = /^[1-9]\d{0,17}$/;
const ALLOWED_FORMATS = new Set<WinerimCatalogFormat>(["BOTTLE", "GLASS", "MAGNUM"]);
const AES_GCM_NONCE_BYTES = 12;
const AES_256_KEY_BYTES = 32;
const MAX_SECRET_BYTES = 8 * 1024;

export type CatalogProducerTarget = Readonly<{
  connectionId: string;
  runId: string;
  winerimWineId: string;
  format: WinerimCatalogFormat;
  agoraProductId: string;
}>;

export type CatalogProducerScope = CatalogProducerTarget;

export interface CatalogProducerQueue {
  send(body: RuntimeEnvelopeV1): Promise<void>;
}

export type RuntimeVaultSecretBinding = Readonly<{
  get(): Promise<string>;
}>;

type CatalogProducerCredentialAttestation = Readonly<{
  reference: string;
  version: string;
  connectionId: string;
  provider: "agora";
  kind: "winerim";
}>;

type AttestedSecretTextPort = SecretTextPort & Readonly<{
  attestation(): CatalogProducerCredentialAttestation;
}>;

export interface MiddlewareCatalogProducerEnv {
  ENVIRONMENT?: string;
  CATALOG_PRODUCER_ENABLED?: string;
  CANARY_RUN_ID?: string;
  CANARY_CONNECTION_ID?: string;
  CANARY_WINERIM_WINE_ID?: string;
  CANARY_CATALOG_FORMAT?: string;
  CANARY_AGORA_PRODUCT_ID?: string;
  RUNTIME_VAULT_KEY_VERSION?: string;
  WINERIM_API_BASE_URL?: string;
  WINERIM_ALLOWED_HOSTS?: string;
  MIDDLEWARE_DB?: HyperdriveBinding;
  RUNTIME_VAULT_KEY?: RuntimeVaultSecretBinding;
  MIDDLEWARE_CATALOG_QUEUE?: CatalogProducerQueue;
}

export interface ScheduledControllerLike {
  readonly cron: string;
  readonly scheduledTime: number;
}

export type CatalogProducerResult = Readonly<{
  status: "dispatched" | "inactive";
  reason?:
    | "INVALID_CRON"
    | "PRODUCER_DISABLED"
    | "CONFIGURATION_REJECTED"
    | "SOURCE_SCOPE_REJECTED"
    | "CREDENTIAL_REJECTED";
  messages: 0 | 1;
  fingerprint?: string;
}>;

export type CatalogProducerDependencies = Readonly<{
  database(env: MiddlewareCatalogProducerEnv): DatabaseAdapter;
  loadScope(database: DatabaseAdapter, target: CatalogProducerTarget): Promise<CatalogProducerScope | null>;
  openCredential(
    database: DatabaseAdapter,
    env: MiddlewareCatalogProducerEnv,
    target: CatalogProducerTarget,
  ): Promise<SecretTextPort | null>;
  catalog(env: MiddlewareCatalogProducerEnv, credential: SecretTextPort): WinerimCatalogClient;
}>;

interface SourceScopeRow extends Record<string, unknown> {
  connection_id: unknown;
  run_id: unknown;
  winerim_wine_id: unknown;
  format: unknown;
  agora_product_id: unknown;
}

interface CredentialRow extends Record<string, unknown> {
  connection_id: unknown;
  provider: unknown;
  credential_kind: unknown;
  algorithm: unknown;
  key_version: unknown;
  aad_version: unknown;
  ciphertext_base64: unknown;
  nonce_base64: unknown;
  active: unknown;
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function decodeBase64(value: unknown): Uint8Array {
  const encoded = text(value).replace(/[\t\n\r ]+/g, "");
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error("CATALOG_PRODUCER_CREDENTIAL_INVALID");
  }
  const binary = atob(encoded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function credentialAad(input: {
  connectionId: string;
  keyVersion: string;
  aadVersion: number;
}): Uint8Array {
  return new TextEncoder().encode([
    "winerim-runtime-credential",
    String(input.aadVersion),
    input.connectionId,
    "agora",
    "winerim",
    input.keyVersion,
  ].join("|"));
}

async function decryptCredential(
  row: CredentialRow,
  env: MiddlewareCatalogProducerEnv,
  target: CatalogProducerTarget,
): Promise<string> {
  const keyVersion = text(env.RUNTIME_VAULT_KEY_VERSION);
  const aadVersion = Number(row.aad_version);
  if (
    text(row.connection_id) !== target.connectionId
    || text(row.provider).toLowerCase() !== "agora"
    || text(row.credential_kind) !== "winerim"
    || text(row.algorithm) !== "AES-256-GCM"
    || text(row.key_version) !== keyVersion
    || aadVersion !== 1
    || row.active !== true
    || !env.RUNTIME_VAULT_KEY
  ) throw new Error("CATALOG_PRODUCER_CREDENTIAL_SCOPE_REJECTED");

  const masterKeyBytes = decodeBase64(await env.RUNTIME_VAULT_KEY.get());
  const nonce = decodeBase64(row.nonce_base64);
  const ciphertext = decodeBase64(row.ciphertext_base64);
  if (
    masterKeyBytes.byteLength !== AES_256_KEY_BYTES
    || nonce.byteLength !== AES_GCM_NONCE_BYTES
    || ciphertext.byteLength <= 16
  ) throw new Error("CATALOG_PRODUCER_CREDENTIAL_INVALID");
  const masterKey = await crypto.subtle.importKey(
    "raw",
    masterKeyBytes,
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  const plaintext = await crypto.subtle.decrypt({
    name: "AES-GCM",
    iv: nonce,
    additionalData: credentialAad({ connectionId: target.connectionId, keyVersion, aadVersion }),
    tagLength: 128,
  }, masterKey, ciphertext);
  if (plaintext.byteLength === 0 || plaintext.byteLength > MAX_SECRET_BYTES) {
    throw new Error("CATALOG_PRODUCER_CREDENTIAL_INVALID");
  }
  const value = new TextDecoder("utf-8", { fatal: true }).decode(plaintext).trim();
  if (!value || /[\r\n]/.test(value)) throw new Error("CATALOG_PRODUCER_CREDENTIAL_INVALID");
  return value;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function credentialAttestation(value: SecretTextPort): CatalogProducerCredentialAttestation {
  const candidate = value as Partial<AttestedSecretTextPort>;
  if (typeof candidate.attestation !== "function") {
    throw new Error("CATALOG_PRODUCER_CREDENTIAL_ATTESTATION_MISSING");
  }
  const attestation = candidate.attestation();
  if (
    !attestation.reference.startsWith("runtime-vault://postgres/")
    || !/^[a-f0-9]{64}$/.test(attestation.version)
    || attestation.provider !== "agora"
    || attestation.kind !== "winerim"
  ) throw new Error("CATALOG_PRODUCER_CREDENTIAL_ATTESTATION_INVALID");
  return attestation;
}

function configuredTarget(env: MiddlewareCatalogProducerEnv): CatalogProducerTarget | null {
  const connectionId = text(env.CANARY_CONNECTION_ID);
  const runId = text(env.CANARY_RUN_ID);
  const winerimWineId = text(env.CANARY_WINERIM_WINE_ID);
  const format = text(env.CANARY_CATALOG_FORMAT).toUpperCase() as WinerimCatalogFormat;
  const agoraProductId = text(env.CANARY_AGORA_PRODUCT_ID);
  if (
    !isDeployableRuntimeCanaryConnectionId(connectionId)
    || !CANARY_RUN_PATTERN.test(runId)
    || !NUMERIC_ID_PATTERN.test(winerimWineId)
    || !ALLOWED_FORMATS.has(format)
    || !NUMERIC_ID_PATTERN.test(agoraProductId)
  ) return null;
  return Object.freeze({ connectionId, runId, winerimWineId, format, agoraProductId });
}

function producerConfigured(env: MiddlewareCatalogProducerEnv): boolean {
  return Boolean(
    env.MIDDLEWARE_DB
    && env.RUNTIME_VAULT_KEY
    && typeof env.RUNTIME_VAULT_KEY.get === "function"
    && text(env.RUNTIME_VAULT_KEY_VERSION)
    && text(env.WINERIM_API_BASE_URL)
    && text(env.WINERIM_ALLOWED_HOSTS)
    && env.MIDDLEWARE_CATALOG_QUEUE
    && typeof env.MIDDLEWARE_CATALOG_QUEUE.send === "function",
  );
}

function sameTarget(left: CatalogProducerTarget, right: CatalogProducerScope): boolean {
  return left.connectionId === right.connectionId
    && left.runId === right.runId
    && left.winerimWineId === right.winerimWineId
    && left.format === right.format
    && left.agoraProductId === right.agoraProductId;
}

function scheduledSlotIso(scheduledTime: number): string {
  return new Date(Math.floor(scheduledTime / 60_000) * 60_000).toISOString();
}

export async function loadPostgresCatalogProducerScope(
  database: DatabaseAdapter,
  target: CatalogProducerTarget,
): Promise<CatalogProducerScope | null> {
  const result = await database.query<SourceScopeRow>(sql`
    SELECT
      target.connection_id::text,
      target.run_id,
      target.winerim_wine_id,
      target.format,
      target.agora_product_id
    FROM public.runtime_catalog_source_scope target
    JOIN public.runtime_canary_connections scope
      ON scope.connection_id = target.connection_id
     AND scope.run_id = target.run_id
    JOIN public.pos_connections connection
      ON connection.id = target.connection_id
    JOIN public.winerim_wines wine
      ON wine.connection_id = target.connection_id
     AND wine.winerim_id = target.winerim_wine_id
    JOIN public.product_mappings mapping
      ON mapping.connection_id = target.connection_id
     AND mapping.provider_product_id = target.agora_product_id
     AND mapping.winerim_wine_id = target.winerim_wine_id
     AND upper(mapping.format_type) = target.format
    WHERE target.connection_id = ${target.connectionId}::uuid
      AND target.run_id = ${target.runId}
      AND target.winerim_wine_id = ${target.winerimWineId}
      AND target.format = ${target.format}
      AND target.agora_product_id = ${target.agoraProductId}
      AND scope.status = 'ACTIVE'
      AND scope.active = true
      AND scope.approved_at <= now()
      AND scope.expires_at > now()
      AND connection.provider = 'agora'
      AND connection.enabled = true
    LIMIT 2
  `);
  if (result.rowCount !== 1) return null;
  const row = result.rows[0];
  const scope: CatalogProducerScope = Object.freeze({
    connectionId: text(row.connection_id),
    runId: text(row.run_id),
    winerimWineId: text(row.winerim_wine_id),
    format: text(row.format) as WinerimCatalogFormat,
    agoraProductId: text(row.agora_product_id),
  });
  return sameTarget(target, scope) ? scope : null;
}

const createPostgresClient: PostgresClientFactory = ({ connectionString, applicationName }) => {
  const client = new Client({ connectionString, application_name: applicationName });
  return {
    connect: async () => { await client.connect(); },
    query: async <Row extends Record<string, unknown>>(query: string | DriverQueryConfig) => {
      const result = await client.query<Row>(query);
      return { rows: result.rows, rowCount: result.rowCount };
    },
    end: () => client.end(),
  };
};

function defaultDatabase(env: MiddlewareCatalogProducerEnv): DatabaseAdapter {
  if (!env.MIDDLEWARE_DB) throw new Error("CATALOG_PRODUCER_DB_NOT_CONFIGURED");
  return createHyperdrivePostgresAdapter(env.MIDDLEWARE_DB, {
    createClient: createPostgresClient,
    applicationName: "winerim-catalog-producer",
  });
}

async function defaultCredential(
  database: DatabaseAdapter,
  env: MiddlewareCatalogProducerEnv,
  target: CatalogProducerTarget,
): Promise<SecretTextPort | null> {
  if (!env.RUNTIME_VAULT_KEY) return null;
  const result = await database.query<CredentialRow>(sql`
    SELECT
      credentials.connection_id::text,
      credentials.provider,
      credentials.credential_kind,
      credentials.algorithm,
      credentials.key_version,
      credentials.aad_version,
      encode(credentials.ciphertext, 'base64') AS ciphertext_base64,
      encode(credentials.nonce, 'base64') AS nonce_base64,
      credentials.active
    FROM public.runtime_connection_credentials credentials
    JOIN public.runtime_canary_connections scope
      ON scope.connection_id = credentials.connection_id
     AND scope.run_id = credentials.run_id
    WHERE credentials.connection_id = ${target.connectionId}::uuid
      AND credentials.run_id = ${target.runId}
      AND credentials.provider = 'agora'
      AND credentials.credential_kind = 'winerim'
      AND credentials.active = true
      AND scope.status = 'ACTIVE'
      AND scope.active = true
      AND scope.approved_at <= now()
      AND scope.expires_at > now()
    LIMIT 2
  `);
  if (result.rowCount !== 1) return null;
  const row = result.rows[0];
  const value = await decryptCredential(row, env, target);
  const reference = `runtime-vault://postgres/${target.connectionId}/agora/winerim`;
  const version = await sha256([
    "winerim-runtime-credential-attestation",
    "1",
    reference,
    text(row.key_version),
    String(row.aad_version),
    text(row.nonce_base64).replace(/[\t\n\r ]+/g, ""),
    text(row.ciphertext_base64).replace(/[\t\n\r ]+/g, ""),
  ].join("|"));
  return Object.freeze({
    read: () => value,
    attestation: () => Object.freeze({
      reference,
      version,
      connectionId: target.connectionId,
      provider: "agora" as const,
      kind: "winerim" as const,
    }),
  }) as AttestedSecretTextPort;
}

const defaultRequest: HttpRequestPort = Object.freeze({
  request: (url, init) => fetch(url, init),
});

const defaultTimer: HttpTimerPort = Object.freeze({
  now: () => Date.now(),
  schedule: (callback, milliseconds) => setTimeout(callback, milliseconds),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
});

function allowedHosts(env: MiddlewareCatalogProducerEnv): string[] {
  return text(env.WINERIM_ALLOWED_HOSTS).split(",").map((host) => host.trim()).filter(Boolean);
}

export const DEFAULT_CATALOG_PRODUCER_DEPENDENCIES: CatalogProducerDependencies = Object.freeze({
  database: defaultDatabase,
  loadScope: loadPostgresCatalogProducerScope,
  openCredential: defaultCredential,
  catalog: (env, credential) => createWinerimCatalogClient({
    baseUrl: text(env.WINERIM_API_BASE_URL),
    allowedHosts: allowedHosts(env),
    credential,
    request: defaultRequest,
    timer: defaultTimer,
  }),
});

export async function runCatalogProducerScheduled(
  controller: ScheduledControllerLike,
  env: MiddlewareCatalogProducerEnv,
  dependencies: CatalogProducerDependencies = DEFAULT_CATALOG_PRODUCER_DEPENDENCIES,
): Promise<CatalogProducerResult> {
  if (controller.cron !== CATALOG_PRODUCER_CRON || !Number.isFinite(controller.scheduledTime)) {
    return { status: "inactive", reason: "INVALID_CRON", messages: 0 };
  }
  if (
    text(env.ENVIRONMENT).toLowerCase() !== RESCUE_PRODUCTION_ENVIRONMENT
    || text(env.CATALOG_PRODUCER_ENABLED).toLowerCase() !== PRODUCER_ENABLED
  ) {
    return { status: "inactive", reason: "PRODUCER_DISABLED", messages: 0 };
  }
  const target = configuredTarget(env);
  if (!target || !producerConfigured(env)) {
    return { status: "inactive", reason: "CONFIGURATION_REJECTED", messages: 0 };
  }

  const database = dependencies.database(env);
  const scope = await dependencies.loadScope(database, target);
  if (!scope || !sameTarget(target, scope)) {
    return { status: "inactive", reason: "SOURCE_SCOPE_REJECTED", messages: 0 };
  }
  const credential = await dependencies.openCredential(database, env, target);
  if (!credential) {
    return { status: "inactive", reason: "CREDENTIAL_REJECTED", messages: 0 };
  }
  let attestation: CatalogProducerCredentialAttestation;
  try {
    attestation = credentialAttestation(credential);
  } catch {
    return { status: "inactive", reason: "CREDENTIAL_REJECTED", messages: 0 };
  }
  if (
    attestation.connectionId !== target.connectionId
    || attestation.provider !== "agora"
    || attestation.kind !== "winerim"
  ) {
    return { status: "inactive", reason: "CREDENTIAL_REJECTED", messages: 0 };
  }

  const observed = await dependencies.catalog(env, credential).fetchOne({
    winerimWineId: target.winerimWineId,
    format: target.format,
  });
  const payload = Object.freeze({
    winerimWineIds: [target.winerimWineId],
    formatTypes: [target.format],
    agoraProductId: target.agoraProductId,
    target: {
      connectionId: target.connectionId,
      winerimWineId: target.winerimWineId,
      format: target.format,
      agoraProductId: target.agoraProductId,
    },
    refreshBeforeApply: {
      version: 1,
      runId: target.runId,
      source: "winerim.bulk",
      endpoint: "/api/v2/wines/bulk",
      fingerprint: observed.fingerprint,
      wine: observed.wine,
    },
  }) as unknown as JsonValue;
  const slot = scheduledSlotIso(controller.scheduledTime);
  const envelope = await createRuntimeEnvelope({
    connectionId: target.connectionId,
    job: "catalog.sync-master",
    dedupeScope: `catalog-source:${target.runId}:${observed.fingerprint}`,
    payload,
    createdAt: slot,
    source: {
      kind: "cron",
      eventId: `catalog-source:${target.runId}:${observed.fingerprint}`,
      scheduledSlot: slot,
      trigger: CATALOG_PRODUCER_CRON,
    },
  });
  await env.MIDDLEWARE_CATALOG_QUEUE!.send(envelope);
  return { status: "dispatched", messages: 1, fingerprint: observed.fingerprint };
}

export default {
  async scheduled(
    controller: ScheduledControllerLike,
    env: MiddlewareCatalogProducerEnv,
  ): Promise<void> {
    await runCatalogProducerScheduled(controller, env);
  },
};
