import { describe, expect, it, vi } from "vitest";

import {
  planSalesRun,
  type ProviderSalesDocument,
  type SalesLineResolution,
  type SalesPlanningPorts,
} from "../../cloudflare/workers/middleware-runtime/src/handlers/sales";

function document(overrides: Partial<ProviderSalesDocument> = {}): ProviderSalesDocument {
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
      productName: "C Vi de Glass",
      quantity: 1,
      unitPrice: 6,
    }],
    ...overrides,
  };
}

function ports(resolution: SalesLineResolution, appliedQuantity = 0): SalesPlanningPorts {
  return {
    resolveLine: vi.fn().mockResolvedValue(resolution),
    loadClaims: vi.fn().mockImplementation(async (keys: string[]) => keys.map((claimKey) => ({
      claimKey,
      state: "COMPLETE" as const,
      appliedQuantity,
    }))),
  };
}

describe("Cloudflare runtime sales planner", () => {
  it("plans definitive and intraday active glass as live sales/import", async () => {
    const resolution: SalesLineResolution = {
      winerimWineId: "47593",
      variant: "GLASS",
      stockId: "stock-glass-1",
      stockActive: true,
    };

    for (const runKind of ["CLOSED_DAY", "INTRADAY"] as const) {
      const plan = await planSalesRun({
        connectionId: "connection-1",
        provider: "agora",
        runKind,
        documents: [document()],
      }, ports(resolution));

      expect(plan.blocked).toEqual([]);
      expect(plan.intents).toHaveLength(1);
      expect(plan.intents[0].action).toMatchObject({
        kind: "SALES_IMPORT",
        live: true,
        requireStockApplied: true,
      });
    }
  });

  it("keeps historical imports sales-only for both glass and bottle", async () => {
    for (const variant of ["GLASS", "BOTTLE"] as const) {
      const plan = await planSalesRun({
        connectionId: "connection-1",
        provider: "agora",
        runKind: "HISTORICAL",
        documents: [document()],
      }, ports({
        winerimWineId: "47593",
        variant,
        stockId: "stock-1",
        stockActive: true,
      }));

      expect(plan.intents[0].action).toMatchObject({
        kind: "SALES_IMPORT",
        live: false,
        requireStockApplied: false,
      });
    }
  });

  it("observes OpenTicket by default without planning a mutation", async () => {
    const plan = await planSalesRun({
      connectionId: "connection-1",
      provider: "agora",
      runKind: "OPEN_TICKET",
      documents: [document({
        documentId: "open-ticket:sale-cycle-1",
        kind: "OPEN_TICKET",
      })],
    }, ports({
      winerimWineId: "47593",
      variant: "BOTTLE",
      stockId: "stock-1",
      stockActive: true,
    }));

    expect(plan.observations).toHaveLength(1);
    expect(plan.intents).toEqual([]);
  });

  it("shares claim identity between provisional OpenTicket and its definitive invoice", async () => {
    const resolution: SalesLineResolution = {
      winerimWineId: "47593",
      variant: "BOTTLE",
      stockId: "stock-1",
      stockActive: true,
    };
    const openPlan = await planSalesRun({
      connectionId: "connection-1",
      provider: "agora",
      runKind: "OPEN_TICKET",
      openTicketPolicy: "PROVISIONAL_STOCK",
      documents: [document({
        documentId: "open-ticket:sale-cycle-1",
        kind: "OPEN_TICKET",
      })],
    }, ports(resolution));
    const claimKey = openPlan.intents[0].claimKey;

    const finalPlan = await planSalesRun({
      connectionId: "connection-1",
      provider: "agora",
      runKind: "INTRADAY",
      documents: [document()],
    }, {
      resolveLine: vi.fn().mockResolvedValue(resolution),
      loadClaims: vi.fn().mockResolvedValue([{ claimKey, state: "COMPLETE", appliedQuantity: 1 }]),
    });

    expect(finalPlan.intents).toEqual([]);
    expect(finalPlan.noops).toEqual([expect.objectContaining({
      claimKey,
      reason: "ALREADY_APPLIED",
      desiredQuantity: 1,
      appliedQuantity: 1,
    })]);
  });

  it("keeps orderId stable across retries and line ordering", async () => {
    const resolution: SalesLineResolution = {
      winerimWineId: "47593",
      variant: "GLASS",
      stockId: "stock-glass-1",
      stockActive: true,
    };
    const lines = [
      { lineId: "b", providerProductId: "2", productName: "C Wine", quantity: 1 },
      { lineId: "a", providerProductId: "1", productName: "C Wine", quantity: 2 },
    ];
    const first = await planSalesRun({
      connectionId: "connection-1",
      provider: "agora",
      runKind: "INTRADAY",
      documents: [document({ lines })],
    }, ports(resolution));
    const second = await planSalesRun({
      connectionId: "connection-1",
      provider: "agora",
      runKind: "INTRADAY",
      documents: [document({ lines: [...lines].reverse() })],
    }, ports(resolution));

    expect(first.intents[0].claimKey).toBe(second.intents[0].claimKey);
    expect(first.intents[0].orderId).toBe(second.intents[0].orderId);
    expect(first.intents[0].desiredQuantity).toBe(3);
  });

  it("deduplicates the same definitive invoice even when provider line order changes", async () => {
    const resolution: SalesLineResolution = {
      winerimWineId: "47593",
      variant: "GLASS",
      stockActive: true,
    };
    const lines = [
      { lineId: "b", providerProductId: "2", productName: "C Wine", quantity: 1 },
      { lineId: "a", providerProductId: "1", productName: "C Wine", quantity: 2 },
    ];
    const plan = await planSalesRun({
      connectionId: "connection-1",
      provider: "agora",
      runKind: "INTRADAY",
      documents: [document({ lines }), document({ lines: [...lines].reverse() })],
    }, ports(resolution));

    expect(plan.blocked).toEqual([]);
    expect(plan.documents).toHaveLength(1);
    expect(plan.intents[0].desiredQuantity).toBe(3);
  });

  it("fails closed for refunds, fractional history and unstable provisional tickets", async () => {
    const resolution: SalesLineResolution = {
      winerimWineId: "47593",
      variant: "BOTTLE",
      stockId: "stock-1",
      stockActive: true,
    };
    const refund = await planSalesRun({
      connectionId: "connection-1",
      provider: "agora",
      runKind: "INTRADAY",
      documents: [document({ isRefund: true })],
    }, ports(resolution));
    expect(refund.blocked[0].reason).toBe("REFUND_REQUIRES_RECONCILIATION");

    const fractional = await planSalesRun({
      connectionId: "connection-1",
      provider: "agora",
      runKind: "HISTORICAL",
      documents: [document({ lines: [{ ...document().lines[0], quantity: 0.5 }] })],
    }, ports(resolution));
    expect(fractional.blocked[0].reason).toBe("FRACTIONAL_HISTORICAL_QUANTITY");

    const operationalFractional = await planSalesRun({
      connectionId: "connection-1",
      provider: "agora",
      runKind: "INTRADAY",
      documents: [document({
        lines: [
          { ...document().lines[0], lineId: "fraction-1", quantity: 0.5 },
          { ...document().lines[0], lineId: "fraction-2", quantity: 0.5 },
        ],
      })],
    }, ports(resolution));
    expect(operationalFractional.intents).toEqual([]);
    expect(operationalFractional.blocked).toEqual([
      expect.objectContaining({ reason: "INVALID_QUANTITY", lineId: "fraction-1" }),
      expect.objectContaining({ reason: "INVALID_QUANTITY", lineId: "fraction-2" }),
    ]);

    const fallbackTicket = await planSalesRun({
      connectionId: "connection-1",
      provider: "agora",
      runKind: "OPEN_TICKET",
      openTicketPolicy: "PROVISIONAL_STOCK",
      documents: [document({ kind: "OPEN_TICKET", identitySource: "FALLBACK" })],
    }, ports(resolution));
    expect(fallbackTicket.blocked[0].reason).toBe("OPEN_TICKET_IDENTITY_NOT_STABLE");
  });
});
