import {
  HttpAdapterError,
  type HttpAdapterErrorCode,
  type HttpAdapterLogEvent,
  type HttpAdapterResponse,
  type SafeHttpClient,
  type SafeHttpClientOptions,
  type SafeHttpRequest,
} from "./contracts";

const MIN_TIMEOUT_MS = 1;
const MAX_TIMEOUT_MS = 60_000;
const MIN_RESPONSE_BYTES = 1;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const SENSITIVE_KEY = /authorization|cookie|password|secret|token|api[-_]?key|credential/i;

function normalizedHost(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

function validatedBaseUrl(options: SafeHttpClientOptions): URL {
  let base: URL;
  try {
    base = new URL(options.baseUrl);
  } catch {
    throw new HttpAdapterError("HTTP_INVALID_BASE_URL");
  }
  if (!options.allowedProtocols.includes(base.protocol as "http:" | "https:") ||
      base.username || base.password || base.search || base.hash ||
      (base.pathname !== "/" && base.pathname !== "")) {
    throw new HttpAdapterError("HTTP_INVALID_BASE_URL");
  }
  const allowed = new Set(options.allowedHosts.map(normalizedHost).filter(Boolean));
  if (allowed.size === 0 || !allowed.has(normalizedHost(base.host))) {
    throw new HttpAdapterError("HTTP_BASE_URL_NOT_ALLOWLISTED");
  }
  base.pathname = "/";
  return base;
}

function validateLimits(options: SafeHttpClientOptions): void {
  if (!Number.isInteger(options.timeoutMs) ||
      options.timeoutMs < MIN_TIMEOUT_MS || options.timeoutMs > MAX_TIMEOUT_MS) {
    throw new HttpAdapterError("HTTP_INVALID_TIMEOUT");
  }
  if (!Number.isInteger(options.maxResponseBytes) ||
      options.maxResponseBytes < MIN_RESPONSE_BYTES || options.maxResponseBytes > MAX_RESPONSE_BYTES) {
    throw new HttpAdapterError("HTTP_INVALID_RESPONSE_LIMIT");
  }
}

function requestUrl(base: URL, input: SafeHttpRequest): URL {
  if (!input.path.startsWith("/") || input.path.startsWith("//") ||
      input.path.includes("\\") || input.path.includes("\0") || input.path.includes("..")) {
    throw new HttpAdapterError("HTTP_INVALID_REQUEST_PATH");
  }
  const url = new URL(input.path, base);
  if (url.origin !== base.origin || url.username || url.password || url.hash) {
    throw new HttpAdapterError("HTTP_INVALID_REQUEST_PATH");
  }
  for (const [key, value] of Object.entries(input.query ?? {})) {
    url.searchParams.set(key, value);
  }
  return url;
}

async function safeLog(
  logger: SafeHttpClientOptions["logger"],
  event: HttpAdapterLogEvent,
): Promise<void> {
  try {
    await logger?.write(event);
  } catch {
    // Observability must never change transport semantics.
  }
}

function elapsed(timer: SafeHttpClientOptions["timer"], startedAt: number): number {
  return Math.max(0, Math.floor(timer.now() - startedAt));
}

function contentLength(response: Response): number | null {
  const value = response.headers.get("content-length");
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/\b(authorization|api[-_]?token|token|password|secret|api[-_]?key)\b\s*[:=]\s*([^\s,;]+)/gi, "$1=[REDACTED]");
}

export function redactSensitiveValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[REDACTED_DEPTH]";
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map((entry) => redactSensitiveValue(entry, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
    key,
    SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactSensitiveValue(entry, depth + 1),
  ]));
}

async function readResponseBody(response: Response, maxResponseBytes: number): Promise<unknown> {
  const declaredLength = contentLength(response);
  if (declaredLength !== null && declaredLength > maxResponseBytes) {
    throw new HttpAdapterError("HTTP_RESPONSE_TOO_LARGE");
  }

  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new HttpAdapterError("HTTP_RESPONSE_READ_FAILED");
  }
  if (new TextEncoder().encode(text).byteLength > maxResponseBytes) {
    throw new HttpAdapterError("HTTP_RESPONSE_TOO_LARGE");
  }
  if (!text) return null;

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("json")) {
    try {
      return redactSensitiveValue(JSON.parse(text));
    } catch {
      return redactSensitiveText(text);
    }
  }
  return redactSensitiveText(text);
}

function errorOutcome(code: HttpAdapterErrorCode): HttpAdapterLogEvent["outcome"] {
  if (code === "HTTP_TIMEOUT") return "timeout";
  if (code === "HTTP_NETWORK_ERROR") return "network_error";
  return "blocked";
}

function requestDiagnostic(
  options: SafeHttpClientOptions,
  input: SafeHttpRequest,
  url: URL,
  startedAt: number,
  status?: number,
  bodySample?: string,
): ConstructorParameters<typeof HttpAdapterError>[1] {
  const path = `${url.pathname}${url.search}`;
  return {
    target: options.target,
    operation: input.operation,
    method: input.method,
    protocol: url.protocol,
    host: url.host,
    path,
    url: `${url.protocol}//${url.host}${path}`,
    durationMs: elapsed(options.timer, startedAt),
    ...(status !== undefined ? { status } : {}),
    ...(bodySample ? { bodySample: redactSensitiveText(bodySample).slice(0, 256) } : {}),
  };
}

export function createSafeHttpClient(options: SafeHttpClientOptions): SafeHttpClient {
  const base = validatedBaseUrl(options);
  validateLimits(options);

  return {
    async request(input): Promise<HttpAdapterResponse> {
      const startedAt = options.timer.now();
      let url: URL;
      try {
        url = requestUrl(base, input);
      } catch (error) {
        const adapterError = error instanceof HttpAdapterError
          ? error
          : new HttpAdapterError("HTTP_INVALID_REQUEST_PATH");
        await safeLog(options.logger, {
          event: "http.adapter.request",
          target: options.target,
          operation: input.operation,
          method: input.method,
          host: base.host,
          path: "/[blocked]",
          outcome: "blocked",
          durationMs: elapsed(options.timer, startedAt),
          errorCode: adapterError.code,
        });
        throw adapterError;
      }

      const controller = new AbortController();
      const timeoutHandle = options.timer.schedule(() => controller.abort(), options.timeoutMs);
      let response: Response;
      try {
        response = await options.request.request(url.toString(), {
          method: input.method,
          headers: { ...input.headers },
          body: input.body === undefined ? undefined : JSON.stringify(input.body),
          redirect: "manual",
          signal: controller.signal,
        });
      } catch (error) {
        options.timer.cancel(timeoutHandle);
        const code: HttpAdapterErrorCode = controller.signal.aborted ? "HTTP_TIMEOUT" : "HTTP_NETWORK_ERROR";
        const errorSample = error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error);
        await safeLog(options.logger, {
          event: "http.adapter.request",
          target: options.target,
          operation: input.operation,
          method: input.method,
          host: base.host,
          path: `${url.pathname}${url.search}`,
          outcome: errorOutcome(code),
          durationMs: elapsed(options.timer, startedAt),
          errorCode: code,
        });
        throw new HttpAdapterError(code, requestDiagnostic(options, input, url, startedAt, undefined, errorSample));
      }

      if (response.status >= 300 && response.status < 400) {
        options.timer.cancel(timeoutHandle);
        await safeLog(options.logger, {
          event: "http.adapter.request",
          target: options.target,
          operation: input.operation,
          method: input.method,
          host: base.host,
          path: url.pathname,
          outcome: "blocked",
          durationMs: elapsed(options.timer, startedAt),
          status: response.status,
          errorCode: "HTTP_REDIRECT_BLOCKED",
        });
        throw new HttpAdapterError("HTTP_REDIRECT_BLOCKED", requestDiagnostic(options, input, url, startedAt, response.status));
      }

      let body: unknown;
      try {
        body = await readResponseBody(response, options.maxResponseBytes);
      } catch (error) {
        options.timer.cancel(timeoutHandle);
        const adapterError = error instanceof HttpAdapterError
          ? controller.signal.aborted ? new HttpAdapterError("HTTP_TIMEOUT") : error
          : new HttpAdapterError("HTTP_RESPONSE_READ_FAILED");
        await safeLog(options.logger, {
          event: "http.adapter.request",
          target: options.target,
          operation: input.operation,
          method: input.method,
          host: base.host,
          path: url.pathname,
          outcome: "blocked",
          durationMs: elapsed(options.timer, startedAt),
          status: response.status,
          errorCode: adapterError.code,
        });
        throw new HttpAdapterError(
          adapterError.code,
          requestDiagnostic(options, input, url, startedAt, response.status),
        );
      }

      options.timer.cancel(timeoutHandle);
      await safeLog(options.logger, {
        event: "http.adapter.request",
        target: options.target,
        operation: input.operation,
        method: input.method,
        host: base.host,
        path: url.pathname,
        outcome: response.ok ? "success" : "http_error",
        durationMs: elapsed(options.timer, startedAt),
        status: response.status,
      });
      return {
        ok: response.ok,
        status: response.status,
        contentType: response.headers.get("content-type")?.split(";", 1)[0]?.trim() ?? "",
        body,
      };
    },
  };
}
