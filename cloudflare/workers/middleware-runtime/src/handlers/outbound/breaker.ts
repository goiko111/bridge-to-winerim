import type {
  OutboundBreakerEvent,
  OutboundBreakerPolicy,
  OutboundBreakerState,
  OutboundBreakerTransition,
} from "./types";

export const DEFAULT_OUTBOUND_BREAKER_POLICY: OutboundBreakerPolicy = Object.freeze({
  posDownThreshold: 5,
  posDownPauseMs: 60 * 60 * 1_000,
  posOverloadedThreshold: 10,
  posOverloadedPauseMs: 15 * 60 * 1_000,
});

export const EMPTY_OUTBOUND_BREAKER_STATE: OutboundBreakerState = Object.freeze({
  consecutiveFailures: 0,
  pausedUntil: null,
  reason: null,
});

function normalizedState(state: OutboundBreakerState): OutboundBreakerState {
  return {
    consecutiveFailures: Math.max(0, Math.floor(state.consecutiveFailures || 0)),
    pausedUntil: state.pausedUntil ?? null,
    reason: state.reason ?? null,
    revision: state.revision,
  };
}

function sameState(left: OutboundBreakerState, right: OutboundBreakerState): boolean {
  return left.consecutiveFailures === right.consecutiveFailures &&
    left.pausedUntil === right.pausedUntil &&
    left.reason === right.reason;
}

export function isOutboundBreakerOpen(state: OutboundBreakerState, at: Date | string): boolean {
  if (!state.pausedUntil) return false;
  const nowMs = (at instanceof Date ? at : new Date(at)).getTime();
  const pausedUntilMs = Date.parse(state.pausedUntil);
  return Number.isFinite(nowMs) && Number.isFinite(pausedUntilMs) && pausedUntilMs > nowMs;
}

export function reduceOutboundBreaker(
  state: OutboundBreakerState,
  event: OutboundBreakerEvent,
  occurredAt: Date | string,
  policy: OutboundBreakerPolicy = DEFAULT_OUTBOUND_BREAKER_POLICY,
): OutboundBreakerTransition {
  const previous = normalizedState(state);
  const now = occurredAt instanceof Date ? occurredAt : new Date(occurredAt);
  if (!Number.isFinite(now.getTime())) throw new Error("outbound_breaker_time_invalid");

  let next = previous;
  if (event.kind === "success" ||
      (event.kind === "failure" && event.failureClass === "BUSINESS_ERROR")) {
    next = { ...previous, consecutiveFailures: 0, pausedUntil: null, reason: null };
  } else if (event.kind === "failure" && event.failureClass === "POS_DOWN") {
    const consecutiveFailures = previous.consecutiveFailures + 1;
    const opened = consecutiveFailures >= policy.posDownThreshold;
    next = {
      ...previous,
      consecutiveFailures,
      pausedUntil: opened ? new Date(now.getTime() + policy.posDownPauseMs).toISOString() : null,
      reason: opened ? "POS_DOWN" : null,
    };
  } else if (event.kind === "failure" && event.failureClass === "POS_OVERLOADED") {
    const consecutiveFailures = previous.consecutiveFailures + 1;
    const opened = consecutiveFailures >= policy.posOverloadedThreshold;
    next = {
      ...previous,
      consecutiveFailures,
      pausedUntil: opened ? new Date(now.getTime() + policy.posOverloadedPauseMs).toISOString() : null,
      reason: opened ? "POS_OVERLOADED" : null,
    };
  }

  return {
    event,
    previous,
    next,
    changed: !sameState(previous, next),
    opened: !isOutboundBreakerOpen(previous, now) && isOutboundBreakerOpen(next, now),
  };
}
