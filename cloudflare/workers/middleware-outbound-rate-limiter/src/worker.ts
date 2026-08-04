type JsonRecord = Record<string, unknown>;

type DurableObjectStorageLike = Readonly<{
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}>;

type DurableObjectStateLike = Readonly<{
  storage: DurableObjectStorageLike;
}>

type DurableObjectStubLike = Readonly<{
  fetch(request: Request): Promise<Response>;
}>;

type DurableObjectNamespaceLike = Readonly<{
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStubLike;
}>;

export interface OutboundRateLimiterEnv {
  OUTBOUND_RATE_LIMITER: DurableObjectNamespaceLike;
}

type PermitRequest = Readonly<{
  key: string;
  maxRequests: 2;
  windowMs: 1_000;
  requestedAtMs: number;
}>;

const REQUEST_PATH = "/v1/acquire";
const STATE_KEY = "request-times";
const KEY_PATTERN = /^outbound:agora:[A-Za-z0-9%._~-]{8,128}$/;

function json(body: JsonRecord, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function requestInput(value: unknown): PermitRequest | null {
  const body = record(value);
  const plan = record(body.plan);
  const key = String(body.key ?? "").trim();
  const provider = String(body.provider ?? "").trim().toLowerCase();
  const connectionId = String(body.connectionId ?? "").trim();
  const requestedAtMs = Date.parse(String(body.requestedAt ?? ""));
  if (
    provider !== "agora"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(connectionId)
    || key !== `outbound:${encodeURIComponent(provider)}:${encodeURIComponent(connectionId)}`
    || !KEY_PATTERN.test(key)
    || plan.algorithm !== "sliding-window"
    || plan.scope !== "provider_connection"
    || plan.maxRequests !== 2
    || plan.windowMs !== 1_000
    || plan.sharedAcrossIsolates !== true
    || plan.requiresAtomicReservation !== true
    || !Number.isFinite(requestedAtMs)
    || Math.abs(Date.now() - requestedAtMs) > 60_000
  ) return null;
  return { key, maxRequests: 2, windowMs: 1_000, requestedAtMs };
}

export class OutboundRateLimiter {
  constructor(private readonly state: DurableObjectStateLike) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== REQUEST_PATH) {
      return json({ ok: false, error: "NOT_FOUND" }, 404);
    }
    const input = requestInput(await request.json().catch(() => null));
    if (!input) return json({ ok: false, error: "INVALID_REQUEST" }, 422);

    const now = Date.now();
    const windowStart = now - input.windowMs;
    const stored = await this.state.storage.get<unknown>(STATE_KEY);
    const retained = (Array.isArray(stored) ? stored : [])
      .map(Number)
      .filter((value) => Number.isFinite(value) && value > windowStart && value <= now)
      .sort((left, right) => left - right)
      .slice(-input.maxRequests);
    if (retained.length >= input.maxRequests) {
      return json({
        ok: true,
        granted: false,
        retryAfterMs: Math.max(1, retained[0] + input.windowMs - now),
      }, 429);
    }
    retained.push(now);
    await this.state.storage.put(STATE_KEY, retained);
    return json({
      ok: true,
      granted: true,
      reservedAt: new Date(now).toISOString(),
    }, 200);
  }
}

export default {
  async fetch(request: Request, env: OutboundRateLimiterEnv): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== REQUEST_PATH) {
      return json({ ok: false, error: "NOT_FOUND" }, 404);
    }
    const raw = await request.clone().json().catch(() => null);
    const input = requestInput(raw);
    if (!input) return json({ ok: false, error: "INVALID_REQUEST" }, 422);
    const id = env.OUTBOUND_RATE_LIMITER.idFromName(input.key);
    return env.OUTBOUND_RATE_LIMITER.get(id).fetch(new Request("https://rate-limit-object.internal/v1/acquire", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(raw),
    }));
  },
};
