import { describe, expect, it, vi } from "vitest";

import { createServiceOutboundRateLimiter } from "./outboundRateLimiter";

const input = {
  key: "outbound:agora:11111111-1111-4111-8111-111111111111",
  provider: "agora",
  connectionId: "11111111-1111-4111-8111-111111111111",
  taskId: "task-1",
  requestedAt: "2026-08-04T17:00:00.000Z",
  plan: {
    algorithm: "sliding-window" as const,
    scope: "provider_connection" as const,
    maxRequests: 2 as const,
    windowMs: 1_000 as const,
    sharedAcrossIsolates: true as const,
    requiresAtomicReservation: true as const,
  },
};

function response(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("service-backed outbound rate limiter", () => {
  it("returns the first atomically reserved permit without waiting", async () => {
    const fetch = vi.fn(async () => response(200, {
      granted: true,
      reservedAt: "2026-08-04T17:00:00.000Z",
    }));
    const sleep = vi.fn();
    const limiter = createServiceOutboundRateLimiter({ binding: { fetch }, sleep });

    await expect(limiter.acquire(input)).resolves.toEqual({
      granted: true,
      waitedMs: 0,
      reservedAt: "2026-08-04T17:00:00.000Z",
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("waits once for a bounded 429 and requires a second atomic permit", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(429, { granted: false, retryAfterMs: 250 }))
      .mockResolvedValueOnce(response(200, { granted: true }));
    const sleep = vi.fn(async () => undefined);
    const limiter = createServiceOutboundRateLimiter({ binding: { fetch }, sleep, maxWaitMs: 1_000 });

    await expect(limiter.acquire(input)).resolves.toMatchObject({ granted: true });
    expect(sleep).toHaveBeenCalledWith(250);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("fails closed on malformed responses or an excessive wait", async () => {
    const malformed = createServiceOutboundRateLimiter({
      binding: { fetch: async () => response(200, { ok: true }) },
      sleep: async () => undefined,
    });
    await expect(malformed.acquire(input)).rejects.toThrow("OUTBOUND_RATE_LIMITER_INVALID_RESPONSE");

    const excessive = createServiceOutboundRateLimiter({
      binding: { fetch: async () => response(429, { granted: false, retryAfterMs: 1_000 }) },
      sleep: async () => undefined,
      maxWaitMs: 100,
    });
    await expect(excessive.acquire(input)).rejects.toThrow("OUTBOUND_RATE_LIMITER_WAIT_EXCEEDED");
  });
});
