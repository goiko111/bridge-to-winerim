import { describe, expect, it } from "vitest";
import {
  buildOutboundClaimPlan,
  decideOutboundTask,
  DEFAULT_OUTBOUND_BREAKER_POLICY,
  DEFAULT_OUTBOUND_RATE_LIMITER_PLAN,
  isOutboundBreakerOpen,
  nextSlidingWindowPermit,
  outboundRateLimitKey,
  reduceOutboundBreaker,
  sanitizeOutboundLog,
  sanitizeOutboundValue,
  type OutboundBreakerState,
  type OutboundTask,
} from "../../cloudflare/workers/middleware-runtime/src/handlers/outbound";

function task(overrides: Partial<OutboundTask> = {}): OutboundTask {
  return {
    id: "task-1",
    connectionId: "connection-1",
    provider: "agora",
    taskType: "UPSERT_PRODUCT",
    payload: { productId: "710280" },
    status: "RUNNING",
    attempts: 1,
    maxAttempts: 5,
    createdAt: "2026-08-02T10:00:00.000Z",
    ...overrides,
  };
}

describe("provider-neutral outbound contracts", () => {
  it("builds the atomic oldest-first claim plan and clamps its batch", () => {
    expect(buildOutboundClaimPlan({
      connectionId: " connection-1 ",
      provider: " agora ",
      taskTypes: ["UPSERT_PRODUCT", "UPSERT_PRODUCT", "HIDE_PRODUCT"],
      limit: 500,
      readyAt: "2026-08-02T10:00:00.000Z",
    })).toEqual({
      connectionId: "connection-1",
      provider: "agora",
      taskTypes: ["HIDE_PRODUCT", "UPSERT_PRODUCT"],
      limit: 100,
      readyAt: "2026-08-02T10:00:00.000Z",
      fromStatus: "QUEUED",
      toStatus: "RUNNING",
      incrementAttempts: true,
      locking: "FOR_UPDATE_SKIP_LOCKED",
      orderBy: ["next_retry_at", "created_at", "id"],
    });
  });

  it("requires exact verified evidence before completing a task as superseded", () => {
    const current = task();
    expect(decideOutboundTask(current, {
      kind: "superseded",
      evidence: {
        verified: true,
        taskId: current.id,
        connectionId: current.connectionId,
        observedAt: "2026-08-02T10:01:00.000Z",
        source: "provider_readback",
      },
    }, "2026-08-02T10:02:00.000Z")).toMatchObject({
      action: "complete",
      status: "SUCCESS",
      terminalReason: "SUPERSEDED_VERIFIED",
    });

    expect(decideOutboundTask(current, {
      kind: "superseded",
      evidence: {
        verified: true,
        taskId: "some-other-task",
        connectionId: current.connectionId,
        observedAt: "2026-08-02T10:01:00.000Z",
        source: "provider_master",
      },
    }, "2026-08-02T10:02:00.000Z")).toMatchObject({
      action: "terminal",
      status: "BLOCKED",
      terminalReason: "INVALID_SUPERSEDED_EVIDENCE",
    });
  });

  it("retries POS_DOWN with the inherited schedule and terminates business errors", () => {
    expect(decideOutboundTask(task({ attempts: 2 }), {
      kind: "failure",
      failure: { message: "TCP connect error: timeout" },
    }, "2026-08-02T10:00:00.000Z")).toMatchObject({
      action: "retry",
      status: "QUEUED",
      nextRetryAt: "2026-08-02T10:04:00.000Z",
      failure: { class: "POS_DOWN", countsForCircuitBreaker: true },
    });

    expect(decideOutboundTask(task(), {
      kind: "failure",
      failure: { httpStatus: 404, message: "not found" },
    }, "2026-08-02T10:00:00.000Z")).toMatchObject({
      action: "terminal",
      status: "FAILED",
      terminalReason: "NON_RETRYABLE",
      failure: { class: "BUSINESS_ERROR", countsForCircuitBreaker: false },
    });

    expect(decideOutboundTask(task({ attempts: 5 }), {
      kind: "failure",
      failure: { httpStatus: 503 },
    }, "2026-08-02T10:00:00.000Z")).toMatchObject({
      action: "terminal",
      status: "FAILED",
      terminalReason: "ATTEMPTS_EXHAUSTED",
    });
  });

  it("opens POS_DOWN after five consecutive failures and resets on provider success", () => {
    const at = "2026-08-02T10:00:00.000Z";
    let state: OutboundBreakerState = { consecutiveFailures: 0, pausedUntil: null, reason: null };
    for (let index = 0; index < 4; index++) {
      const transition = reduceOutboundBreaker(state, {
        kind: "failure",
        failureClass: "POS_DOWN",
      }, at);
      expect(transition.opened).toBe(false);
      state = transition.next;
    }

    const fifth = reduceOutboundBreaker(state, { kind: "failure", failureClass: "POS_DOWN" }, at);
    expect(fifth).toMatchObject({
      opened: true,
      next: {
        consecutiveFailures: 5,
        pausedUntil: "2026-08-02T11:00:00.000Z",
        reason: "POS_DOWN",
      },
    });
    expect(isOutboundBreakerOpen(fifth.next, "2026-08-02T10:59:59.999Z")).toBe(true);
    expect(isOutboundBreakerOpen(fifth.next, "2026-08-02T11:00:00.000Z")).toBe(false);

    expect(reduceOutboundBreaker(fifth.next, { kind: "success" }, at).next).toMatchObject({
      consecutiveFailures: 0,
      pausedUntil: null,
      reason: null,
    });
    expect(DEFAULT_OUTBOUND_BREAKER_POLICY).toMatchObject({
      posDownThreshold: 5,
      posDownPauseMs: 3_600_000,
    });
  });

  it("defines a distributed two requests/second provider-connection limiter", () => {
    expect(DEFAULT_OUTBOUND_RATE_LIMITER_PLAN).toEqual({
      algorithm: "sliding-window",
      scope: "provider_connection",
      maxRequests: 2,
      windowMs: 1_000,
      sharedAcrossIsolates: true,
      requiresAtomicReservation: true,
    });
    expect(outboundRateLimitKey("Agora", "connection/1")).toBe("outbound:agora:connection%2F1");

    const first = nextSlidingWindowPermit({ priorRequestTimesMs: [], nowMs: 1_000 });
    const second = nextSlidingWindowPermit({ priorRequestTimesMs: first.retainedRequestTimesMs, nowMs: 1_100 });
    const third = nextSlidingWindowPermit({ priorRequestTimesMs: second.retainedRequestTimesMs, nowMs: 1_200 });
    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    expect(third).toMatchObject({ allowed: false, retryAfterMs: 800 });
  });

  it("redacts credentials, authorization headers, JWTs and secret query parameters", () => {
    const sanitized = sanitizeOutboundValue({
      apiToken: "plain-secret",
      nested: {
        message: "Authorization: Bearer bearer-secret api-key=key-secret https://x.test?a=1&token=url-secret",
        jwt: "abcdefghij.abcdefghij.abcdefghij",
      },
    });
    const serialized = JSON.stringify(sanitized);
    expect(serialized).not.toContain("plain-secret");
    expect(serialized).not.toContain("bearer-secret");
    expect(serialized).not.toContain("key-secret");
    expect(serialized).not.toContain("url-secret");
    expect(serialized).not.toContain("abcdefghij.abcdefghij.abcdefghij");
    expect(serialized).toContain("[REDACTED]");

    const log = sanitizeOutboundLog({
      event: "outbound.execution",
      at: "2026-08-02T10:00:00.000Z",
      connectionId: "connection-1",
      provider: "agora",
      outcome: "retry",
      error: "password=hunter2",
    });
    expect(JSON.stringify(log)).not.toContain("hunter2");
  });
});
