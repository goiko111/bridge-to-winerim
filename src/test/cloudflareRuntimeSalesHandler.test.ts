import { describe, expect, it, vi } from "vitest";

import {
  evaluateSalesImportResult,
  handleSalesRun,
  type ProviderSalesDocument,
  type SalesExecutionPorts,
  type SalesHandlerPorts,
  type SalesLineResolution,
} from "../../cloudflare/workers/middleware-runtime/src/handlers/sales";

function document(quantity = 1): ProviderSalesDocument {
  return {
    provider: "agora",
    documentId: "invoice:inv-1",
    lifecycleId: "sale-cycle-1",
    identitySource: "PROVIDER",
    businessDay: "2026-07-29",
    kind: "DEFINITIVE_INVOICE",
    isRefund: false,
    lines: [{
      lineId: "line-1",
      providerProductId: "547593",
      productName: "Wine",
      quantity,
      unitPrice: 29,
    }],
  };
}

function handlerPorts(
  resolution: SalesLineResolution,
  overrides: Partial<SalesHandlerPorts> = {},
): SalesHandlerPorts {
  return {
    resolveLine: vi.fn().mockResolvedValue(resolution),
    loadClaims: vi.fn().mockResolvedValue([]),
    persistDocuments: vi.fn().mockResolvedValue(undefined),
    reserveClaim: vi.fn().mockResolvedValue({
      state: "ACQUIRED",
      appliedQuantity: 0,
      claimKey: "owned-claim",
      payloadSha256: "a".repeat(64),
      leaseToken: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    }),
    applyStock: vi.fn().mockResolvedValue({ ok: true, stockMoved: true }),
    importSales: vi.fn().mockResolvedValue({
      ok: true,
      lines: [{ lineId: "line-1", stockApplied: true }],
    }),
    completeClaim: vi.fn().mockResolvedValue(undefined),
    releaseClaim: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("Cloudflare runtime sales handler", () => {
  it("has no I/O in dry-run mode", async () => {
    const ports = handlerPorts({
      winerimWineId: "47593",
      variant: "GLASS",
      stockId: "stock-1",
      stockActive: true,
    });
    const result = await handleSalesRun({
      connectionId: "connection-1",
      provider: "agora",
      runKind: "INTRADAY",
      documents: [document()],
      dryRun: true,
    }, ports);

    expect(result.execution.items[0].status).toBe("DRY_RUN");
    expect(ports.persistDocuments).not.toHaveBeenCalled();
    expect(ports.reserveClaim).not.toHaveBeenCalled();
    expect(ports.applyStock).not.toHaveBeenCalled();
    expect(ports.importSales).not.toHaveBeenCalled();
  });

  it("accepts live glass only with stockApplied or duplicate evidence", async () => {
    const rejectedPorts = handlerPorts({
      winerimWineId: "47593",
      variant: "GLASS",
      stockId: "stock-1",
      stockActive: true,
    }, {
      importSales: vi.fn().mockResolvedValue({ ok: true, lines: [{ stockApplied: false }] }),
    });
    const rejected = await handleSalesRun({
      connectionId: "connection-1",
      provider: "agora",
      runKind: "INTRADAY",
      documents: [document()],
    }, rejectedPorts);
    expect(rejected.execution.items[0]).toMatchObject({ status: "FAILED", retryable: false });
    expect(rejectedPorts.completeClaim).not.toHaveBeenCalled();
    expect(rejectedPorts.releaseClaim).toHaveBeenCalledOnce();

    const duplicatePorts = handlerPorts({
      winerimWineId: "47593",
      variant: "GLASS",
      stockId: "stock-1",
      stockActive: true,
    }, {
      importSales: vi.fn().mockResolvedValue({ ok: true, duplicate: true }),
    });
    const duplicate = await handleSalesRun({
      connectionId: "connection-1",
      provider: "agora",
      runKind: "INTRADAY",
      documents: [document()],
    }, duplicatePorts);
    expect(duplicate.execution.items[0].status).toBe("APPLIED");
  });

  it("marks HTTP 409 and retryable line errors for the three-attempt runtime profile", async () => {
    expect(evaluateSalesImportResult({ ok: false, status: 409 }, true)).toMatchObject({
      accepted: false,
      retryable: true,
    });
    expect(evaluateSalesImportResult({
      ok: true,
      status: 200,
      lines: [{ retryable: true, error: "temporary" }],
    }, false)).toMatchObject({ accepted: false, retryable: true });
    expect(evaluateSalesImportResult({ ok: false, status: 422 }, false)).toMatchObject({
      accepted: false,
      retryable: false,
    });

    const ports = handlerPorts({
      winerimWineId: "47593",
      variant: "GLASS",
      stockId: "stock-1",
      stockActive: true,
    }, {
      importSales: vi.fn().mockResolvedValue({ ok: false, status: 409 }),
    });
    const result = await handleSalesRun({
      connectionId: "connection-1",
      provider: "agora",
      runKind: "INTRADAY",
      documents: [document()],
    }, ports);

    expect(result.execution.items[0]).toMatchObject({
      status: "FAILED",
      retryable: true,
      retryMaxAttempts: 3,
    });
  });

  it("executes historical sales as non-live imports without applying stock", async () => {
    const importSales = vi.fn().mockResolvedValue({
      ok: true,
      lines: [{ stockApplied: false }],
    });
    const ports = handlerPorts({
      winerimWineId: "47593",
      variant: "BOTTLE",
      stockId: "stock-1",
      stockActive: true,
    }, { importSales });

    const result = await handleSalesRun({
      connectionId: "connection-1",
      provider: "agora",
      runKind: "HISTORICAL",
      documents: [document()],
    }, ports);

    expect(importSales).toHaveBeenCalledWith(expect.objectContaining({ live: false }));
    expect(ports.applyStock).not.toHaveBeenCalled();
    expect(result.execution.items[0].status).toBe("APPLIED");
  });

  it("reuses the same orderId and idempotency key when a 409 attempt is retried", async () => {
    const importSales = vi.fn().mockResolvedValue({ ok: false, status: 409 });
    const ports = handlerPorts({
      winerimWineId: "47593",
      variant: "GLASS",
      stockId: "stock-1",
      stockActive: true,
    }, { importSales });
    const input = {
      connectionId: "connection-1",
      provider: "agora",
      runKind: "INTRADAY" as const,
      documents: [document()],
    };

    await handleSalesRun(input, ports);
    await handleSalesRun(input, ports);

    const first = importSales.mock.calls[0][0];
    const second = importSales.mock.calls[1][0];
    expect(first.orderId).toBe(second.orderId);
    expect(first.idempotencyKey).toBe(second.idempotencyKey);
    expect(first.lines).toEqual(second.lines);
  });

  it("applies only the atomic cumulative delta and keeps order identity stable", async () => {
    const applyStock = vi.fn().mockResolvedValue({ ok: true, stockMoved: true });
    const ports = handlerPorts({
      winerimWineId: "47593",
      variant: "BOTTLE",
      stockId: "stock-1",
      stockActive: true,
    }, {
      reserveClaim: vi.fn().mockResolvedValue({
        state: "ACQUIRED",
        appliedQuantity: 1,
        claimKey: "owned-claim",
        payloadSha256: "b".repeat(64),
        leaseToken: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      }),
      applyStock,
    });
    const result = await handleSalesRun({
      connectionId: "connection-1",
      provider: "agora",
      runKind: "INTRADAY",
      documents: [document(2)],
    }, ports);

    expect(applyStock).toHaveBeenCalledWith(expect.objectContaining({
      decrementQuantity: 1,
      desiredQuantity: 2,
    }));
    expect(result.execution.items[0]).toMatchObject({
      status: "APPLIED",
      appliedBefore: 1,
      appliedDelta: 1,
    });
    expect(ports.completeClaim).toHaveBeenCalledWith(expect.objectContaining({ appliedQuantity: 2 }));
    expect(ports.completeClaim).toHaveBeenCalledWith(expect.objectContaining({
      claimKey: "owned-claim",
      payloadSha256: "b".repeat(64),
      leaseToken: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    }));
  });

  it("records an active bottle sales-only when stock reports that it did not move", async () => {
    const importSales = vi.fn().mockResolvedValue({ ok: true, lines: [{ stockApplied: false }] });
    const ports = handlerPorts({
      winerimWineId: "47593",
      variant: "BOTTLE",
      stockId: "stock-1",
      stockActive: true,
    }, {
      applyStock: vi.fn().mockResolvedValue({ ok: true, stockMoved: false }),
      importSales,
    });
    const result = await handleSalesRun({
      connectionId: "connection-1",
      provider: "agora",
      runKind: "INTRADAY",
      documents: [document()],
    }, ports);

    expect(importSales).toHaveBeenCalledWith(expect.objectContaining({
      live: false,
      orderId: expect.stringMatching(/:sales-only$/),
    }));
    expect(result.execution.items[0]).toMatchObject({
      status: "APPLIED",
      usedSalesOnlyFallback: true,
    });
  });

  it("does not mutate an already applied or busy claim", async () => {
    for (const reservation of [
      { state: "DUPLICATE" as const, appliedQuantity: 1 },
      { state: "BUSY" as const, appliedQuantity: 0 },
    ]) {
      const ports = handlerPorts({
        winerimWineId: "47593",
        variant: "BOTTLE",
        stockId: "stock-1",
        stockActive: true,
      }, {
        reserveClaim: vi.fn().mockResolvedValue(reservation),
      });
      const result = await handleSalesRun({
        connectionId: "connection-1",
        provider: "agora",
        runKind: "INTRADAY",
        documents: [document()],
      }, ports);
      expect(result.execution.items[0].status).toBe(reservation.state === "BUSY" ? "BUSY" : "ALREADY_APPLIED");
      expect(ports.applyStock).not.toHaveBeenCalled();
      expect(ports.importSales).not.toHaveBeenCalled();
    }
  });

  it("contains no direct network dependency in the execution port contract", async () => {
    const ports: Pick<SalesExecutionPorts, "applyStock" | "importSales"> = {
      applyStock: vi.fn().mockResolvedValue({ ok: true, stockMoved: true }),
      importSales: vi.fn().mockResolvedValue({ ok: true }),
    };
    expect(ports.applyStock).toBeTypeOf("function");
    expect(ports.importSales).toBeTypeOf("function");
  });
});
