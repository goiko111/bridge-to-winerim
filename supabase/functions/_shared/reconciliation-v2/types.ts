export const RECONCILIATION_STATES = [
  "MATCHED",
  "HISTORY_MISSING",
  "STOCK_MISSING",
  "BOTH_MISSING",
  "STOCK_UNKNOWN",
  "AMBIGUOUS",
  "SOURCE_INCOMPLETE",
  "DELETED_OR_CANCELLED",
  "OPEN",
] as const;

export type ReconciliationState = (typeof RECONCILIATION_STATES)[number];

export const LEGACY_RECONCILIATION_STATES = [
  "MISSING_IN_WINERIM", "EXTRA_IN_WINERIM", "QUANTITY_MISMATCH", "AMOUNT_MISMATCH",
  "CONFIRMED_DUPLICATE", "PROBABLE_DUPLICATE", "PARTIAL_STOCK", "STOCK_CONFLICT",
  "OPEN_PENDING", "REVERSAL_PENDING", "RESOLVED_EXTERNALLY",
  "EXTERNAL_RESOLUTION_EVIDENCE_INCOMPLETE", "CARDINALITY_CONFLICT",
] as const;
export type LegacyReconciliationState = (typeof LEGACY_RECONCILIATION_STATES)[number];

/** Stable public contract. Existing rows are translated explicitly at read time. */
export function canonicalizeReconciliationState(state: string): ReconciliationState {
  switch (state) {
    case "MATCHED":
    case "RESOLVED_EXTERNALLY": return "MATCHED";
    case "HISTORY_MISSING":
    case "MISSING_IN_WINERIM": return "HISTORY_MISSING";
    case "STOCK_MISSING":
    case "PARTIAL_STOCK":
    case "STOCK_CONFLICT": return "STOCK_MISSING";
    case "BOTH_MISSING": return "BOTH_MISSING";
    case "STOCK_UNKNOWN":
    case "EXTERNAL_RESOLUTION_EVIDENCE_INCOMPLETE": return "STOCK_UNKNOWN";
    case "SOURCE_INCOMPLETE": return "SOURCE_INCOMPLETE";
    case "DELETED_OR_CANCELLED":
    case "REVERSAL_PENDING": return "DELETED_OR_CANCELLED";
    case "OPEN":
    case "OPEN_PENDING": return "OPEN";
    case "AMBIGUOUS":
    case "EXTRA_IN_WINERIM":
    case "QUANTITY_MISMATCH":
    case "AMOUNT_MISMATCH":
    case "CONFIRMED_DUPLICATE":
    case "PROBABLE_DUPLICATE":
    case "CARDINALITY_CONFLICT": return "AMBIGUOUS";
    default: return "SOURCE_INCOMPLETE";
  }
}

export type SourceCompleteness = {
  agoraComplete: boolean;
  winerimComplete: boolean;
  stockComplete: boolean;
  pagesRead: number;
  expectedPages: number | null;
  reason?: string | null;
};

export type AgoraLine = {
  connectionId: string;
  restaurantId: number;
  businessDay: string;
  documentId: string;
  sourceSystem: string | null;
  externalOrderId: string | null;
  orderId: string | null;
  sourceLineId: string | null;
  wineId: string;
  wineName?: string | null;
  family?: string | null;
  providerProductId?: string | null;
  format: string | null;
  quantity: number;
  amountMinor: number | null;
  effectiveAt: string;
  isOpen: boolean;
  isCancelled: boolean;
};

export type StockEffect = {
  known: boolean;
  status: string;
  stockApplied: boolean | null;
  receiptId: string | null;
  movementIds: number[];
  movementDifference: number | null;
  unbackedQty: number | null;
};

export type WinerimLine = {
  restaurantId: number;
  saleId: number;
  lineId: string;
  saleDetailId: number | null;
  saleStatus: "confirmed" | "pending" | "rejected";
  sourceSystem: string | null;
  externalOrderId: string | null;
  orderId: string | null;
  sourceLineId: string | null;
  invoiceId: string | null;
  receiptId: string | null;
  wineId: string;
  format: string | null;
  quantity: number;
  amountMinor: number | null;
  effectiveAt: string;
  businessDay?: string;
  stockEffect: StockEffect;
};

export type SaleDeletion = {
  saleId: number;
  saleDetailId: number | null;
  lineId: string;
  reason: "sale_cancelled" | "empty_bottle_discarded" | "product_deleted" | "line_deleted";
  deletedAt: string;
  effectiveAt: string | null;
  externalOrderId: string | null;
};

export type ReconciliationResult = {
  connectionId: string;
  restaurantId: number;
  businessDay: string;
  sourceLineKey: string;
  state: ReconciliationState;
  agora: AgoraLine | null;
  winerim: WinerimLine | null;
  evidence: Record<string, unknown>;
  manualAction: string;
  mode: "AUDIT_ONLY";
};

export type CandidateTarget = {
  saleId: string;
  saleDetailId: string | null;
  qty: number;
  receiptId?: string | null;
  wineId?: string | null;
  priceId?: string | null;
  stockId?: string | null;
  format?: string | null;
};

export type ExternalResolutionCase = {
  id: string;
  connectionId: string;
  caseFingerprint: string;
  identityScope: "SALE" | "DETAIL" | null;
  evidenceClassification: string;
  keepSaleIds: string[];
  candidateTargets: CandidateTarget[];
  expectedRestoredQty: number;
};

export type StockMovement = {
  movementId: number;
  category: string;
  change: number | null;
  quantityBefore: number | null;
  quantityAfter: number | null;
  wine: { wineId: number | null };
  variant: { priceId: number | null; stockId: number | null; format: string | null };
  sale: {
    saleId: number | null;
    saleDetailIds: number[];
    receiptId: string | null;
    orderId: string | null;
  } | null;
  reference: { type: string; id: number | string } | null;
};

export type ExternalResolutionEvidence = {
  auditCaseId: string;
  connectionId: string;
  caseFingerprint: string;
  candidateTargets: CandidateTarget[];
  verdict:
    | "RESOLVED_EXTERNALLY"
    | "EXTERNAL_RESOLUTION_EVIDENCE_INCOMPLETE"
    | "NOT_CANCELLED_YET"
    | "BLOCKED_DETAIL_SCOPE"
    | "NOT_ELIGIBLE"
    | "CONFLICT"
    | "CARDINALITY_CONFLICT";
  missing: string[];
  cancelledSaleId: number | null;
  keptSaleIds: number[];
  movementIds: number[];
  checkedAt: string;
};
