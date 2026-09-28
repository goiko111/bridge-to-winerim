// NOT DEPLOYED. Read-only Winerim fleet reader + external-cancellation checker + AUDIT_ONLY daily reconciler.
// Never calls Winerim write endpoints, never touches agora_reversal_queue, never cancels sales.
// Writes (only with dryRun=false) go to evidence/reconciliation tables and to agora_reversal_audit.workflow_status.
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { createClient } from "npm:@supabase/supabase-js@2";
import { z } from "npm:zod@3";
import { createFleetClient, redact } from "../_shared/winerimFleetClient.ts";
import { evaluateExternalResolution, type AuditCase, type SaleDeletion, type StockMovement, type SaleRecord } from "../_shared/winerimFleetEvidence.ts";

const Body = z.object({
  action: z.enum(["list-restaurants", "check-external-resolutions"]),
  connectionIds: z.array(z.string().uuid()).max(30).optional(),
  changedSince: z.string().optional(),
  dryRun: z.boolean().default(true),
});
const EXCLUDED_LOCATIONS = ["Ocean Club"]; // ya no es cliente

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const auth = req.headers.get("Authorization") || "";
    const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
    const { data: isAdmin } = await userClient.rpc("is_platform_admin");
    if (isAdmin !== true) return json({ error: "Solo administradores de plataforma" }, 403);
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) return json({ error: parsed.error.flatten().fieldErrors }, 400);
    const { action, connectionIds, changedSince, dryRun } = parsed.data;

    const fleet = createFleetClient(Deno.env.get("WINERIM_FLEET_READ_TOKEN") || "");
    const db = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const rs = await fleet.restaurants();
    if (action === "list-restaurants") return json({ restaurants: rs.data, serverTimezone: rs.serverTimezone, salesRecordedIn: rs.salesRecordedIn, calls: fleet.calls });
    const inScope = new Set((rs.data || []).map((r: { restaurantId: number }) => r.restaurantId));

    const { data: links } = await db.from("winerim_restaurant_links").select("connection_id, winerim_restaurant_id, pos_connections(location_name)");
    const runId = crypto.randomUUID();
    const checkedAt = new Date().toISOString();
    const results: unknown[] = [];
    for (const link of links || []) {
      const loc = (link as any).pos_connections?.location_name;
      if (EXCLUDED_LOCATIONS.includes(loc)) continue;
      if (connectionIds && !connectionIds.includes(link.connection_id)) continue;
      const rid = Number(link.winerim_restaurant_id);
      if (!inScope.has(rid)) { results.push({ connection_id: link.connection_id, error: "restaurante fuera del alcance de la credencial" }); continue; }
      const { data: cases } = await db.from("agora_reversal_audit")
        .select("id, connection_id, identity_scope, evidence_classification, keep_sale_ids, candidate_targets, winerim_wine_id, reverse_qty, history_units_excess, bottles_overdeducted, business_day, workflow_status")
        .eq("connection_id", link.connection_id).eq("identity_scope", "SALE").like("evidence_classification", "CONFIRMED_DUPLICATE%")
        .neq("workflow_status", "RESOLVED_EXTERNALLY");
      if (!cases?.length) continue;

      // Deletions via sync mode (bounded by changedSince).
      const deletions: SaleDeletion[] = []; const present: SaleRecord[] = [];
      let cursor: string | undefined; let respRid = rid;
      const since = changedSince || new Date(Date.now() - 14 * 864e5).toISOString();
      for (let i = 0; i < 50; i++) {
        const r = await fleet.salesSync(rid, since, cursor);
        respRid = Number(r.restaurantId ?? rid);
        deletions.push(...(r.deletions || [])); present.push(...(r.data || []));
        if (!r.sync?.hasMore) break; cursor = r.sync.nextCursor;
      }
      // Kept sales: exact read by orderId of each case's day.
      const kept: SaleRecord[] = [];
      for (const c of cases) {
        const day = String(c.business_day);
        const next = new Date(`${day}T12:00:00Z`); next.setUTCDate(next.getUTCDate() + 1);
        const r = await fleet.salesByDate(rid, day, next.toISOString().slice(0, 10), 1);
        kept.push(...(r.data || []));
      }
      // Return movements in the same window.
      const returns: StockMovement[] = []; let afterId: number | undefined;
      for (let i = 0; i < 50; i++) {
        const r = await fleet.movements(rid, { from: since, category: "return", afterId });
        returns.push(...(r.data || []));
        if (!r.hasMore) break; afterId = r.nextAfterId;
      }
      for (const c of cases as unknown as AuditCase[]) {
        const ev = evaluateExternalResolution(c, { connectionId: link.connection_id, winerimRestaurantId: rid, responseRestaurantId: respRid, deletions, keptSales: kept, candidateSalesStillPresent: [...present, ...kept], returnMovements: returns, checkedAt, runId, deletionsWindowStart: since });
        results.push(ev);
        if (!dryRun) {
          await db.from("winerim_external_resolution_evidence").insert(ev);
          if (ev.verdict === "RESOLVED_EXTERNALLY") await db.from("agora_reversal_audit").update({ workflow_status: "RESOLVED_EXTERNALLY" }).eq("id", c.id);
        }
      }
    }
    return json({ runId, dryRun, calls: fleet.calls, results });
  } catch (e) {
    return json({ error: redact(e instanceof Error ? e.message : String(e)) }, 500);
  }
});
