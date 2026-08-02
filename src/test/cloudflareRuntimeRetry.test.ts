import { describe, expect, it, vi } from "vitest";
import {
  classifyRuntimeFailure,
  consumeRuntimeQueueBatch,
  createRuntimeEnvelope,
  decideRuntimeQueueDisposition,
  retryDelaySeconds,
  RuntimeQueueHooks,
} from "../../cloudflare/workers/middleware-runtime/src";

async function envelope(maxAttempts = 5) {
  return createRuntimeEnvelope({
    connectionId: "connection-a",
    job: "outbound.process",
    dedupeScope: "task:1",
    source: { kind: "queue", eventId: "task-1" },
    payload: { taskId: "task-1" },
    createdAt: "2026-08-02T10:00:00.000Z",
    maxAttempts,
  });
}

describe("Cloudflare runtime retry policy", () => {
  it("preserves current POS error and breaker semantics", () => {
    expect(classifyRuntimeFailure({
      profile: "POS_OUTBOUND",
      message: "TCP connect error: timed out",
    })).toMatchObject({ class: "POS_DOWN", retryable: true, countsForCircuitBreaker: true });
    expect(classifyRuntimeFailure({
      profile: "POS_OUTBOUND",
      httpStatus: 503,
    })).toMatchObject({ class: "POS_OVERLOADED", retryable: true, countsForCircuitBreaker: true });
    expect(classifyRuntimeFailure({
      profile: "POS_OUTBOUND",
      httpStatus: 409,
    })).toMatchObject({ class: "BUSINESS_ERROR", retryable: false, countsForCircuitBreaker: false });
  });

  it("treats Winerim live-sale conflicts and retryable lines as transient", () => {
    expect(classifyRuntimeFailure({
      profile: "WINERIM_MUTATION",
      httpStatus: 409,
    })).toMatchObject({ class: "WINERIM_CONFLICT", retryable: true });
    expect(classifyRuntimeFailure({
      profile: "WINERIM_MUTATION",
      retryableLine: true,
    })).toMatchObject({ class: "TRANSIENT_UPSTREAM", retryable: true });
    expect(retryDelaySeconds("WINERIM_MUTATION", 2)).toBe(1);
    expect(classifyRuntimeFailure({
      profile: "WINERIM_MUTATION",
      httpStatus: 422,
      retryableLine: true,
    })).toMatchObject({ class: "BUSINESS_ERROR", retryable: false });
  });

  it("uses the existing outbound exponential schedule and stops at the cap", () => {
    expect([1, 2, 3, 4, 5, 6].map((attempt) => retryDelaySeconds("POS_OUTBOUND", attempt)))
      .toEqual([120, 240, 480, 960, 1920, 3600]);
  });

  it("stops retrying at the envelope maximum", async () => {
    const message = await envelope(3);
    expect(decideRuntimeQueueDisposition({
      envelope: message,
      deliveryAttempts: 2,
      failure: { profile: "POS_OUTBOUND", httpStatus: 503 },
    })).toMatchObject({ action: "retry", delaySeconds: 240 });
    expect(decideRuntimeQueueDisposition({
      envelope: message,
      deliveryAttempts: 3,
      failure: { profile: "POS_OUTBOUND", httpStatus: 503 },
    })).toMatchObject({ action: "terminal", reason: "attempts_exhausted" });
  });

  it("acks duplicates and retries failures without changing the envelope key", async () => {
    const firstEnvelope = await envelope();
    const secondEnvelope = await envelope();
    const first = { id: "cf-1", attempts: 1, body: firstEnvelope, ack: vi.fn(), retry: vi.fn() };
    const second = { id: "cf-2", attempts: 1, body: secondEnvelope, ack: vi.fn(), retry: vi.fn() };
    const hooks: RuntimeQueueHooks = {
      reserve: vi.fn(async (value) => value.messageId === firstEnvelope.messageId ? "duplicate" : "acquired"),
      execute: vi.fn(async () => ({ ok: false, failure: { httpStatus: 503 } })),
      complete: vi.fn(async () => undefined),
      releaseForRetry: vi.fn(async () => undefined),
      recordTerminal: vi.fn(async () => undefined),
    };

    // Give the second message a distinct logical task while preserving its key on retry.
    second.body = await createRuntimeEnvelope({
      connectionId: "connection-a",
      job: "outbound.process",
      dedupeScope: "task:2",
      source: { kind: "queue", eventId: "task-2" },
      payload: { taskId: "task-2" },
      createdAt: "2026-08-02T10:00:00.000Z",
    });
    const retryKey = second.body.idempotencyKey;

    const summary = await consumeRuntimeQueueBatch({ queue: "runtime", messages: [first, second] }, hooks);

    expect(first.ack).toHaveBeenCalledOnce();
    expect(second.retry).toHaveBeenCalledWith({ delaySeconds: 120 });
    expect(second.body.idempotencyKey).toBe(retryKey);
    expect(summary).toMatchObject({ received: 2, duplicates: 1, retried: 1 });
  });

  it("routes poison envelopes toward the configured DLQ without acknowledging their body", async () => {
    const message = {
      id: "poison-message",
      attempts: 1,
      body: { token: "must-never-be-logged" },
      ack: vi.fn(),
      retry: vi.fn(),
    };
    const hooks: RuntimeQueueHooks = {
      reserve: vi.fn(),
      execute: vi.fn(),
      complete: vi.fn(),
      releaseForRetry: vi.fn(),
      recordTerminal: vi.fn(async () => undefined),
    };

    const summary = await consumeRuntimeQueueBatch({ queue: "runtime", messages: [message] }, hooks);

    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 300 });
    expect(hooks.recordTerminal).toHaveBeenCalledWith(null, {
      messageId: "poison-message",
      reason: "invalid_runtime_envelope",
    });
    expect(JSON.stringify(vi.mocked(hooks.recordTerminal).mock.calls)).not.toContain("must-never-be-logged");
    expect(summary).toMatchObject({ invalid: 1, retried: 1, acknowledged: 0, terminal: 0 });
  });

  it("does not acknowledge exhausted transient failures so the platform DLQ can receive them", async () => {
    const body = await createRuntimeEnvelope({
      connectionId: "connection-a",
      job: "winerim.stock-apply",
      dedupeScope: "stock:exhausted",
      source: { kind: "queue", eventId: "stock-exhausted" },
      payload: { dryRun: true },
      createdAt: "2026-08-02T10:00:00.000Z",
      maxAttempts: 3,
    });
    const message = {
      id: "exhausted-message",
      attempts: 3,
      body,
      ack: vi.fn(),
      retry: vi.fn(),
    };
    const hooks: RuntimeQueueHooks = {
      reserve: vi.fn(async () => "acquired" as const),
      execute: vi.fn(async () => ({ ok: false as const, failure: { httpStatus: 503 } })),
      complete: vi.fn(),
      releaseForRetry: vi.fn(),
      recordTerminal: vi.fn(),
    };

    const summary = await consumeRuntimeQueueBatch({ queue: "runtime", messages: [message] }, hooks);

    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledWith();
    expect(hooks.releaseForRetry).not.toHaveBeenCalled();
    expect(hooks.recordTerminal).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ retried: 1, acknowledged: 0, terminal: 0 });
  });
});
