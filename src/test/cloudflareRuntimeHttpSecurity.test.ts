import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  createSafeHttpClient,
  HttpAdapterError,
  redactSensitiveValue,
  type HttpAdapterLogEvent,
  type HttpTimerPort,
} from "../../cloudflare/workers/middleware-runtime/src/adapters/http";

function timer(overrides: Partial<HttpTimerPort> = {}): HttpTimerPort {
  return {
    now: () => 1_000,
    schedule: vi.fn(() => Symbol("timer")),
    cancel: vi.fn(),
    ...overrides,
  };
}

function options(request = vi.fn()) {
  return {
    target: "agora" as const,
    baseUrl: "https://safe.example.test",
    allowedHosts: ["safe.example.test"],
    allowedProtocols: ["https:" as const],
    timeoutMs: 1_000,
    maxResponseBytes: 1_024,
    request: { request },
    timer: timer(),
  };
}

describe("provider-neutral HTTP adapter security", () => {
  it("fails closed when base URL origin, path or host is not explicitly allowed", () => {
    expect(() => createSafeHttpClient({
      ...options(),
      baseUrl: "https://blocked.example.test",
    })).toThrowError(expect.objectContaining({ code: "HTTP_BASE_URL_NOT_ALLOWLISTED" }));
    expect(() => createSafeHttpClient({
      ...options(),
      baseUrl: "https://user:password@safe.example.test/",
    })).toThrowError(expect.objectContaining({ code: "HTTP_INVALID_BASE_URL" }));
    expect(() => createSafeHttpClient({
      ...options(),
      baseUrl: "https://safe.example.test/api/v2",
    })).toThrowError(expect.objectContaining({ code: "HTTP_INVALID_BASE_URL" }));
    expect(() => createSafeHttpClient({
      ...options(),
      baseUrl: "http://safe.example.test",
    })).toThrowError(expect.objectContaining({ code: "HTTP_INVALID_BASE_URL" }));
  });

  it("blocks path escapes and redirects without following them", async () => {
    const request = vi.fn().mockResolvedValue(new Response(null, {
      status: 302,
      headers: { location: "https://attacker.example.test/collect" },
    }));
    const client = createSafeHttpClient(options(request));

    await expect(client.request({ operation: "test", method: "GET", path: "/../escape" }))
      .rejects.toMatchObject<HttpAdapterError>({ code: "HTTP_INVALID_REQUEST_PATH" });
    expect(request).not.toHaveBeenCalled();

    await expect(client.request({ operation: "test", method: "GET", path: "/api/" }))
      .rejects.toMatchObject<HttpAdapterError>({ code: "HTTP_REDIRECT_BLOCKED" });
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
  });

  it("aborts at the injected timeout and emits only a sanitized error code", async () => {
    const logs: HttpAdapterLogEvent[] = [];
    const timeoutTimer = timer({
      schedule: vi.fn((callback) => {
        queueMicrotask(callback);
        return Symbol("timer");
      }),
    });
    const request = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("Api-Token=do-not-log")));
    }));
    const client = createSafeHttpClient({
      ...options(request),
      timer: timeoutTimer,
      logger: { write: (event) => { logs.push(event); } },
    });

    await expect(client.request({ operation: "timeout", method: "GET", path: "/api/" }))
      .rejects.toMatchObject<HttpAdapterError>({
        code: "HTTP_TIMEOUT",
        diagnostic: {
          target: "agora",
          operation: "timeout",
          method: "GET",
          protocol: "https:",
          host: "safe.example.test",
          path: "/api/",
          url: "https://safe.example.test/api/",
        },
      });
    expect(timeoutTimer.cancel).toHaveBeenCalledOnce();
    expect(logs).toEqual([expect.objectContaining({ outcome: "timeout", errorCode: "HTTP_TIMEOUT" })]);
    expect(JSON.stringify(logs)).not.toContain("do-not-log");
  });

  it("keeps the timeout active while the response body is being read", async () => {
    let expire = () => undefined;
    const bodyTimer = timer({
      schedule: vi.fn((callback) => {
        expire = callback;
        return Symbol("timer");
      }),
    });
    const request = vi.fn((_url: string, init: RequestInit) => Promise.resolve({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      text: () => {
        expire();
        return Promise.reject(new Error(`Bearer body-secret aborted=${init.signal?.aborted}`));
      },
    } as Response));
    const client = createSafeHttpClient({ ...options(request), timer: bodyTimer });

    await expect(client.request({ operation: "slow-body", method: "GET", path: "/api/" }))
      .rejects.toMatchObject<HttpAdapterError>({ code: "HTTP_TIMEOUT" });
    expect(bodyTimer.cancel).toHaveBeenCalledOnce();
  });

  it("rejects oversized bodies before returning them", async () => {
    const declared = createSafeHttpClient(options(vi.fn().mockResolvedValue(new Response("small", {
      status: 200,
      headers: { "content-length": "2048" },
    }))));
    await expect(declared.request({ operation: "large", method: "GET", path: "/api/" }))
      .rejects.toMatchObject<HttpAdapterError>({ code: "HTTP_RESPONSE_TOO_LARGE" });

    const actual = createSafeHttpClient(options(vi.fn().mockResolvedValue(new Response("x".repeat(1_025)))));
    await expect(actual.request({ operation: "large", method: "GET", path: "/api/" }))
      .rejects.toMatchObject<HttpAdapterError>({ code: "HTTP_RESPONSE_TOO_LARGE" });
  });

  it("redacts credential-shaped fields recursively without mutating useful payload fields", () => {
    expect(redactSensitiveValue({
      token: "top-secret",
      nested: { Authorization: "Bearer abc", status: "imported" },
      lines: [{ orderId: "order-1", error: "Api-Token=private-value timeout" }],
    })).toEqual({
      token: "[REDACTED]",
      nested: { Authorization: "[REDACTED]", status: "imported" },
      lines: [{ orderId: "order-1", error: "Api-Token=[REDACTED] timeout" }],
    });
  });

  it("uses only the injected request port and has no network execution at module import", () => {
    const files = ["agora.ts", "contracts.ts", "index.ts", "safe-http.ts", "winerim.ts"];
    const source = files.map((file) => readFileSync(
      `${process.cwd()}/cloudflare/workers/middleware-runtime/src/adapters/http/${file}`,
      "utf8",
    )).join("\n");

    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/https?:\/\/app\.winerim|https?:\/\/[^"']*tpvrent/i);
    expect(source).not.toMatch(/console\.(log|warn|error)/);
  });
});
