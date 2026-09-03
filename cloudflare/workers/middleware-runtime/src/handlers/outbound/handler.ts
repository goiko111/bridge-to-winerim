import { classifyRuntimeFailure } from "../../retry";
import { DEFAULT_OUTBOUND_BREAKER_POLICY, isOutboundBreakerOpen } from "./breaker";
import { buildOutboundClaimPlan, isClaimedTaskInScope, outboundTaskIdempotencyKey } from "./claim";
import { decideOutboundTask } from "./decision";
import { DEFAULT_OUTBOUND_RATE_LIMITER_PLAN, outboundRateLimitKey } from "./limiter";
import { sanitizeOutboundLog, sanitizeOutboundText, sanitizeOutboundValue } from "./logging";
import type {
  OutboundBatchInput,
  OutboundBatchSummary,
  OutboundBreakerEvent,
  OutboundBreakerState,
  OutboundExecutionLog,
  OutboundExecutionResult,
  OutboundPorts,
  OutboundTask,
  OutboundTaskDecision,
} from "./types";

function emptySummary(): OutboundBatchSummary {
  return {
    claimed: 0,
    completed: 0,
    superseded: 0,
    retried: 0,
    terminal: 0,
    blocked: 0,
    deferred: 0,
    invalidClaims: 0,
    skippedByBreaker: false,
  };
}

function deferForBreaker(
  state: OutboundBreakerState,
  now: Date,
): Extract<OutboundTaskDecision, { action: "defer" }> {
  const nextRetryAt = state.pausedUntil && Date.parse(state.pausedUntil) > now.getTime()
    ? state.pausedUntil
    : new Date(now.getTime() + 5_000).toISOString();
  return {
    action: "defer",
    status: "QUEUED",
    nextRetryAt,
    reason: "BREAKER_OPEN",
    restoreClaimedAttempt: true,
    lastError: "connection_breaker_open",
  };
}

function breakerEventFor(
  result: OutboundExecutionResult,
  decision: OutboundTaskDecision,
): OutboundBreakerEvent | null {
  if (result.kind === "success") return { kind: "success" };
  if (result.kind !== "failure") return null;
  const failure = decision.action === "retry" || decision.action === "terminal"
    ? decision.failure
    : undefined;
  return {
    kind: "failure",
    failureClass: failure?.class ?? classifyRuntimeFailure({ ...result.failure, profile: "POS_OUTBOUND" }).class,
  };
}

function executionLog(input: {
  at: Date;
  task: OutboundTask;
  result: OutboundExecutionResult;
  decision: OutboundTaskDecision;
  durationMs: number;
  limiterWaitMs: number;
  breaker: OutboundBreakerState;
}): OutboundExecutionLog {
  const failure = input.decision.action === "retry" || input.decision.action === "terminal"
    ? input.decision.failure
    : undefined;
  const terminalReason = input.decision.action === "terminal" || input.decision.action === "complete"
    ? input.decision.terminalReason
    : undefined;
  const error = input.decision.action === "retry" || input.decision.action === "terminal" ||
      input.decision.action === "defer"
    ? input.decision.lastError
    : undefined;
  const detail = input.result.kind === "success"
    ? input.result.detail
    : input.result.kind === "blocked"
    ? input.result.detail ?? input.result.reason
    : input.result.kind === "superseded"
    ? { source: input.result.evidence.source, observedAt: input.result.evidence.observedAt }
    : input.result.kind === "failure"
    ? {
      ...(input.result.failure.message ? { failureMessage: input.result.failure.message } : {}),
      ...(input.result.failure.diagnostic ? { failureDiagnostic: input.result.failure.diagnostic } : {}),
    }
    : undefined;

  return sanitizeOutboundLog({
    event: "outbound.execution",
    at: input.at.toISOString(),
    connectionId: input.task.connectionId,
    provider: input.task.provider,
    outcome: input.decision.action === "complete" && input.decision.terminalReason === "SUPERSEDED_VERIFIED"
      ? "superseded"
      : input.decision.action,
    taskId: input.task.id,
    taskType: input.task.taskType,
    attempt: input.task.attempts,
    maxAttempts: input.task.maxAttempts,
    httpStatus: input.result.kind === "failure" ? input.result.failure.httpStatus : undefined,
    failureClass: failure?.class,
    terminalReason,
    nextRetryAt: input.decision.action === "retry" || input.decision.action === "defer"
      ? input.decision.nextRetryAt
      : undefined,
    limiterWaitMs: input.limiterWaitMs,
    durationMs: input.durationMs,
    breakerFailures: input.breaker.consecutiveFailures,
    breakerPausedUntil: input.breaker.pausedUntil,
    error,
    detail: detail === undefined ? undefined : sanitizeOutboundValue(detail),
  });
}

function incrementSummary(summary: OutboundBatchSummary, decision: OutboundTaskDecision): void {
  if (decision.action === "complete") {
    summary.completed++;
    if (decision.terminalReason === "SUPERSEDED_VERIFIED") summary.superseded++;
  } else if (decision.action === "retry") {
    summary.retried++;
  } else if (decision.action === "defer") {
    summary.deferred++;
  } else {
    summary.terminal++;
    if (decision.status === "BLOCKED") summary.blocked++;
  }
}

async function writeLog(ports: OutboundPorts, record: OutboundExecutionLog): Promise<void> {
  await ports.logger.write(sanitizeOutboundLog(record));
}

export async function processOutboundTasks(
  input: OutboundBatchInput,
  ports: OutboundPorts,
): Promise<OutboundBatchSummary> {
  const summary = emptySummary();
  const startedAt = ports.clock.now();
  let breakerState = await ports.breaker.read(input.connectionId);

  if (isOutboundBreakerOpen(breakerState, startedAt)) {
    summary.skippedByBreaker = true;
    await writeLog(ports, {
      event: "outbound.batch.skipped",
      at: startedAt.toISOString(),
      connectionId: input.connectionId,
      provider: input.provider,
      outcome: "breaker_open",
      breakerFailures: breakerState.consecutiveFailures,
      breakerPausedUntil: breakerState.pausedUntil,
    });
    return summary;
  }

  const claimPlan = buildOutboundClaimPlan({
    connectionId: input.connectionId,
    provider: input.provider,
    taskTypes: input.taskTypes,
    limit: input.limit,
    readyAt: startedAt,
  });
  const tasks = await ports.tasks.claim(claimPlan);
  summary.claimed = tasks.length;

  for (const task of tasks) {
    const now = ports.clock.now();
    if (!isClaimedTaskInScope(task, claimPlan)) {
      const decision: OutboundTaskDecision = {
        action: "terminal",
        status: "BLOCKED",
        terminalReason: "DEPENDENCY_BLOCKED",
        lastError: "claimed_task_outside_requested_scope",
      };
      await ports.tasks.transition(task, decision);
      summary.invalidClaims++;
      incrementSummary(summary, decision);
      await writeLog(ports, {
        event: "outbound.claim.invalid",
        at: now.toISOString(),
        connectionId: input.connectionId,
        provider: input.provider,
        outcome: "blocked",
        taskId: task.id,
        taskType: task.taskType,
        attempt: task.attempts,
        maxAttempts: task.maxAttempts,
        terminalReason: decision.terminalReason,
        error: decision.lastError,
      });
      continue;
    }

    if (isOutboundBreakerOpen(breakerState, now)) {
      const decision = deferForBreaker(breakerState, now);
      await ports.tasks.transition(task, decision);
      incrementSummary(summary, decision);
      await writeLog(ports, {
        event: "outbound.execution",
        at: now.toISOString(),
        connectionId: task.connectionId,
        provider: task.provider,
        outcome: "defer",
        taskId: task.id,
        taskType: task.taskType,
        attempt: task.attempts,
        maxAttempts: task.maxAttempts,
        nextRetryAt: decision.nextRetryAt,
        breakerFailures: breakerState.consecutiveFailures,
        breakerPausedUntil: breakerState.pausedUntil,
        error: decision.lastError,
      });
      continue;
    }

    let limiterWaitMs = 0;
    try {
      const permit = await ports.limiter.acquire({
        key: outboundRateLimitKey(task.provider, task.connectionId),
        provider: task.provider,
        connectionId: task.connectionId,
        taskId: task.id,
        requestedAt: now.toISOString(),
        plan: DEFAULT_OUTBOUND_RATE_LIMITER_PLAN,
      });
      if (!permit || permit.granted !== true) throw new Error("limiter_did_not_grant_permit");
      limiterWaitMs = Math.max(0, Math.floor(permit.waitedMs || 0));
    } catch (error) {
      const decision: OutboundTaskDecision = {
        action: "defer",
        status: "QUEUED",
        nextRetryAt: new Date(now.getTime() + 5_000).toISOString(),
        reason: "LIMITER_UNAVAILABLE",
        restoreClaimedAttempt: true,
        lastError: sanitizeOutboundText(error),
      };
      await ports.tasks.transition(task, decision);
      incrementSummary(summary, decision);
      await writeLog(ports, {
        event: "outbound.execution",
        at: now.toISOString(),
        connectionId: task.connectionId,
        provider: task.provider,
        outcome: "defer",
        taskId: task.id,
        taskType: task.taskType,
        attempt: task.attempts,
        maxAttempts: task.maxAttempts,
        nextRetryAt: decision.nextRetryAt,
        error: decision.lastError,
      });
      continue;
    }

    const executionStartedAt = ports.clock.now();
    let result: OutboundExecutionResult;
    try {
      result = await ports.executor.execute(task, {
        idempotencyKey: outboundTaskIdempotencyKey(task),
        attempt: task.attempts,
        maxAttempts: task.maxAttempts,
      });
    } catch (error) {
      result = { kind: "failure", failure: { message: sanitizeOutboundText(error) } };
    }

    const finishedAt = ports.clock.now();
    const decision = decideOutboundTask(task, result, finishedAt);
    const breakerEvent = breakerEventFor(result, decision);
    if (breakerEvent) {
      breakerState = await ports.breaker.record({
        connectionId: task.connectionId,
        occurredAt: finishedAt.toISOString(),
        event: breakerEvent,
        policy: DEFAULT_OUTBOUND_BREAKER_POLICY,
      });
    }
    await ports.tasks.transition(task, decision);
    incrementSummary(summary, decision);

    await writeLog(ports, executionLog({
      at: finishedAt,
      task,
      result,
      decision,
      durationMs: Math.max(0, finishedAt.getTime() - executionStartedAt.getTime()),
      limiterWaitMs,
      breaker: breakerState,
    }));
  }

  return summary;
}
