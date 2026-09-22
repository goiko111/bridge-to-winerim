// ─────────────────────────────────────────────────────────────────────
// STABLE WINERIM SALES ORDER SCOPE (duplicate-safe idempotency key)
// ─────────────────────────────────────────────────────────────────────
// The Winerim /sales/import idempotency key is derived from the order scope.
// Historically the scope included the ACCUMULATED quantity of the aggregate,
// so re-syncing an open ticket after the waiter added one more glass/bottle
// produced a DIFFERENT key for the very same Agora lines. Winerim then
// recorded a brand new sale instead of recognising the previous one, which is
// the exact mechanism behind the 18–20/09 Cienvinos duplicates.
//
// The stable scope keeps the line identity (event/line ids or intraday group
// keys) and DROPS the quantity, so the same lines always map to the same
// receiving sale, whatever the ticket grows to.
//
// Rollout is fail-closed and canary-gated:
//   * only connections in the canary allowlist, and
//   * only business days >= the cutoff day.
// Closed/older days keep the legacy scope, so no historical line is ever
// re-sent under a new key (which would itself create duplicates).

/** Cienvinos Écija — first canary for the stable scope. */
export const AGORA_STABLE_SALES_ORDER_SCOPE_CANARY_CONNECTION_IDS: readonly string[] = [
  "21ee3345-1090-4e83-94f2-43126d6e7695",
];

/** Business day (inclusive) from which the stable scope applies. */
export const AGORA_STABLE_SALES_ORDER_SCOPE_FROM_DAY = "2026-09-23";

function normalizeConnectionId(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeDay(value: unknown): string {
  const day = String(value ?? "").trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : "";
}

export function isStableAgoraSalesOrderScopeEnabled(input: {
  connectionId: unknown;
  day: unknown;
}): boolean {
  const connectionId = normalizeConnectionId(input.connectionId);
  if (!AGORA_STABLE_SALES_ORDER_SCOPE_CANARY_CONNECTION_IDS.includes(connectionId)) return false;
  const day = normalizeDay(input.day);
  if (!day) return false;
  return day >= AGORA_STABLE_SALES_ORDER_SCOPE_FROM_DAY;
}

/**
 * Builds the order scope of a Winerim sales import. `keys` are the identity
 * keys of the aggregated Agora lines (sales_event ids + sales_line_item ids,
 * or intraday group keys). `qty` is the accumulated quantity and is only kept
 * for the legacy (non-canary / pre-cutoff) scope.
 */
export function buildAgoraWinerimSalesOrderScope(input: {
  connectionId: unknown;
  day: unknown;
  keys: readonly string[];
  qty: number | string;
  prefix?: string;
}): string {
  const parts: string[] = [];
  if (input.prefix) parts.push(input.prefix);
  parts.push(...input.keys.slice().sort());
  if (!isStableAgoraSalesOrderScopeEnabled({ connectionId: input.connectionId, day: input.day })) {
    parts.push(String(input.qty));
  }
  return parts.join("|");
}
