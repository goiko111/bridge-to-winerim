import type { OutboundPorts } from "../../middleware-runtime/src/handlers/outbound";

type JsonRecord = Record<string, unknown>;

export type OutboundRateLimiterServiceBinding = Readonly<{
  fetch(request: Request): Promise<Response>;
}>;

export type ServiceOutboundRateLimiterOptions = Readonly<{
  binding: OutboundRateLimiterServiceBinding;
  sleep(milliseconds: number): Promise<void>;
  maxWaitMs?: number;
}>;

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function boundedWait(value: unknown, maximum: number): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= maximum ? parsed : null;
}

async function requestPermit(
  binding: OutboundRateLimiterServiceBinding,
  input: Parameters<OutboundPorts["limiter"]["acquire"]>[0],
): Promise<Readonly<{ granted: boolean; retryAfterMs: number; reservedAt?: string }>> {
  const response = await binding.fetch(new Request("https://outbound-rate-limiter.internal/v1/acquire", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      key: input.key,
      provider: input.provider,
      connectionId: input.connectionId,
      taskId: input.taskId,
      requestedAt: input.requestedAt,
      plan: input.plan,
    }),
  }));
  const body = record(await response.json().catch(() => ({})));
  if (![200, 429].includes(response.status) || typeof body.granted !== "boolean") {
    throw new Error("OUTBOUND_RATE_LIMITER_INVALID_RESPONSE");
  }
  const retryAfterMs = body.granted === true
    ? 0
    : boundedWait(body.retryAfterMs, input.plan.windowMs) ?? input.plan.windowMs;
  const reservedAt = typeof body.reservedAt === "string" ? body.reservedAt.trim() : "";
  return {
    granted: body.granted,
    retryAfterMs,
    ...(reservedAt ? { reservedAt } : {}),
  };
}

export function createServiceOutboundRateLimiter(
  options: ServiceOutboundRateLimiterOptions,
): OutboundPorts["limiter"] {
  const maximum = Number.isInteger(options.maxWaitMs)
    ? Math.max(1, Math.min(5_000, Number(options.maxWaitMs)))
    : 1_000;
  return Object.freeze({
    async acquire(input) {
      const startedAt = Date.now();
      const first = await requestPermit(options.binding, input);
      if (first.granted) {
        return { granted: true, waitedMs: 0, ...(first.reservedAt ? { reservedAt: first.reservedAt } : {}) };
      }
      if (first.retryAfterMs > maximum) {
        throw new Error("OUTBOUND_RATE_LIMITER_WAIT_EXCEEDED");
      }
      await options.sleep(first.retryAfterMs);
      const second = await requestPermit(options.binding, input);
      if (!second.granted) throw new Error("OUTBOUND_RATE_LIMITER_BUSY");
      return {
        granted: true,
        waitedMs: Math.max(0, Date.now() - startedAt),
        ...(second.reservedAt ? { reservedAt: second.reservedAt } : {}),
      };
    },
  });
}
