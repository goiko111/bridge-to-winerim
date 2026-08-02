import {
  buildSalesClaimKey,
  buildSalesMutationIdempotencyKey,
  buildSalesOrderId,
} from "./identity";
import type {
  ProviderSalesDocument,
  ProviderSalesLine,
  SalesBlockedItem,
  SalesClaimSnapshot,
  SalesImportLine,
  SalesLineResolution,
  SalesMutationIntent,
  SalesObservation,
  SalesPlan,
  SalesPlanningInput,
  SalesPlanningPorts,
} from "./types";

type ResolvedLine = {
  document: ProviderSalesDocument;
  line: ProviderSalesLine;
  resolution: SalesLineResolution;
};

type SalesGroup = {
  document: ProviderSalesDocument;
  lines: ResolvedLine[];
  rawQuantity: number;
  totalAmount?: number;
};

function expectedDocumentKind(runKind: SalesPlanningInput["runKind"]): ProviderSalesDocument["kind"] {
  return runKind === "OPEN_TICKET" ? "OPEN_TICKET" : "DEFINITIVE_INVOICE";
}

function applyMode(runKind: SalesPlanningInput["runKind"]): SalesPlan["applyMode"] {
  return runKind === "HISTORICAL" ? "HISTORICAL" : "OPERATIONAL";
}

function documentSignature(document: ProviderSalesDocument): string {
  return JSON.stringify({
    lifecycleId: document.lifecycleId,
    businessDay: document.businessDay,
    kind: document.kind,
    isRefund: document.isRefund,
    lines: document.lines
      .map((line) => ({
        lineId: line.lineId,
        providerProductId: line.providerProductId,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        totalAmount: line.totalAmount,
      }))
      .sort((left, right) => left.lineId.localeCompare(right.lineId)),
  });
}

function selectDocuments(input: SalesPlanningInput, blocked: SalesBlockedItem[]): ProviderSalesDocument[] {
  const expectedKind = expectedDocumentKind(input.runKind);
  const unique = new Map<string, ProviderSalesDocument>();
  const conflicts = new Set<string>();
  for (const document of input.documents) {
    if (document.kind !== expectedKind) {
      blocked.push({
        reason: "DOCUMENT_KIND_MISMATCH",
        documentId: document.documentId,
        detail: `${input.runKind} accepts ${expectedKind} documents, received ${document.kind}`,
      });
      continue;
    }
    if (conflicts.has(document.documentId)) continue;
    const existing = unique.get(document.documentId);
    if (!existing) {
      unique.set(document.documentId, document);
      continue;
    }
    if (documentSignature(existing) !== documentSignature(document)) {
      blocked.push({
        reason: "DUPLICATE_DOCUMENT_CONFLICT",
        documentId: document.documentId,
        detail: "The same provider document id was received with different contents",
      });
      unique.delete(document.documentId);
      conflicts.add(document.documentId);
    }
  }
  return Array.from(unique.values());
}

function positiveIntegerQuantity(rawQuantity: number, historical: boolean): number | null {
  if (!Number.isFinite(rawQuantity) || rawQuantity <= 0) return null;
  if (historical && !Number.isInteger(rawQuantity)) return null;
  return historical ? rawQuantity : Math.ceil(rawQuantity);
}

function weightedUnitPrice(group: SalesGroup): number | undefined {
  const values = group.lines.filter(({ line }) => line.unitPrice !== undefined && line.quantity > 0);
  if (!values.length) return undefined;
  const weighted = values.reduce((sum, { line }) => sum + (line.unitPrice ?? 0) * line.quantity, 0);
  const quantity = values.reduce((sum, { line }) => sum + line.quantity, 0);
  return quantity > 0 ? weighted / quantity : undefined;
}

function buildImportLine(group: SalesGroup, quantity: number): SalesImportLine {
  return {
    lineId: group.lines.map(({ line }) => line.lineId).sort().join("+") || "aggregate",
    winerimWineId: group.lines[0].resolution.winerimWineId,
    variant: group.lines[0].resolution.variant,
    quantity,
    unitPrice: weightedUnitPrice(group),
    totalAmount: group.totalAmount,
    providerProductIds: Array.from(new Set(group.lines.map(({ line }) => line.providerProductId))).sort(),
  };
}

export async function planSalesRun(
  input: SalesPlanningInput,
  ports: SalesPlanningPorts,
): Promise<SalesPlan> {
  const blocked: SalesBlockedItem[] = [];
  const observations: SalesObservation[] = [];
  const noops: SalesPlan["noops"] = [];
  const intents: SalesMutationIntent[] = [];
  const mode = applyMode(input.runKind);
  const documents = selectDocuments(input, blocked);
  const groups = new Map<string, SalesGroup>();

  for (const document of documents) {
    if (document.isRefund) {
      blocked.push({
        reason: "REFUND_REQUIRES_RECONCILIATION",
        documentId: document.documentId,
        detail: "Refunds are recorded for explicit reconciliation and never restore stock automatically",
      });
      continue;
    }
    if (document.kind === "OPEN_TICKET" && input.openTicketPolicy === "PROVISIONAL_STOCK" && document.identitySource !== "PROVIDER") {
      blocked.push({
        reason: "OPEN_TICKET_IDENTITY_NOT_STABLE",
        documentId: document.documentId,
        detail: "Provisional stock requires a stable provider lifecycle id shared with the definitive invoice",
      });
      continue;
    }

    for (const line of document.lines) {
      const resolution = await ports.resolveLine({
        connectionId: input.connectionId,
        provider: input.provider,
        document,
        line,
      });
      observations.push({
        documentId: document.documentId,
        lifecycleId: document.lifecycleId,
        lineId: line.lineId,
        providerProductId: line.providerProductId,
        quantity: line.quantity,
        mapped: !!resolution,
        winerimWineId: resolution?.winerimWineId,
        variant: resolution?.variant,
      });
      if (!Number.isFinite(line.quantity) || line.quantity <= 0) {
        blocked.push({
          reason: "INVALID_QUANTITY",
          documentId: document.documentId,
          lineId: line.lineId,
          providerProductId: line.providerProductId,
          detail: `Automatic application requires a positive finite quantity; received ${line.quantity}`,
        });
        continue;
      }
      if (!resolution) {
        blocked.push({
          reason: "MAPPING_NOT_FOUND",
          documentId: document.documentId,
          lineId: line.lineId,
          providerProductId: line.providerProductId,
          detail: "No exact provider-product to Winerim mapping was resolved",
        });
        continue;
      }
      if (mode === "OPERATIONAL" && resolution.stockActive && resolution.variant !== "GLASS" && !resolution.stockId) {
        blocked.push({
          reason: "STOCK_ID_REQUIRED",
          documentId: document.documentId,
          lineId: line.lineId,
          providerProductId: line.providerProductId,
          detail: `Active ${resolution.variant} stock requires a stock id`,
        });
        continue;
      }

      const key = [
        document.businessDay,
        document.lifecycleId,
        resolution.winerimWineId,
        resolution.variant,
      ].join("\u001f");
      const group = groups.get(key) ?? {
        document,
        lines: [],
        rawQuantity: 0,
        totalAmount: undefined,
      };
      group.lines.push({ document, line, resolution });
      group.rawQuantity += line.quantity;
      if (line.totalAmount !== undefined) group.totalAmount = (group.totalAmount ?? 0) + line.totalAmount;
      groups.set(key, group);
    }
  }

  const drafts: Array<Omit<SalesMutationIntent, "observedAppliedQuantity">> = [];
  for (const group of groups.values()) {
    const quantity = positiveIntegerQuantity(group.rawQuantity, mode === "HISTORICAL");
    if (quantity === null) {
      blocked.push({
        reason: mode === "HISTORICAL" && group.rawQuantity > 0
          ? "FRACTIONAL_HISTORICAL_QUANTITY"
          : "INVALID_QUANTITY",
        documentId: group.document.documentId,
        detail: mode === "HISTORICAL"
          ? `Historical sales-only import omits fractional totals; received ${group.rawQuantity}`
          : `Automatic application requires a positive quantity; received ${group.rawQuantity}`,
      });
      continue;
    }

    const resolution = group.lines[0].resolution;
    const claimKey = await buildSalesClaimKey({
      connectionId: input.connectionId,
      provider: input.provider,
      businessDay: group.document.businessDay,
      lifecycleId: group.document.lifecycleId,
      winerimWineId: resolution.winerimWineId,
      variant: resolution.variant,
    });
    const orderId = await buildSalesOrderId({
      provider: input.provider,
      claimKey,
      businessDay: group.document.businessDay,
      variant: resolution.variant,
      desiredQuantity: quantity,
    });
    const importLine = buildImportLine(group, quantity);
    const isObserveOnly = group.document.kind === "OPEN_TICKET" && input.openTicketPolicy !== "PROVISIONAL_STOCK";
    if (isObserveOnly) continue;

    const action = mode === "HISTORICAL" || !resolution.stockActive || resolution.variant === "GLASS"
      ? {
        kind: "SALES_IMPORT" as const,
        live: mode === "OPERATIONAL" && resolution.stockActive && resolution.variant === "GLASS",
        requireStockApplied: mode === "OPERATIONAL" && resolution.stockActive && resolution.variant === "GLASS",
        lines: [importLine],
      }
      : {
        kind: "STOCK_APPLY" as const,
        stockId: resolution.stockId!,
        variant: resolution.variant,
        fallbackToSalesOnlyIfStockDidNotMove: true,
        line: importLine,
      };
    drafts.push({
      claimKey,
      orderId,
      mutationIdempotencyKey: await buildSalesMutationIdempotencyKey({ orderId, action: action.kind }),
      connectionId: input.connectionId,
      provider: input.provider,
      businessDay: group.document.businessDay,
      lifecycleId: group.document.lifecycleId,
      winerimWineId: resolution.winerimWineId,
      variant: resolution.variant,
      desiredQuantity: quantity,
      sourceDocumentIds: Array.from(new Set(group.lines.map(({ document }) => document.documentId))).sort(),
      sourceLineIds: Array.from(new Set(group.lines.map(({ line }) => line.lineId))).sort(),
      action,
    });
  }

  const snapshots = ports.loadClaims
    ? await ports.loadClaims(drafts.map((draft) => draft.claimKey))
    : [];
  const snapshotByKey = new Map<string, SalesClaimSnapshot>();
  for (const snapshot of snapshots) {
    const existing = snapshotByKey.get(snapshot.claimKey);
    if (!existing || snapshot.appliedQuantity > existing.appliedQuantity) {
      snapshotByKey.set(snapshot.claimKey, snapshot);
    }
  }

  for (const draft of drafts) {
    const snapshot = snapshotByKey.get(draft.claimKey);
    const observedAppliedQuantity = Math.max(0, snapshot?.appliedQuantity ?? 0);
    if (snapshot?.state === "PENDING") {
      noops.push({
        claimKey: draft.claimKey,
        desiredQuantity: draft.desiredQuantity,
        appliedQuantity: observedAppliedQuantity,
        reason: "CLAIM_BUSY",
      });
      continue;
    }
    if (observedAppliedQuantity >= draft.desiredQuantity) {
      noops.push({
        claimKey: draft.claimKey,
        desiredQuantity: draft.desiredQuantity,
        appliedQuantity: observedAppliedQuantity,
        reason: "ALREADY_APPLIED",
      });
      continue;
    }
    intents.push({ ...draft, observedAppliedQuantity });
  }

  return {
    connectionId: input.connectionId,
    provider: input.provider,
    runKind: input.runKind,
    applyMode: mode,
    documents,
    observations,
    blocked,
    noops,
    intents,
  };
}
