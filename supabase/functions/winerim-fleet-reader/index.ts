import { asDryRun, assertPost, json, parseJson, preflight, requirePlatformAdmin, safeError } from "../_shared/reconciliation-v2/edge.ts";
import { fleetClient, MAX_PAGES } from "../_shared/reconciliation-v2/runtime.ts";

type Body = { dryRun?: boolean; mappings?: Array<{ connectionId: string; restaurantId: number; fleetScope?: string; status?: "ACTIVE" | "EXCLUDED" | "DISABLED" | "UNVERIFIED"; exclusionReason?: string }> };

// This replaces the partial multi-action reader. It only discovers the fleet and
// verifies explicit bindings; no arbitrary path/method forwarding exists.
Deno.serve(async (request) => {
  const options = preflight(request); if (options) return options;
  try {
    assertPost(request); const { db } = await requirePlatformAdmin(request); const body = await parseJson<Body>(request); const dryRun = asDryRun(body.dryRun);
    const client = fleetClient(); const restaurants: unknown[] = []; let page = 1; let cursor: string | undefined; let complete = false;
    for (; page <= MAX_PAGES; page += 1) {
      const result = await client.restaurants(page, cursor); restaurants.push(...result.data);
      if (!result.hasMore) { complete = true; break; }
      cursor = result.nextCursor ?? undefined; if (!cursor && !result.pagination) break;
    }
    if (!complete) return json(request, { ok: false, mode: "AUDIT_ONLY", dryRun, state: "SOURCE_INCOMPLETE", restaurants, pagesRead: page, calls: client.callCount }, 206);
    const mappings = body.mappings ?? []; const fleetIds = new Set(restaurants.map((row) => Number((row as { restaurantId: number }).restaurantId)));
    const connectionIds = [...new Set(mappings.map((mapping) => mapping.connectionId))];
    const excluded = new Map<string, string>();
    if (connectionIds.length) {
      const { data, error } = await db.from("reconciliation_v2_connection_exclusions").select("connection_id,reason").in("connection_id", connectionIds);
      if (error) throw Object.assign(new Error("No se pudieron comprobar las exclusiones persistidas"), { status: 500, code: "EXCLUSION_READ_FAILED" });
      for (const row of data ?? []) excluded.set(String(row.connection_id), String(row.reason));
    }
    for (const mapping of mappings) {
      if (excluded.has(mapping.connectionId)) throw Object.assign(new Error(`Conexión excluida de forma persistente: ${mapping.connectionId}`), { status: 409, code: "CONNECTION_PERSISTED_EXCLUDED" });
      if (!fleetIds.has(mapping.restaurantId)) throw Object.assign(new Error(`restaurantId ${mapping.restaurantId} no aparece en /restaurants`), { status: 409, code: "RESTAURANT_NOT_IN_FLEET" });
      if (mapping.status === "EXCLUDED" && !mapping.exclusionReason) throw Object.assign(new Error("Una exclusión requiere motivo persistido"), { status: 400, code: "EXCLUSION_REASON_REQUIRED" });
    }
    if (!dryRun && mappings.length) {
      const rows = mappings.map((mapping) => ({ connection_id: mapping.connectionId, fleet_scope: mapping.fleetScope ?? "primary", winerim_restaurant_id: mapping.restaurantId, status: mapping.status ?? "ACTIVE", exclusion_reason: mapping.status === "EXCLUDED" ? mapping.exclusionReason : null, verified_via: "fleet_read_token_restaurants", verified_at: new Date().toISOString() }));
      const { error } = await db.from("winerim_restaurant_bindings").upsert(rows, { onConflict: "connection_id" });
      if (error) throw Object.assign(new Error("No se pudieron guardar los bindings verificados"), { status: 500, code: "BINDING_WRITE_FAILED" });
    }
    return json(request, { ok: true, mode: "AUDIT_ONLY", dryRun, complete, pagesRead: page, calls: client.callCount, restaurants, proposedMappings: mappings });
  } catch (error) { return safeError(request, error); }
});
