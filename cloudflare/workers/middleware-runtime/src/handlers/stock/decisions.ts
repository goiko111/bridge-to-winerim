import {
  WinerimMutationHttpRequest,
  WinerimMutationPlan,
  WinerimMutationPlanError,
  WinerimMutationResponse,
  WinerimMutationResponseDecision,
  WinerimSalesImportBody,
  WinerimSalesImportResponseLine,
  WinerimStockIdentity,
  WinerimStockMutationInput,
} from "./contracts";

const NON_RETRYABLE_STATUSES = new Set([400, 401, 403, 404, 422]);
const IMPORT_SUCCESS_STATUSES = new Set(["imported", "duplicate"]);

function assertStockIdentity(identity: WinerimStockIdentity, label: string): void {
  if (!identity || !String(identity.wineId || "").trim() ||
      !Number.isInteger(identity.stockId) || identity.stockId <= 0 ||
      !["glass", "bottle", "magnum"].includes(identity.variant)) {
    throw new WinerimMutationPlanError(
      "INVALID_STOCK_IDENTITY",
      `${label} must contain a wineId, positive integer stockId and canonical variant`,
    );
  }
}

function assertCommonInput(input: WinerimStockMutationInput): void {
  if (!String(input.orderId || "").trim()) {
    throw new WinerimMutationPlanError("INVALID_ORDER_ID", "orderId must be stable and non-empty");
  }
  if (!String(input.soldAt || "").trim()) {
    throw new WinerimMutationPlanError("INVALID_SOLD_AT", "soldAt must be non-empty");
  }
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
    throw new WinerimMutationPlanError("INVALID_QUANTITY", "quantity must be a positive integer");
  }
  assertStockIdentity(input.soldStock, "soldStock");
}

function assertSameWine(sold: WinerimStockIdentity, source: WinerimStockIdentity): void {
  if (sold.wineId !== source.wineId) {
    throw new WinerimMutationPlanError(
      "CROSS_WINE_STOCK_SOURCE",
      "sold variant and stock source must belong to the same Winerim wine",
    );
  }
}

function planHistoricalMutation(input: WinerimStockMutationInput): WinerimMutationPlan {
  if (input.stockSource) {
    assertStockIdentity(input.stockSource, "stockSource");
    assertSameWine(input.soldStock, input.stockSource);
  }

  return {
    mode: "historical",
    soldStock: input.soldStock,
    stockSource: input.stockSource,
    mutatesStock: false,
    requiresLiveStockCertification: false,
    request: {
      kind: "sales-import",
      method: "POST",
      path: "/api/v2/sales/import",
      body: {
        sales: [{
          stockId: input.soldStock.stockId,
          qty: input.quantity,
          soldAt: input.soldAt,
          orderId: input.orderId,
        }],
      },
    },
  };
}

function planOperationalGlassMutation(input: WinerimStockMutationInput): WinerimMutationPlan {
  const source = input.stockSource;
  if (!source) {
    throw new WinerimMutationPlanError(
      "MISSING_STOCK_SOURCE",
      "operational glass sales require the bottle stock source identity",
    );
  }
  assertStockIdentity(source, "stockSource");
  assertSameWine(input.soldStock, source);
  if (source.variant !== "bottle") {
    throw new WinerimMutationPlanError(
      "UNSUPPORTED_STOCK_SOURCE",
      "operational glass sales must identify their bottle stock source",
    );
  }

  return {
    mode: "operational",
    soldStock: input.soldStock,
    stockSource: source,
    mutatesStock: true,
    requiresLiveStockCertification: true,
    request: {
      kind: "sales-import",
      method: "POST",
      path: "/api/v2/sales/import",
      body: {
        live: true,
        sales: [{
          // Winerim resolves the bottle partition from the sold glass stockId.
          stockId: input.soldStock.stockId,
          qty: input.quantity,
          soldAt: input.soldAt,
          orderId: input.orderId,
        }],
      },
    },
  };
}

function planOperationalAbsoluteStockMutation(input: WinerimStockMutationInput): WinerimMutationPlan {
  const source = input.stockSource;
  if (!source) {
    throw new WinerimMutationPlanError(
      "MISSING_STOCK_SOURCE",
      "operational bottle and magnum sales require a stock source identity",
    );
  }
  assertStockIdentity(source, "stockSource");
  assertSameWine(input.soldStock, source);

  const sameVariantAndStock = source.variant === input.soldStock.variant &&
    source.stockId === input.soldStock.stockId;
  if (!sameVariantAndStock) {
    throw new WinerimMutationPlanError(
      "UNSUPPORTED_STOCK_SOURCE",
      "bottle and magnum currently mutate only their own variant stockId",
    );
  }
  if (!Number.isInteger(input.currentSourceStock) || Number(input.currentSourceStock) < 0) {
    throw new WinerimMutationPlanError(
      "MISSING_CURRENT_STOCK",
      "operational bottle and magnum sales require a non-negative integer currentSourceStock",
    );
  }

  const targetStock = Math.max(0, Number(input.currentSourceStock) - input.quantity);
  return {
    mode: "operational",
    soldStock: input.soldStock,
    stockSource: source,
    mutatesStock: true,
    requiresLiveStockCertification: false,
    request: {
      kind: "stock-put",
      method: "PUT",
      path: `/api/v2/stock/${source.stockId}`,
      body: { stock: targetStock },
    },
  };
}

export function planWinerimStockMutation(input: WinerimStockMutationInput): WinerimMutationPlan {
  assertCommonInput(input);
  if (input.mode === "historical") return planHistoricalMutation(input);
  if (input.mode !== "operational") {
    throw new WinerimMutationPlanError("INVALID_STOCK_IDENTITY", "unknown mutation mode");
  }
  if (input.soldStock.variant === "glass") return planOperationalGlassMutation(input);
  return planOperationalAbsoluteStockMutation(input);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function responseLines(body: unknown): WinerimSalesImportResponseLine[] {
  const payload = asRecord(body);
  const lines: WinerimSalesImportResponseLine[] = [];
  for (const key of ["sales", "errors"]) {
    const rawLines = payload[key];
    if (!Array.isArray(rawLines)) continue;
    for (const rawLine of rawLines) {
      if (!rawLine || typeof rawLine !== "object") continue;
      const line = rawLine as Record<string, unknown>;
      lines.push({
        orderId: line.orderId === undefined ? undefined : String(line.orderId),
        status: line.status === undefined ? undefined : String(line.status),
        stockApplied: line.stockApplied === true,
        duplicate: line.duplicate === true,
        retryable: line.retryable === true,
        error: line.error === undefined ? undefined : String(line.error),
      });
    }
  }
  return lines;
}

function emptyDecision(
  action: WinerimMutationResponseDecision["action"],
  reason: string,
): WinerimMutationResponseDecision {
  return {
    action,
    certifiedOrderIds: [],
    retryableOrderIds: [],
    terminalOrderIds: [],
    reason,
  };
}

function salesImportDecision(
  plan: WinerimMutationPlan,
  request: Extract<WinerimMutationHttpRequest, { kind: "sales-import" }>,
  response: WinerimMutationResponse,
): WinerimMutationResponseDecision {
  const requestedIds = request.body.sales.map((sale) => sale.orderId);
  if (response.status === 409) {
    return {
      ...emptyDecision("retry-full", "winerim_conflict_no_mutation_applied"),
      retryableOrderIds: requestedIds,
    };
  }
  if (NON_RETRYABLE_STATUSES.has(response.status)) {
    return {
      ...emptyDecision("terminal", "winerim_request_or_identity_rejected"),
      terminalOrderIds: requestedIds,
    };
  }
  if (response.status < 200 || response.status >= 300) {
    return {
      ...emptyDecision("terminal", "winerim_unclassified_http_failure"),
      terminalOrderIds: requestedIds,
    };
  }

  const linesByOrderId = new Map<string, WinerimSalesImportResponseLine>();
  for (const line of responseLines(response.body)) {
    if (line.orderId) linesByOrderId.set(line.orderId, line);
  }

  const certifiedOrderIds: string[] = [];
  const retryableOrderIds: string[] = [];
  const terminalOrderIds: string[] = [];
  for (const orderId of requestedIds) {
    const line = linesByOrderId.get(orderId);
    if (line?.retryable === true) {
      retryableOrderIds.push(orderId);
      continue;
    }

    const certified = plan.requiresLiveStockCertification
      ? line?.stockApplied === true || line?.duplicate === true
      : line?.duplicate === true || IMPORT_SUCCESS_STATUSES.has(String(line?.status || "").toLowerCase());
    if (certified) certifiedOrderIds.push(orderId);
    else terminalOrderIds.push(orderId);
  }

  if (retryableOrderIds.length > 0) {
    return {
      action: "retry-lines",
      certifiedOrderIds,
      retryableOrderIds,
      terminalOrderIds,
      reason: terminalOrderIds.length > 0
        ? "retry_only_retryable_lines_with_terminal_siblings"
        : "retry_only_lines_marked_retryable",
    };
  }
  if (terminalOrderIds.length > 0) {
    return {
      action: "terminal",
      certifiedOrderIds,
      retryableOrderIds,
      terminalOrderIds,
      reason: plan.requiresLiveStockCertification
        ? "glass_line_not_certified_stock_applied_or_duplicate"
        : "historical_line_not_certified_imported_or_duplicate",
    };
  }
  return {
    action: "success",
    certifiedOrderIds,
    retryableOrderIds,
    terminalOrderIds,
    reason: plan.requiresLiveStockCertification
      ? "all_glass_lines_stock_certified"
      : "all_historical_lines_import_certified",
  };
}

export function decideWinerimMutationResponse(input: {
  plan: WinerimMutationPlan;
  request?: WinerimMutationHttpRequest;
  response: WinerimMutationResponse;
}): WinerimMutationResponseDecision {
  const request = input.request ?? input.plan.request;
  if (input.response.status === 409) {
    const ids = request.kind === "sales-import"
      ? request.body.sales.map((sale) => sale.orderId)
      : [];
    return {
      ...emptyDecision("retry-full", "winerim_conflict_no_mutation_applied"),
      retryableOrderIds: ids,
    };
  }

  if (request.kind === "sales-import") {
    return salesImportDecision(input.plan, request, input.response);
  }
  if (NON_RETRYABLE_STATUSES.has(input.response.status)) {
    return emptyDecision("terminal", "winerim_request_or_identity_rejected");
  }
  if (input.response.status >= 200 && input.response.status < 300) {
    return emptyDecision("success", "absolute_stock_put_accepted_pending_readback");
  }
  return emptyDecision("terminal", "winerim_unclassified_http_failure");
}

export function selectRetryableSalesImportRequest(
  request: Extract<WinerimMutationHttpRequest, { kind: "sales-import" }>,
  retryableOrderIds: readonly string[],
): Extract<WinerimMutationHttpRequest, { kind: "sales-import" }> {
  const retryable = new Set(retryableOrderIds);
  const body: WinerimSalesImportBody = {
    ...(request.body.live === true ? { live: true as const } : {}),
    sales: request.body.sales.filter((sale) => retryable.has(sale.orderId)),
  };
  return { ...request, body };
}
