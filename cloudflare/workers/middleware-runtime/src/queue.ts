import { isRuntimeEnvelope, RuntimeEnvelopeV1 } from "./contracts";
import {
  decideRuntimeQueueDisposition,
  RuntimeFailureInput,
  RuntimeQueueDisposition,
} from "./retry";

const POISON_RETRY_DELAY_SECONDS = 300;

export type CloudflareQueueMessageLike<TBody = unknown> = {
  readonly id: string;
  readonly attempts: number;
  readonly body: TBody;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
};

export type CloudflareMessageBatchLike<TBody = unknown> = {
  readonly queue: string;
  readonly messages: readonly CloudflareQueueMessageLike<TBody>[];
};

export type IdempotencyReservation = "acquired" | "duplicate" | "busy" | "conflict";

export type RuntimeExecutionResult =
  | { ok: true; detail?: string }
  | { ok: false; failure: Omit<RuntimeFailureInput, "profile"> };

export type RuntimeQueueHooks = {
  reserve(envelope: RuntimeEnvelopeV1): Promise<IdempotencyReservation>;
  execute(envelope: RuntimeEnvelopeV1): Promise<RuntimeExecutionResult>;
  complete(envelope: RuntimeEnvelopeV1, result: Extract<RuntimeExecutionResult, { ok: true }>): Promise<void>;
  releaseForRetry(envelope: RuntimeEnvelopeV1, disposition: Extract<RuntimeQueueDisposition, { action: "retry" }>): Promise<void>;
  releaseForDeadLetter(envelope: RuntimeEnvelopeV1, input: {
    messageId: string;
    reason: "attempts_exhausted";
    disposition: Extract<RuntimeQueueDisposition, { action: "terminal" }>;
  }): Promise<void>;
  recordTerminal(envelope: RuntimeEnvelopeV1 | null, input: {
    messageId: string;
    reason: string;
    disposition?: Extract<RuntimeQueueDisposition, { action: "terminal" }>;
  }): Promise<void>;
};

export type RuntimeBatchSummary = {
  received: number;
  acknowledged: number;
  duplicates: number;
  retried: number;
  terminal: number;
  invalid: number;
};

export async function consumeRuntimeQueueBatch(
  batch: CloudflareMessageBatchLike,
  hooks: RuntimeQueueHooks,
): Promise<RuntimeBatchSummary> {
  const summary: RuntimeBatchSummary = {
    received: batch.messages.length,
    acknowledged: 0,
    duplicates: 0,
    retried: 0,
    terminal: 0,
    invalid: 0,
  };

  for (const message of batch.messages) {
    if (!isRuntimeEnvelope(message.body)) {
      await hooks.recordTerminal(null, { messageId: message.id, reason: "invalid_runtime_envelope" });
      // Let the configured Queue retry limit route poison messages into the
      // DLQ. Never persist or log their potentially sensitive body.
      message.retry({ delaySeconds: POISON_RETRY_DELAY_SECONDS });
      summary.retried++;
      summary.invalid++;
      continue;
    }

    const envelope = message.body;
    const reservation = await hooks.reserve(envelope);
    if (reservation === "duplicate") {
      message.ack();
      summary.acknowledged++;
      summary.duplicates++;
      continue;
    }
    if (reservation === "busy") {
      message.retry({ delaySeconds: 5 });
      summary.retried++;
      continue;
    }
    if (reservation === "conflict") {
      // A different immutable identity owns the key. Back off and let the
      // configured Queue retry budget move it to the DLQ without executing.
      message.retry({ delaySeconds: POISON_RETRY_DELAY_SECONDS });
      summary.retried++;
      continue;
    }

    let result: RuntimeExecutionResult;
    try {
      result = await hooks.execute(envelope);
    } catch (error) {
      result = {
        ok: false,
        failure: { message: error instanceof Error ? error.message : String(error) },
      };
    }

    if (result.ok) {
      await hooks.complete(envelope, result);
      message.ack();
      summary.acknowledged++;
      continue;
    }

    const disposition = decideRuntimeQueueDisposition({
      envelope,
      deliveryAttempts: message.attempts,
      failure: { ...result.failure, profile: envelope.retryProfile },
    });
    if (disposition.action === "retry") {
      await hooks.releaseForRetry(envelope, disposition);
      message.retry({ delaySeconds: disposition.delaySeconds });
      summary.retried++;
      continue;
    }

    if (disposition.action === "terminal") {
      if (disposition.reason === "attempts_exhausted") {
        // A final retry hands the message to the platform DLQ. Recording a
        // terminal idempotency row first would make a redelivery look like an
        // acknowledged duplicate and bypass that DLQ transition.
        await hooks.releaseForDeadLetter(envelope, {
          messageId: message.id,
          reason: "attempts_exhausted",
          disposition,
        });
        message.retry();
        summary.retried++;
        continue;
      }
      await hooks.recordTerminal(envelope, {
        messageId: message.id,
        reason: disposition.reason,
        disposition,
      });
      message.ack();
      summary.acknowledged++;
      summary.terminal++;
    }
  }

  return summary;
}
