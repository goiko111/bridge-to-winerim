import { asDryRun, assertPost, json, parseJson, preflight, requireAdminOrScheduler, safeError } from "../_shared/reconciliation-v2/edge.ts";
import { assertSchedulerRequest } from "../_shared/reconciliation-v2/scheduler.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { activeBinding, addBusinessDays, businessWindow, checkpoint, claim, fleetClient, MAX_PAGES, release } from "../_shared/reconciliation-v2/runtime.ts";

type Body = { connectionId: string; dryRun?: boolean; maxPages?: number; overlapBusinessDay?: string };
const validDay = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
Deno.serve(async (request) => {
  const options = preflight(request); if (options) return options;
  const owner = crypto.randomUUID(); let locked = false; let connectionId = ""; let dbRef: SupabaseClient | null = null;
  try {
    assertPost(request); const auth = await requireAdminOrScheduler(request); const db = auth.db; dbRef = db; const body = await parseJson<Body>(request);
    if (auth.scheduler) assertSchedulerRequest({ connectionId: body.connectionId, dryRun: body.dryRun, historical: false, businessDay: body.overlapBusinessDay });
    connectionId = body.connectionId; const dryRun = asDryRun(body.dryRun); const binding = await activeBinding(db, connectionId);
    const saved = await checkpoint(db, connectionId, "stock_movements"); const maxPages = Math.max(1, Math.min(body.maxPages ?? MAX_PAGES, MAX_PAGES));
    const client = fleetClient(); let afterId = saved?.after_id == null ? undefined : Number(saved.after_id); let pagesRead = 0; let movements = 0; let complete = false;
    if (!dryRun) { await claim(db, connectionId, "stock_movements", owner); locked = true; }
    for (; pagesRead < maxPages; pagesRead += 1) {
      const page = await client.movements(binding.winerim_restaurant_id, { afterId }); movements += page.data.length;
      const next = page.nextAfterId ?? afterId ?? 0;
      if (!dryRun) {
        const { error } = await db.rpc("reconciliation_v2_commit_movement_page", { p_connection_id: connectionId, p_restaurant_id: binding.winerim_restaurant_id, p_request_id: crypto.randomUUID(), p_movements: page.data, p_next_after_id: next, p_has_more: page.hasMore, p_overlap_from: saved?.overlap_from ?? new Date(Date.now() - 86_400_000).toISOString() });
        if (error) throw Object.assign(new Error("Falló el commit atómico de movimientos"), { status: 500, code: "MOVEMENT_PAGE_COMMIT_FAILED" });
      }
      if (!page.hasMore) { complete = true; break; }
      if (next === afterId) throw Object.assign(new Error("Cursor de movimientos sin avance"), { status: 502, code: "MOVEMENT_CURSOR_STALLED" });
      afterId = next;
    }
    let overlap = { attempted: false, complete: false, businessDay: null as string | null, pages: 0, movements: 0 };
    if (complete) {
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: String(binding.metadata.timezone ?? "Europe/Madrid"), year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
      const overlapDay = body.overlapBusinessDay ?? addBusinessDays(today, -1);
      if (!validDay(overlapDay)) throw Object.assign(new Error("overlapBusinessDay inválido"), { status: 400, code: "INVALID_OVERLAP_DAY" });
      const window = businessWindow(binding, overlapDay); overlap.businessDay = overlapDay;
      if (!saved?.overlap_from || Date.parse(String(saved.overlap_from)) < Date.parse(window.to)) {
        overlap.attempted = true; let windowAfter: number | undefined;
        for (let pageNo = 0; pageNo < maxPages; pageNo += 1) {
          const page = await client.movements(binding.winerim_restaurant_id, { afterId: windowAfter, from: window.from, to: window.to });
          overlap.pages += 1; overlap.movements += page.data.length; movements += page.data.length;
          const next = page.nextAfterId ?? windowAfter ?? afterId ?? 0;
          if (!dryRun) {
            const { error } = await db.rpc("reconciliation_v2_commit_movement_page", { p_connection_id: connectionId, p_restaurant_id: binding.winerim_restaurant_id, p_request_id: crypto.randomUUID(), p_movements: page.data, p_next_after_id: next, p_has_more: page.hasMore, p_overlap_from: window.to });
            if (error) throw Object.assign(new Error("Falló el commit atómico del solape de movimientos"), { status: 500, code: "MOVEMENT_OVERLAP_COMMIT_FAILED" });
          }
          if (!page.hasMore) { overlap.complete = true; break; }
          if (next === windowAfter) throw Object.assign(new Error("Cursor de solape de movimientos sin avance"), { status: 502, code: "MOVEMENT_OVERLAP_CURSOR_STALLED" });
          windowAfter = next;
        }
      } else overlap.complete = true;
    }
    const allComplete = complete && overlap.complete;
    return json(request, { ok: allComplete, mode: "AUDIT_ONLY", dryRun, state: allComplete ? "COMPLETE" : "SOURCE_INCOMPLETE", pagesRead: pagesRead + (complete ? 1 : 0), movements, overlap, calls: client.callCount }, allComplete ? 200 : 206);
  } catch (error) { return safeError(request, error); }
  finally { if (locked && dbRef) { try { await release(dbRef, connectionId, "stock_movements", owner); } catch { /* TTL is the recovery path */ } } }
});
