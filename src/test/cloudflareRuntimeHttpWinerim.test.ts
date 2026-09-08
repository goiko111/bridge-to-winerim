import { describe, expect, it, vi } from "vitest";

import {
  createWinerimMutationTransport,
  HttpAdapterError,
  type HttpAdapterLogEvent,
  type HttpTimerPort,
  WinerimStockReadbackError,
} from "../../cloudflare/workers/middleware-runtime/src/adapters/http";
import {
  executeWinerimMutationPlan,
  planWinerimStockMutation,
  type WinerimMutationHttpRequest,
} from "../../cloudflare/workers/middleware-runtime/src/handlers/stock";

function timer(): HttpTimerPort {
  let now = 5_000;
  return {
    now: () => now++,
    schedule: vi.fn(() => Symbol("timer")),
    cancel: vi.fn(),
  };
}

function timeoutTimer(): HttpTimerPort {
  return {
    now: vi.fn(() => 5_000),
    schedule: vi.fn((callback) => {
      queueMicrotask(callback);
      return Symbol("timer");
    }),
    cancel: vi.fn(),
  };
}

function stockPage(input: {
  page?: number;
  totalPages?: number;
  totalCount?: number;
  stocks?: unknown[];
} = {}): Response {
  const stocks = input.stocks ?? [{ id: 4201, stock: 4 }];
  return jsonResponse({
    success: true,
    pagination: {
      page: input.page ?? 1,
      limit: 100,
      total_count: input.totalCount ?? stocks.length,
      total_pages: input.totalPages ?? 1,
    },
    stocks,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Winerim stock and sales HTTP transport", () => {
  it("does not execute HTTP, credential or sleep ports during construction", () => {
    const request = vi.fn();
    const credential = { read: vi.fn() };
    const sleep = vi.fn();

    const transport = createWinerimMutationTransport({
      baseUrl: "https://winerim.example.test",
      allowedHosts: ["winerim.example.test"],
      credential,
      request: { request },
      timer: timer(),
      sleep,
    });

    expect(transport).toBeDefined();
    expect(request).not.toHaveBeenCalled();
    expect(credential.read).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("sends live sales/import through the current mutation contract without logging secrets", async () => {
    const logs: HttpAdapterLogEvent[] = [];
    const request = vi.fn().mockResolvedValue(jsonResponse({
      sales: [{ orderId: "order-1", status: "imported", stockApplied: true }],
      apiToken: "echoed-secret",
    }));
    const transport = createWinerimMutationTransport({
      baseUrl: "https://winerim.example.test",
      allowedHosts: ["winerim.example.test"],
      credential: { read: () => "winerim-super-secret" },
      request: { request },
      timer: timer(),
      sleep: vi.fn().mockResolvedValue(undefined),
      logger: { write: (event) => { logs.push(event); } },
    });
    const mutation: WinerimMutationHttpRequest = {
      kind: "sales-import",
      method: "POST",
      path: "/api/v2/sales/import",
      body: {
        live: true,
        sales: [{ stockId: 4202, qty: 1, soldAt: "2026-08-02T12:00:00Z", orderId: "order-1" }],
      },
    };

    const result = await transport.send(mutation);

    expect(result).toMatchObject({
      status: 200,
      body: {
        sales: [{ orderId: "order-1", status: "imported", stockApplied: true }],
        apiToken: "[REDACTED]",
      },
    });
    const [url, init] = request.mock.calls[0];
    expect(url).toBe("https://winerim.example.test/api/v2/sales/import");
    expect(init).toMatchObject({
      method: "POST",
      redirect: "manual",
      headers: expect.objectContaining({
        "Content-Type": "application/json",
        "WINERIM-API-TOKEN": "winerim-super-secret",
      }),
    });
    expect(JSON.parse(init.body)).toEqual(mutation.body);
    expect(JSON.stringify(logs)).not.toContain("winerim-super-secret");
    expect(JSON.stringify(logs)).not.toContain("echoed-secret");
  });

  it("sends absolute stock PUT only to a positive numeric stock path", async () => {
    const request = vi.fn().mockResolvedValue(jsonResponse({ stock: 4 }));
    const transport = createWinerimMutationTransport({
      baseUrl: "https://winerim.example.test",
      allowedHosts: ["winerim.example.test"],
      credential: { read: () => "credential" },
      request: { request },
      timer: timer(),
      sleep: vi.fn().mockResolvedValue(undefined),
    });

    await transport.send({
      kind: "stock-put",
      method: "PUT",
      path: "/api/v2/stock/4201",
      body: { stock: 4 },
    });

    expect(request.mock.calls[0][0]).toBe("https://winerim.example.test/api/v2/stock/4201");
    expect(request.mock.calls[0][1]).toMatchObject({ method: "PUT", body: JSON.stringify({ stock: 4 }) });
  });

  it("certifies a 2xx absolute PUT only after the real paginated stock readback matches", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ stock: 4 }))
      .mockResolvedValueOnce(stockPage());
    const transport = createWinerimMutationTransport({
      baseUrl: "https://winerim.example.test",
      allowedHosts: ["winerim.example.test"],
      credential: { read: () => "credential" },
      request: { request },
      timer: timer(),
      sleep: vi.fn().mockResolvedValue(undefined),
    });
    const plan = planWinerimStockMutation({
      mode: "operational",
      orderId: "order-bottle-readback-required",
      soldAt: "2026-08-02T12:00:00Z",
      quantity: 1,
      soldStock: { wineId: "42", stockId: 4201, variant: "bottle" },
      stockSource: { wineId: "42", stockId: 4201, variant: "bottle" },
      currentSourceStock: 5,
    });

    const result = await executeWinerimMutationPlan(plan, transport);

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][0]).toBe("https://winerim.example.test/api/v2/stock?page=1&limit=100");
    expect(request.mock.calls[1][1]).toMatchObject({ method: "GET", body: undefined });
    expect(result).toMatchObject({
      ok: true,
      retryable: false,
      reason: "absolute_stock_put_readback_certified",
    });
  });

  it("fails retryable when the real post-write stock readback does not match the PUT target", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ stock: 4 }))
      .mockResolvedValueOnce(stockPage({ stocks: [{ id: 4201, stock: 3 }] }));
    const transport = createWinerimMutationTransport({
      baseUrl: "https://winerim.example.test",
      allowedHosts: ["winerim.example.test"],
      credential: { read: () => "credential" },
      request: { request },
      timer: timer(),
      sleep: vi.fn().mockResolvedValue(undefined),
    });
    const plan = planWinerimStockMutation({
      mode: "operational",
      orderId: "order-bottle-readback-mismatch",
      soldAt: "2026-08-02T12:00:00Z",
      quantity: 1,
      soldStock: { wineId: "42", stockId: 4201, variant: "bottle" },
      stockSource: { wineId: "42", stockId: 4201, variant: "bottle" },
      currentSourceStock: 5,
    });

    await expect(executeWinerimMutationPlan(plan, transport)).resolves.toMatchObject({
      ok: false,
      retryable: true,
      reason: "absolute_stock_readback_mismatch",
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("paginates the documented stock listing and normalizes one exact stock row", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(stockPage({ page: 1, totalPages: 2, totalCount: 2, stocks: [{ id: 4100, stock: 8 }] }))
      .mockResolvedValueOnce(stockPage({ page: 2, totalPages: 2, totalCount: 2, stocks: [{ id: 4201, stock: 4 }] }));
    const transport = createWinerimMutationTransport({
      baseUrl: "https://winerim.example.test",
      allowedHosts: ["winerim.example.test"],
      credential: { read: () => "credential" },
      request: { request },
      timer: timer(),
      sleep: vi.fn().mockResolvedValue(undefined),
    });

    await expect(transport.readStock!(4201)).resolves.toEqual({ stockId: 4201, stock: 4 });
    expect(request.mock.calls.map(([url]) => url)).toEqual([
      "https://winerim.example.test/api/v2/stock?page=1&limit=100",
      "https://winerim.example.test/api/v2/stock?page=2&limit=100",
    ]);
  });

  it("fails closed for ambiguous, missing or malformed stock listing responses", async () => {
    const cases: Array<{
      responses: Response[];
      code: string;
    }> = [
      {
        responses: [
          stockPage({ page: 1, totalPages: 2, totalCount: 2, stocks: [{ id: 4201, stock: 4 }] }),
          stockPage({ page: 2, totalPages: 2, totalCount: 2, stocks: [{ id: 4201, stock: 4 }] }),
        ],
        code: "WINERIM_STOCK_READBACK_AMBIGUOUS",
      },
      {
        responses: [stockPage({ stocks: [{ id: 4100, stock: 8 }] })],
        code: "WINERIM_STOCK_READBACK_NOT_FOUND",
      },
      {
        responses: [stockPage({ stocks: [{ id: "4201", stock: 4 }] })],
        code: "WINERIM_STOCK_READBACK_INVALID_RESPONSE",
      },
      {
        responses: [stockPage({ stocks: [{ id: 4201, stock: "4" }] })],
        code: "WINERIM_STOCK_READBACK_INVALID_RESPONSE",
      },
    ];

    for (const testCase of cases) {
      const queue = [...testCase.responses];
      const transport = createWinerimMutationTransport({
        baseUrl: "https://winerim.example.test",
        allowedHosts: ["winerim.example.test"],
        credential: { read: () => "credential" },
        request: { request: vi.fn(async () => queue.shift() ?? stockPage()) },
        timer: timer(),
        sleep: vi.fn().mockResolvedValue(undefined),
      });
      await expect(transport.readStock!(4201)).rejects.toMatchObject<WinerimStockReadbackError>({
        code: testCase.code,
      });
    }
  });

  it("propagates safe HTTP timeout and rejects non-2xx stock readback", async () => {
    const timeoutRequest = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("timeout")));
    }));
    const timedOut = createWinerimMutationTransport({
      baseUrl: "https://winerim.example.test",
      allowedHosts: ["winerim.example.test"],
      credential: { read: () => "credential" },
      request: { request: timeoutRequest },
      timer: timeoutTimer(),
      timeoutMs: 10,
      sleep: vi.fn().mockResolvedValue(undefined),
    });
    await expect(timedOut.readStock!(4201)).rejects.toMatchObject<HttpAdapterError>({ code: "HTTP_TIMEOUT" });

    const rejected = createWinerimMutationTransport({
      baseUrl: "https://winerim.example.test",
      allowedHosts: ["winerim.example.test"],
      credential: { read: () => "credential" },
      request: { request: vi.fn().mockResolvedValue(jsonResponse({ error: "denied" }, 403)) },
      timer: timer(),
      sleep: vi.fn().mockResolvedValue(undefined),
    });
    await expect(rejected.readStock!(4201)).rejects.toMatchObject<WinerimStockReadbackError>({
      code: "WINERIM_STOCK_READBACK_HTTP_ERROR",
    });
  });

  it("is compatible with existing 409 retry semantics and preserves the same payload", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: "Conflict" }, 409))
      .mockResolvedValueOnce(jsonResponse({
        sales: [{ orderId: "order-retry", status: "imported", stockApplied: true }],
      }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const transport = createWinerimMutationTransport({
      baseUrl: "https://winerim.example.test",
      allowedHosts: ["winerim.example.test"],
      credential: { read: () => "credential" },
      request: { request },
      timer: timer(),
      sleep,
    });
    const plan = planWinerimStockMutation({
      mode: "operational",
      orderId: "order-retry",
      soldAt: "2026-08-02T12:00:00Z",
      quantity: 1,
      soldStock: { wineId: "42", stockId: 4202, variant: "glass" },
      stockSource: { wineId: "42", stockId: 4201, variant: "bottle" },
    });

    const result = await executeWinerimMutationPlan(plan, transport);

    expect(result.ok).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][1].body).toBe(request.mock.calls[0][1].body);
    expect(JSON.parse(request.mock.calls[1][1].body).sales[0].orderId).toBe("order-retry");
    expect(sleep).toHaveBeenCalledWith(1_000);
  });

  it("rejects malformed or out-of-contract mutation paths before credentials and HTTP", async () => {
    const request = vi.fn();
    const credential = { read: vi.fn() };
    const transport = createWinerimMutationTransport({
      baseUrl: "https://winerim.example.test",
      allowedHosts: ["winerim.example.test"],
      credential,
      request: { request },
      timer: timer(),
      sleep: vi.fn().mockResolvedValue(undefined),
    });
    const invalid = {
      kind: "stock-put",
      method: "PUT",
      path: "/api/v2/stock/4201/../../admin",
      body: { stock: 4 },
    } as WinerimMutationHttpRequest;

    await expect(transport.send(invalid)).rejects.toMatchObject<HttpAdapterError>({
      code: "WINERIM_INVALID_MUTATION_REQUEST",
    });
    expect(credential.read).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("delegates retry sleeping to the injected port", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const transport = createWinerimMutationTransport({
      baseUrl: "https://winerim.example.test",
      allowedHosts: ["winerim.example.test"],
      credential: { read: () => "credential" },
      request: { request: vi.fn() },
      timer: timer(),
      sleep,
    });

    await transport.sleep(250);

    expect(sleep).toHaveBeenCalledWith(250);
  });
});
