import type {
  WinerimMutationExecutionResult,
  WinerimMutationPlan,
  WinerimMutationTransport,
  WinerimStockMutationInput,
} from "../../handlers/stock";

export type StockMutationContext = Readonly<{
  idempotencyKey: string;
  mutation: WinerimStockMutationInput;
  productName: string;
  providerProductId?: string;
  salesEventId?: string;
  salesLineItemId?: string;
  dryRun?: boolean;
}>;

export type StockClaimState =
  | "ACQUIRED"
  | "DUPLICATE"
  | "BUSY"
  | "TERMINAL"
  | "CONFLICT";

export type StockMutationRunState =
  | "DRY_RUN"
  | "HISTORICAL_BLOCKED"
  | "APPLIED"
  | "DUPLICATE"
  | "BUSY"
  | "RETRY"
  | "TERMINAL"
  | "IDEMPOTENCY_CONFLICT";

export type StockClaimReadback = Readonly<{
  idempotencyKey: string;
  orderId: string;
  connectionId: string;
  job: string;
  status: string;
  attempt: number;
  leaseExpiresAt: string | null;
  result: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}>;

export type StockExecutionReadback = Readonly<{
  id: string;
  orderId: string;
  idempotencyKey: string;
  outcome: string;
  attempt: number;
  durationMs: number | null;
  errorClass: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
}>;

export type StockSyncReadback = Readonly<{
  id: string;
  salesEventId: string | null;
  salesLineItemId: string | null;
  providerProductId: string | null;
  winerimProductId: string | null;
  productName: string;
  quantity: number;
  status: string;
  variant: string | null;
  stockId: string | null;
  idempotencyKey: string | null;
  errorMessage: string | null;
  winerimResponse: Record<string, unknown>;
  createdAt: string;
  syncedAt: string | null;
}>;

export type StockMutationAuditReadback = Readonly<{
  claim: StockClaimReadback | null;
  executions: readonly StockExecutionReadback[];
  stockLogs: readonly StockSyncReadback[];
}>;

export type StockMutationRunResult = Readonly<{
  state: StockMutationRunState;
  connectionId: string;
  idempotencyKey: string;
  orderId: string;
  payloadHash: string;
  plan: WinerimMutationPlan;
  writesPerformed: boolean;
  reason: string;
  execution: WinerimMutationExecutionResult | null;
  audit: StockMutationAuditReadback | null;
}>;

export type PostgresStockAdapterOptions = Readonly<{
  connectionId: string;
  transport: WinerimMutationTransport;
  claimLeaseSeconds?: number;
  now?: () => number;
}>;

export type PostgresStockAdapter = Readonly<{
  execute(input: StockMutationContext): Promise<StockMutationRunResult>;
  readAudit(idempotencyKey: string): Promise<StockMutationAuditReadback>;
}>;
