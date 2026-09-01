export const WINERIM_MUTATION_MAX_ATTEMPTS = 3;
export const WINERIM_MUTATION_RETRY_DELAY_MS = 1_000;

export type WinerimStockVariant = "glass" | "bottle" | "magnum";
export type WinerimMutationMode = "operational" | "historical";

export type WinerimStockIdentity = Readonly<{
  wineId: string;
  stockId: number;
  variant: WinerimStockVariant;
}>;

export type WinerimStockMutationInput = Readonly<{
  mode: WinerimMutationMode;
  orderId: string;
  soldAt: string;
  quantity: number;
  soldStock: WinerimStockIdentity;
  stockSource?: WinerimStockIdentity;
  currentSourceStock?: number;
}>;

export type WinerimSalesImportLine = Readonly<{
  stockId: number;
  qty: number;
  soldAt: string;
  orderId: string;
}>;

export type WinerimSalesImportBody = Readonly<{
  live?: true;
  sales: readonly WinerimSalesImportLine[];
}>;

export type WinerimStockPutBody = Readonly<{
  stock: number;
}>;

export type WinerimMutationHttpRequest =
  | Readonly<{
    kind: "stock-put";
    method: "PUT";
    path: string;
    body: WinerimStockPutBody;
  }>
  | Readonly<{
    kind: "sales-import";
    method: "POST";
    path: "/api/v2/sales/import";
    body: WinerimSalesImportBody;
  }>;

export type WinerimMutationPlan = Readonly<{
  mode: WinerimMutationMode;
  soldStock: WinerimStockIdentity;
  stockSource?: WinerimStockIdentity;
  mutatesStock: boolean;
  requiresLiveStockCertification: boolean;
  request: WinerimMutationHttpRequest;
}>;

export type WinerimMutationResponse = Readonly<{
  status: number;
  body?: unknown;
}>;

export type WinerimStockReadback = Readonly<{
  stockId: number;
  stock: number;
}>;

export type WinerimSalesImportResponseLine = Readonly<{
  orderId?: string;
  status?: string;
  stockApplied?: boolean;
  duplicate?: boolean;
  retryable?: boolean;
  error?: string;
}>;

export type WinerimMutationResponseDecision = Readonly<{
  action: "success" | "retry-full" | "retry-lines" | "terminal";
  certifiedOrderIds: readonly string[];
  retryableOrderIds: readonly string[];
  terminalOrderIds: readonly string[];
  reason: string;
}>;

export type WinerimMutationAttempt = Readonly<{
  number: number;
  request: WinerimMutationHttpRequest;
  response?: WinerimMutationResponse;
  decision?: WinerimMutationResponseDecision;
  readback?: WinerimStockReadback;
  readbackError?: string;
  error?: string;
}>;

export type WinerimMutationExecutionResult = Readonly<{
  ok: boolean;
  retryable: boolean;
  plan: WinerimMutationPlan;
  attempts: readonly WinerimMutationAttempt[];
  certifiedOrderIds: readonly string[];
  terminalOrderIds: readonly string[];
  pendingOrderIds: readonly string[];
  reason: string;
}>;

export type WinerimMutationTransport = Readonly<{
  send(request: WinerimMutationHttpRequest): Promise<WinerimMutationResponse>;
  // Absolute stock writes remain uncertified unless the adapter supplies a
  // separately fetched, normalized post-write value for the same stockId.
  readStock?(stockId: number): Promise<WinerimStockReadback>;
  sleep(milliseconds: number): Promise<void>;
}>;

export type WinerimMutationPlanErrorCode =
  | "INVALID_ORDER_ID"
  | "INVALID_SOLD_AT"
  | "INVALID_QUANTITY"
  | "INVALID_STOCK_IDENTITY"
  | "MISSING_STOCK_SOURCE"
  | "CROSS_WINE_STOCK_SOURCE"
  | "UNSUPPORTED_STOCK_SOURCE"
  | "MISSING_CURRENT_STOCK";

export class WinerimMutationPlanError extends Error {
  readonly code: WinerimMutationPlanErrorCode;

  constructor(code: WinerimMutationPlanErrorCode, message: string) {
    super(message);
    this.name = "WinerimMutationPlanError";
    this.code = code;
  }
}
