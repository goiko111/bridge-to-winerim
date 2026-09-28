import type {
  AgoraLine,
  CandidateTarget,
  ExternalResolutionCase,
  ExternalResolutionEvidence,
  ReconciliationResult,
  SaleDeletion,
  SourceCompleteness,
  StockMovement,
  WinerimLine,
} from "./types.ts";

const norm = (value: string | null | undefined) => String(value ?? "").trim().toLowerCase();
const cents = (value: number | null) => value == null ? null : Math.round(value);

/** Normalize only contractually equivalent POS/Winerim format labels. */
export function canonicalFormat(value: string | null | undefined): string {
  const normalized = norm(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[\s_]+/g, "-");
  if (["bot", "bottle", "botella"].includes(normalized)) return "botella";
  if (["cop", "glass", "copa"].includes(normalized)) return "copa";
  return normalized;
}

function exactIdentityMatches(a: AgoraLine, w: WinerimLine): boolean {
  const order = norm(a.externalOrderId || a.orderId);
  const winerimOrder = norm(w.externalOrderId || w.orderId);
  return Boolean(
    norm(a.sourceSystem) &&
      order &&
      norm(a.sourceLineId) &&
      norm(a.sourceSystem) === norm(w.sourceSystem) &&
      order === winerimOrder &&
      norm(a.sourceLineId) === norm(w.sourceLineId) &&
      canonicalFormat(a.format) === canonicalFormat(w.format),
  );
}

function fallbackSignatureMatches(a: AgoraLine, w: WinerimLine): boolean {
  return (
    a.businessDay === (w.businessDay ?? w.effectiveAt.slice(0, 10)) &&
    a.effectiveAt === w.effectiveAt &&
    norm(a.wineId) === norm(w.wineId) &&
    canonicalFormat(a.format) === canonicalFormat(w.format)
  );
}

function fallbackMatches(a: AgoraLine, w: WinerimLine): boolean {
  return (
    fallbackSignatureMatches(a, w) &&
    a.quantity === w.quantity &&
    cents(a.amountMinor) === cents(w.amountMinor)
  );
}

function aggregateWinerimLines(lines: WinerimLine[]): WinerimLine {
  const first = lines[0];
  const stockStatuses = new Set(lines.map((line) => line.stockEffect.status));
  const stockStatus = stockStatuses.size === 1
    ? lines[0].stockEffect.status
    : lines.some((line) => line.stockEffect.status === "CONFLICT")
    ? "CONFLICT"
    : lines.some((line) => line.stockEffect.status === "PARTIAL" || Number(line.stockEffect.unbackedQty ?? 0) > 0)
    ? "PARTIAL"
    : lines.some((line) => line.stockEffect.status === "MOVEMENT_MISSING")
    ? "MOVEMENT_MISSING"
    : "UNKNOWN";
  const receiptIds = [...new Set(lines.map((line) => line.stockEffect.receiptId).filter(Boolean))];
  const stockAppliedValues = [...new Set(lines.map((line) => line.stockEffect.stockApplied))];
  return {
    ...first,
    lineId: `aggregate:${lines.map((line) => line.lineId).sort().join(",")}`,
    saleDetailId: null,
    saleStatus: lines.some((line) => line.saleStatus === "rejected") ? "rejected" : lines.some((line) => line.saleStatus === "pending") ? "pending" : "confirmed",
    format: canonicalFormat(first.format),
    quantity: lines.reduce((sum, line) => sum + line.quantity, 0),
    amountMinor: lines.every((line) => line.amountMinor != null) ? lines.reduce((sum, line) => sum + Number(line.amountMinor), 0) : null,
    stockEffect: {
      known: lines.every((line) => line.stockEffect.known),
      status: stockStatus,
      stockApplied: stockAppliedValues.length === 1 ? stockAppliedValues[0] : null,
      receiptId: receiptIds.length === 1 ? receiptIds[0] : null,
      movementIds: [...new Set(lines.flatMap((line) => line.stockEffect.movementIds))],
      movementDifference: lines.every((line) => line.stockEffect.movementDifference != null)
        ? lines.reduce((sum, line) => sum + Number(line.stockEffect.movementDifference), 0)
        : null,
      unbackedQty: lines.every((line) => line.stockEffect.unbackedQty != null)
        ? lines.reduce((sum, line) => sum + Number(line.stockEffect.unbackedQty), 0)
        : null,
    },
  };
}

function groupedFallbackMatches(a: AgoraLine, winerim: WinerimLine[], available: Set<number>): number[][] {
  if (a.amountMinor == null) return [];
  const bySale = new Map<number, number[]>();
  for (const index of available) {
    const line = winerim[index];
    if (!fallbackSignatureMatches(a, line)) continue;
    const group = bySale.get(line.saleId) ?? [];
    group.push(index);
    bySale.set(line.saleId, group);
  }
  return [...bySale.values()].filter((indexes) => {
    if (indexes.length < 2) return false;
    const lines = indexes.map((index) => winerim[index]);
    if (lines.some((line) => line.amountMinor == null)) return false;
    return lines.reduce((sum, line) => sum + line.quantity, 0) === a.quantity &&
      cents(lines.reduce((sum, line) => sum + Number(line.amountMinor), 0)) === cents(a.amountMinor);
  });
}

function sourceLineKey(line: AgoraLine): string {
  return [
    line.connectionId,
    line.businessDay,
    line.documentId,
    line.sourceLineId || "no-source-line",
    line.wineId,
    line.format || "unknown-format",
    line.quantity,
    line.amountMinor ?? "unknown-amount",
    line.effectiveAt,
  ].join("|");
}

function classifyMatched(a: AgoraLine, w: WinerimLine): Pick<ReconciliationResult, "state" | "manualAction" | "evidence"> {
  if (a.quantity !== w.quantity) {
    return { state: "AMBIGUOUS", manualAction: "Revisar cantidades; no corregir automáticamente", evidence: { reason: "QUANTITY_MISMATCH", agoraQuantity: a.quantity, winerimQuantity: w.quantity } };
  }
  if (a.amountMinor != null && w.amountMinor != null && cents(a.amountMinor) !== cents(w.amountMinor)) {
    return { state: "AMBIGUOUS", manualAction: "Revisar importe observado; no completar desde catálogo", evidence: { reason: "AMOUNT_MISMATCH", agoraAmountMinor: a.amountMinor, winerimAmountMinor: w.amountMinor } };
  }
  if (!w.stockEffect.known) {
    return { state: "STOCK_UNKNOWN", manualAction: "Historial emparejado; efecto de stock no demostrable", evidence: { stockStatus: w.stockEffect.status } };
  }
  if (w.stockEffect.status === "PARTIAL" || Number(w.stockEffect.unbackedQty ?? 0) > 0) return { state: "STOCK_MISSING", manualAction: "Revisar remanente de stock; no aplicar automáticamente", evidence: { reason: "PARTIAL_STOCK", quantity: a.quantity, unbackedQty: w.stockEffect.unbackedQty, stockStatus: w.stockEffect.status } };
  if (w.stockEffect.status === "MOVEMENT_MISSING") return { state: "STOCK_MISSING", manualAction: "Revisar recibo y movimiento de stock", evidence: { reason: "MOVEMENT_MISSING", stockStatus: w.stockEffect.status } };
  if (w.stockEffect.status === "CONFLICT") return { state: "AMBIGUOUS", manualAction: "Revisar recibo y movimiento de stock", evidence: { reason: "STOCK_CONFLICT", stockStatus: w.stockEffect.status } };
  if (w.stockEffect.stockApplied !== true && !["APPLIED", "HISTORY_ONLY"].includes(w.stockEffect.status)) return { state: "STOCK_UNKNOWN", manualAction: "Historial emparejado; efecto de stock no demostrable", evidence: { stockStatus: w.stockEffect.status, stockApplied: w.stockEffect.stockApplied } };
  return { state: "MATCHED", manualAction: "Ninguna", evidence: { receiptId: w.stockEffect.receiptId, movementIds: w.stockEffect.movementIds } };
}

export function reconcileLines(input: {
  connectionId: string;
  agora: AgoraLine[];
  winerim: WinerimLine[];
  deletions?: SaleDeletion[];
  completeness: SourceCompleteness;
}): ReconciliationResult[] {
  const deletions = input.deletions ?? [];
  const deletedSales = new Set(deletions.filter((row) => row.saleDetailId == null).map((row) => row.saleId));
  const deletedLines = new Set(deletions.filter((row) => row.saleDetailId != null).map((row) => row.lineId));
  const available = new Set(input.winerim.map((_, index) => index));
  const results: ReconciliationResult[] = [];

  for (const agora of input.agora) {
    const base = {
      connectionId: agora.connectionId,
      restaurantId: agora.restaurantId,
      businessDay: agora.businessDay,
      sourceLineKey: sourceLineKey(agora),
      agora,
      mode: "AUDIT_ONLY" as const,
    };
    if (!input.completeness.agoraComplete || !input.completeness.winerimComplete) {
      results.push({ ...base, winerim: null, state: "SOURCE_INCOMPLETE", evidence: { completeness: input.completeness }, manualAction: "Completar la lectura antes de clasificar" });
      continue;
    }
    if (agora.isOpen) {
      results.push({ ...base, winerim: null, state: "OPEN", evidence: {}, manualAction: "Esperar al cierre del documento" });
      continue;
    }
    if (agora.isCancelled) {
      results.push({ ...base, winerim: null, state: "DELETED_OR_CANCELLED", evidence: { stockStatus: "UNKNOWN", reason: "causal_stock_link_required" }, manualAction: "Verificar anulación y vínculo causal de stock; el mismo vino/formato/cantidad no basta" });
      continue;
    }

    const exact = [...available].filter((index) => exactIdentityMatches(agora, input.winerim[index]));
    let candidates = exact;
    let matchedIndexes: number[] = [];
    let matchKind = "EXACT_SOURCE_IDENTITY";
    if (candidates.length === 0) {
      candidates = [...available].filter((index) => fallbackMatches(agora, input.winerim[index]));
      matchKind = "UNIQUE_SIGNATURE_FALLBACK";
    }
    if (candidates.length > 1) {
      results.push({ ...base, winerim: null, state: "AMBIGUOUS", evidence: { reason: exact.length > 1 ? "CONFIRMED_DUPLICATE" : "AMBIGUOUS_MATCH", matchKind, candidateLineIds: candidates.map((index) => input.winerim[index].lineId) }, manualAction: "Revisión manual; ninguna línea se consume" });
      continue;
    }
    if (candidates.length === 0) {
      const grouped = groupedFallbackMatches(agora, input.winerim, available);
      if (grouped.length > 1) {
        results.push({ ...base, winerim: null, state: "AMBIGUOUS", evidence: { reason: "AMBIGUOUS_GROUPED_MATCH", matchKind: "GROUPED_DETAIL_FALLBACK", candidateLineIds: grouped.flatMap((indexes) => indexes.map((index) => input.winerim[index].lineId)) }, manualAction: "Revisión manual; ningún grupo se consume" });
        continue;
      }
      if (grouped.length === 1) {
        matchedIndexes = grouped[0];
        matchKind = "GROUPED_DETAIL_FALLBACK";
      }
    } else {
      matchedIndexes = [candidates[0]];
    }
    if (matchedIndexes.length === 0) {
      const deleted = input.winerim.find((line) => deletedSales.has(line.saleId) || deletedLines.has(line.lineId));
      results.push({ ...base, winerim: deleted ?? null, state: deleted ? "DELETED_OR_CANCELLED" : "HISTORY_MISSING", evidence: { matchKind }, manualAction: deleted ? "Verificar la anulación" : "Revisar alta manual; no importar automáticamente" });
      continue;
    }

    matchedIndexes.forEach((index) => available.delete(index));
    const matchedLines = matchedIndexes.map((index) => input.winerim[index]);
    const winerim = matchedLines.length === 1 ? matchedLines[0] : aggregateWinerimLines(matchedLines);
    if (matchedLines.some((line) => deletedSales.has(line.saleId) || deletedLines.has(line.lineId) || line.saleStatus === "rejected")) {
      results.push({ ...base, winerim, state: "DELETED_OR_CANCELLED", evidence: { matchKind, memberLineIds: matchedLines.map((line) => line.lineId) }, manualAction: "Verificar que la anulación es la correcta" });
      continue;
    }
    const classification = classifyMatched(agora, winerim);
    results.push({ ...base, winerim, ...classification, evidence: { ...classification.evidence, matchKind, ...(matchedLines.length > 1 ? { memberLineIds: matchedLines.map((line) => line.lineId) } : {}) } });
  }

  for (const index of available) {
    const winerim = input.winerim[index];
    const deleted = deletedSales.has(winerim.saleId) || deletedLines.has(winerim.lineId) || winerim.saleStatus === "rejected";
    const sourceIncomplete = !input.completeness.agoraComplete || !input.completeness.winerimComplete;
    results.push({
      connectionId: input.connectionId,
      restaurantId: winerim.restaurantId,
      businessDay: winerim.businessDay ?? winerim.effectiveAt.slice(0, 10),
      sourceLineKey: `winerim:${winerim.saleId}:${winerim.lineId}`,
      state: sourceIncomplete ? "SOURCE_INCOMPLETE" : deleted ? "DELETED_OR_CANCELLED" : "AMBIGUOUS",
      agora: null,
      winerim,
      evidence: sourceIncomplete ? { completeness: input.completeness } : deleted ? {} : { reason: "EXTRA_IN_WINERIM" },
      manualAction: sourceIncomplete ? "Completar la lectura antes de clasificar" : deleted ? "Ninguna" : "Revisar origen antes de cualquier actuación",
      mode: "AUDIT_ONLY",
    });
  }
  return results;
}

const canonicalTargets = (targets: CandidateTarget[]) => [...targets]
  .map((target) => ({
    saleId: String(target.saleId),
    saleDetailId: target.saleDetailId == null ? null : String(target.saleDetailId),
    qty: Number(target.qty),
    receiptId: target.receiptId ?? null,
    wineId: target.wineId ?? null,
    priceId: target.priceId ?? null,
    stockId: target.stockId ?? null,
    format: target.format ?? null,
  }))
  .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

export function compareAuthorizedBatch(
  authoritative: Array<{ caseFingerprint: string; candidateTargets: CandidateTarget[] }>,
  observed: Array<{ caseFingerprint: string; candidateTargets: CandidateTarget[] }>,
) {
  // The persisted reversal audit predates the enriched evidence target. Its durable
  // authorization identity is the case fingerprint plus the cancelled sale/detail
  // and quantity. Receipt, wine, variant and format remain mandatory for causal
  // stock evidence when present, but their absence in the legacy audit row must not
  // make the same authorized case appear simultaneously extra and missing.
  const authorizationTargets = (targets: CandidateTarget[]) => [...targets]
    .map((target) => ({
      saleId: String(target.saleId),
      saleDetailId: target.saleDetailId == null ? null : String(target.saleDetailId),
      qty: Number(target.qty),
    }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const key = (row: { caseFingerprint: string; candidateTargets: CandidateTarget[] }) => `${row.caseFingerprint}|${JSON.stringify(authorizationTargets(row.candidateTargets))}`;
  const allowed = new Set(authoritative.map(key));
  const seen = new Set(observed.map(key));
  return {
    matching: observed.filter((row) => allowed.has(key(row))),
    extra: observed.filter((row) => !allowed.has(key(row))),
    missing: authoritative.filter((row) => !seen.has(key(row))),
    state: observed.every((row) => allowed.has(key(row))) && authoritative.every((row) => seen.has(key(row))) ? "MATCHED" : "CARDINALITY_CONFLICT",
  } as const;
}

function movementCausallyLinked(movement: StockMovement, candidate: CandidateTarget): boolean {
  const saleId = Number(candidate.saleId);
  const detailId = candidate.saleDetailId == null ? null : Number(candidate.saleDetailId);
  const causal = movement.sale?.saleId === saleId ||
    (detailId != null && movement.sale?.saleDetailIds.includes(detailId)) ||
    Boolean(candidate.receiptId && movement.sale?.receiptId === candidate.receiptId) ||
    (movement.reference?.type === "sale" && String(movement.reference.id) === String(candidate.saleId));
  if (!causal) return false;
  if (candidate.wineId != null && String(movement.wine.wineId) !== String(candidate.wineId)) return false;
  if (candidate.priceId != null && String(movement.variant.priceId) !== String(candidate.priceId)) return false;
  if (candidate.stockId != null && String(movement.variant.stockId) !== String(candidate.stockId)) return false;
  if (candidate.format != null && canonicalFormat(movement.variant.format) !== canonicalFormat(candidate.format)) return false;
  return true;
}

export function evaluateExternalResolution(input: {
  auditCase: ExternalResolutionCase;
  authoritativeBatch: Array<{ caseFingerprint: string; candidateTargets: CandidateTarget[] }>;
  liveSaleIds: number[];
  confirmedKeptSaleIds: number[];
  deletions: SaleDeletion[];
  movements: StockMovement[];
  checkedAt: string;
}): ExternalResolutionEvidence {
  const c = input.auditCase;
  const base: ExternalResolutionEvidence = {
    auditCaseId: c.id,
    connectionId: c.connectionId,
    caseFingerprint: c.caseFingerprint,
    candidateTargets: canonicalTargets(c.candidateTargets),
    verdict: "EXTERNAL_RESOLUTION_EVIDENCE_INCOMPLETE",
    missing: [],
    cancelledSaleId: null,
    keptSaleIds: [],
    movementIds: [],
    checkedAt: input.checkedAt,
  };
  if (c.identityScope === "DETAIL") return { ...base, verdict: "BLOCKED_DETAIL_SCOPE" };
  if (c.identityScope !== "SALE" || !c.evidenceClassification.startsWith("CONFIRMED_DUPLICATE")) return { ...base, verdict: "NOT_ELIGIBLE" };
  const batch = compareAuthorizedBatch(input.authoritativeBatch, [{ caseFingerprint: c.caseFingerprint, candidateTargets: c.candidateTargets }]);
  if (batch.extra.length || batch.matching.length !== 1) return { ...base, verdict: "CARDINALITY_CONFLICT", missing: ["cardinality_conflict"] };
  const saleIds = [...new Set(c.candidateTargets.map((target) => Number(target.saleId)))];
  if (saleIds.length !== 1) return { ...base, verdict: "NOT_ELIGIBLE", missing: ["single_candidate_sale_required"] };
  const candidateSaleId = saleIds[0];
  base.cancelledSaleId = candidateSaleId;
  if (input.liveSaleIds.includes(candidateSaleId)) return { ...base, verdict: "NOT_CANCELLED_YET" };

  const cancel = input.deletions.find((row) => row.saleId === candidateSaleId && row.saleDetailId == null && row.reason === "sale_cancelled");
  if (!cancel) base.missing.push("sale_cancelled");
  if (!c.keepSaleIds.length || !c.keepSaleIds.every((id) => input.confirmedKeptSaleIds.includes(Number(id)))) base.missing.push("kept_sale_present");
  else base.keptSaleIds = c.keepSaleIds.map(Number);

  if (c.expectedRestoredQty === 0) {
    // Winerim's documented cancellation path can add stock even when the original
    // import was history_only. Absence of a movement is not proof of safety.
    const linked = input.movements.filter((movement) => movement.category === "return" && c.candidateTargets.some((target) => movementCausallyLinked(movement, target)));
    if (linked.length) return { ...base, verdict: "CONFLICT", missing: ["unexpected_stock_return_for_history_only"], movementIds: linked.map((movement) => movement.movementId) };
    base.missing.push("history_only_cancellation_stock_readback");
  } else {
    const linked = input.movements.filter((movement) => movement.category === "return" && c.candidateTargets.some((target) => movementCausallyLinked(movement, target)));
    if (!linked.length) base.missing.push("return_movement_exact_link");
    else if (linked.some((movement) => movement.change == null || movement.quantityBefore == null || movement.quantityAfter == null)) base.missing.push("movement_quantities");
    else if (linked.some((movement) => Math.abs((Number(movement.quantityAfter) - Number(movement.quantityBefore)) - Number(movement.change)) > 1e-9)) base.missing.push("movement_quantity_conflict");
    else if (Math.abs(linked.reduce((sum, movement) => sum + Number(movement.change), 0) - c.expectedRestoredQty) > 1e-9) base.missing.push("movement_quantity_conflict");
    else base.movementIds = linked.map((movement) => movement.movementId).sort((a, b) => a - b);
  }
  return base.missing.length ? base : { ...base, verdict: "RESOLVED_EXTERNALLY" };
}
