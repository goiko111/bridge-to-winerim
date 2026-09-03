// ─────────────────────────────────────────────────────────────────────
// SHARED RESILIENCE PRIMITIVES (per-connection throttle, retry, classify, breaker, pre-flight)
// ─────────────────────────────────────────────────────────────────────
// Extracted from agora-proxy after Luruna SQL-pool incident (03/05/2026).
// Apply to every outbound POS proxy to prevent us from DDoS-ing customer POS servers
// and to auto-pause connections whose POS is down or overloaded.
//
// USAGE
//   import { createResilientFetch, classifyPosError, applyCircuitBreaker, isConnectionPaused, preflightCheck } from "../_shared/resilience.ts";
//   const rf = createResilientFetch(connectionId);
//   const res = await rf(url, { headers }, 15000);
//   if (!res.ok) {
//     const cls = classifyPosError(await res.text(), res.status);
//     await applyCircuitBreaker(supabase, connectionId, cls);
//   }
// ─────────────────────────────────────────────────────────────────────

export type ErrorClass = "POS_DOWN" | "POS_OVERLOADED" | "BUSINESS_ERROR" | "UNKNOWN";

// In-memory state (survives across invocations within the same isolate)
const POS_MAX_REQS_PER_SECOND = 2;
const lastReqAt = new Map<string, number[]>();

async function throttle(connectionId: string): Promise<void> {
  const now = Date.now();
  const windowMs = 1000;
  const arr = lastReqAt.get(connectionId) || [];
  const recent = arr.filter((t) => now - t < windowMs);
  if (recent.length >= POS_MAX_REQS_PER_SECOND) {
    const waitMs = windowMs - (now - recent[0]) + 50;
    await new Promise((r) => setTimeout(r, waitMs));
    return throttle(connectionId);
  }
  recent.push(now);
  lastReqAt.set(connectionId, recent);
}

/**
 * Returns a fetch-like function that:
 *  - throttles to POS_MAX_REQS_PER_SECOND per connection
 *  - applies a configurable timeout via AbortController
 *  - retries once on network error
 */
export function createResilientFetch(connectionId: string) {
  return async function resilientFetch(
    url: string,
    init: RequestInit = {},
    timeoutMs = 15000,
  ): Promise<Response> {
    await throttle(connectionId);
    const c1 = new AbortController();
    const t1 = setTimeout(() => c1.abort(), timeoutMs);
    try {
      const r = await fetch(url, { ...init, signal: init.signal ?? c1.signal });
      clearTimeout(t1);
      return r;
    } catch (_e1) {
      clearTimeout(t1);
      await throttle(connectionId);
      const c2 = new AbortController();
      const t2 = setTimeout(() => c2.abort(), timeoutMs);
      try {
        const r = await fetch(url, { ...init, signal: init.signal ?? c2.signal });
        clearTimeout(t2);
        return r;
      } catch (e2) {
        clearTimeout(t2);
        throw e2;
      }
    }
  };
}

export function classifyPosError(errorText: string | null | undefined, httpStatus?: number): ErrorClass {
  const msg = (errorText || "").toLowerCase();
  if (
    msg.includes("connection refused") || msg.includes("no route to host") ||
    msg.includes("connect error") || msg.includes("aborterror") ||
    msg.includes("signal has been aborted") || msg.includes("network is unreachable") ||
    msg.includes("dns error") || msg.includes("failed to lookup address") ||
    msg.includes("tcp connect error") || msg.includes("timed out")
  ) {
    return "POS_DOWN";
  }
  if (
    httpStatus === 500 || httpStatus === 501 || httpStatus === 502 || httpStatus === 503 ||
    httpStatus === 504 || httpStatus === 429 ||
    msg.includes("begin failed with sql exception") || msg.includes("sql pool") ||
    msg.includes("too many requests") || msg.includes("rate limit")
  ) {
    return "POS_OVERLOADED";
  }
  if (
    msg.includes("invalid") || msg.includes("validation") ||
    msg.includes("not found") || msg.includes("forbidden") ||
    httpStatus === 400 || httpStatus === 401 || httpStatus === 403 || httpStatus === 404 ||
    httpStatus === 422
  ) {
    return "BUSINESS_ERROR";
  }
  return "UNKNOWN";
}

/**
 * Updates pos_connections.consecutive_failures and circuit_breaker_paused_until
 * based on error class. Returns whether the breaker tripped.
 *
 *  POS_DOWN       -> 5 consecutive failures => pause 60 min
 *  POS_OVERLOADED -> 10 consecutive failures => pause 15 min
 *  BUSINESS_ERROR -> reset counter (this is not the POS's fault)
 */
export async function applyCircuitBreaker(
  supabase: any,
  connectionId: string,
  errorClass: ErrorClass,
): Promise<{ paused: boolean; pauseMinutes: number }> {
  if (errorClass === "BUSINESS_ERROR") {
    await supabase.from("pos_connections").update({ consecutive_failures: 0 }).eq("id", connectionId);
    return { paused: false, pauseMinutes: 0 };
  }
  if (errorClass !== "POS_DOWN" && errorClass !== "POS_OVERLOADED") {
    return { paused: false, pauseMinutes: 0 };
  }
  const { data: conn } = await supabase
    .from("pos_connections").select("consecutive_failures").eq("id", connectionId).single();
  const newCount = ((conn?.consecutive_failures as number) || 0) + 1;
  const threshold = errorClass === "POS_DOWN" ? 5 : 10;
  const pauseMinutes = errorClass === "POS_DOWN" ? 60 : 15;
  if (newCount >= threshold) {
    const pausedUntil = new Date(Date.now() + pauseMinutes * 60_000).toISOString();
    await supabase.from("pos_connections").update({
      consecutive_failures: newCount,
      circuit_breaker_paused_until: pausedUntil,
      circuit_breaker_reason: `Auto-pause: ${errorClass} (${newCount} consecutive failures)`,
    }).eq("id", connectionId);
    console.log(`[CIRCUIT BREAKER] ${connectionId} paused ${pauseMinutes}min — ${errorClass}`);
    return { paused: true, pauseMinutes };
  }
  await supabase.from("pos_connections").update({ consecutive_failures: newCount }).eq("id", connectionId);
  return { paused: false, pauseMinutes: 0 };
}

export async function resetFailureCounter(supabase: any, connectionId: string): Promise<void> {
  await supabase.from("pos_connections").update({ consecutive_failures: 0, circuit_breaker_paused_until: null, circuit_breaker_reason: null }).eq("id", connectionId);
}

/**
 * Returns true if the connection is currently paused by the circuit breaker.
 * Caller should short-circuit the request and return a 503-equivalent.
 */
export async function isConnectionPaused(supabase: any, connectionId: string): Promise<{ paused: boolean; until?: string; reason?: string }> {
  const { data } = await supabase
    .from("pos_connections")
    .select("circuit_breaker_paused_until, circuit_breaker_reason")
    .eq("id", connectionId)
    .single();
  const until = data?.circuit_breaker_paused_until as string | null;
  if (until && new Date(until).getTime() > Date.now()) {
    return { paused: true, until, reason: data?.circuit_breaker_reason || undefined };
  }
  return { paused: false };
}

/**
 * Lightweight pre-flight: a single HEAD/GET with a tight timeout against a known-cheap endpoint.
 * Returns ok=true if the POS responds at all (any HTTP status is fine — we only care about reachability).
 * Use BEFORE dispatching a batch to avoid filling the queue with FAILED tasks when the POS is down.
 */
export async function preflightCheck(
  url: string,
  init: RequestInit = {},
  timeoutMs = 5000,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...init, signal: controller.signal });
    clearTimeout(t);
    return { ok: true, status: r.status };
  } catch (e) {
    clearTimeout(t);
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
