export type FleetBinding = { connection_id: string; location_name: string | null; provider: string; enabled: boolean; winerim_restaurant_id: number | null; status: "ACTIVE" | "UNBOUND" | string; exclusion_reason: string | null; verified_at: string | null; metadata: Record<string, unknown> };
export type FleetPayload = { ok: boolean; mode: "AUDIT_ONLY"; bindings: FleetBinding[]; dashboard: Array<{ connection_id: string; business_day: string; state: string; line_count: number; revenue_minor: number; freshness_at: string }>; checkpoints: Array<{ connection_id: string; stream: string; last_complete_at: string | null; coverage_complete: boolean; last_error_code: string | null }>; readCoverage: { complete: boolean } };
export type ResultRow = { id: string; business_day: string; state: string; canonical_state: string; state_contract_version: string; agora_line: Record<string, unknown> | null; winerim_line: Record<string, unknown> | null; evidence: Record<string, unknown>; manual_action: string; last_seen_at: string };
export type ReconciliationPayload = {
  ok: boolean; mode: "AUDIT_ONLY"; results: ResultRow[];
  dashboard: Array<{ business_day: string; state: string; line_count: number; revenue_minor: number; freshness_at: string }>;
  analytics: Array<{ business_day: string; category: "WINE" | "OTHER_BEVERAGE" | "FOOD" | "UNCLASSIFIED"; revenue_minor: number; quantity: number; ticket_count: number; currency: string | null; freshness_at: string; coverage_complete: boolean }>;
  aggregates: Array<{ period_kind: string; period_start: string; category: string; revenue_minor: number; revenue_share: number | null; quantity: number; ticket_count: number }>;
  coverage: Array<{ stream: string; last_complete_at: string | null; coverage_complete: boolean; last_error_code: string | null }>;
  stockSnapshots: Array<{ id: string; captured_at: string; complete: boolean; page_count: number; item_count: number; content_hash: string }>;
  stockItems: Array<{ stock_id: number; wine_id: number; wine_name: string | null; vintage: string | null; format_key: string | null; price_amount: number | null; stock: number | null; stock_active: boolean; threshold: number | null; max_qty: number | null }>;
  stockMovements: Array<{ movement_id: number; recorded_at: string; wine_id: number | null; format_key: string | null; quantity_before: number | null; quantity_change: number | null; quantity_after: number | null; category: string; cause: string | null; linked_sale_id: number | null; receipt_id: string | null }>;
  readCoverage: { complete: boolean; pages: Record<string, number> };
};
