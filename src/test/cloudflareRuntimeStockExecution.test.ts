import { describe, expect, it, vi } from "vitest";
import {
  decideWinerimMutationResponse,
  executeWinerimMutationPlan,
  executeWinerimStockMutation,
  planWinerimStockMutation,
  WINERIM_MUTATION_MAX_ATTEMPTS,
  WINERIM_MUTATION_RETRY_DELAY_MS,
  WinerimMutationPlan,
  WinerimMutationResponse,
  WinerimMutationTransport,
} from "../../cloudflare/workers/middleware-runtime/src/handlers/stock";

const bottle = { wineId: "wine-42", stockId: 4201, variant: "bottle" as const };
const glass = { wineId: "wine-42", stockId: 4202, variant: "glass" as const };

function glassInput(orderId = "provider:glass:1") {
  return {
    mode: "operational" as const,
    orderId,
    soldAt: "2026-08-02T12:00:00Z",
    quantity: 1,
    soldStock: glass,
    stockSource: bottle,
  };
}

function transportFor(responses: WinerimMutationResponse[]): WinerimMutationTransport & {
  send: ReturnType<typeof vi.fn>;
  sleep: ReturnType<typeof vi.fn>;
} {
  const queue = [...responses];
  return {
    send: vi.fn(async () => {
      const response = queue.shift();
      if (!response) throw new Error("test response queue exhausted");
      return response;
    }),
    sleep: vi.fn(async () => undefined),
  };
}

function absoluteStockTransport(
  responses: WinerimMutationResponse[],
  readback: { stockId: number; stock: number } | Error,
): WinerimMutationTransport & {
  send: ReturnType<typeof vi.fn>;
  readStock: ReturnType<typeof vi.fn>;
  sleep: ReturnType<typeof vi.fn>;
} {
  const transport = transportFor(responses);
  return {
    ...transport,
    readStock: vi.fn(async () => {
      if (readback instanceof Error) throw readback;
      return readback;
    }),
  };
}

describe("Cloudflare runtime Winerim mutation execution", () => {
  it("certifies live glass stock only with stockApplied true or duplicate true", async () => {
    for (const line of [
      { orderId: "provider:glass:1", status: "imported", stockApplied: true },
      { orderId: "provider:glass:1", status: "duplicate", duplicate: true, stockApplied: false },
    ]) {
      const transport = transportFor([{ status: 200, body: { imported: 1, sales: [line] } }]);
      const result = await executeWinerimStockMutation(glassInput(), transport);

      expect(result.ok).toBe(true);
      expect(result.certifiedOrderIds).toEqual(["provider:glass:1"]);
      expect(transport.send).toHaveBeenCalledOnce();
    }

    const uncertified = transportFor([{
      status: 200,
      body: {
        imported: 1,
        sales: [{ orderId: "provider:glass:1", status: "imported", stockApplied: false }],
      },
    }]);
    const failed = await executeWinerimStockMutation(glassInput(), uncertified);
    expect(failed).toMatchObject({
      ok: false,
      retryable: false,
      reason: "glass_line_not_certified_stock_applied_or_duplicate",
    });
  });

  it("retries a 409 at most three times with the exact same request and payload", async () => {
    const transport = transportFor([
      { status: 409, body: { error: "Conflict" } },
      { status: 409, body: { error: "Conflict" } },
      { status: 409, body: { error: "Conflict" } },
    ]);
    const result = await executeWinerimStockMutation(glassInput(), transport);
    const requests = transport.send.mock.calls.map(([request]) => request);

    expect(WINERIM_MUTATION_MAX_ATTEMPTS).toBe(3);
    expect(transport.send).toHaveBeenCalledTimes(3);
    expect(transport.sleep).toHaveBeenCalledTimes(2);
    expect(transport.sleep).toHaveBeenNthCalledWith(1, WINERIM_MUTATION_RETRY_DELAY_MS);
    expect(requests[1]).toBe(requests[0]);
    expect(requests[2]).toBe(requests[0]);
    expect(requests[2].body).toBe(requests[0].body);
    expect(result).toMatchObject({
      ok: false,
      retryable: true,
      reason: "winerim_mutation_attempts_exhausted",
    });
  });

  it("accepts a successful same-payload retry without changing orderId", async () => {
    const transport = transportFor([
      { status: 409, body: { error: "Conflict" } },
      {
        status: 200,
        body: {
          imported: 1,
          sales: [{ orderId: "provider:glass:1", status: "imported", stockApplied: true }],
        },
      },
    ]);
    const result = await executeWinerimStockMutation(glassInput(), transport);
    const requests = transport.send.mock.calls.map(([request]) => request);

    expect(result.ok).toBe(true);
    expect(requests[1]).toBe(requests[0]);
    expect(requests[1].body.sales[0].orderId).toBe("provider:glass:1");
  });

  it("retries only the lines explicitly marked retryable in a partial 200 response", async () => {
    const firstLine = {
      stockId: 4202,
      qty: 1,
      soldAt: "2026-08-02T12:00:00Z",
      orderId: "provider:glass:ok",
    };
    const secondLine = {
      stockId: 4202,
      qty: 1,
      soldAt: "2026-08-02T12:00:01Z",
      orderId: "provider:glass:retry",
    };
    const plan: WinerimMutationPlan = {
      mode: "operational",
      soldStock: glass,
      stockSource: bottle,
      mutatesStock: true,
      requiresLiveStockCertification: true,
      request: {
        kind: "sales-import",
        method: "POST",
        path: "/api/v2/sales/import",
        body: { live: true, sales: [firstLine, secondLine] },
      },
    };
    const transport = transportFor([
      {
        status: 200,
        body: {
          imported: 1,
          sales: [{ orderId: firstLine.orderId, status: "imported", stockApplied: true }],
          errors: [{ orderId: secondLine.orderId, retryable: true, error: "bottle busy" }],
        },
      },
      {
        status: 200,
        body: {
          imported: 1,
          sales: [{ orderId: secondLine.orderId, status: "imported", stockApplied: true }],
        },
      },
    ]);

    const result = await executeWinerimMutationPlan(plan, transport);
    const secondRequest = transport.send.mock.calls[1][0];

    expect(result.ok).toBe(true);
    expect(result.certifiedOrderIds).toEqual([firstLine.orderId, secondLine.orderId]);
    expect(secondRequest.body).toEqual({ live: true, sales: [secondLine] });
    expect(secondRequest.body.sales[0]).toBe(secondLine);
  });

  it("does not retry non-retryable lines or terminal HTTP statuses", async () => {
    const plan = planWinerimStockMutation(glassInput());
    const lineDecision = decideWinerimMutationResponse({
      plan,
      response: {
        status: 200,
        body: {
          failed: 1,
          errors: [{ orderId: "provider:glass:1", retryable: false, error: "invalid stockId" }],
        },
      },
    });
    expect(lineDecision).toMatchObject({
      action: "terminal",
      retryableOrderIds: [],
      terminalOrderIds: ["provider:glass:1"],
    });

    for (const status of [400, 403, 404, 422]) {
      const transport = transportFor([{ status, body: { error: "rejected" } }]);
      const result = await executeWinerimStockMutation(glassInput(), transport);
      expect(result).toMatchObject({ ok: false, retryable: false });
      expect(transport.send).toHaveBeenCalledOnce();
      expect(transport.sleep).not.toHaveBeenCalled();
    }
  });

  it("accepts historical imported and duplicate lines without live or stock certification", async () => {
    for (const line of [
      { orderId: "history:glass:1", status: "imported", stockApplied: false },
      { orderId: "history:glass:1", status: "duplicate", duplicate: true },
    ]) {
      const transport = transportFor([{ status: 200, body: { sales: [line] } }]);
      const result = await executeWinerimStockMutation({
        mode: "historical",
        orderId: "history:glass:1",
        soldAt: "2026-05-01",
        quantity: 5,
        soldStock: glass,
        stockSource: bottle,
        currentSourceStock: 99,
      }, transport);
      const request = transport.send.mock.calls[0][0];

      expect(result.ok).toBe(true);
      expect(request.kind).toBe("sales-import");
      expect("live" in request.body).toBe(false);
      expect(transport.send).toHaveBeenCalledOnce();
    }
  });

  it("retries an absolute stock 409 with the same PUT payload and certifies an exact readback", async () => {
    const transport = absoluteStockTransport([
      { status: 409, body: { error: "Conflict" } },
      { status: 200, body: { success: true } },
    ], { stockId: 4201, stock: 5 });
    const result = await executeWinerimStockMutation({
      mode: "operational",
      orderId: "provider:bottle:1",
      soldAt: "2026-08-02",
      quantity: 1,
      soldStock: bottle,
      stockSource: bottle,
      currentSourceStock: 6,
    }, transport);
    const requests = transport.send.mock.calls.map(([request]) => request);

    expect(result.ok).toBe(true);
    expect(result.reason).toBe("absolute_stock_put_readback_certified");
    expect(requests).toHaveLength(2);
    expect(transport.readStock).toHaveBeenCalledOnce();
    expect(transport.readStock).toHaveBeenCalledWith(4201);
    expect(requests[0]).toBe(requests[1]);
    expect(requests[0]).toMatchObject({
      kind: "stock-put",
      path: "/api/v2/stock/4201",
      body: { stock: 5 },
    });
  });

  it("does not certify a bottle or magnum PUT without an exact post-write readback", async () => {
    for (const [soldStock, readback] of [
      [bottle, { stockId: 4201, stock: 4 }],
      [{ wineId: "wine-42", stockId: 4203, variant: "magnum" as const }, { stockId: 9999, stock: 5 }],
    ] as const) {
      const transport = absoluteStockTransport(
        [{ status: 200, body: { success: true } }],
        readback,
      );
      const result = await executeWinerimStockMutation({
        mode: "operational",
        orderId: `provider:${soldStock.variant}:mismatch`,
        soldAt: "2026-08-02",
        quantity: 1,
        soldStock,
        stockSource: soldStock,
        currentSourceStock: 6,
      }, transport);

      expect(result).toMatchObject({
        ok: false,
        retryable: true,
        reason: "absolute_stock_readback_mismatch",
      });
      expect(transport.send).toHaveBeenCalledOnce();
      expect(transport.readStock).toHaveBeenCalledOnce();
      expect(transport.sleep).not.toHaveBeenCalled();
    }
  });

  it("fails retryable when absolute stock readback times out or is unavailable", async () => {
    const timeout = absoluteStockTransport(
      [{ status: 200, body: { success: true } }],
      new Error("HTTP_TIMEOUT"),
    );
    const timedOut = await executeWinerimStockMutation({
      mode: "operational",
      orderId: "provider:bottle:timeout",
      soldAt: "2026-08-02",
      quantity: 1,
      soldStock: bottle,
      stockSource: bottle,
      currentSourceStock: 6,
    }, timeout);
    expect(timedOut).toMatchObject({
      ok: false,
      retryable: true,
      reason: "absolute_stock_readback_failed",
    });
    expect(timedOut.attempts[0]).toMatchObject({ readbackError: "HTTP_TIMEOUT" });

    const unavailable = transportFor([{ status: 200, body: { success: true } }]);
    const missingPort = await executeWinerimStockMutation({
      mode: "operational",
      orderId: "provider:bottle:no-readback-port",
      soldAt: "2026-08-02",
      quantity: 1,
      soldStock: bottle,
      stockSource: bottle,
      currentSourceStock: 6,
    }, unavailable);
    expect(missingPort).toMatchObject({
      ok: false,
      retryable: true,
      reason: "absolute_stock_readback_unavailable",
    });
  });
});
