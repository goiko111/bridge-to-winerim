import { describe, expect, it, vi } from "vitest";

import {
  buildLegacySalesClaimKey,
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

  it("shares claim identity when the definitive invoice closes on a later business day", async () => {
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
        businessDay: "2026-07-29",
      })],
    }, ports(resolution));
    expect(openPlan.intents[0].claimKey).toMatch(/^sales-claim:v2:/);
    const claimKey = await buildLegacySalesClaimKey({
      connectionId: "connection-1",
      provider: "agora",
      businessDay: "2026-07-29",
      lifecycleId: "sale-cycle-1",
      winerimWineId: "47593",
      variant: "BOTTLE",
    });

    const finalPlan = await planSalesRun({
      connectionId: "connection-1",
      provider: "agora",
      runKind: "INTRADAY",
      documents: [document({ businessDay: "2026-07-30" })],
    }, {
      resolveLine: vi.fn().mockResolvedValue(resolution),
      loadClaims: vi.fn().mockResolvedValue([]),
      loadReconciliationClaims: vi.fn().mockResolvedValue([{
        claimKey,
        state: "COMPLETE",
        appliedQuantity: 1,
        lifecycleId: "sale-cycle-1",
        winerimWineId: "47593",
        variant: "BOTTLE",
        sourceDocumentIds: ["open-ticket:sale-cycle-1"],
        sourceLineIds: ["line-1"],
        sourceDocumentKind: "OPEN_TICKET",
      }]),
    });

    expect(finalPlan.intents).toEqual([]);
    expect(finalPlan.noops).toEqual([expect.objectContaining({
      claimKey,
      reason: "ALREADY_APPLIED",
      desiredQuantity: 1,
      appliedQuantity: 1,
    })]);
  });

  it("blocks a quantity reduction after provisional stock instead of treating it as applied", async () => {
    const resolution: SalesLineResolution = {
      winerimWineId: "47593",
      variant: "BOTTLE",
      stockId: "stock-1",
      stockActive: true,
    };
    const provisional = await planSalesRun({
      connectionId: "connection-1",
      provider: "agora",
      runKind: "OPEN_TICKET",
      openTicketPolicy: "PROVISIONAL_STOCK",
      documents: [document({
        documentId: "open-ticket:sale-cycle-1",
        kind: "OPEN_TICKET",
        lines: [{ ...document().lines[0], quantity: 2 }],
      })],
    }, ports(resolution));
    const claimKey = provisional.intents[0].claimKey;

    const reduced = await planSalesRun({
      connectionId: "connection-1",
      provider: "agora",
      runKind: "OPEN_TICKET",
      openTicketPolicy: "PROVISIONAL_STOCK",
      documents: [document({
        documentId: "open-ticket:sale-cycle-1",
        kind: "OPEN_TICKET",
        lines: [{ ...document().lines[0], quantity: 1 }],
      })],
    }, {
      resolveLine: vi.fn().mockResolvedValue(resolution),
      loadClaims: vi.fn().mockResolvedValue([{ claimKey, state: "COMPLETE", appliedQuantity: 2 }]),
    });

    expect(reduced.intents).toEqual([]);
    expect(reduced.noops).toEqual([]);
    expect(reduced.blocked).toEqual([expect.objectContaining({
      reason: "REFUND_REQUIRES_RECONCILIATION",
      detail: expect.stringContaining("fell from 2 applied unit(s) to 1"),
    })]);
  });

  it("blocks deleted or zeroed provisional lines for explicit reconciliation", async () => {
    const resolution: SalesLineResolution = {
      winerimWineId: "47593",
      variant: "BOTTLE",
      stockId: "stock-1",
      stockActive: true,
    };
    const provisional = await planSalesRun({
      connectionId: "connection-1",
      provider: "agora",
      runKind: "OPEN_TICKET",
      openTicketPolicy: "PROVISIONAL_STOCK",
      documents: [document({
        documentId: "open-ticket:sale-cycle-1",
        kind: "OPEN_TICKET",
      })],
    }, ports(resolution));
    const claimKey = provisional.intents[0].claimKey;

    const zeroed = await planSalesRun({
      connectionId: "connection-1",
      provider: "agora",
      runKind: "OPEN_TICKET",
      openTicketPolicy: "PROVISIONAL_STOCK",
      documents: [document({
        documentId: "open-ticket:sale-cycle-1",
        kind: "OPEN_TICKET",
        lines: [{ ...document().lines[0], quantity: 0 }],
      })],
    }, {
      resolveLine: vi.fn().mockResolvedValue(resolution),
      loadClaims: vi.fn().mockResolvedValue([{ claimKey, state: "COMPLETE", appliedQuantity: 1 }]),
    });

    expect(zeroed.intents).toEqual([]);
    expect(zeroed.noops).toEqual([]);
    expect(zeroed.blocked).toEqual([expect.objectContaining({
      reason: "REFUND_REQUIRES_RECONCILIATION",
      lineId: "line-1",
      detail: expect.stringContaining("after 1 unit(s) were applied provisionally"),
    })]);

    const loadReconciliationClaims = vi.fn().mockResolvedValue([{
      claimKey,
      state: "COMPLETE" as const,
      appliedQuantity: 1,
      lifecycleId: "sale-cycle-1",
      winerimWineId: "47593",
      variant: "BOTTLE" as const,
      sourceDocumentIds: ["open-ticket:sale-cycle-1"],
      sourceLineIds: ["line-1"],
      sourceDocumentKind: "OPEN_TICKET" as const,
    }]);
    const removed = await planSalesRun({
      connectionId: "connection-1",
      provider: "agora",
      runKind: "INTRADAY",
      documents: [document({ lines: [] })],
    }, {
      resolveLine: vi.fn().mockResolvedValue(resolution),
      loadClaims: vi.fn().mockResolvedValue([]),
      loadReconciliationClaims,
    });

    expect(removed.intents).toEqual([]);
    expect(removed.noops).toEqual([]);
    expect(removed.blocked).toEqual([expect.objectContaining({
      reason: "OPEN_TICKET_REMOVAL_REQUIRES_RECONCILIATION",
      detail: expect.stringContaining("stock is not restored automatically"),
    })]);
    expect(loadReconciliationClaims).toHaveBeenCalledWith({
      lifecycleIds: ["sale-cycle-1"],
      includeMissingOpenTickets: false,
    });
  });

  it("allows an empty planning invoice when no provisional wine claim exists", async () => {
    const plan = await planSalesRun({
      connectionId: "connection-1",
      provider: "agora",
      runKind: "INTRADAY",
      documents: [document({ lines: [] })],
    }, {
      resolveLine: vi.fn(),
      loadClaims: vi.fn().mockResolvedValue([]),
      loadReconciliationClaims: vi.fn().mockResolvedValue([]),
    });

    expect(plan.blocked).toEqual([]);
    expect(plan.intents).toEqual([]);
    expect(plan.noops).toEqual([]);
  });

  it("blocks a removed wine line and a missing OpenTicket without restoring stock", async () => {
    const priorClaim = {
      claimKey: "sales-claim:v1:removed-wine",
      state: "COMPLETE" as const,
      appliedQuantity: 2,
      lifecycleId: "sale-cycle-1",
      winerimWineId: "removed-wine",
      variant: "BOTTLE" as const,
      sourceDocumentIds: ["open-ticket:sale-cycle-1"],
      sourceLineIds: ["removed-line"],
      sourceDocumentKind: "OPEN_TICKET" as const,
    };
    const remaining = await planSalesRun({
      connectionId: "connection-1",
      provider: "agora",
      runKind: "OPEN_TICKET",
      openTicketPolicy: "PROVISIONAL_STOCK",
      documents: [document({
        kind: "OPEN_TICKET",
        documentId: "open-ticket:sale-cycle-1",
      })],
    }, {
      resolveLine: vi.fn().mockResolvedValue({
        winerimWineId: "remaining-wine",
        variant: "BOTTLE",
        stockId: "remaining-stock",
        stockActive: true,
      }),
      loadClaims: vi.fn().mockResolvedValue([]),
      loadReconciliationClaims: vi.fn().mockResolvedValue([priorClaim]),
    });
    expect(remaining.blocked).toEqual([expect.objectContaining({
      reason: "OPEN_TICKET_REMOVAL_REQUIRES_RECONCILIATION",
      lineId: "removed-line",
    })]);

    const loadMissing = vi.fn().mockResolvedValue([priorClaim]);
    const missing = await planSalesRun({
      connectionId: "connection-1",
      provider: "agora",
      runKind: "OPEN_TICKET",
      openTicketPolicy: "PROVISIONAL_STOCK",
      documents: [],
    }, {
      resolveLine: vi.fn(),
      loadClaims: vi.fn().mockResolvedValue([]),
      loadReconciliationClaims: loadMissing,
    });
    expect(missing.intents).toEqual([]);
    expect(missing.blocked).toEqual([expect.objectContaining({
      reason: "OPEN_TICKET_REMOVAL_REQUIRES_RECONCILIATION",
      documentId: "open-ticket:sale-cycle-1",
    })]);
    expect(loadMissing).toHaveBeenCalledWith({
      lifecycleIds: [],
      includeMissingOpenTickets: true,
    });
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
