/**
 * Winerim API v2 "certified" sales import contract (POST /api/v2/sales/import
 * with `mode`).
 *
 * Why this exists: the legacy contract (`live: true`, no `mode`) gives no
 * guarantee about the effective sale date and no strong per-line idempotency,
 * so bottle deductions ended up stamped with the push timestamp instead of the
 * real provider sale time (Albariza, Sept 2026). The certified contract accepts
 * `soldAt` as the effective date, keys idempotency on
 * (restaurant, sourceSystem, orderId, sourceLineId, variant) and returns a
 * receipt per line, so a resend can never deduct twice.
 *
 * Mode mapping (deliberately conservative):
 *   operational + live  -> history_and_stock  (today's service; Winerim moves stock)
 *   everything else     -> history_only       (stock already handled by PUT /stock)
 *
 * We never emit stock_only from here: the absolute stock lane already owns the
 * inventory effect, and asking Winerim to move it again would double-deduct.
 */

import type { WinerimSalesImportMode, WinerimSalesImportSale } from "./stockSyncUtils.ts";

export type WinerimCertifiedMode = "history_and_stock" | "history_only" | "stock_only";

export const WINERIM_CERTIFIED_SOURCE_SYSTEM = "agora";

/** Canary gate: provider_config.winerim_certified_sales_import === true. */
export function isWinerimCertifiedSalesImportEnabled(providerConfig: unknown): boolean {
  const config = (providerConfig && typeof providerConfig === "object")
    ? providerConfig as Record<string, unknown>
    : {};
  return config.winerim_certified_sales_import === true;
}

export function certifiedModeForWinerimSalesImport(input: {
  mode: WinerimSalesImportMode;
  live: boolean;
}): WinerimCertifiedMode {
  return input.mode === "operational" && input.live === true ? "history_and_stock" : "history_only";
}

/**
 * Deterministic line id inside the order. Our orderIds already encode
 * connection/day/wine/variant/scope and we send one line per order, so a fixed
 * id keeps the idempotency key stable across retries.
 */
export function certifiedSourceLineId(_sale: WinerimSalesImportSale): string {
  return "1";
}

export function buildCertifiedWinerimSalesImportBody(input: {
  mode: WinerimCertifiedMode;
  sales: WinerimSalesImportSale[];
  variant: string;
  sourceSystem?: string;
  correlationId?: string;
}): Record<string, unknown> {
  return {
    mode: input.mode,
    sourceSystem: (input.sourceSystem || WINERIM_CERTIFIED_SOURCE_SYSTEM).toLowerCase(),
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    sales: input.sales.map((sale) => ({
      stockId: sale.stockId,
      qty: sale.qty,
      soldAt: sale.soldAt,
      orderId: sale.orderId,
      sourceLineId: certifiedSourceLineId(sale),
      variant: input.variant,
    })),
  };
}

export type CertifiedSalesImportLine = {
  index?: number;
  orderId?: string;
  result?: string;
  reasonCode?: string;
  retryable?: boolean;
  receiptId?: string;
  historyWritten?: boolean;
  stockApplied?: boolean;
  stockSkipReason?: string;
  [key: string]: unknown;
};

export function extractCertifiedSalesImportLines(response: unknown): CertifiedSalesImportLine[] {
  const payload = (response && typeof response === "object" ? response : {}) as Record<string, unknown>;
  const value = payload.sales;
  if (!Array.isArray(value)) return [];
  return value
    .filter((line) => line && typeof line === "object")
    .map((line) => {
      const raw = line as Record<string, unknown>;
      return {
        ...raw,
        orderId: raw.orderId === undefined ? undefined : String(raw.orderId),
        result: raw.result === undefined ? undefined : String(raw.result).toUpperCase(),
        reasonCode: raw.reasonCode === undefined ? undefined : String(raw.reasonCode).toUpperCase(),
        retryable: raw.retryable === true,
        receiptId: raw.receiptId === undefined ? undefined : String(raw.receiptId),
        historyWritten: raw.historyWritten === true,
        stockApplied: raw.stockApplied === true,
        stockSkipReason: raw.stockSkipReason === undefined ? undefined : String(raw.stockSkipReason),
      } as CertifiedSalesImportLine;
    });
}

/** Lines Winerim says we may safely resend (RESOURCE_BUSY, STORAGE_ERROR, ...). */
export function retryableCertifiedSales(
  sales: WinerimSalesImportSale[],
  response: unknown,
): WinerimSalesImportSale[] {
  const lines = extractCertifiedSalesImportLines(response);
  if (lines.length === 0) return [];
  const retryableOrderIds = new Set(
    lines
      .filter((line) => line.retryable === true || line.result === "UNCERTAIN")
      .map((line) => String(line.orderId || "")),
  );
  if (retryableOrderIds.size === 0) return [];
  return sales.filter((sale) => retryableOrderIds.has(String(sale.orderId)));
}

/**
 * A line already imported through the legacy contract is rejected with
 * LEGACY_ALREADY_IMPORTED. The unit is already in Winerim (history and, in that
 * lane, stock), so this is a duplicate, not a failure: treating it as an error
 * would make the queue retry forever on sales that are already recorded.
 */
export function isCertifiedDuplicateLine(line: CertifiedSalesImportLine): boolean {
  if (line.result === "DUPLICATE") return true;
  return line.result === "REJECTED" && line.reasonCode === "LEGACY_ALREADY_IMPORTED";
}

export function assessCertifiedWinerimSalesImportResponse(input: {
  status: number;
  response: unknown;
  sales: WinerimSalesImportSale[];
  requireStockApplied: boolean;
}): {
  ok: boolean;
  imported: number;
  skipped: number;
  failed: number;
  stockApplied: boolean;
  retryable: boolean;
  receiptIds: string[];
  error?: string;
} {
  const payload = (input.response && typeof input.response === "object" ? input.response : {}) as Record<string, unknown>;
  const lines = extractCertifiedSalesImportLines(input.response);
  const byOrderId = new Map(lines.filter((line) => line.orderId).map((line) => [String(line.orderId), line]));
  const targetLines = input.sales
    .map((sale, index) => byOrderId.get(String(sale.orderId)) ?? lines[index])
    .filter(Boolean) as CertifiedSalesImportLine[];

  const applied = targetLines.filter((line) => line.result === "APPLIED");
  const duplicates = targetLines.filter((line) => isCertifiedDuplicateLine(line));
  const rejected = targetLines.filter((line) => line.result === "REJECTED" && !isCertifiedDuplicateLine(line));
  const uncertain = targetLines.filter((line) => line.result === "UNCERTAIN");
  const retryableSales = retryableCertifiedSales(input.sales, input.response);
  const httpOk = input.status >= 200 && input.status < 300;
  const retryable = retryableSales.length > 0 || uncertain.length > 0;
  const receiptIds = targetLines.map((line) => line.receiptId).filter(Boolean) as string[];

  if (!httpOk && applied.length === 0 && duplicates.length === 0) {
    const reason = rejected[0]?.reasonCode || String(payload.error || "");
    return {
      ok: false,
      imported: 0,
      skipped: 0,
      failed: Math.max(rejected.length, input.sales.length),
      stockApplied: false,
      retryable,
      receiptIds,
      error: `POST /sales/import (certified) failed (${input.status})${reason ? `: ${reason}` : ""}`,
    };
  }

  // Duplicates report the ORIGINAL application, so their stock flag is trustworthy.
  const stockApplied = targetLines.length > 0 &&
    targetLines.every((line) =>
      line.stockApplied === true ||
      (line.result === "REJECTED" && line.reasonCode === "LEGACY_ALREADY_IMPORTED")
    );

  if (rejected.length > 0 || uncertain.length > 0 || targetLines.length === 0) {
    return {
      ok: false,
      imported: applied.length,
      skipped: duplicates.length,
      failed: rejected.length + uncertain.length,
      stockApplied,
      retryable,
      receiptIds,
      error: targetLines.length === 0
        ? "POST /sales/import (certified) returned no line for the requested sale"
        : `POST /sales/import (certified) line not committed: ${
          (rejected[0]?.reasonCode || uncertain[0]?.reasonCode || "UNKNOWN")
        }`,
    };
  }

  if (input.requireStockApplied && !stockApplied) {
    // Restaurant has stock control disabled in Winerim: history is written,
    // stock intentionally skipped. Terminal and correct — never retry.
    const stockControlDisabled = targetLines.length > 0 &&
      targetLines.every((line) =>
        line.historyWritten === true && line.stockSkipReason === "stock_control_disabled"
      );
    if (stockControlDisabled) {
      return {
        ok: true,
        imported: applied.length,
        skipped: duplicates.length,
        failed: 0,
        stockApplied: false,
        retryable: false,
        receiptIds,
      };
    }
    return {
      ok: false,
      imported: applied.length,
      skipped: duplicates.length,
      failed: 0,
      stockApplied: false,
      retryable,
      receiptIds,
      error: "POST /sales/import (certified) did not apply stock for every line",
    };
  }

  return {
    ok: true,
    imported: applied.length,
    skipped: duplicates.length,
    failed: 0,
    stockApplied,
    retryable: false,
    receiptIds,
  };
}
