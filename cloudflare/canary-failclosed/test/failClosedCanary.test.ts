import { describe, expect, it, vi } from "vitest";

import { RuntimeEnvelopeV1 } from "../../workers/middleware-runtime/src/contracts";
import { observeCanaryDlqBatch } from "../src/dlqObserver";
import {
  CanaryQueueMessageLike,
  guardExclusiveCanaryBatch,
} from "../src/exclusiveScope";
import {
  acquireExclusiveWriterFence,
  parseWriterFenceGrant,
  sha256Hex,
  validateWriterFenceGrant,
  WriterFenceGrantV1,
} from "../src/writerFence";

const connectionId = "11111111-1111-4111-8111-111111111111";
const runId = "run-20260803-a";
const queueName = `winerim-rescue-prod-canary-${runId}`;

function envelope(overrides: Partial<RuntimeEnvelopeV1> = {}): RuntimeEnvelopeV1 {
  return {
    name: "winerim.middleware.runtime",
    version: 1,
    messageId: "message-1",
    idempotencyKey: "idem-1",
    connectionId,
    lane: "sales-import",
    job: "winerim.sales-import-live",
    retryProfile: "WINERIM_MUTATION",
    attempt: 0,
    maxAttempts: 3,
    createdAt: "2026-08-03T06:00:00.000Z",
    availableAt: "2026-08-03T06:00:00.000Z",
    source: { kind: "queue", eventId: `canary:${runId}:sale-1` },
    payload: {},
    ...overrides,
  };
}

function message(body: unknown = envelope()): CanaryQueueMessageLike & {
  ack: ReturnType<typeof vi.fn>;
  retry: ReturnType<typeof vi.fn>;
} {
  return { id: "queue-message-1", attempts: 1, body, ack: vi.fn(), retry: vi.fn() };
}

const scope = {
  queueName,
  connectionId,
  runId,
  job: "winerim.sales-import-live" as const,
  lane: "sales-import" as const,
};

describe("exclusive physical canary queue", () => {
  it("accepts only the exact physical queue, connection, lane, job and run", () => {
    const accepted = message();
    const result = guardExclusiveCanaryBatch({ queue: queueName, messages: [accepted] }, scope);
    expect(result.accepted).toEqual([accepted]);
    expect(result.rejected).toBe(0);
    expect(accepted.ack).not.toHaveBeenCalled();
    expect(accepted.retry).not.toHaveBeenCalled();
  });

  it("never acknowledges an out-of-scope connection", () => {
    const foreign = message(envelope({ connectionId: "22222222-2222-4222-8222-222222222222" }));
    const result = guardExclusiveCanaryBatch({ queue: queueName, messages: [foreign] }, scope);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toBe(1);
    expect(foreign.ack).not.toHaveBeenCalled();
    expect(foreign.retry).toHaveBeenCalledTimes(1);
  });

  it("routes a physical queue mismatch toward DLQ instead of dropping it", () => {
    const foreign = message();
    guardExclusiveCanaryBatch({ queue: "winerim-rescue-prod-sales", messages: [foreign] }, scope);
    expect(foreign.ack).not.toHaveBeenCalled();
    expect(foreign.retry).toHaveBeenCalledWith({ delaySeconds: 300 });
  });
});

describe("connection writer fence", () => {
  it("fails closed without the lease service or exclusive proof binding", async () => {
    await expect(acquireExclusiveWriterFence({
      env: {}, connectionId, runId, holderId: "deploy-a",
    })).rejects.toThrow("WRITER_FENCE_SERVICE_BINDING_MISSING");
    await expect(acquireExclusiveWriterFence({
      env: { WRITER_FENCE: { fetch: vi.fn() } }, connectionId, runId, holderId: "deploy-a",
    })).rejects.toThrow("WRITER_FENCE_EXCLUSIVE_CREDENTIAL_BINDING_MISSING");
  });

  it("fails closed when the connection lease is denied", async () => {
    await expect(acquireExclusiveWriterFence({
      env: {
        WRITER_FENCE: { fetch: vi.fn(async () => new Response("held", { status: 409 })) },
        CANARY_WRITER_FENCE_PROOF: { get: vi.fn(async () => "x".repeat(40)) },
      },
      connectionId,
      runId,
      holderId: "deploy-a",
    })).rejects.toThrow("WRITER_FENCE_LEASE_DENIED_409");
  });

  it("accepts a valid unexpired lease response", async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const lease = await acquireExclusiveWriterFence({
      env: {
        WRITER_FENCE: {
          fetch: vi.fn(async () => Response.json({
            connectionId,
            runId,
            holderId: "deploy-a",
            fencingToken: 7,
            credentialVersion: "rotated-v2",
            expiresAt,
          })),
        },
        CANARY_WRITER_FENCE_PROOF: { get: vi.fn(async () => "x".repeat(40)) },
      },
      connectionId,
      runId,
      holderId: "deploy-a",
    });
    expect(lease.fencingToken).toBe(7);
  });

  it("requires evidence that the legacy writer credential is revoked", async () => {
    const proof = "proof-only-known-by-the-new-runtime-1234567890";
    const grant: WriterFenceGrantV1 = {
      version: 1,
      connectionId,
      runId,
      holderId: "deploy-a",
      proofSha256: await sha256Hex(proof),
      exclusiveCredentialRef: "cloudflare-secrets-store://store/new-provider-token",
      credentialVersion: "rotated-v2",
      legacyWriter: {
        revokedAt: "2026-08-03T05:59:00.000Z",
        negativeProbeStatus: 401,
        evidenceSha256: "a".repeat(64),
      },
      issuedAt: "2026-08-03T06:00:00.000Z",
      expiresAt: "2026-08-03T07:00:00.000Z",
    };
    await expect(validateWriterFenceGrant({
      grant,
      proof,
      connectionId,
      runId,
      holderId: "deploy-a",
      nowMs: Date.parse("2026-08-03T06:30:00.000Z"),
    })).resolves.toBeUndefined();

    expect(() => parseWriterFenceGrant(JSON.stringify({
      ...grant,
      legacyWriter: { ...grant.legacyWriter, negativeProbeStatus: 200 },
    }))).toThrow("WRITER_FENCE_GRANT_LEGACY_NEGATIVE_PROBE_REQUIRED");
    expect(() => parseWriterFenceGrant(JSON.stringify({
      ...grant,
      exclusiveCredentialRef: "same-token-used-by-lovable",
    }))).toThrow("WRITER_FENCE_GRANT_EXCLUSIVE_CREDENTIAL_REQUIRED");
  });
});

describe("observable canary DLQ", () => {
  it("acknowledges only after archive and alarm enqueue both succeed", async () => {
    const dlqMessage = message();
    const archive = vi.fn(async () => ({}));
    const send = vi.fn(async () => undefined);
    await observeCanaryDlqBatch(
      { queue: `${queueName}-dlq`, messages: [dlqMessage] },
      {
        CANARY_DLQ_ARCHIVE: { put: archive },
        CANARY_DLQ_ALERTS: { send },
        CANARY_DLQ_QUEUE_NAME: `${queueName}-dlq`,
        CANARY_ALARM_QUEUE_NAME: `${queueName}-alarms`,
      },
    );
    expect(archive).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(dlqMessage.ack).toHaveBeenCalledTimes(1);
    expect(dlqMessage.retry).not.toHaveBeenCalled();
  });

  it("retries and never acknowledges when the archive or alarm path fails", async () => {
    const dlqMessage = message();
    await observeCanaryDlqBatch(
      { queue: `${queueName}-dlq`, messages: [dlqMessage] },
      {
        CANARY_DLQ_ARCHIVE: { put: vi.fn(async () => { throw new Error("r2 unavailable"); }) },
        CANARY_DLQ_ALERTS: { send: vi.fn(async () => undefined) },
        CANARY_DLQ_QUEUE_NAME: `${queueName}-dlq`,
        CANARY_ALARM_QUEUE_NAME: `${queueName}-alarms`,
      },
    );
    expect(dlqMessage.ack).not.toHaveBeenCalled();
    expect(dlqMessage.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
  });
});
