import {
  isRuntimeEnvelope,
  RuntimeJob,
  RuntimeLane,
  RuntimeEnvelopeV1,
} from "../../workers/middleware-runtime/src/contracts";
import { sha256Hex } from "./writerFence";

const OUT_OF_SCOPE_RETRY_DELAY_SECONDS = 300;

export type CanaryQueueMessageLike = {
  readonly id: string;
  readonly attempts: number;
  readonly body: unknown;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
};

export type CanaryQueueBatchLike = {
  readonly queue: string;
  readonly messages: readonly CanaryQueueMessageLike[];
};

export type ExclusiveCanaryScope = {
  queueName: string;
  connectionId: string;
  runId: string;
  messageId: string;
  idempotencyKey: string;
  payloadSha256: string;
  job: ExclusiveCanaryJob;
  lane: ExclusiveCanaryLane;
};

export type ExclusiveCanaryJob = "winerim.sales-import-live" | "catalog.sync-master";
export type ExclusiveCanaryLane = "sales-import" | "catalog";

export const DEFAULT_EXCLUSIVE_CANARY_JOB = "winerim.sales-import-live" as const;
export const DEFAULT_EXCLUSIVE_CANARY_LANE = "sales-import" as const;

const EXCLUSIVE_CANARY_JOB_LANES: Readonly<Record<ExclusiveCanaryJob, ExclusiveCanaryLane>> =
  Object.freeze({
    "winerim.sales-import-live": "sales-import",
    "catalog.sync-master": "catalog",
  });

export function resolveExclusiveCanaryJobLane(
  jobValue: unknown,
  laneValue: unknown,
): Readonly<{ job: ExclusiveCanaryJob; lane: ExclusiveCanaryLane }> | null {
  const rawJob = String(jobValue ?? "").trim();
  const rawLane = String(laneValue ?? "").trim();
  const job = (rawJob || DEFAULT_EXCLUSIVE_CANARY_JOB) as RuntimeJob;
  const expectedLane = EXCLUSIVE_CANARY_JOB_LANES[job as ExclusiveCanaryJob];
  if (!expectedLane) return null;
  const lane = (rawLane || expectedLane) as RuntimeLane;
  return lane === expectedLane
    ? { job: job as ExclusiveCanaryJob, lane: lane as ExclusiveCanaryLane }
    : null;
}

export type ExclusiveScopeResult = {
  accepted: CanaryQueueMessageLike[];
  rejected: number;
  reasons: Record<string, number>;
};

function rejectForDeadLetter(
  message: CanaryQueueMessageLike,
  reasons: Record<string, number>,
  reason: string,
): void {
  reasons[reason] = (reasons[reason] ?? 0) + 1;
  // Out-of-scope messages must reach the physical Queue DLQ. Acknowledging
  // them would silently discard work belonging to another connection.
  message.retry({ delaySeconds: OUT_OF_SCOPE_RETRY_DELAY_SECONDS });
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${stableStringify(record[key])}`
  )).join(",")}}`;
}

export async function runtimePayloadSha256(payload: unknown): Promise<string> {
  return sha256Hex(stableStringify(payload));
}

export async function isEnvelopeInsideExclusiveCanaryScope(
  envelope: RuntimeEnvelopeV1,
  scope: ExclusiveCanaryScope,
): Promise<boolean> {
  return envelope.connectionId === scope.connectionId
    && envelope.job === scope.job
    && envelope.lane === scope.lane
    && envelope.messageId === scope.messageId
    && envelope.idempotencyKey === scope.idempotencyKey
    && envelope.source.eventId === `canary:${scope.runId}:${scope.messageId}`
    && await runtimePayloadSha256(envelope.payload) === scope.payloadSha256;
}

export async function guardExclusiveCanaryBatch(
  batch: CanaryQueueBatchLike,
  scope: ExclusiveCanaryScope,
): Promise<ExclusiveScopeResult> {
  const result: ExclusiveScopeResult = { accepted: [], rejected: 0, reasons: {} };

  if (batch.queue !== scope.queueName) {
    for (const message of batch.messages) {
      rejectForDeadLetter(message, result.reasons, "physical_queue_mismatch");
      result.rejected += 1;
    }
    return result;
  }

  for (const message of batch.messages) {
    if (!isRuntimeEnvelope(message.body)) {
      rejectForDeadLetter(message, result.reasons, "invalid_runtime_envelope");
      result.rejected += 1;
      continue;
    }
    if (!await isEnvelopeInsideExclusiveCanaryScope(message.body, scope)) {
      rejectForDeadLetter(message, result.reasons, "canary_scope_mismatch");
      result.rejected += 1;
      continue;
    }
    result.accepted.push(message);
  }

  return result;
}
