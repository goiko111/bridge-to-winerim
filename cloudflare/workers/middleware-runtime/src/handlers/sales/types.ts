export type SalesVariant = "BOTTLE" | "GLASS" | "MAGNUM";

export type SalesDocumentKind = "DEFINITIVE_INVOICE" | "OPEN_TICKET";

export type SalesRunKind = "CLOSED_DAY" | "INTRADAY" | "OPEN_TICKET" | "HISTORICAL";

export type SalesApplyMode = "OPERATIONAL" | "HISTORICAL";

export type OpenTicketPolicy = "OBSERVE_ONLY" | "PROVISIONAL_STOCK";

export type SalesIdentitySource = "PROVIDER" | "FALLBACK";

export type SalesLineClassification = "WINE" | "NOT_WINE" | "AMBIGUOUS";

export type ProviderSalesLine = {
  lineId: string;
  providerProductId: string;
  saleFormatId?: string;
  productName: string;
  familyName?: string;
  quantity: number;
  unitPrice?: number;
  totalAmount?: number;
  soldAt?: string;
  suggestedVariant?: SalesVariant;
  classification?: SalesLineClassification;
};

export type ProviderSalesDocument = {
  provider: string;
  documentId: string;
  lifecycleId: string;
  identitySource: SalesIdentitySource;
  businessDay: string;
  kind: SalesDocumentKind;
  isRefund: boolean;
  observedAt?: string;
  lines: ProviderSalesLine[];
};

export type SalesLineResolution = {
  winerimWineId: string;
  variant: SalesVariant;
  stockId?: string;
  stockActive: boolean;
};

export type SalesClaimState = "COMPLETE" | "PENDING" | "FAILED" | "QUARANTINED";

export type SalesClaimSnapshot = {
  claimKey: string;
  state: SalesClaimState;
  appliedQuantity: number;
  lifecycleId?: string;
  winerimWineId?: string;
  variant?: SalesVariant;
  sourceDocumentIds?: string[];
  sourceLineIds?: string[];
  sourceDocumentKind?: SalesDocumentKind;
};

export type SalesBlockedReason =
  | "DOCUMENT_KIND_MISMATCH"
  | "DUPLICATE_DOCUMENT_CONFLICT"
  | "REFUND_REQUIRES_RECONCILIATION"
  | "INVALID_QUANTITY"
  | "FRACTIONAL_HISTORICAL_QUANTITY"
  | "MAPPING_NOT_FOUND"
  | "STOCK_ID_REQUIRED"
  | "OPEN_TICKET_IDENTITY_NOT_STABLE"
  | "OPEN_TICKET_REMOVAL_REQUIRES_RECONCILIATION";

export type SalesBlockedItem = {
  reason: SalesBlockedReason;
  documentId: string;
  lineId?: string;
  providerProductId?: string;
  detail: string;
};

export type SalesObservation = {
  documentId: string;
  lifecycleId: string;
  lineId: string;
  providerProductId: string;
  quantity: number;
  mapped: boolean;
  winerimWineId?: string;
  variant?: SalesVariant;
};

export type SalesImportLine = {
  lineId: string;
  winerimWineId: string;
  variant: SalesVariant;
  stockId?: string;
  quantity: number;
  unitPrice?: number;
  totalAmount?: number;
  providerProductIds: string[];
};

export type SalesImportAction = {
  kind: "SALES_IMPORT";
  live: boolean;
  requireStockApplied: boolean;
  stockDisposition: SalesMutationAcceptanceEvidence["stockDisposition"];
  lines: SalesImportLine[];
};

export type StockApplyAction = {
  kind: "STOCK_APPLY";
  stockId: string;
  variant: "BOTTLE" | "MAGNUM";
  fallbackToSalesOnlyIfStockDidNotMove: boolean;
  line: SalesImportLine;
};

export type SalesIntentAction = SalesImportAction | StockApplyAction;

export type SalesMutationIntent = {
  claimKey: string;
  orderId: string;
  mutationIdempotencyKey: string;
  connectionId: string;
  provider: string;
  businessDay: string;
  lifecycleId: string;
  winerimWineId: string;
  variant: SalesVariant;
  desiredQuantity: number;
  observedAppliedQuantity: number;
  sourceDocumentIds: string[];
  sourceLineIds: string[];
  sourceDocumentKind: SalesDocumentKind;
  action: SalesIntentAction;
};

export type SalesNoopDecision = {
  claimKey: string;
  desiredQuantity: number;
  appliedQuantity: number;
  reason: "ALREADY_APPLIED" | "CLAIM_BUSY" | "CLAIM_QUARANTINED";
};

export type SalesPlan = {
  connectionId: string;
  provider: string;
  runKind: SalesRunKind;
  applyMode: SalesApplyMode;
  documents: ProviderSalesDocument[];
  observations: SalesObservation[];
  blocked: SalesBlockedItem[];
  noops: SalesNoopDecision[];
  intents: SalesMutationIntent[];
};

export type SalesPlanningInput = {
  connectionId: string;
  provider: string;
  runKind: SalesRunKind;
  documents: ProviderSalesDocument[];
  openTicketPolicy?: OpenTicketPolicy;
};

export type SalesPlanningPorts = {
  resolveLine(input: {
    connectionId: string;
    provider: string;
    document: ProviderSalesDocument;
    line: ProviderSalesLine;
  }): Promise<SalesLineResolution | null>;
  loadClaims?(claimKeys: string[]): Promise<SalesClaimSnapshot[]>;
  loadReconciliationClaims?(input: {
    lifecycleIds: string[];
    includeMissingOpenTickets: boolean;
  }): Promise<SalesClaimSnapshot[]>;
};

export type SalesClaimReservation =
  | {
    state: "ACQUIRED";
    appliedQuantity: number;
    claimKey: string;
    payloadSha256: string;
    leaseToken: string;
  }
  | { state: "DUPLICATE"; appliedQuantity: number }
  | { state: "BUSY"; appliedQuantity: number }
  | { state: "QUARANTINED"; appliedQuantity: number; error: string };

export type SalesMutationAcceptanceEvidence = {
  contractVersion: 1;
  orderId: string;
  accepted: true;
  acceptedBy:
    | "WINERIM_MUTATION_RESPONSE"
    | "WINERIM_STOCK_READBACK"
    | "WINERIM_IDEMPOTENCY";
  reason: string;
  responseStatus?: number;
  certifiedOrderIds: string[];
  stockDisposition:
    | "APPLIED_EXACT_ONCE"
    | "HISTORY_ONLY_NO_STOCK"
    | "SALES_ONLY_NO_STOCK";
};

export type SalesClaimCompletionEvidence = {
  contractVersion: 1;
  sourceObserved: true;
  sourcePersisted: true;
  action: SalesIntentAction["kind"];
  winerim: SalesMutationAcceptanceEvidence;
};

export type StockApplyCommand = {
  claimKey: string;
  orderId: string;
  idempotencyKey: string;
  connectionId: string;
  stockId: string;
  winerimWineId: string;
  variant: "BOTTLE" | "MAGNUM";
  decrementQuantity: number;
  desiredQuantity: number;
  businessDay: string;
};

export type StockApplyResult = {
  ok: boolean;
  status?: number;
  duplicate?: boolean;
  stockMoved?: boolean;
  retryable?: boolean;
  error?: string;
  evidence?: SalesMutationAcceptanceEvidence;
};

export type SalesImportCommand = {
  claimKey: string;
  orderId: string;
  idempotencyKey: string;
  connectionId: string;
  businessDay: string;
  live: boolean;
  stockDisposition: SalesMutationAcceptanceEvidence["stockDisposition"];
  lines: SalesImportLine[];
};

export type SalesImportLineResult = {
  lineId?: string;
  stockApplied?: boolean;
  duplicate?: boolean;
  retryable?: boolean;
  error?: string;
};

export type SalesImportResult = {
  ok: boolean;
  status?: number;
  duplicate?: boolean;
  retryable?: boolean;
  error?: string;
  lines?: SalesImportLineResult[];
  evidence?: SalesMutationAcceptanceEvidence;
};

export type SalesExecutionPorts = {
  persistDocuments?(documents: ProviderSalesDocument[]): Promise<void>;
  reserveClaim(intent: SalesMutationIntent): Promise<SalesClaimReservation>;
  applyStock(command: StockApplyCommand): Promise<StockApplyResult>;
  importSales(command: SalesImportCommand): Promise<SalesImportResult>;
  completeClaim(input: {
    claimKey: string;
    orderId: string;
    appliedQuantity: number;
    payloadSha256: string;
    leaseToken: string;
    evidence: SalesClaimCompletionEvidence;
  }): Promise<void>;
  releaseClaim(input: {
    claimKey: string;
    orderId: string;
    retryable: boolean;
    error: string;
    payloadSha256: string;
    leaseToken: string;
  }): Promise<void>;
};

export type SalesExecutionStatus =
  | "DRY_RUN"
  | "APPLIED"
  | "ALREADY_APPLIED"
  | "BUSY"
  | "QUARANTINED"
  | "FAILED";

export type SalesExecutionItem = {
  claimKey: string;
  orderId: string;
  status: SalesExecutionStatus;
  desiredQuantity: number;
  appliedBefore: number;
  appliedDelta: number;
  retryable?: boolean;
  retryMaxAttempts?: number;
  usedSalesOnlyFallback?: boolean;
  completionEvidence?: SalesClaimCompletionEvidence;
  error?: string;
};

export type SalesExecutionResult = {
  dryRun: boolean;
  items: SalesExecutionItem[];
};

export type SalesHandlerInput = SalesPlanningInput & {
  dryRun?: boolean;
};

export type SalesHandlerPorts = SalesPlanningPorts & SalesExecutionPorts;

export type SalesHandlerResult = {
  plan: SalesPlan;
  execution: SalesExecutionResult;
};
