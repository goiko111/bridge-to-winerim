import {
  isRuntimeEnvelope,
  RuntimeEnvelopeV1,
} from "../../workers/middleware-runtime/src/contracts";

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
  job: "winerim.sales-import-live";
  lane: "sales-import";
};

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

export function isEnvelopeInsideExclusiveCanaryScope(
  envelope: RuntimeEnvelopeV1,
  scope: ExclusiveCanaryScope,
): boolean {
  return envelope.connectionId === scope.connectionId
    && envelope.job === scope.job
    && envelope.lane === scope.lane
    && envelope.source.eventId.startsWith(`canary:${scope.runId}:`);
}

export function guardExclusiveCanaryBatch(
  batch: CanaryQueueBatchLike,
  scope: ExclusiveCanaryScope,
): ExclusiveScopeResult {
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
    if (!isEnvelopeInsideExclusiveCanaryScope(message.body, scope)) {
      rejectForDeadLetter(message, result.reasons, "canary_scope_mismatch");
      result.rejected += 1;
      continue;
    }
    result.accepted.push(message);
  }

  return result;
}
