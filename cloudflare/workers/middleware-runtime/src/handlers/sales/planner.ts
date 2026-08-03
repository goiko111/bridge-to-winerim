import {
  buildCompatibleSalesClaimKeys,
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

type ReconciliationProbe = {
  document: ProviderSalesDocument;
  line: ProviderSalesLine;
  resolution: SalesLineResolution;
  claimKeys: readonly [string, string];
};

type SalesDraft = Omit<
  SalesMutationIntent,
  "claimKey" | "orderId" | "mutationIdempotencyKey" | "observedAppliedQuantity"
> & {
  claimKeys: readonly [string, string];
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

function positiveIntegerQuantity(rawQuantity: number): number | null {
  if (!Number.isFinite(rawQuantity) || rawQuantity <= 0) return null;
  return Number.isInteger(rawQuantity) ? rawQuantity : null;
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

function logicalClaimIdentity(input: {
  lifecycleId: string;
  winerimWineId: string;
  variant: SalesLineResolution["variant"];
}): string {
  return [input.lifecycleId, input.winerimWineId, input.variant].join("\u001f");
}

function snapshotIdentity(snapshot: SalesClaimSnapshot): string | null {
  if (!snapshot.lifecycleId || !snapshot.winerimWineId || !snapshot.variant) return null;
  return logicalClaimIdentity({
    lifecycleId: snapshot.lifecycleId,
    winerimWineId: snapshot.winerimWineId,
    variant: snapshot.variant,
  });
}

function effectiveSnapshot(
  snapshots: SalesClaimSnapshot[],
  preferredKeys: readonly string[],
): SalesClaimSnapshot | undefined {
  const byKey = new Map<string, SalesClaimSnapshot>();
  for (const snapshot of snapshots) {
    const existing = byKey.get(snapshot.claimKey);
    if (
      !existing
      || snapshot.state === "PENDING"
      || snapshot.appliedQuantity > existing.appliedQuantity
    ) {
      byKey.set(snapshot.claimKey, snapshot);
    }
  }
  const ranked = Array.from(byKey.values()).sort((left, right) => {
    if (left.state === "PENDING" && right.state !== "PENDING") return -1;
    if (right.state === "PENDING" && left.state !== "PENDING") return 1;
    if (left.appliedQuantity !== right.appliedQuantity) {
      return right.appliedQuantity - left.appliedQuantity;
    }
    const leftRank = preferredKeys.indexOf(left.claimKey);
    const rightRank = preferredKeys.indexOf(right.claimKey);
    return (leftRank < 0 ? preferredKeys.length : leftRank)
      - (rightRank < 0 ? preferredKeys.length : rightRank);
  });
  return ranked[0];
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
  const reconciliationProbeInputs: Array<Omit<ReconciliationProbe, "claimKeys">> = [];

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
      if (!Number.isFinite(line.quantity)) {
        blocked.push({
          reason: "INVALID_QUANTITY",
          documentId: document.documentId,
          lineId: line.lineId,
          providerProductId: line.providerProductId,
          detail: `Automatic application requires a positive finite quantity; received ${line.quantity}`,
        });
        continue;
      }
      if (line.quantity <= 0) {
        if (mode === "OPERATIONAL" && resolution && document.identitySource === "PROVIDER") {
          reconciliationProbeInputs.push({ document, line, resolution });
        } else {
          blocked.push({
            reason: "INVALID_QUANTITY",
            documentId: document.documentId,
            lineId: line.lineId,
            providerProductId: line.providerProductId,
            detail: `Automatic application requires a positive finite quantity; received ${line.quantity}`,
          });
        }
        continue;
      }
      if (!Number.isInteger(line.quantity)) {
        blocked.push({
          reason: mode === "HISTORICAL" ? "FRACTIONAL_HISTORICAL_QUANTITY" : "INVALID_QUANTITY",
          documentId: document.documentId,
          lineId: line.lineId,
          providerProductId: line.providerProductId,
          detail: mode === "HISTORICAL"
            ? `Historical sales-only import omits fractional quantities; received ${line.quantity}`
            : `Operational stock application requires a whole quantity; received ${line.quantity}`,
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

  const drafts: SalesDraft[] = [];
  for (const group of groups.values()) {
    const quantity = positiveIntegerQuantity(group.rawQuantity);
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
    const claimKeys = await buildCompatibleSalesClaimKeys({
      connectionId: input.connectionId,
      provider: input.provider,
      businessDay: group.document.businessDay,
      lifecycleId: group.document.lifecycleId,
      winerimWineId: resolution.winerimWineId,
      variant: resolution.variant,
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
      claimKeys,
      connectionId: input.connectionId,
      provider: input.provider,
      businessDay: group.document.businessDay,
      lifecycleId: group.document.lifecycleId,
      winerimWineId: resolution.winerimWineId,
      variant: resolution.variant,
      desiredQuantity: quantity,
      sourceDocumentIds: Array.from(new Set(group.lines.map(({ document }) => document.documentId))).sort(),
      sourceLineIds: Array.from(new Set(group.lines.map(({ line }) => line.lineId))).sort(),
      sourceDocumentKind: group.document.kind,
      action,
    });
  }

  const reconciliationProbes = await Promise.all(reconciliationProbeInputs.map(async (probe) => ({
    ...probe,
    claimKeys: await buildCompatibleSalesClaimKeys({
      connectionId: input.connectionId,
      provider: input.provider,
      businessDay: probe.document.businessDay,
      lifecycleId: probe.document.lifecycleId,
      winerimWineId: probe.resolution.winerimWineId,
      variant: probe.resolution.variant,
    }),
  })));

  const directSnapshots = ports.loadClaims
    ? await ports.loadClaims(Array.from(new Set([
      ...drafts.flatMap((draft) => [...draft.claimKeys]),
      ...reconciliationProbes.flatMap((probe) => [...probe.claimKeys]),
    ])))
    : [];
  const reconciliationSnapshots = mode === "OPERATIONAL" && ports.loadReconciliationClaims
    ? await ports.loadReconciliationClaims({
      lifecycleIds: Array.from(new Set(documents.map((document) => document.lifecycleId))).sort(),
      includeMissingOpenTickets: input.runKind === "OPEN_TICKET"
        && input.openTicketPolicy === "PROVISIONAL_STOCK",
    })
    : [];
  const snapshotByKey = new Map<string, SalesClaimSnapshot>();
  for (const snapshot of [...directSnapshots, ...reconciliationSnapshots]) {
    const existing = snapshotByKey.get(snapshot.claimKey);
    if (
      !existing
      || snapshot.state === "PENDING"
      || snapshot.appliedQuantity > existing.appliedQuantity
    ) {
      snapshotByKey.set(snapshot.claimKey, snapshot);
    }
  }
  const snapshotsByIdentity = new Map<string, SalesClaimSnapshot[]>();
  for (const snapshot of reconciliationSnapshots) {
    const identity = snapshotIdentity(snapshot);
    if (!identity) continue;
    const values = snapshotsByIdentity.get(identity) ?? [];
    values.push(snapshot);
    snapshotsByIdentity.set(identity, values);
  }

  const currentIdentities = new Set([
    ...drafts.map((draft) => logicalClaimIdentity(draft)),
    ...reconciliationProbes.map((probe) => logicalClaimIdentity({
      lifecycleId: probe.document.lifecycleId,
      winerimWineId: probe.resolution.winerimWineId,
      variant: probe.resolution.variant,
    })),
  ]);
  const representedClaimKeys = new Set([
    ...drafts.flatMap((draft) => [...draft.claimKeys]),
    ...reconciliationProbes.flatMap((probe) => [...probe.claimKeys]),
  ]);
  const orphanedSnapshots = new Map<string, SalesClaimSnapshot>();
  for (const snapshot of reconciliationSnapshots) {
    if (
      (snapshot.appliedQuantity <= 0 && snapshot.state !== "PENDING")
      || representedClaimKeys.has(snapshot.claimKey)
    ) continue;
    const identity = snapshotIdentity(snapshot);
    if (identity && currentIdentities.has(identity)) continue;
    const key = identity ?? snapshot.claimKey;
    const existing = orphanedSnapshots.get(key);
    if (!existing || snapshot.appliedQuantity > existing.appliedQuantity) {
      orphanedSnapshots.set(key, snapshot);
    }
  }
  for (const snapshot of orphanedSnapshots.values()) {
    const exposure = snapshot.state === "PENDING"
      ? "an in-flight mutation"
      : `${snapshot.appliedQuantity} applied unit(s)`;
    blocked.push({
      reason: "OPEN_TICKET_REMOVAL_REQUIRES_RECONCILIATION",
      documentId: snapshot.sourceDocumentIds?.[0] ?? snapshot.lifecycleId ?? "unknown-open-ticket",
      lineId: snapshot.sourceLineIds?.[0],
      detail: `An OpenTicket claim (${snapshot.claimKey}) is absent from the current lifecycle snapshot; ${exposure} requires explicit reconciliation and stock is not restored automatically`,
    });
  }

  const snapshotsFor = (
    identity: string,
    claimKeys: readonly string[],
  ): SalesClaimSnapshot[] => [
    ...claimKeys.map((claimKey) => snapshotByKey.get(claimKey)).filter(
      (snapshot): snapshot is SalesClaimSnapshot => !!snapshot,
    ),
    ...(snapshotsByIdentity.get(identity) ?? []),
  ];

  for (const probe of reconciliationProbes) {
    const identity = logicalClaimIdentity({
      lifecycleId: probe.document.lifecycleId,
      winerimWineId: probe.resolution.winerimWineId,
      variant: probe.resolution.variant,
    });
    const snapshot = effectiveSnapshot(snapshotsFor(identity, probe.claimKeys), probe.claimKeys);
    const observedAppliedQuantity = Math.max(0, snapshot?.appliedQuantity ?? 0);
    blocked.push({
      reason: observedAppliedQuantity > 0
        ? "REFUND_REQUIRES_RECONCILIATION"
        : "INVALID_QUANTITY",
      documentId: probe.document.documentId,
      lineId: probe.line.lineId,
      providerProductId: probe.line.providerProductId,
      detail: observedAppliedQuantity > 0
        ? `Lifecycle quantity fell to ${probe.line.quantity} after ${observedAppliedQuantity} unit(s) were applied provisionally; automatic reversal is blocked`
        : `Automatic application requires a positive finite quantity; received ${probe.line.quantity}`,
    });
  }

  for (const draft of drafts) {
    const identity = logicalClaimIdentity(draft);
    const snapshot = effectiveSnapshot(snapshotsFor(identity, draft.claimKeys), draft.claimKeys);
    const claimKey = snapshot?.claimKey ?? draft.claimKeys[0];
    const observedAppliedQuantity = Math.max(0, snapshot?.appliedQuantity ?? 0);
    if (snapshot?.state === "PENDING") {
      noops.push({
        claimKey,
        desiredQuantity: draft.desiredQuantity,
        appliedQuantity: observedAppliedQuantity,
        reason: "CLAIM_BUSY",
      });
      continue;
    }
    if (observedAppliedQuantity > draft.desiredQuantity) {
      blocked.push({
        reason: "REFUND_REQUIRES_RECONCILIATION",
        documentId: draft.sourceDocumentIds[0],
        detail: `Lifecycle quantity fell from ${observedAppliedQuantity} applied unit(s) to ${draft.desiredQuantity}; automatic reversal is blocked`,
      });
      continue;
    }
    if (observedAppliedQuantity === draft.desiredQuantity) {
      noops.push({
        claimKey,
        desiredQuantity: draft.desiredQuantity,
        appliedQuantity: observedAppliedQuantity,
        reason: "ALREADY_APPLIED",
      });
      continue;
    }
    const orderId = await buildSalesOrderId({
      provider: input.provider,
      claimKey: draft.claimKeys[0],
      businessDay: draft.businessDay,
      variant: draft.variant,
      desiredQuantity: draft.desiredQuantity,
    });
    const { claimKeys, ...intent } = draft;
    void claimKeys;
    intents.push({
      ...intent,
      claimKey,
      orderId,
      mutationIdempotencyKey: await buildSalesMutationIdempotencyKey({
        orderId,
        action: draft.action.kind,
      }),
      observedAppliedQuantity,
    });
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
