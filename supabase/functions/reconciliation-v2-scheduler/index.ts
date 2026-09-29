// Fleet AUDIT_ONLY daily orchestrator: fresh sales ingest -> fresh movements ingest -> reconciliation.
// Accepts ONLY the rotating scheduler service identity. Never repairs, never calls /stock, never uses historical mode.
// Without connectionId it dispatches one child run per ACTIVE binding (Ocean Club hard-excluded) and publishes
// a fleet summary; with connectionId it runs that single restaurant.
import { assertPost, json, parseJson, requireAdminOrScheduler, safeError, SCHEDULER_KEY_HEADER } from "../_shared/reconciliation-v2/edge.ts";
import { activeBinding } from "../_shared/reconciliation-v2/runtime.ts";
import { closedBusinessDay, type FleetRow, PIPELINE_VERSION, runScheduledPipeline, SCHEDULER_LOCK_STREAM, SCHEDULER_LOCK_TTL_SECONDS, schedulerScopeAllows, type StepResult, summarizeFleet } from "../_shared/reconciliation-v2/scheduler.ts";

const CONCURRENCY = 2;
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

Deno.serve(async (request) => {
  try {
    assertPost(request);
    const auth = await requireAdminOrScheduler(request);
    if (!auth.scheduler) throw Object.assign(new Error("Solo la identidad de servicio del scheduler"), { status: 403, code: "SCHEDULER_IDENTITY_REQUIRED" });
    const db = auth.db; const body = await parseJson<{ connectionId?: string; wait?: boolean }>(request).catch(() => ({} as { connectionId?: string; wait?: boolean }));
    const key = request.headers.get(SCHEDULER_KEY_HEADER)!; const base = Deno.env.get("SUPABASE_URL")!; const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
    const post = async (fn: string, payload: Record<string, unknown>): Promise<StepResult> => {
      const response = await fetch(`${base}/functions/v1/${fn}`, { method: "POST", headers: { "Content-Type": "application/json", apikey: anon, Authorization: `Bearer ${anon}`, [SCHEDULER_KEY_HEADER]: key }, body: JSON.stringify(payload) });
      const parsed = await response.json().catch(() => ({})); return { status: response.status, body: parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {} };
    };
    const table = () => db.from("reconciliation_v2_scheduler_state");

    if (!body.connectionId) {
      // ── Dispatcher ──
      const { data: bindings, error } = await db.from("winerim_restaurant_bindings").select("connection_id,metadata").eq("status", "ACTIVE");
      if (error) throw Object.assign(new Error("Bindings"), { status: 500, code: "BINDINGS_READ_FAILED" });
      const { count: enabled, error: cErr } = await db.from("pos_connections").select("id", { count: "exact", head: true }).eq("provider", "agora").eq("enabled", true);
      if (cErr) throw Object.assign(new Error("Conexiones"), { status: 500, code: "CONNECTIONS_READ_FAILED" });
      const targets = (bindings ?? []).filter((b) => schedulerScopeAllows(b.connection_id));
      const unbound = Math.max(0, (enabled ?? 0) - targets.length - 1 /* Ocean Club, excluded by design */);
      const work = async () => {
        const rows: FleetRow[] = []; const queue = [...targets];
        await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
          for (let b = queue.shift(); b; b = queue.shift()) {
            try {
              const r = await post("reconciliation-v2-scheduler", { connectionId: b.connection_id });
              let outcome = String(r.body.outcome ?? "DISPATCH_FAILED") as FleetRow["outcome"]; const day = typeof r.body.businessDay === "string" ? r.body.businessDay : null;
              if (outcome === "ALREADY_DONE" && day) { // report the stored state, never "done" as success
                const { data } = await table().select("status").eq("connection_id", b.connection_id).eq("business_day", day).eq("pipeline_version", PIPELINE_VERSION).maybeSingle();
                outcome = (data?.status ?? "DISPATCH_FAILED") as FleetRow["outcome"];
              }
              rows.push({ connectionId: b.connection_id, outcome, businessDay: day, errorCode: (r.body.errorCode ?? r.body.code ?? null) as string | null });
            } catch { rows.push({ connectionId: b.connection_id, outcome: "DISPATCH_FAILED", businessDay: null, errorCode: "DISPATCH_EXCEPTION" }); }
          }
        }));
        const summary = summarizeFleet(rows, unbound);
        console.log(JSON.stringify({ event: "fleet_audit_summary", pipelineVersion: PIPELINE_VERSION, bound: targets.length, unbound, ...summary, rows }));
        return { rows, summary };
      };
      if (body.wait === true) { const r = await work(); return json(request, { ok: r.summary.fleetReconciled, mode: "AUDIT_ONLY", dispatch: "FLEET", bound: targets.length, unbound, ...r.summary, rows: r.rows }); }
      const p = work(); if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(p);
      return json(request, { ok: true, mode: "AUDIT_ONLY", dispatch: "FLEET", accepted: targets.length, unbound }, 202);
    }

    // ── Single restaurant ──
    const connectionId = body.connectionId;
    if (!schedulerScopeAllows(connectionId)) throw Object.assign(new Error("Fuera de alcance"), { status: 403, code: "SCHEDULER_SCOPE_DENIED" });
    const binding = await activeBinding(db, connectionId);
    const owner = crypto.randomUUID();
    const outcome = await runScheduledPipeline(binding, {
      now: () => new Date(),
      claim: async () => { const { data, error } = await db.rpc("reconciliation_v2_claim_lock", { p_connection_id: connectionId, p_stream: SCHEDULER_LOCK_STREAM, p_owner_id: owner, p_ttl_seconds: SCHEDULER_LOCK_TTL_SECONDS }); if (error) throw Object.assign(new Error("Lock"), { status: 500, code: "LOCK_FAILED" }); return data === true; },
      release: async () => { await db.rpc("reconciliation_v2_release_lock", { p_connection_id: connectionId, p_stream: SCHEDULER_LOCK_STREAM, p_owner_id: owner }); },
      getState: async (day) => { const { data, error } = await table().select("business_day,status,error_code,attempts").eq("connection_id", connectionId).eq("business_day", day).eq("pipeline_version", PIPELINE_VERSION).maybeSingle(); if (error) throw Object.assign(new Error("Estado"), { status: 500, code: "STATE_READ_FAILED" }); return data; },
      lastOtherState: async (day) => { const { data, error } = await table().select("business_day,status,error_code,attempts").eq("connection_id", connectionId).eq("pipeline_version", PIPELINE_VERSION).neq("business_day", day).order("updated_at", { ascending: false }).limit(1).maybeSingle(); if (error) throw Object.assign(new Error("Estado"), { status: 500, code: "STATE_READ_FAILED" }); return data; },
      putState: async (day, patch) => { const { error } = await table().upsert({ connection_id: connectionId, business_day: day, pipeline_version: PIPELINE_VERSION, ...patch }, { onConflict: "connection_id,business_day,pipeline_version" }); if (error) throw Object.assign(new Error("Estado"), { status: 500, code: "STATE_WRITE_FAILED" }); },
      sales: (day) => post("sync-sales-records", { connectionId, dryRun: false, maxPages: 100, overlapBusinessDay: day }),
      movements: (day) => post("sync-stock-movements", { connectionId, dryRun: false, maxPages: 100, overlapBusinessDay: day }),
      reconcile: (day) => post("run-daily-reconciliation", { connectionId, businessDay: day, dryRun: false }),
    });
    void closedBusinessDay;
    return json(request, { ok: outcome.outcome === "SUCCEEDED", mode: "AUDIT_ONLY", pipelineVersion: PIPELINE_VERSION, connectionId, ...outcome });
  } catch (error) { return safeError(request, error); }
});
