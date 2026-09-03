export const RUNTIME_ENVELOPE_NAME = "winerim.middleware.runtime" as const;
export const RUNTIME_ENVELOPE_VERSION = 1 as const;
export const RUNTIME_CANARY_PLACEHOLDER_CONNECTION_ID = "00000000-0000-4000-8000-000000000000" as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isDeployableRuntimeCanaryConnectionId(value: unknown): value is string {
  const connectionId = String(value ?? "").trim();
  return UUID_PATTERN.test(connectionId)
    && connectionId !== RUNTIME_CANARY_PLACEHOLDER_CONNECTION_ID;
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type RuntimeLane =
  | "catalog"
  | "sales-stock"
  | "sales-import"
  | "stock-sync"
  | "outbound-queue"
  | "maintenance";

export type RuntimeJob =
  | "catalog.fetch-winerim"
  | "catalog.sync-master"
  | "sales.auto-sync"
  | "sales.sync-intraday"
  | "sales.sync-open-tickets"
  | "outbound.process"
  | "winerim.sales-import-live"
  | "winerim.sales-import-historical"
  | "winerim.stock-apply"
  | "maintenance.reconcile";

export type RuntimeRetryProfile =
  | "POS_OUTBOUND"
  | "WINERIM_MUTATION"
  | "CONTROL_PLANE";

export type RuntimeSource = {
  kind: "cron" | "api" | "queue";
  eventId: string;
  scheduledSlot?: string;
  trigger?: string;
};

export type RuntimeGenerationScope = {
  runId: string;
  credentialSetSha256: string;
};

export type RuntimeEnvelopeV1<TPayload extends JsonValue = JsonValue> = {
  name: typeof RUNTIME_ENVELOPE_NAME;
  version: typeof RUNTIME_ENVELOPE_VERSION;
  messageId: string;
  idempotencyKey: string;
  connectionId: string;
  lane: RuntimeLane;
  job: RuntimeJob;
  retryProfile: RuntimeRetryProfile;
  attempt: number;
  maxAttempts: number;
  createdAt: string;
  availableAt: string;
  source: RuntimeSource;
  runtimeScope?: RuntimeGenerationScope;
  payload: TPayload;
};

export type LegacyRuntimeInvocation = {
  functionName: "agora-proxy" | "winerim-proxy";
  body: {
    action: string;
    connectionId: string;
    serverLoop?: boolean;
  };
};

const JOB_LANES: Record<RuntimeJob, RuntimeLane> = {
  "catalog.fetch-winerim": "catalog",
  "catalog.sync-master": "catalog",
  "sales.auto-sync": "sales-stock",
  "sales.sync-intraday": "sales-stock",
  "sales.sync-open-tickets": "sales-stock",
  "outbound.process": "outbound-queue",
  "winerim.sales-import-live": "sales-import",
  "winerim.sales-import-historical": "sales-import",
  "winerim.stock-apply": "stock-sync",
  "maintenance.reconcile": "maintenance",
};

const JOB_RETRY_PROFILES: Record<RuntimeJob, RuntimeRetryProfile> = {
  "catalog.fetch-winerim": "CONTROL_PLANE",
  "catalog.sync-master": "POS_OUTBOUND",
  "sales.auto-sync": "POS_OUTBOUND",
  "sales.sync-intraday": "POS_OUTBOUND",
  "sales.sync-open-tickets": "POS_OUTBOUND",
  "outbound.process": "POS_OUTBOUND",
  "winerim.sales-import-live": "WINERIM_MUTATION",
  "winerim.sales-import-historical": "WINERIM_MUTATION",
  "winerim.stock-apply": "WINERIM_MUTATION",
  "maintenance.reconcile": "CONTROL_PLANE",
};

const JOB_MAX_ATTEMPTS: Record<RuntimeJob, number> = {
  "catalog.fetch-winerim": 3,
  "catalog.sync-master": 5,
  "sales.auto-sync": 5,
  "sales.sync-intraday": 5,
  "sales.sync-open-tickets": 5,
  "outbound.process": 5,
  "winerim.sales-import-live": 3,
  "winerim.sales-import-historical": 3,
  "winerim.stock-apply": 3,
  "maintenance.reconcile": 3,
};

export function runtimeLaneForJob(job: RuntimeJob): RuntimeLane {
  return JOB_LANES[job];
}

export function runtimeRetryProfileForJob(job: RuntimeJob): RuntimeRetryProfile {
  return JOB_RETRY_PROFILES[job];
}

export function runtimeMaxAttemptsForJob(job: RuntimeJob): number {
  return JOB_MAX_ATTEMPTS[job];
}

export function buildLegacyRuntimeInvocation(
  envelope: Pick<RuntimeEnvelopeV1, "job" | "connectionId">,
): LegacyRuntimeInvocation | null {
  const connectionId = envelope.connectionId;
  switch (envelope.job) {
    case "catalog.fetch-winerim":
      return {
        functionName: "winerim-proxy",
        body: { action: "fetch-catalog", connectionId },
      };
    case "catalog.sync-master":
      return {
        functionName: "agora-proxy",
        body: { action: "sync-master-data", connectionId },
      };
    case "sales.auto-sync":
      return {
        functionName: "agora-proxy",
        body: { action: "auto-sync-sales", connectionId },
      };
    case "sales.sync-intraday":
      return {
        functionName: "agora-proxy",
        body: { action: "sync-intraday-sales", connectionId },
      };
    case "sales.sync-open-tickets":
      return {
        functionName: "agora-proxy",
        body: { action: "sync-open-tickets", connectionId },
      };
    case "outbound.process":
      return {
        functionName: "agora-proxy",
        body: { action: "process-xml-outbound-queue", connectionId, serverLoop: true },
      };
    case "winerim.sales-import-live":
    case "winerim.sales-import-historical":
    case "winerim.stock-apply":
    case "maintenance.reconcile":
      return null;
  }
}

export function isRuntimeEnvelope(value: unknown): value is RuntimeEnvelopeV1 {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<RuntimeEnvelopeV1>;
  return candidate.name === RUNTIME_ENVELOPE_NAME &&
    candidate.version === RUNTIME_ENVELOPE_VERSION &&
    typeof candidate.messageId === "string" && candidate.messageId.length > 0 &&
    typeof candidate.idempotencyKey === "string" && candidate.idempotencyKey.length > 0 &&
    typeof candidate.connectionId === "string" && candidate.connectionId.length > 0 &&
    typeof candidate.job === "string" && candidate.job in JOB_LANES &&
    candidate.lane === JOB_LANES[candidate.job as RuntimeJob] &&
    candidate.retryProfile === JOB_RETRY_PROFILES[candidate.job as RuntimeJob] &&
    typeof candidate.attempt === "number" && candidate.attempt >= 0 &&
    typeof candidate.maxAttempts === "number" && candidate.maxAttempts > 0 &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.availableAt === "string" &&
    !!candidate.source &&
    ["cron", "api", "queue"].includes(candidate.source.kind ?? "") &&
    typeof candidate.source.eventId === "string" &&
    (
      candidate.runtimeScope === undefined
      || (
        typeof candidate.runtimeScope.runId === "string"
        && typeof candidate.runtimeScope.credentialSetSha256 === "string"
      )
    );
}
