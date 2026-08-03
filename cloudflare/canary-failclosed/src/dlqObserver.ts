import { isRuntimeEnvelope } from "../../workers/middleware-runtime/src/contracts";
import { CanaryQueueBatchLike, CanaryQueueMessageLike } from "./exclusiveScope";
import { sha256Hex } from "./writerFence";

type R2BucketLike = {
  put(
    key: string,
    value: string,
    options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> },
  ): Promise<unknown>;
};

type QueueProducerLike = { send(body: unknown): Promise<void> };

export type CanaryDlqObserverEnvironment = {
  CANARY_DLQ_ARCHIVE: R2BucketLike;
  CANARY_DLQ_ALERTS: QueueProducerLike;
  CANARY_DLQ_QUEUE_NAME: string;
  CANARY_ALARM_QUEUE_NAME: string;
};

type CanaryDlqAlarmV1 = {
  version: 1;
  event: "canary_dlq_message";
  messageId: string;
  queue: string;
  attempts: number;
  bodySha256: string;
  connectionId: string | null;
  runEventId: string | null;
  observedAt: string;
  archiveKey: string;
};

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 160) || "unknown";
}

async function bodyDigest(body: unknown): Promise<string> {
  try {
    return sha256Hex(JSON.stringify(body));
  } catch {
    return sha256Hex("unserializable");
  }
}

async function alarmFor(
  queue: string,
  message: CanaryQueueMessageLike,
  observedAt: string,
): Promise<CanaryDlqAlarmV1> {
  const envelope = isRuntimeEnvelope(message.body) ? message.body : null;
  const archiveKey = [
    "dlq",
    observedAt.slice(0, 10),
    `${safeSegment(observedAt)}-${safeSegment(message.id)}.json`,
  ].join("/");
  return {
    version: 1,
    event: "canary_dlq_message",
    messageId: message.id,
    queue,
    attempts: message.attempts,
    bodySha256: await bodyDigest(message.body),
    connectionId: envelope?.connectionId ?? null,
    runEventId: envelope?.source.eventId ?? null,
    observedAt,
    archiveKey,
  };
}

async function archiveDlqMessage(
  env: CanaryDlqObserverEnvironment,
  queue: string,
  message: CanaryQueueMessageLike,
): Promise<void> {
  const alarm = await alarmFor(queue, message, new Date().toISOString());
  await env.CANARY_DLQ_ARCHIVE.put(alarm.archiveKey, JSON.stringify(alarm), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: {
      event: alarm.event,
      queue: safeSegment(queue),
      bodySha256: alarm.bodySha256,
    },
  });
  await env.CANARY_DLQ_ALERTS.send(alarm);
}

async function archiveAlarm(
  env: CanaryDlqObserverEnvironment,
  message: CanaryQueueMessageLike,
): Promise<void> {
  const body = message.body as Partial<CanaryDlqAlarmV1>;
  if (body.version !== 1 || body.event !== "canary_dlq_message" || typeof body.bodySha256 !== "string") {
    throw new Error("CANARY_DLQ_ALARM_INVALID");
  }
  const key = `alarms/${safeSegment(body.observedAt ?? new Date().toISOString())}-${safeSegment(message.id)}.json`;
  await env.CANARY_DLQ_ARCHIVE.put(key, JSON.stringify(body), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { event: "canary_dlq_alarm", bodySha256: body.bodySha256 },
  });
  console.error(JSON.stringify({
    event: "canary_dlq_alarm",
    messageId: body.messageId,
    connectionId: body.connectionId ?? null,
    bodySha256: body.bodySha256,
    observedAt: body.observedAt,
  }));
}

export async function observeCanaryDlqBatch(
  batch: CanaryQueueBatchLike,
  env: CanaryDlqObserverEnvironment,
): Promise<void> {
  for (const message of batch.messages) {
    try {
      if (batch.queue === env.CANARY_DLQ_QUEUE_NAME) {
        await archiveDlqMessage(env, batch.queue, message);
      } else if (batch.queue === env.CANARY_ALARM_QUEUE_NAME) {
        await archiveAlarm(env, message);
      } else {
        throw new Error("CANARY_DLQ_UNEXPECTED_PHYSICAL_QUEUE");
      }
      message.ack();
    } catch {
      // Archive and alarm delivery are both part of acknowledgement. Any
      // partial failure must retry and must remain visible in Queue metrics.
      message.retry({ delaySeconds: 60 });
    }
  }
}

export default {
  async queue(
    batch: CanaryQueueBatchLike,
    env: CanaryDlqObserverEnvironment,
  ): Promise<void> {
    await observeCanaryDlqBatch(batch, env);
  },
};
