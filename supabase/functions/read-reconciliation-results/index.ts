import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { aggregateByWineFormat, resolveAgoraFormat } from "../_shared/reconciliation-v2/dayAggregate.ts";
import { corsFor, json, preflight, requireAuthenticated, safeError, serverClient } from "../_shared/reconciliation-v2/edge.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const day = /^\d{4}-\d{2}-\d{2}$/; const PAGE = 1000; const MAX_PAGES = 100;
const csvCell = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
async function paged<T>(make: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>) {
  const rows: T[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) { const { data, error } = await make(page * PAGE, page * PAGE + PAGE - 1); if (error) throw Object.assign(new Error("Lectura paginada fallida"), { status: 500, code: "READ_MODEL_PAGE_FAILED" }); const batch = data ?? []; rows.push(...batch); if (batch.length < PAGE) return { rows, complete: true, pages: page + 1 }; }
  return { rows, complete: false, pages: MAX_PAGES };
}
async function assertConnectionAccess(auth: SupabaseClient, connectionId: string) {
  const [{ data: admin, error: adminError }, { data: allowed, error: accessError }] = await Promise.all([auth.rpc("is_platform_admin"), auth.rpc("can_access_connection", { _connection_id: connectionId })]);
  if (adminError || accessError) throw Object.assign(new Error("No se pudo validar el acceso al restaurante"), { status: 500, code: "ACCESS_CHECK_FAILED" });
  if (admin !== true && allowed !== true) throw Object.assign(new Error("Sin acceso a este restaurante"), { status: 403, code: "CONNECTION_FORBIDDEN" });
}

Deno.serve(async (request) => {
  const options = preflight(request); if (options) return options;
  try {
    if (request.method !== "GET") throw Object.assign(new Error("Método no permitido"), { status: 405 });
    const { db: auth } = await requireAuthenticated(request); const db = serverClient(); const url = new URL(request.url);
    if (url.searchParams.get("view") === "fleet") {
      const { data: isAdmin, error: roleError } = await auth.rpc("is_platform_admin"); if (roleError || isAdmin !== true) throw Object.assign(new Error("La vista de flota requiere rol de plataforma"), { status: 403, code: "FLEET_FORBIDDEN" });
      const [bindings, connections, dashboard, checkpoints] = await Promise.all([
        paged<Record<string, unknown>>((from, to) => db.from("winerim_restaurant_bindings").select("connection_id,winerim_restaurant_id,status,exclusion_reason,verified_at,metadata").order("connection_id").range(from, to)),
        paged<Record<string, unknown>>((from, to) => db.from("pos_connections").select("id,location_name,provider,enabled").eq("provider", "agora").eq("enabled", true).order("location_name").range(from, to)),
        paged<Record<string, unknown>>((from, to) => db.from("reconciliation_v2_dashboard").select("connection_id,business_day,state,line_count,revenue_minor,freshness_at").order("business_day", { ascending: false }).range(from, to)),
        paged<Record<string, unknown>>((from, to) => db.from("winerim_sync_checkpoints").select("connection_id,stream,last_complete_at,coverage_complete,last_error_code").order("connection_id").range(from, to)),
      ]);
      const bindingByConnection = new Map(bindings.rows.map((binding) => [String(binding.connection_id), binding]));
      const fleet = connections.rows.map((connection) => {
        const connectionId = String(connection.id); const binding = bindingByConnection.get(connectionId);
        const metadata = binding?.metadata && typeof binding.metadata === "object" && !Array.isArray(binding.metadata) ? binding.metadata as Record<string, unknown> : {};
        return {
          connection_id: connectionId,
          location_name: connection.location_name == null ? null : String(connection.location_name),
          provider: String(connection.provider),
          enabled: connection.enabled === true,
          winerim_restaurant_id: binding?.winerim_restaurant_id ?? null,
          status: binding?.status ?? "UNBOUND",
          exclusion_reason: binding?.exclusion_reason ?? null,
          verified_at: binding?.verified_at ?? null,
          metadata: { ...metadata, restaurantName: connection.location_name ?? metadata.restaurantName ?? null },
        };
      });
      const complete = bindings.complete && connections.complete && dashboard.complete && checkpoints.complete;
      return json(request, { ok: complete, mode: "AUDIT_ONLY", bindings: fleet, dashboard: dashboard.rows, checkpoints: checkpoints.rows, readCoverage: { complete, pages: { bindings: bindings.pages, connections: connections.pages, dashboard: dashboard.pages, checkpoints: checkpoints.pages } } }, complete ? 200 : 206);
    }
    const connectionId = url.searchParams.get("connectionId") ?? ""; const from = url.searchParams.get("from") ?? ""; const to = url.searchParams.get("to") ?? "";
    if (!uuid.test(connectionId) || !day.test(from) || !day.test(to) || from > to) throw Object.assign(new Error("Filtros inválidos"), { status: 400, code: "INVALID_FILTERS" });
    await assertConnectionAccess(auth, connectionId); const state = url.searchParams.get("state"); const format = url.searchParams.get("format") ?? "json";
    const results = await paged<Record<string, unknown>>((start, end) => { let query = db.from("reconciliation_v2_latest").select("*").eq("connection_id", connectionId).gte("business_day", from).lte("business_day", to).order("business_day", { ascending: false }).order("id").range(start, end); if (state) query = query.eq("canonical_state", state); return query; });
    const [dashboard, analytics, aggregates, checkpoints, snapshots, movements] = await Promise.all([
      paged<Record<string, unknown>>((start, end) => db.from("reconciliation_v2_dashboard").select("*").eq("connection_id", connectionId).gte("business_day", from).lte("business_day", to).order("business_day").range(start, end)),
      paged<Record<string, unknown>>((start, end) => db.from("reconciliation_v2_analytics_series").select("*").eq("connection_id", connectionId).gte("business_day", from).lte("business_day", to).order("business_day").range(start, end)),
      paged<Record<string, unknown>>((start, end) => db.from("reconciliation_v2_analytics_aggregates").select("*").eq("connection_id", connectionId).gte("period_start", from).lte("period_start", to).order("period_start").range(start, end)),
      paged<Record<string, unknown>>((start, end) => db.from("winerim_sync_checkpoints").select("*").eq("connection_id", connectionId).order("stream").range(start, end)),
      paged<Record<string, unknown>>((start, end) => db.from("winerim_stock_snapshots").select("id,captured_at,complete,page_count,item_count,content_hash").eq("connection_id", connectionId).order("captured_at", { ascending: false }).range(start, end)),
      paged<Record<string, unknown>>((start, end) => db.from("winerim_stock_movements").select("movement_id,recorded_at,wine_id,price_id,stock_id,format_key,quantity_before,quantity_change,quantity_after,category,cause,linked_sale_id,receipt_id").eq("connection_id", connectionId).gte("recorded_at", `${from}T00:00:00Z`).lt("recorded_at", `${to}T23:59:59.999Z`).order("recorded_at", { ascending: false }).order("movement_id").range(start, end)),
    ]);
    let stockItems = { rows: [] as Record<string, unknown>[], complete: true, pages: 0 };
    if (snapshots.rows[0]?.id) stockItems = await paged<Record<string, unknown>>((start, end) => db.from("winerim_stock_snapshot_items").select("stock_id,wine_id,wine_name,vintage,format_key,price_amount,stock,stock_active,threshold,max_qty").eq("snapshot_id", snapshots.rows[0].id).order("wine_name").range(start, end));
    // Live daily category totals from the compact projection (current classification rules), replacing stored DAY rows.
    const { data: daily, error: dailyError } = await db.rpc("reconciliation_v2_analytics_daily", { p_connection_id: connectionId, p_from: from, p_to: to });
    if (!dailyError && Array.isArray(daily)) {
      aggregates.rows = [...aggregates.rows.filter((row) => row.period_kind !== "DAY"), ...daily.map((row: Record<string, unknown>) => ({ connection_id: connectionId, period_kind: "DAY", period_start: row.business_day, business_day: row.business_day, category: row.category, revenue_minor: Number(row.revenue_minor ?? 0), quantity: Number(row.quantity ?? 0), ticket_count: Number(row.ticket_count ?? 0), currency: row.currency ?? "EUR", coverage_complete: true }))];
    }
    // Winerim wine names for display.
    const winerimIds = [...new Set(results.rows.map((row) => (row.winerim_line as Record<string, unknown> | null)?.wineId).filter((id) => id != null).map(String))];
    if (winerimIds.length) {
      const names = new Map<string, string>();
      for (let i = 0; i < winerimIds.length; i += 200) {
        const { data } = await db.from("winerim_wines").select("winerim_id,name,vintage").eq("connection_id", connectionId).in("winerim_id", winerimIds.slice(i, i + 200));
        for (const w of data ?? []) names.set(String(w.winerim_id), `${w.name ?? ""}${w.vintage ? ` ${w.vintage}` : ""}`.trim());
      }
      for (const row of results.rows) { const w = row.winerim_line as Record<string, unknown> | null; if (w && w.wineId != null) w.wineName = names.get(String(w.wineId)) ?? null; }
    }
    // Display format from recognised labels only (Ágora may carry the product name in `format`).
    for (const row of results.rows) { const a = row.agora_line as Record<string, unknown> | null; if (a) { const f = resolveAgoraFormat(a.format == null ? null : String(a.format)); a.formatRaw = a.format; a.format = f.format; a.formatInferred = f.inferred; } }
    // Day comparison by (day, Winerim wine, format) summing units; line detail is explanation only.
    const dayAggregate = state ? null : aggregateByWineFormat(results.rows.map((row) => ({ businessDay: String(row.business_day), state: String(row.canonical_state) as never, agora: row.agora_line as Record<string, unknown> | null, winerim: row.winerim_line as Record<string, unknown> | null })), results.complete);
    const sets = { results, dashboard, analytics, aggregates, checkpoints, snapshots, stockItems, movements }; const complete = Object.values(sets).every((item) => item.complete);
    if (format === "csv") {
      if (!complete) return json(request, { ok: false, code: "EXPORT_INCOMPLETE", message: "El export superó el límite explícito; reduce el rango. No se genera un CSV parcial.", readCoverage: { complete: false } }, 409);
      const header = ["fecha","estado","estado_origen","referencia","formato","factura","hora","unidades_agora","importe_agora","sale_id_winerim","unidades_winerim","accion_manual"];
      const rows = results.rows.map((row) => { const a = (row.agora_line ?? {}) as Record<string, unknown>; const w = (row.winerim_line ?? {}) as Record<string, unknown>; return [row.business_day,row.canonical_state,row.state,a.wineName ?? a.wineId,a.format,a.documentId,a.effectiveAt,a.quantity,a.amountMinor,w.saleId,w.quantity,row.manual_action].map(csvCell).join(","); });
      return new Response([header.map(csvCell).join(","), ...rows].join("\n"), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename=reconciliation-${connectionId}-${from}-${to}.csv`, ...corsFor(request) } });
    }
    if (format !== "json") throw Object.assign(new Error("format debe ser json o csv"), { status: 400, code: "INVALID_FORMAT" });
    return json(request, { ok: complete, mode: "AUDIT_ONLY", filters: { connectionId, from, to, state }, results: results.rows, dayAggregate, dashboard: dashboard.rows, analytics: analytics.rows, aggregates: aggregates.rows, coverage: checkpoints.rows, stockSnapshots: snapshots.rows, stockItems: stockItems.rows, stockMovements: movements.rows, readCoverage: { complete, pages: Object.fromEntries(Object.entries(sets).map(([key, item]) => [key, item.pages])) } }, complete ? 200 : 206);
  } catch (error) { return safeError(request, error); }
});
