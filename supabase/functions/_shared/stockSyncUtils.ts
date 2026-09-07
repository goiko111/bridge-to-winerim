import {
  resolveWinerimFormat,
  WINERIM_FORMAT_CATALOG,
} from "./winerimFormats.ts";

/**
 * Canonical Winerim variant string (e.g. "botella", "copa", "magnum",
 * "media-botella", "jeroboam"). Driven by the shared format catalog instead of
 * a hardcoded three-format union.
 */
export type WinerimVariant = string;

export const WINERIM_SALES_IMPORT_MAX_ATTEMPTS = 3;

export const WINERIM_VARIANT_ALIASES: Record<string, string[]> = Object.fromEntries(
  WINERIM_FORMAT_CATALOG.map((format) => [format.variant, format.variants]),
);

/**
 * Fallback chain used ONLY to fill the legacy bottle columns of winerim_wines,
 * preserving the historical behaviour where a wine sold exclusively in half or
 * small bottles still had a bottle price. Stock deduction never uses it.
 */
export const WINERIM_BOTTLE_LEGACY_FALLBACK: readonly string[] = [
  "botella",
  "botella-tienda",
  "botella-pequena",
  "media-botella",
];

export function normalizeWinerimVariant(value: unknown): WinerimVariant | null {
  return resolveWinerimFormat(value)?.variant ?? null;
}

export function variantForAgoraFormat(format: unknown): WinerimVariant {
  const exact = resolveWinerimFormat(format);
  if (exact) return exact.variant;
  // Tolerate decorated POS labels such as "COPA 15CL" or "BOTELLA MAGNUM".
  const raw = String(format || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  if (!raw) return "botella";
  const matches = WINERIM_FORMAT_CATALOG.filter((definition) =>
    definition.variants.some((variant) => {
      const needle = variant.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
      return needle.length >= 4 && raw.includes(needle);
    })
  );
  // Prefer the most specific match ("doble-magnum" over "magnum").
  matches.sort((left, right) => right.variant.length - left.variant.length);
  return matches[0]?.variant ?? "botella";
}



export function signedWholeSaleQuantity(value: unknown): number {
  const quantity = Number(value || 0);
  if (!Number.isFinite(quantity) || quantity === 0) return 0;
  return quantity > 0 ? Math.ceil(quantity) : Math.floor(quantity);
}

export function netSyncedQuantity(values: unknown[]): number {
  const signedTotal = values.reduce<number>((total, value) => {
    const quantity = Number(value || 0);
    return Number.isFinite(quantity) ? total + quantity : total;
  }, 0);
  return Math.max(0, signedTotal);
}

export function findEntryForVariant<T extends { variant?: unknown }>(
  entries: T[],
  variant: WinerimVariant,
): T | undefined {
  return entries.find((entry) => normalizeWinerimVariant(entry.variant) === variant);
}

export function readStockVariant(stock: Record<string, unknown>): WinerimVariant | null {
  const winePrice = stock.winePrice as { variant?: unknown } | undefined;
  return normalizeWinerimVariant(winePrice?.variant ?? stock.variant);
}

export function findStockForVariant<T extends Record<string, unknown>>(
  stocks: T[],
  variant: WinerimVariant,
): T | undefined {
  return stocks.find((stock) => readStockVariant(stock) === variant);
}

export function parseWinerimStockRows(payload: unknown): Record<string, unknown>[] {
  const data = payload as {
    stocks?: unknown;
    data?: { stocks?: unknown };
  } | null;
  const rows = data?.stocks ?? data?.data?.stocks ?? (Array.isArray(payload) ? payload : []);
  return Array.isArray(rows) ? rows as Record<string, unknown>[] : [];
}

export function buildStockSyncIdempotencyKey(
  connectionId: string,
  salesLineItemId: string,
  variant: WinerimVariant,
): string {
  return `${connectionId}:${salesLineItemId}:${variant}`;
}

export function buildStockSyncGroupKey(
  salesEventId: string,
  winerimWineId: string | number,
  variant: WinerimVariant,
): string {
  return `${salesEventId}:${winerimWineId}:${variant}`;
}

export function isStockGroupAlreadySynced(
  rows: { sales_event_id?: unknown; winerim_product_id?: unknown; variant?: unknown }[],
  salesEventId: string,
  winerimWineId: string | number,
  variant: WinerimVariant,
): boolean {
  return rows.some((row) => {
    if (String(row.sales_event_id || "") !== salesEventId) return false;
    if (String(row.winerim_product_id || "") !== String(winerimWineId)) return false;
    const rowVariant = normalizeWinerimVariant(row.variant);
    return rowVariant === null || rowVariant === variant;
  });
}

export function isTerminalStockSyncError(error: unknown): boolean {
  const msg = String(error || "").toLowerCase();
  return (
    msg.includes("wine not found") ||
    msg.includes("not found or not accessible") ||
    msg.includes("variant 'copa' not found") ||
    msg.includes("variant 'botella' not found") ||
    msg.includes("variant 'magnum' not found")
  );
}

export function salesImportQtyWhenStockDidNotMove(input: {
  soldQty: unknown;
  previousStock: unknown;
  newStock: unknown;
}): number {
  const soldQty = Math.ceil(Math.abs(Number(input.soldQty || 0)));
  if (!Number.isFinite(soldQty) || soldQty <= 0) return 0;

  const previousStock = Number(input.previousStock || 0);
  const newStock = Number(input.newStock || 0);
  if (!Number.isFinite(previousStock) || !Number.isFinite(newStock)) return 0;

  return previousStock === newStock ? soldQty : 0;
}

export type WinerimSalesImportMode = "operational" | "historical";

export type WinerimSalesImportSale = {
  orderId: string;
  stockId?: number;
  qty?: number;
  soldAt?: string;
  [key: string]: unknown;
};

export type WinerimSalesImportLine = {
  orderId?: string;
  status?: string;
  stockApplied?: boolean;
  duplicate?: boolean;
  retryable?: boolean;
  error?: string;
  [key: string]: unknown;
};

export function numberFromWinerimSalesImportResponse(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function extractWinerimSalesImportLines(response: unknown): WinerimSalesImportLine[] {
  const payload = (response && typeof response === "object" ? response : {}) as Record<string, unknown>;
  const lines: WinerimSalesImportLine[] = [];
  for (const key of ["sales", "errors"]) {
    const value = payload[key];
    if (!Array.isArray(value)) continue;
    for (const line of value) {
      if (!line || typeof line !== "object") continue;
      const raw = line as Record<string, unknown>;
      lines.push({
        ...raw,
        orderId: raw.orderId === undefined ? undefined : String(raw.orderId),
        status: raw.status === undefined ? undefined : String(raw.status),
        stockApplied: raw.stockApplied === undefined ? undefined : raw.stockApplied === true,
        duplicate: raw.duplicate === undefined ? undefined : raw.duplicate === true,
        retryable: raw.retryable === undefined ? undefined : raw.retryable === true,
        error: raw.error === undefined ? undefined : String(raw.error),
      });
    }
  }
  return lines;
}

export function retryableWinerimSalesImportOrderIds(response: unknown): Set<string> {
  const ids = new Set<string>();
  for (const line of extractWinerimSalesImportLines(response)) {
    if (line.retryable && line.orderId) ids.add(line.orderId);
  }
  return ids;
}

export function retryableWinerimSalesImportSales(
  sales: WinerimSalesImportSale[],
  response: unknown,
): WinerimSalesImportSale[] {
  const retryableIds = retryableWinerimSalesImportOrderIds(response);
  if (retryableIds.size === 0) return [];
  return sales.filter((sale) => retryableIds.has(String(sale.orderId)));
}

export function shouldRequireWinerimSalesImportStockApplied(input: {
  variant: WinerimVariant;
  mode: WinerimSalesImportMode;
}): boolean {
  return input.mode === "operational" && input.variant === "copa";
}

export function assessWinerimSalesImportResponse(input: {
  status: number;
  response: unknown;
  sales: WinerimSalesImportSale[];
  variant: WinerimVariant;
  live: boolean;
  mode: WinerimSalesImportMode;
}): {
  ok: boolean;
  imported: number;
  skipped: number;
  failed: number;
  stockApplied: boolean;
  retryable: boolean;
  error?: string;
} {
  const responsePayload = (input.response && typeof input.response === "object" ? input.response : {}) as Record<string, unknown>;
  const imported = numberFromWinerimSalesImportResponse(responsePayload.imported);
  const skipped = numberFromWinerimSalesImportResponse(responsePayload.skipped);
  const failed = numberFromWinerimSalesImportResponse(responsePayload.failed);
  const lines = extractWinerimSalesImportLines(input.response);
  const retryableSales = retryableWinerimSalesImportSales(input.sales, input.response);
  const httpOk = input.status >= 200 && input.status < 300;
  const retryable = input.status === 409 || retryableSales.length > 0;

  if (!httpOk) {
    return {
      ok: false,
      imported,
      skipped,
      failed,
      stockApplied: false,
      retryable,
      error: `POST /sales/import failed (${input.status})`,
    };
  }

  const requireStockApplied = shouldRequireWinerimSalesImportStockApplied(input);
  if (requireStockApplied && !input.live) {
    return {
      ok: false,
      imported,
      skipped,
      failed,
      stockApplied: false,
      retryable: false,
      error: "POST /sales/import for operational glass sales requires live=true",
    };
  }

  const lineByOrderId = new Map(lines.filter((line) => line.orderId).map((line) => [String(line.orderId), line]));
  const targetLines = input.sales.map((sale) => lineByOrderId.get(String(sale.orderId))).filter(Boolean) as WinerimSalesImportLine[];
  const stockApplied = targetLines.length > 0 && targetLines.every((line) => line.stockApplied === true || line.duplicate === true);

  if (requireStockApplied && !stockApplied) {
    return {
      ok: false,
      imported,
      skipped,
      failed,
      stockApplied: false,
      retryable,
      error: "POST /sales/import live did not apply stock for every glass line",
    };
  }

  const accepted = imported + skipped;
  const hasSuccessLine = targetLines.some((line) =>
    line.duplicate === true ||
    String(line.status || "").toLowerCase() === "imported" ||
    String(line.status || "").toLowerCase() === "duplicate"
  );
  const ok = failed === 0 && retryableSales.length === 0 && (accepted > 0 || hasSuccessLine || responsePayload.success === true);

  return {
    ok,
    imported,
    skipped,
    failed,
    stockApplied,
    retryable,
    error: ok ? undefined : "POST /sales/import response was not accepted",
  };
}

export type SalesCursorDecisionReason =
  | "stock_not_required"
  | "stock_sync_skipped"
  | "missing_winerim_token"
  | "stock_failed"
  | "stock_ok";

export function decideSalesCursorAdvance(input: {
  resolvedLines: number;
  skipStockSync?: boolean;
  hasWinerimToken: boolean;
  stockFailed?: number;
}): { advance: boolean; reason: SalesCursorDecisionReason } {
  // A no-stock import is a historical/backfill operation. It must never move
  // the live sales cursor, otherwise an old import can make cron replay days.
  if (input.skipStockSync) return { advance: false, reason: "stock_sync_skipped" };
  if (input.resolvedLines <= 0) return { advance: true, reason: "stock_not_required" };
  if (!input.hasWinerimToken) return { advance: false, reason: "missing_winerim_token" };
  if ((input.stockFailed || 0) > 0) return { advance: false, reason: "stock_failed" };
  return { advance: true, reason: "stock_ok" };
}
