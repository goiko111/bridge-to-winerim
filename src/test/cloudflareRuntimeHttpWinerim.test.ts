import { describe, expect, it, vi } from "vitest";

import {
  createWinerimMutationTransport,
  HttpAdapterError,
  type HttpAdapterLogEvent,
  type HttpTimerPort,
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
