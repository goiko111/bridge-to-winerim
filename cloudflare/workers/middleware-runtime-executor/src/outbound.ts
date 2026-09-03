import type { DatabaseAdapter } from "../../middleware-api/src/db";
import {
  createPostgresOutboundAdapter,
  type PosOutboundTransport,
  type PostgresOutboundAdapter,
  type PostgresOutboundAdapterOptions,
  type PostgresOutboundProcessInput,
} from "../../middleware-runtime/src/adapters/outbound";
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
import type { OutboundPorts } from "../../middleware-runtime/src/handlers/outbound";
import type { RuntimeExecutionResult } from "../../middleware-runtime/src/queue";
import type { RuntimeFailureDiagnosticInput } from "../../middleware-runtime/src/retry";

type BooleanSwitch = boolean | string | null | undefined;
type JsonRecord = Record<string, unknown>;

const OUTBOUND_JOB = "outbound.process" as const satisfies RuntimeJob;
export const PRIVATE_OUTBOUND_TASK_TYPES = Object.freeze([
  "AGORA_XML_UPSERT_PRODUCT",
  "AGORA_MIGRATE_FAMILY",
  "AGORA_HIDE_PRODUCT",
] as const);
const OUTBOUND_TASK_TYPE_SET = new Set<string>(PRIVATE_OUTBOUND_TASK_TYPES);

export const PRIVATE_OUTBOUND_SAFETY_CONTRACT = Object.freeze({
  enabledByDefault: false,
  queueClaim: "runtime_idempotency",
  taskClaim: "outbound_tasks/FOR_UPDATE_SKIP_LOCKED",
  taskIdempotency: "payload._idempotency_key || outbound-task:<task-id>",
  deadLetter: "cloudflare-queue/max-attempts",
  mutationIsSeparateGate: true,
});

export type PrivateOutboundSwitches = Readonly<{
  executionEnabled?: BooleanSwitch;
  mutationEnabled?: BooleanSwitch;
}>;

export type PrivateOutboundTransportFactory = (input: Readonly<{
  envelope: RuntimeEnvelopeV1;
  connection: RuntimeConnectionConfiguration;
  credential: SecretTextPort;
}>) => PosOutboundTransport | Promise<PosOutboundTransport>;

export type PrivateOutboundAdapterFactory = (
  database: DatabaseAdapter,
  transport: PosOutboundTransport,
  options: PostgresOutboundAdapterOptions,
) => PostgresOutboundAdapter;

export type PrivateOutboundCompositionOptions = Readonly<{
  allowedConnectionId: string;
  switches?: PrivateOutboundSwitches;
  database: DatabaseAdapter;
  connections: RuntimeConnectionConfigurationPort;
  credentials: RuntimeCredentialAccessPort;
  transport: PrivateOutboundTransportFactory;
  limiter: OutboundPorts["limiter"];
  adapterFactory?: PrivateOutboundAdapterFactory;
  clock?: OutboundPorts["clock"];
  lockTtlSeconds?: number;
  lockTokenFactory?: () => string;
  maxBatchSize?: number;
}>;

export type PrivateOutboundLaneExecutor = Readonly<{
  execute(envelope: RuntimeEnvelopeV1): Promise<RuntimeExecutionResult>;
}>;

function enabled(value: BooleanSwitch): boolean {
  return value === true || String(value ?? "").trim().toLowerCase() === "true";
}

function failure(
  httpStatus: number,
  message: string,
  diagnostic?: RuntimeFailureDiagnosticInput,
): RuntimeExecutionResult {
  return {
    ok: false,
    failure: {
      httpStatus,
      message,
      ...(diagnostic ? { diagnostic } : {}),
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

function isFailure(value: RuntimeConnectionConfiguration | RuntimeExecutionResult): value is RuntimeExecutionResult {
  return "ok" in value;
}

function boundedLimit(value: unknown, configuredMaximum = 10): number {
  const maximum = Number.isInteger(configuredMaximum)
    ? Math.max(1, Math.min(10, configuredMaximum))
    : 10;
  const requested = Number(value);
  return Number.isInteger(requested) && requested > 0
    ? Math.min(requested, maximum)
    : maximum;
}

function taskTypes(value: unknown): readonly string[] | null {
  if (value === undefined) return PRIVATE_OUTBOUND_TASK_TYPES;
  if (!Array.isArray(value) || value.length === 0) return null;
  const normalized = [...new Set(value.map((item) => String(item ?? "").trim()).filter(Boolean))];
  if (normalized.length !== value.length || normalized.some((item) => !OUTBOUND_TASK_TYPE_SET.has(item))) {
    return null;
  }
  return normalized;
}

function unavailableTransport(): PosOutboundTransport {
  return Object.freeze({
    execute: async () => {
      throw new Error("OUTBOUND_TRANSPORT_MUST_NOT_RUN_DURING_DRY_RUN");
    },
  });
}

async function scopedConnection(
  envelope: RuntimeEnvelopeV1,
  options: PrivateOutboundCompositionOptions,
): Promise<RuntimeConnectionConfiguration | RuntimeExecutionResult> {
  if (envelope.connectionId !== options.allowedConnectionId.trim()) {
    return failure(422, "OUTBOUND_CONNECTION_REJECTED");
  }
  let connection: RuntimeConnectionConfiguration | null;
  try {
    connection = await options.connections.load(envelope.connectionId);
  } catch {
    return failure(503, "OUTBOUND_CONNECTION_UNAVAILABLE");
  }
  return validConnection(envelope, connection)
    ? connection
    : failure(422, "OUTBOUND_CONNECTION_SCOPE_REJECTED");
}

async function agoraCredential(
  envelope: RuntimeEnvelopeV1,
  connection: RuntimeConnectionConfiguration,
  options: PrivateOutboundCompositionOptions,
): Promise<SecretTextPort | null> {
  try {
    const opened = await options.credentials.open({
      connectionId: envelope.connectionId,
      provider: connection.provider,
      kind: "agora",
    });
    return opened && typeof opened.read === "function" ? opened : null;
  } catch {
    return null;
  }
}

function adapterOptions(
  envelope: RuntimeEnvelopeV1,
  connection: RuntimeConnectionConfiguration,
  options: PrivateOutboundCompositionOptions,
  dryRun: boolean,
): PostgresOutboundAdapterOptions {
  return {
    connectionId: envelope.connectionId,
    provider: connection.provider,
    dryRun,
    limiter: options.limiter,
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.lockTtlSeconds === undefined ? {} : { lockTtlSeconds: options.lockTtlSeconds }),
    ...(options.lockTokenFactory ? { lockTokenFactory: options.lockTokenFactory } : {}),
  };
}

export function privateOutboundEnabledJobs(
  switches: PrivateOutboundSwitches | undefined,
): readonly RuntimeJob[] {
  return enabled(switches?.executionEnabled) ? [OUTBOUND_JOB] : [];
}

export function createPrivateOutboundLaneExecutor(
  options: PrivateOutboundCompositionOptions,
): PrivateOutboundLaneExecutor {
  return Object.freeze({
    async execute(envelope): Promise<RuntimeExecutionResult> {
      if (!isRuntimeEnvelope(envelope) || envelope.job !== OUTBOUND_JOB) {
        return failure(422, "OUTBOUND_ENVELOPE_REJECTED");
      }
      if (!enabled(options.switches?.executionEnabled)) return failure(503, "OUTBOUND_EXECUTION_DISABLED");

      const dryRun = dryRunRequested(envelope);
      if (!dryRun && !enabled(options.switches?.mutationEnabled)) {
        return failure(503, "OUTBOUND_MUTATION_DISABLED");
      }
      const payload = record(envelope.payload);
      const selectedTaskTypes = taskTypes(payload.taskTypes);
      if (!selectedTaskTypes) return failure(422, "OUTBOUND_TASK_TYPES_REJECTED");

      const connection = await scopedConnection(envelope, options);
      if (isFailure(connection)) return connection;

      let transport: PosOutboundTransport;
      if (dryRun) {
        transport = unavailableTransport();
      } else {
        const credential = await agoraCredential(envelope, connection, options);
        if (!credential) return failure(503, "OUTBOUND_AGORA_CREDENTIAL_UNAVAILABLE");
        try {
          transport = await options.transport({ envelope, connection, credential });
        } catch {
          return failure(503, "OUTBOUND_TRANSPORT_UNAVAILABLE");
        }
        if (!transport || typeof transport.execute !== "function") {
          return failure(503, "OUTBOUND_TRANSPORT_UNAVAILABLE");
        }
      }

      const factory = options.adapterFactory ?? createPostgresOutboundAdapter;
      let adapter: PostgresOutboundAdapter;
      try {
        adapter = factory(
          options.database,
          transport,
          adapterOptions(envelope, connection, options, dryRun),
        );
      } catch {
        return failure(503, "OUTBOUND_ADAPTER_UNAVAILABLE");
      }

      const processInput: PostgresOutboundProcessInput = {
        taskTypes: selectedTaskTypes,
        limit: boundedLimit(payload.limit, options.maxBatchSize),
      };
      try {
        const result = await adapter.process(processInput);
        if (!result.lockAcquired) return failure(503, "OUTBOUND_DISPATCH_LOCK_BUSY");
        const summary = result.summary;
        return {
          ok: true,
          detail: [
            "outbound",
            result.dryRun ? "dry-run" : "complete",
            `claimed=${summary.claimed}`,
            `completed=${summary.completed}`,
            `retried=${summary.retried}`,
            `terminal=${summary.terminal}`,
            `blocked=${summary.blocked}`,
          ].join(":"),
        };
      } catch (error) {
        return failure(503, "OUTBOUND_PROCESS_UNAVAILABLE", {
          operation: "outbound.process",
          errorCode: "OUTBOUND_PROCESS_UNAVAILABLE",
          bodySample: error instanceof Error ? error.message : String(error ?? ""),
        });
      }
    },
  });
}
