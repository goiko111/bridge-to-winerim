import { describe, expect, it, vi } from "vitest";
import {
  processOutboundTasks,
  reduceOutboundBreaker,
  type OutboundBreakerState,
  type OutboundExecutionResult,
  type OutboundPorts,
  type OutboundTask,
  type OutboundTaskDecision,
} from "../../cloudflare/workers/middleware-runtime/src/handlers/outbound";

function makeTask(id: string, overrides: Partial<OutboundTask> = {}): OutboundTask {
  return {
    id,
    connectionId: "connection-1",
    provider: "agora",
    taskType: "UPSERT_PRODUCT",
    payload: { wineId: id, apiToken: "must-not-be-logged" },
    status: "RUNNING",
    attempts: 1,
    maxAttempts: 5,
    createdAt: "2026-08-02T10:00:00.000Z",
    ...overrides,
  };
}

function harness(input: {
  tasks?: readonly OutboundTask[];
  breaker?: OutboundBreakerState;
  execute?: OutboundPorts["executor"]["execute"];
  limiter?: OutboundPorts["limiter"]["acquire"];
}) {
  let breaker = input.breaker ?? { consecutiveFailures: 0, pausedUntil: null, reason: null };
  const transitions: Array<{ task: OutboundTask; decision: OutboundTaskDecision }> = [];
  const logs: Parameters<OutboundPorts["logger"]["write"]>[0][] = [];
  const claim = vi.fn(async () => input.tasks ?? []);
  const executeImpl: OutboundPorts["executor"]["execute"] = input.execute ??
    (async () => ({ kind: "success" as const }));
  const execute = vi.fn(executeImpl);
  const acquire = vi.fn(input.limiter ?? (async () => ({ granted: true as const, waitedMs: 0 })));
  const record = vi.fn(async (event: Parameters<OutboundPorts["breaker"]["record"]>[0]) => {
    breaker = reduceOutboundBreaker(breaker, event.event, event.occurredAt, event.policy).next;
    return breaker;
  });
  const ports: OutboundPorts = {
    clock: { now: () => new Date("2026-08-02T10:00:00.000Z") },
    tasks: {
      claim,
      transition: async (task, decision) => {
        transitions.push({ task, decision });
      },
    },
    breaker: {
      read: async () => breaker,
      record,
    },
    limiter: { acquire },
    executor: { execute },
    logger: { write: async (log) => { logs.push(log); } },
  };
  return { ports, claim, execute, acquire, record, transitions, logs, breaker: () => breaker };
}

const batch = {
  connectionId: "connection-1",
  provider: "agora",
  taskTypes: ["UPSERT_PRODUCT"],
};

describe("provider-neutral outbound handler", () => {
  it("does not claim work while the connection breaker is open", async () => {
    const context = harness({
      breaker: {
        consecutiveFailures: 5,
        pausedUntil: "2026-08-02T11:00:00.000Z",
        reason: "POS_DOWN",
      },
    });

    await expect(processOutboundTasks(batch, context.ports)).resolves.toMatchObject({
      claimed: 0,
      skippedByBreaker: true,
    });
    expect(context.claim).not.toHaveBeenCalled();
    expect(context.execute).not.toHaveBeenCalled();
    expect(context.logs).toHaveLength(1);
    expect(context.logs[0]).toMatchObject({ outcome: "breaker_open" });
  });

  it("acquires the shared limiter before executing and persists a stable idempotency key", async () => {
    const current = makeTask("task-1", { idempotencyKey: "stable-provider-key" });
    const context = harness({
      tasks: [current],
      execute: async () => ({ kind: "success", externalId: "provider-123" }),
      limiter: async () => ({ granted: true, waitedMs: 125 }),
    });

    const summary = await processOutboundTasks(batch, context.ports);

    expect(context.acquire).toHaveBeenCalledWith(expect.objectContaining({
      key: "outbound:agora:connection-1",
      plan: expect.objectContaining({ maxRequests: 2, windowMs: 1_000 }),
    }));
    expect(context.execute).toHaveBeenCalledWith(current, {
      idempotencyKey: "stable-provider-key",
      attempt: 1,
      maxAttempts: 5,
    });
    expect(context.transitions[0].decision).toEqual({
      action: "complete",
      status: "SUCCESS",
      externalId: "provider-123",
      detail: undefined,
    });
    expect(context.record).toHaveBeenCalledWith(expect.objectContaining({ event: { kind: "success" } }));
    expect(context.logs[0]).toMatchObject({ outcome: "complete", limiterWaitMs: 125 });
    expect(summary).toMatchObject({ claimed: 1, completed: 1, retried: 0, terminal: 0 });
  });

  it("opens the breaker on the fifth POS_DOWN and defers already-claimed remaining work", async () => {
    const tasks = Array.from({ length: 6 }, (_, index) => makeTask(`task-${index + 1}`));
    const context = harness({
      tasks,
      execute: async () => ({ kind: "failure", failure: { message: "TCP connect error: timed out" } }),
    });

    const summary = await processOutboundTasks(batch, context.ports);

    expect(context.execute).toHaveBeenCalledTimes(5);
    expect(context.acquire).toHaveBeenCalledTimes(5);
    expect(context.breaker()).toMatchObject({
      consecutiveFailures: 5,
      pausedUntil: "2026-08-02T11:00:00.000Z",
      reason: "POS_DOWN",
    });
    expect(context.transitions.slice(0, 5).every(({ decision }) => decision.action === "retry")).toBe(true);
    expect(context.transitions[5].decision).toMatchObject({
      action: "defer",
      status: "QUEUED",
      reason: "BREAKER_OPEN",
      restoreClaimedAttempt: true,
      nextRetryAt: "2026-08-02T11:00:00.000Z",
    });
    expect(summary).toMatchObject({ claimed: 6, retried: 5, deferred: 1 });
  });

  it("fails terminal business errors without counting them as POS_DOWN", async () => {
    const context = harness({
      tasks: [makeTask("task-1")],
      breaker: { consecutiveFailures: 3, pausedUntil: null, reason: null },
      execute: async () => ({ kind: "failure", failure: { httpStatus: 422, message: "Api-Token: secret validation" } }),
    });

    const summary = await processOutboundTasks(batch, context.ports);

    expect(context.transitions[0].decision).toMatchObject({
      action: "terminal",
      status: "FAILED",
      terminalReason: "NON_RETRYABLE",
      failure: { class: "BUSINESS_ERROR", countsForCircuitBreaker: false },
    });
    expect(context.breaker()).toMatchObject({ consecutiveFailures: 0, pausedUntil: null });
    expect(JSON.stringify(context.logs)).not.toContain("secret");
    expect(JSON.stringify(context.logs)).not.toContain("must-not-be-logged");
    expect(summary).toMatchObject({ terminal: 1, blocked: 0 });
  });

  it("completes only exact superseded evidence and blocks mismatches", async () => {
    const exact = makeTask("task-exact");
    const mismatch = makeTask("task-mismatch");
    const context = harness({
      tasks: [exact, mismatch],
      execute: async (task) => ({
        kind: "superseded",
        evidence: {
          verified: true,
          taskId: task.id === exact.id ? task.id : "wrong-task",
          connectionId: task.connectionId,
          observedAt: "2026-08-02T09:59:00.000Z",
          source: "provider_master",
        },
      }),
    });

    const summary = await processOutboundTasks(batch, context.ports);

    expect(context.transitions[0].decision).toMatchObject({
      action: "complete",
      terminalReason: "SUPERSEDED_VERIFIED",
    });
    expect(context.transitions[1].decision).toMatchObject({
      action: "terminal",
      status: "BLOCKED",
      terminalReason: "INVALID_SUPERSEDED_EVIDENCE",
    });
    expect(context.record).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ completed: 1, superseded: 1, terminal: 1, blocked: 1 });
  });

  it("defers without consuming an attempt when the limiter cannot coordinate a permit", async () => {
    const context = harness({
      tasks: [makeTask("task-1")],
      limiter: async () => { throw new Error("Authorization: Bearer limiter-secret"); },
    });

    const summary = await processOutboundTasks(batch, context.ports);

    expect(context.execute).not.toHaveBeenCalled();
    expect(context.transitions[0].decision).toMatchObject({
      action: "defer",
      reason: "LIMITER_UNAVAILABLE",
      restoreClaimedAttempt: true,
      nextRetryAt: "2026-08-02T10:00:05.000Z",
    });
    expect(JSON.stringify(context.logs)).not.toContain("limiter-secret");
    expect(summary).toMatchObject({ claimed: 1, deferred: 1 });
  });

  it("blocks claimed rows that violate the requested connection/provider scope", async () => {
    const context = harness({ tasks: [makeTask("task-1", { connectionId: "other-connection" })] });

    const summary = await processOutboundTasks(batch, context.ports);

    expect(context.execute).not.toHaveBeenCalled();
    expect(context.transitions[0].decision).toMatchObject({ action: "terminal", status: "BLOCKED" });
    expect(context.logs[0].event).toBe("outbound.claim.invalid");
    expect(summary).toMatchObject({ invalidClaims: 1, terminal: 1, blocked: 1 });
  });
});
