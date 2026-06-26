export type WinerimVariant = "copa" | "botella" | "magnum";

export const WINERIM_VARIANT_ALIASES: Record<WinerimVariant, string[]> = {
  copa: ["copa", "glass"],
  botella: ["botella", "bottle", "botella-pequena", "media-botella"],
  magnum: ["magnum"],
};

export function normalizeWinerimVariant(value: unknown): WinerimVariant | null {
  const raw = String(value || "").trim().toLowerCase();
  for (const [canonical, aliases] of Object.entries(WINERIM_VARIANT_ALIASES) as [WinerimVariant, string[]][]) {
    if (aliases.includes(raw)) return canonical;
  }
  return null;
}

export function variantForAgoraFormat(format: unknown): WinerimVariant {
  const raw = String(format || "").toUpperCase();
  if (raw === "COPA" || raw === "GLASS" || raw.includes("COPA") || raw.includes("GLASS")) return "copa";
  if (raw === "MAGNUM" || raw.includes("MAGNUM")) return "magnum";
  return "botella";
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
  if (input.resolvedLines <= 0) return { advance: true, reason: "stock_not_required" };
  if (input.skipStockSync) return { advance: true, reason: "stock_sync_skipped" };
  if (!input.hasWinerimToken) return { advance: false, reason: "missing_winerim_token" };
  if ((input.stockFailed || 0) > 0) return { advance: false, reason: "stock_failed" };
  return { advance: true, reason: "stock_ok" };
}
