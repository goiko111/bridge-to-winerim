import type { SecretTextPort } from "../adapters/http";
import { isRuntimeEnvelope, type RuntimeEnvelopeV1, type RuntimeJob } from "../contracts";
import type { RuntimeExecutionResult } from "../queue";
import type { ProviderNeutralRuntimeExecutorPorts } from "./contracts";
import { createProviderNeutralRuntimeExecutor } from "./executor";

export type RuntimeCredentialKind = "agora" | "winerim";

export type RuntimeConnectionConfiguration = Readonly<{
  connectionId: string;
  provider: string;
  enabled: boolean;
}>;

export type RuntimeConnectionConfigurationPort = Readonly<{
  load(connectionId: string): Promise<RuntimeConnectionConfiguration | null>;
}>;

/**
 * Opens a connection-scoped secret reader. The implementation owns retrieval
 * and decryption; this layer never receives or persists plaintext itself.
 */
export type RuntimeCredentialAccessPort = Readonly<{
  open(input: Readonly<{
    connectionId: string;
    provider: string;
    kind: RuntimeCredentialKind;
  }>): Promise<SecretTextPort | null>;
}>;

export type RuntimeConnectionExecutorContext = Readonly<{
  envelope: RuntimeEnvelopeV1;
  connection: RuntimeConnectionConfiguration;
  credentials: Readonly<Partial<Record<RuntimeCredentialKind, SecretTextPort>>>;
}>;

export type RuntimeConnectionExecutorPortsFactory = Readonly<{
  create(
    context: RuntimeConnectionExecutorContext,
  ): ProviderNeutralRuntimeExecutorPorts | Promise<ProviderNeutralRuntimeExecutorPorts>;
}>;

export type RuntimeExecutorCompositionOptions = Readonly<{
  environment?: string;
  executionEnabled?: boolean | string;
  allowedConnectionId?: string;
  enabledJobs?: readonly RuntimeJob[];
  connections: RuntimeConnectionConfigurationPort;
  credentials: RuntimeCredentialAccessPort;
  ports: RuntimeConnectionExecutorPortsFactory;
}>;

const STAGING_ENVIRONMENT = "staging";
const SUPPORTED_PROVIDER = "agora";

const LIVE_JOB_CREDENTIALS: Readonly<Record<RuntimeJob, readonly RuntimeCredentialKind[]>> = {
  "catalog.fetch-winerim": ["winerim"],
  "catalog.sync-master": ["agora"],
  "sales.auto-sync": ["agora", "winerim"],
  "sales.sync-intraday": ["agora", "winerim"],
  "sales.sync-open-tickets": ["agora", "winerim"],
  "outbound.process": ["agora"],
  "winerim.sales-import-live": ["winerim"],
  "winerim.sales-import-historical": ["winerim"],
  "winerim.stock-apply": ["winerim"],
  "maintenance.reconcile": [],
};

function failure(httpStatus: number, message: string): RuntimeExecutionResult {
  return { ok: false, failure: { httpStatus, message } };
}

function normalized(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function executionGateOpen(options: RuntimeExecutorCompositionOptions): boolean {
  return normalized(options.environment) === STAGING_ENVIRONMENT
    && (options.executionEnabled === true || normalized(options.executionEnabled) === "true");
}

function jobGateOpen(
  options: RuntimeExecutorCompositionOptions,
  envelope: RuntimeEnvelopeV1,
): boolean {
  return Array.isArray(options.enabledJobs)
    && options.enabledJobs.includes(envelope.job);
}

function connectionGateOpen(
  options: RuntimeExecutorCompositionOptions,
  envelope: RuntimeEnvelopeV1,
): boolean {
  const allowedConnectionId = String(options.allowedConnectionId ?? "").trim();
  return allowedConnectionId.length > 0 && envelope.connectionId === allowedConnectionId;
}

function payloadDryRun(envelope: RuntimeEnvelopeV1): boolean {
  return !!envelope.payload
    && typeof envelope.payload === "object"
    && !Array.isArray(envelope.payload)
    && envelope.payload.dryRun === true;
}

function requiredCredentialKinds(envelope: RuntimeEnvelopeV1): readonly RuntimeCredentialKind[] {
  if (!payloadDryRun(envelope)) return LIVE_JOB_CREDENTIALS[envelope.job];
  if (envelope.job.startsWith("winerim.") || envelope.job === "outbound.process") return [];
  if (envelope.job.startsWith("sales.")) return ["agora"];
  return LIVE_JOB_CREDENTIALS[envelope.job];
}

function validConnection(
  envelope: RuntimeEnvelopeV1,
  connection: RuntimeConnectionConfiguration,
): boolean {
  return connection.connectionId === envelope.connectionId
    && normalized(connection.provider) === SUPPORTED_PROVIDER
    && connection.enabled === true;
}

function isSecretPort(value: SecretTextPort | null): value is SecretTextPort {
  return !!value && typeof value.read === "function";
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function cloneEnvelope(envelope: RuntimeEnvelopeV1): RuntimeEnvelopeV1 {
  return deepFreeze(JSON.parse(JSON.stringify(envelope)) as RuntimeEnvelopeV1);
}

async function loadCredentials(
  options: RuntimeExecutorCompositionOptions,
  envelope: RuntimeEnvelopeV1,
  connection: RuntimeConnectionConfiguration,
): Promise<Readonly<Partial<Record<RuntimeCredentialKind, SecretTextPort>>> | null> {
  const resolved: Partial<Record<RuntimeCredentialKind, SecretTextPort>> = {};
  for (const kind of requiredCredentialKinds(envelope)) {
    const credential = await options.credentials.open({
      connectionId: envelope.connectionId,
      provider: connection.provider,
      kind,
    });
    if (!isSecretPort(credential)) return null;
    resolved[kind] = credential;
  }
  return Object.freeze(resolved);
}

export function createConnectionScopedRuntimeExecutor(
  options: RuntimeExecutorCompositionOptions,
): Readonly<{ execute(envelope: RuntimeEnvelopeV1): Promise<RuntimeExecutionResult> }> {
  return {
    async execute(input): Promise<RuntimeExecutionResult> {
      if (!isRuntimeEnvelope(input)) return failure(422, "INVALID_RUNTIME_ENVELOPE");
      if (!executionGateOpen(options)) return failure(503, "RUNTIME_EXECUTION_DISABLED");
      if (!jobGateOpen(options, input)) return failure(503, "RUNTIME_JOB_NOT_ENABLED");
      if (!connectionGateOpen(options, input)) {
        return failure(422, "RUNTIME_CANARY_CONNECTION_REJECTED");
      }

      // Work on a detached envelope so a provider factory cannot mutate the
      // Queue-owned message or its idempotency identity.
      const envelope = cloneEnvelope(input);
      const identity = `${envelope.messageId}:${envelope.idempotencyKey}:${envelope.connectionId}:${envelope.job}`;
      try {
        const connection = await options.connections.load(envelope.connectionId);
        if (!connection) return failure(422, "RUNTIME_CONNECTION_NOT_FOUND");
        if (!validConnection(envelope, connection)) {
          return failure(422, "RUNTIME_CONNECTION_SCOPE_REJECTED");
        }

        const credentials = await loadCredentials(options, envelope, connection);
        if (!credentials) return failure(503, "RUNTIME_CREDENTIAL_UNAVAILABLE");

        const ports = await options.ports.create({ envelope, connection, credentials });
        const currentIdentity = `${envelope.messageId}:${envelope.idempotencyKey}:${envelope.connectionId}:${envelope.job}`;
        if (currentIdentity !== identity || !isRuntimeEnvelope(envelope)) {
          return failure(422, "RUNTIME_ENVELOPE_SCOPE_MUTATED");
        }
        return createProviderNeutralRuntimeExecutor(ports).execute(envelope);
      } catch {
        return failure(503, "RUNTIME_COMPOSITION_UNAVAILABLE");
      }
    },
  };
}
