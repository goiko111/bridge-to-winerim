// Clinic-only AUDIT_ONLY daily orchestrator: fresh sales ingest -> fresh movements ingest -> reconciliation.
// Accepts ONLY the rotating scheduler service identity. Never repairs, never calls /stock, never uses historical mode.
import { assertPost, json, requireAdminOrScheduler, safeError, SCHEDULER_KEY_HEADER } from "../_shared/reconciliation-v2/edge.ts";
import { activeBinding } from "../_shared/reconciliation-v2/runtime.ts";
import { CLINIC_CONNECTION_ID, PIPELINE_VERSION, runScheduledPipeline, SCHEDULER_CONNECTIONS, SCHEDULER_LOCK_STREAM, SCHEDULER_LOCK_TTL_SECONDS, type StepResult } from "../_shared/reconciliation-v2/scheduler.ts";

Deno.serve(async (request) => {
  try {
    assertPost(request);
    const auth = await requireAdminOrScheduler(request);
    if (!auth.scheduler) throw Object.assign(new Error("Solo la identidad de servicio del scheduler"), { status: 403, code: "SCHEDULER_IDENTITY_REQUIRED" });
    const db = auth.db; const connectionId = CLINIC_CONNECTION_ID;
    if (!SCHEDULER_CONNECTIONS.has(connectionId)) throw Object.assign(new Error("Fuera de alcance"), { status: 403, code: "SCHEDULER_SCOPE_DENIED" });
    const binding = await activeBinding(db, connectionId);
    const key = request.headers.get(SCHEDULER_KEY_HEADER)!; const base = Deno.env.get("SUPABASE_URL")!; const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
    const owner = crypto.randomUUID();
    const call = async (fn: string, body: Record<string, unknown>): Promise<StepResult> => {
      const response = await fetch(`${base}/functions/v1/${fn}`, { method: "POST", headers: { "Content-Type": "application/json", apikey: anon, Authorization: `Bearer ${anon}`, [SCHEDULER_KEY_HEADER]: key }, body: JSON.stringify(body) });
      const parsed = await response.json().catch(() => ({})); return { status: response.status, body: parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {} };
    };
    const table = () => db.from("reconciliation_v2_scheduler_state");
    const outcome = await runScheduledPipeline(binding, {
      now: () => new Date(),
      claim: async () => { const { data, error } = await db.rpc("reconciliation_v2_claim_lock", { p_connection_id: connectionId, p_stream: SCHEDULER_LOCK_STREAM, p_owner_id: owner, p_ttl_seconds: SCHEDULER_LOCK_TTL_SECONDS }); if (error) throw Object.assign(new Error("Lock"), { status: 500, code: "LOCK_FAILED" }); return data === true; },
      release: async () => { await db.rpc("reconciliation_v2_release_lock", { p_connection_id: connectionId, p_stream: SCHEDULER_LOCK_STREAM, p_owner_id: owner }); },
      getState: async (day) => { const { data, error } = await table().select("business_day,status,error_code,attempts").eq("connection_id", connectionId).eq("business_day", day).eq("pipeline_version", PIPELINE_VERSION).maybeSingle(); if (error) throw Object.assign(new Error("Estado"), { status: 500, code: "STATE_READ_FAILED" }); return data; },
      lastOtherState: async (day) => { const { data, error } = await table().select("business_day,status,error_code,attempts").eq("connection_id", connectionId).eq("pipeline_version", PIPELINE_VERSION).neq("business_day", day).order("updated_at", { ascending: false }).limit(1).maybeSingle(); if (error) throw Object.assign(new Error("Estado"), { status: 500, code: "STATE_READ_FAILED" }); return data; },
      putState: async (day, patch) => { const { error } = await table().upsert({ connection_id: connectionId, business_day: day, pipeline_version: PIPELINE_VERSION, ...patch }, { onConflict: "connection_id,business_day,pipeline_version" }); if (error) throw Object.assign(new Error("Estado"), { status: 500, code: "STATE_WRITE_FAILED" }); },
      sales: (day) => call("sync-sales-records", { connectionId, dryRun: false, maxPages: 100, overlapBusinessDay: day }),
      movements: (day) => call("sync-stock-movements", { connectionId, dryRun: false, maxPages: 100, overlapBusinessDay: day }),
      reconcile: (day) => call("run-daily-reconciliation", { connectionId, businessDay: day, dryRun: false }),
    });
    return json(request, { ok: outcome.outcome === "SUCCEEDED" || outcome.outcome === "ALREADY_DONE", mode: "AUDIT_ONLY", pipelineVersion: PIPELINE_VERSION, connectionId, ...outcome });
  } catch (error) { return safeError(request, error); }
});
