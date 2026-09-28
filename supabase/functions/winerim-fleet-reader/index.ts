import { asDryRun, assertPost, json, parseJson, preflight, requirePlatformAdmin, safeError } from "../_shared/reconciliation-v2/edge.ts";
import { activeBinding, bindingTimezone, fleetClient, MAX_PAGES } from "../_shared/reconciliation-v2/runtime.ts";
import { CANDIDATE_PROBE_ACTION, assertClosedBusinessDay, nextBusinessDay, normalizeCandidateSales, parseCandidateProbeRequest } from "../_shared/reconciliation-v2/candidateProbe.ts";
import { sha256Canonical } from "../_shared/reconciliation-v2/hash.ts";

type Mapping = { connectionId: string; restaurantId: number; fleetScope?: string; status?: "ACTIVE" | "EXCLUDED" | "DISABLED" | "UNVERIFIED"; exclusionReason?: string };
type DiscoveryBody = { action?: "DISCOVER"; dryRun?: boolean; mappings?: Mapping[] };
type FleetClient = ReturnType<typeof fleetClient>;

async function discover(client: FleetClient) {
  const restaurants: unknown[] = []; let page = 1; let cursor: string | undefined; let complete = false;
  for (; page <= MAX_PAGES; page += 1) {
    const result = await client.restaurants(page, cursor); restaurants.push(...result.data);
    if (!result.hasMore) { complete = true; break; }
    cursor = result.nextCursor ?? undefined; if (!cursor && !result.pagination) break;
  }
  return { restaurants, pagesRead: page, complete };
}

// Fixed operations only: fleet discovery/explicit bindings and a bounded,
// read-only pre-binding probe against GET /api/v2/sales/records.
Deno.serve(async (request) => {
  const options = preflight(request); if (options) return options;
  let probeAuditId: string | null = null; let auditDb: Awaited<ReturnType<typeof requirePlatformAdmin>>["db"] | null = null;
  try {
    assertPost(request);
    const { db, userId } = await requirePlatformAdmin(request); auditDb = db;
    const rawBody = await parseJson<unknown>(request);
    const client = fleetClient(); const credential = await client.credentialEvidence();

    if (rawBody && typeof rawBody === "object" && !Array.isArray(rawBody) && (rawBody as Record<string, unknown>).action === CANDIDATE_PROBE_ACTION) {
      const body = parseCandidateProbeRequest(rawBody);
      const { data: auditId, error: auditError } = await db.rpc("reconciliation_v2_begin_candidate_probe", {
        p_requested_by: userId, p_connection_id: body.connectionId, p_restaurant_id: body.restaurantId, p_business_day: body.businessDay,
      });
      if (auditError || typeof auditId !== "string") throw Object.assign(new Error("La lectura candidata está limitada temporalmente"), { status: 429, code: "CANDIDATE_PROBE_RATE_LIMITED" });
      probeAuditId = auditId;

      const discovery = await discover(client);
      if (!discovery.complete) throw Object.assign(new Error("Discovery de flota incompleto"), { status: 206, code: "FLEET_SOURCE_INCOMPLETE" });
      const candidates = discovery.restaurants.filter((row) => Number((row as { restaurantId?: unknown }).restaurantId) === body.restaurantId);
      if (candidates.length !== 1) throw Object.assign(new Error("restaurantId no permitido por el discovery actual"), { status: 409, code: "RESTAURANT_NOT_DISCOVERED" });
      const candidate = candidates[0] as { restaurantId: number; erpId?: number | string; name?: string; timezone?: string; currency?: string; active?: boolean };
      if (candidate.active === false) throw Object.assign(new Error("El restaurante candidato está inactivo"), { status: 409, code: "RESTAURANT_INACTIVE" });
      const binding = await activeBinding(db, body.connectionId);
      if (binding.winerim_restaurant_id !== body.restaurantId) throw Object.assign(new Error("El binding activo no coincide con el restaurante candidato"), { status: 409, code: "CANDIDATE_BINDING_MISMATCH" });
      const timezone = candidate.timezone || bindingTimezone(binding);
      assertClosedBusinessDay(body.businessDay, timezone);

      const records: unknown[] = []; let salesPages = 0; let complete = false;
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const result = await client.salesByDate(body.restaurantId, { from: body.businessDay, to: nextBusinessDay(body.businessDay), page, status: "all" });
        records.push(...result.data); salesPages = page;
        if (!result.pagination?.hasMore) { complete = true; break; }
      }
      const evidence = normalizeCandidateSales(records);
      const evidenceHash = await sha256Canonical({ restaurantId: body.restaurantId, businessDay: body.businessDay, evidence });
      const outcome = complete ? "COMPLETE" : "SOURCE_INCOMPLETE";
      const { error: finishError } = await db.from("reconciliation_v2_candidate_probe_audit").update({
        outcome, pages_read: salesPages, record_count: evidence.length, evidence_hash: evidenceHash, completed_at: new Date().toISOString(),
      }).eq("id", probeAuditId);
      if (finishError) throw Object.assign(new Error("No se pudo cerrar el registro de auditoría"), { status: 500, code: "PROBE_AUDIT_FINISH_FAILED" });

      return json(request, {
        ok: complete, mode: "AUDIT_ONLY", action: CANDIDATE_PROBE_ACTION, state: outcome,
        connectionId: body.connectionId,
        candidate: { restaurantId: candidate.restaurantId, erpId: candidate.erpId ?? null, name: candidate.name ?? null, timezone, timezoneSource: candidate.timezone ? "fleet_discovery" : "active_binding", currency: candidate.currency ?? null, active: candidate.active ?? null },
        businessDay: body.businessDay, window: { from: body.businessDay, to: nextBusinessDay(body.businessDay) },
        discoveryPages: discovery.pagesRead, salesPages, calls: client.callCount, recordCount: evidence.length, evidenceHash, credential, evidence,
      }, complete ? 200 : 206);
    }

    const body = rawBody as DiscoveryBody;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw Object.assign(new Error("Body inválido"), { status: 400, code: "INVALID_BODY" });
    if (body.action !== undefined && body.action !== "DISCOVER") throw Object.assign(new Error("Acción no permitida"), { status: 400, code: "INVALID_ACTION" });
    const dryRun = asDryRun(body.dryRun);
    const { restaurants, pagesRead, complete } = await discover(client);
    if (!complete) return json(request, { ok: false, mode: "AUDIT_ONLY", dryRun, state: "SOURCE_INCOMPLETE", restaurants, pagesRead, calls: client.callCount }, 206);
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
    return json(request, { ok: true, mode: "AUDIT_ONLY", dryRun, complete, pagesRead, calls: client.callCount, credential, restaurants, proposedMappings: mappings });
  } catch (error) {
    if (probeAuditId && auditDb) {
      const code = typeof error === "object" && error && "code" in error ? String((error as { code: unknown }).code) : "UNEXPECTED_ERROR";
      await auditDb.from("reconciliation_v2_candidate_probe_audit").update({ outcome: "FAILED", error_code: code.slice(0, 96), completed_at: new Date().toISOString() }).eq("id", probeAuditId);
    }
    return safeError(request, error);
  }
});
