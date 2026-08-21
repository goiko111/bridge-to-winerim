// ─────────────────────────────────────────────────────────────────────
// STOCK / SALES-IMPORT DRY BOUNDARY (absolute fence)
// ─────────────────────────────────────────────────────────────────────
// `force` may only allow ingesting sales events/lines. It must NEVER bypass the
// stock fence: if the caller asked for skipStockSync, or the connection has
// provider_config.sales_stock_sync_enabled === false, then syncStockForDays and
// POST /sales/import must not run at all.

export type AgoraStockFenceDecision = {
  allowed: boolean;
  skipped: boolean;
  reason: string | null;
};

export function decideAgoraStockFence(input: {
  payload?: Record<string, unknown> | null;
  providerConfig?: unknown;
}): AgoraStockFenceDecision {
  const payload = (input.payload && typeof input.payload === "object")
    ? input.payload as Record<string, unknown>
    : {};
  const config = (input.providerConfig && typeof input.providerConfig === "object")
    ? input.providerConfig as Record<string, unknown>
    : {};

  if (payload.skipStockSync === true) {
    return { allowed: false, skipped: true, reason: "skip_stock_sync_requested" };
  }
  if (config.sales_stock_sync_enabled === false) {
    return { allowed: false, skipped: true, reason: "sales_stock_sync_disabled" };
  }
  return { allowed: true, skipped: false, reason: null };
}
