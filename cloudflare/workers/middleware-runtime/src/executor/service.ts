import { isRuntimeEnvelope, type RuntimeEnvelopeV1 } from "../contracts";
import type { RuntimeExecutionResult } from "../queue";

export type RuntimeExecutorService = Readonly<{
  execute(envelope: RuntimeEnvelopeV1): Promise<RuntimeExecutionResult>;
}>;

const MAX_EXECUTOR_REQUEST_BYTES = 64 * 1024;
const SENSITIVE_PAYLOAD_KEY = /(^|[_-])(token|secret|password|authorization|credential|api[_-]?key)($|[_-])/i;

function json(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function parseEnvelope(request: Request): Promise<unknown> {
  const declaredLength = Number(request.headers.get("content-length") || "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_EXECUTOR_REQUEST_BYTES) {
    throw new Error("REQUEST_TOO_LARGE");
  }
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_EXECUTOR_REQUEST_BYTES) {
    throw new Error("REQUEST_TOO_LARGE");
  }
  const parsed = JSON.parse(body) as { envelope?: unknown };
  return parsed.envelope;
}

function containsSensitivePayload(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSensitivePayload);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(
    ([key, child]) => SENSITIVE_PAYLOAD_KEY.test(key) || containsSensitivePayload(child),
  );
}

export function createRuntimeExecutorService(executor: RuntimeExecutorService) {
  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (request.method !== "POST" || url.pathname !== "/v1/execute") {
        return json({ ok: false, failure: { httpStatus: 404, message: "NOT_FOUND" } }, 404);
      }

      let envelope: unknown;
      try {
        envelope = await parseEnvelope(request);
      } catch (error) {
        const tooLarge = error instanceof Error && error.message === "REQUEST_TOO_LARGE";
        return json({
          ok: false,
          failure: {
            httpStatus: tooLarge ? 413 : 400,
            message: tooLarge ? "REQUEST_TOO_LARGE" : "INVALID_JSON",
          },
        }, tooLarge ? 413 : 400);
      }

      if (!isRuntimeEnvelope(envelope)) {
        return json({ ok: false, failure: { httpStatus: 422, message: "INVALID_RUNTIME_ENVELOPE" } }, 422);
      }
      if (containsSensitivePayload(envelope.payload)) {
        return json({
          ok: false,
          failure: { httpStatus: 422, message: "SENSITIVE_RUNTIME_PAYLOAD_REJECTED" },
        }, 422);
      }

      const result = await executor.execute(envelope);
      return json(result, result.ok ? 200 : result.failure.httpStatus || 503);
    },
  };
}
