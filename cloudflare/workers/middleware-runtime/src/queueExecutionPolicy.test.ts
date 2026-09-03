import { describe, expect, it, vi } from "vitest";

import type { RuntimeEnvelopeV1 } from "./contracts";
import {
  BUSY_RETRY_DELAY_SECONDS,
  consumeRuntimeQueueBatch,
  type RuntimeQueueHooks,
} from "./queue";

function envelope(
  idempotencyKey: string,
  connectionId = "1c5177f1-9459-4ee9-8b6e-4780f8b6b96b",
): RuntimeEnvelopeV1 {
  return {
    name: "winerim.middleware.runtime",
    version: 1,
    messageId: `message-${idempotencyKey}`,
    idempotencyKey,
    connectionId,
    lane: "catalog",
    job: "catalog.sync-master",
    retryProfile: "POS_OUTBOUND",
    attempt: 0,
    maxAttempts: 5,
    createdAt: "2026-09-02T20:00:00.000Z",
    availableAt: "2026-09-02T20:00:00.000Z",
    source: { kind: "queue", eventId: `event-${idempotencyKey}` },
    payload: {},
  };
}

function hooks(overrides: Partial<RuntimeQueueHooks>): RuntimeQueueHooks {
  return {
    reserve: vi.fn(async () => "acquired"),
    execute: vi.fn(async () => ({ ok: true })),
    complete: vi.fn(async () => undefined),
    releaseForRetry: vi.fn(async () => undefined),
    releaseForDeadLetter: vi.fn(async () => undefined),
    recordTerminal: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("runtime queue execution policy", () => {
  it("lets a healthy connection complete while another connection is slow", async () => {
    let releaseSlow = () => undefined;
    const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve; });
    const slow = {
      id: "cf-slow",
      attempts: 1,
      body: envelope("slow", "11111111-1111-4111-8111-111111111111"),
      ack: vi.fn(),
      retry: vi.fn(),
    };
    const fast = {
      id: "cf-fast",
      attempts: 1,
      body: envelope("fast", "22222222-2222-4222-8222-222222222222"),
      ack: vi.fn(),
      retry: vi.fn(),
    };
    const execute = vi.fn(async (value: RuntimeEnvelopeV1) => {
      if (value.connectionId === slow.body.connectionId) await slowGate;
      return { ok: true as const };
    });

    const consuming = consumeRuntimeQueueBatch(
      { queue: "runtime-catalog", messages: [slow, fast] },
      hooks({ execute }),
    );

    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(fast.ack).toHaveBeenCalledOnce());
    expect(slow.ack).not.toHaveBeenCalled();
    releaseSlow();
    await consuming;
    expect(slow.ack).toHaveBeenCalledOnce();
  });

  it("keeps messages for one connection strictly ordered", async () => {
    let releaseFirst = () => undefined;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const executionOrder: string[] = [];
    const first = {
      id: "cf-first",
      attempts: 1,
      body: envelope("first"),
      ack: vi.fn(),
      retry: vi.fn(),
    };
    const second = {
      id: "cf-second",
      attempts: 1,
      body: envelope("second"),
      ack: vi.fn(),
      retry: vi.fn(),
    };
    const execute = vi.fn(async (value: RuntimeEnvelopeV1) => {
      executionOrder.push(value.idempotencyKey);
      if (value.idempotencyKey === "first") await firstGate;
      return { ok: true as const };
    });

    const consuming = consumeRuntimeQueueBatch(
      { queue: "runtime-catalog", messages: [first, second] },
      hooks({ execute }),
    );

    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    expect(executionOrder).toEqual(["first"]);
    releaseFirst();
    await consuming;
    expect(executionOrder).toEqual(["first", "second"]);
  });

  it("backs off a busy same-connection job without executing it", async () => {
    const retry = vi.fn();
    const runtimeHooks = hooks({ reserve: vi.fn(async () => "busy") });

    const summary = await consumeRuntimeQueueBatch({
      queue: "runtime-catalog",
      messages: [{
        id: "cf-busy",
        attempts: 1,
        body: envelope("catalog-slot-busy"),
        ack: vi.fn(),
        retry,
      }],
    }, runtimeHooks);

    expect(retry).toHaveBeenCalledWith({ delaySeconds: BUSY_RETRY_DELAY_SECONDS });
    expect(runtimeHooks.execute).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ received: 1, acknowledged: 0, retried: 1 });
  });

  it("keeps the immutable idempotency key across a retry", async () => {
    const retry = vi.fn();
    const releaseForRetry = vi.fn(async () => undefined);
    const body = envelope("catalog-slot-retry");
    const runtimeHooks = hooks({
      execute: vi.fn(async () => ({
        ok: false,
        failure: { httpStatus: 503, message: "AGORA_READBACK_HTTP_503" },
      })),
      releaseForRetry,
    });

    await consumeRuntimeQueueBatch({
      queue: "runtime-catalog",
      messages: [{ id: "cf-retry", attempts: 1, body, ack: vi.fn(), retry }],
    }, runtimeHooks);

    expect(releaseForRetry).toHaveBeenCalledOnce();
    expect(releaseForRetry.mock.calls[0]?.[0].idempotencyKey).toBe("catalog-slot-retry");
    expect(body.idempotencyKey).toBe("catalog-slot-retry");
    expect(retry).toHaveBeenCalledWith({ delaySeconds: 120 });
  });
});
