import type { OutboundRateLimiterPlan } from "./types";

export const DEFAULT_OUTBOUND_RATE_LIMITER_PLAN: OutboundRateLimiterPlan = Object.freeze({
  algorithm: "sliding-window",
  scope: "provider_connection",
  maxRequests: 2,
  windowMs: 1_000,
  sharedAcrossIsolates: true,
  requiresAtomicReservation: true,
});

export function outboundRateLimitKey(provider: string, connectionId: string): string {
  const normalizedProvider = provider.trim().toLowerCase();
  const normalizedConnection = connectionId.trim();
  if (!normalizedProvider) throw new Error("outbound_rate_limit_provider_required");
  if (!normalizedConnection) throw new Error("outbound_rate_limit_connection_required");
  return `outbound:${encodeURIComponent(normalizedProvider)}:${encodeURIComponent(normalizedConnection)}`;
}

export function nextSlidingWindowPermit(input: {
  priorRequestTimesMs: readonly number[];
  nowMs: number;
  plan?: OutboundRateLimiterPlan;
}): { allowed: boolean; retryAfterMs: number; retainedRequestTimesMs: readonly number[] } {
  const plan = input.plan ?? DEFAULT_OUTBOUND_RATE_LIMITER_PLAN;
  if (!Number.isFinite(input.nowMs)) throw new Error("outbound_rate_limit_time_invalid");

  const windowStart = input.nowMs - plan.windowMs;
  const retained = input.priorRequestTimesMs
    .filter((value) => Number.isFinite(value) && value > windowStart && value <= input.nowMs)
    .sort((left, right) => left - right)
    .slice(-(plan.maxRequests));

  if (retained.length < plan.maxRequests) {
    return { allowed: true, retryAfterMs: 0, retainedRequestTimesMs: [...retained, input.nowMs] };
  }

  return {
    allowed: false,
    retryAfterMs: Math.max(1, retained[0] + plan.windowMs - input.nowMs),
    retainedRequestTimesMs: retained,
  };
}
