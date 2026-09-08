import {
  JsonValue,
  RUNTIME_ENVELOPE_NAME,
  RUNTIME_ENVELOPE_VERSION,
  RuntimeEnvelopeV1,
  RuntimeJob,
  RuntimeSource,
  runtimeLaneForJob,
  runtimeMaxAttemptsForJob,
  runtimeRetryProfileForJob,
} from "./contracts";

export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;

  const object = value as Record<string, JsonValue>;
  const entries = Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`);
  return `{${entries.join(",")}}`;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function buildRuntimeIdempotencyKey(input: {
  connectionId: string;
  job: RuntimeJob;
  dedupeScope: string;
  payload: JsonValue;
}): Promise<string> {
  const material = canonicalJson({
    version: RUNTIME_ENVELOPE_VERSION,
    connectionId: input.connectionId,
    job: input.job,
    dedupeScope: input.dedupeScope,
    payload: input.payload,
  });
  return `idem:v1:${await sha256Hex(material)}`;
}

export async function createRuntimeEnvelope<TPayload extends JsonValue>(input: {
  connectionId: string;
  job: RuntimeJob;
  dedupeScope: string;
  payload?: TPayload;
  source: RuntimeSource;
  createdAt: string;
  availableAt?: string;
  maxAttempts?: number;
}): Promise<RuntimeEnvelopeV1<TPayload>> {
  const payload = (input.payload ?? {}) as TPayload;
  const idempotencyKey = await buildRuntimeIdempotencyKey({
    connectionId: input.connectionId,
    job: input.job,
    dedupeScope: input.dedupeScope,
    payload,
  });

  return {
    name: RUNTIME_ENVELOPE_NAME,
    version: RUNTIME_ENVELOPE_VERSION,
    messageId: `msg_${idempotencyKey.slice("idem:v1:".length, 40)}`,
    idempotencyKey,
    connectionId: input.connectionId,
    lane: runtimeLaneForJob(input.job),
    job: input.job,
    retryProfile: runtimeRetryProfileForJob(input.job),
    attempt: 0,
    maxAttempts: input.maxAttempts ?? runtimeMaxAttemptsForJob(input.job),
    createdAt: input.createdAt,
    availableAt: input.availableAt ?? input.createdAt,
    source: input.source,
    payload,
  };
}
