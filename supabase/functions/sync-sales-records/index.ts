import { asDryRun, assertPost, json, parseJson, preflight, requireAdminOrScheduler, safeError } from "../_shared/reconciliation-v2/edge.ts";
import { assertSchedulerRequest } from "../_shared/reconciliation-v2/scheduler.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { activeBinding, addBusinessDays, businessWindow, changedSinceFrom, checkpoint, claim, fleetClient, MAX_PAGES, release } from "../_shared/reconciliation-v2/runtime.ts";
import { readHistoricalRange, validateHistoricalRange } from "../_shared/reconciliation-v2/historicalSales.ts";

type Body = { connectionId: string; dryRun?: boolean; maxPages?: number; overlapBusinessDay?: string; historicalRange?: boolean; from?: string; to?: string };
// Technical diagnostic only: Postgres SQLSTATE + truncated message, never the page payload.
const commitError = (message: string, code: string, error: { code?: string; message?: string }) => Object.assign(new Error(message), { status: 500, code, pgCode: error.code ?? null, pgMessage: String(error.message ?? "").slice(0, 200) });
const validDay = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));

Deno.serve(async (request) => {
  const options = preflight(request); if (options) return options;
  const owner = crypto.randomUUID(); let locked = false; let connectionId = ""; let dbRef: SupabaseClient | null = null;
  try {
    assertPost(request); const auth = await requireAdminOrScheduler(request); const db = auth.db; dbRef = db; const body = await parseJson<Body>(request);
    if (auth.scheduler) assertSchedulerRequest({ connectionId: body.connectionId, dryRun: body.dryRun, historical: body.historicalRange !== undefined, businessDay: body.overlapBusinessDay });
    connectionId = body.connectionId;
    if (body.historicalRange !== undefined) {
      // Isolated read-only mode: never reads/writes checkpoints, never locks, never commits.
      const binding = await activeBinding(db, connectionId);
      const range = validateHistoricalRange(body, binding);
      const { evidence } = await readHistoricalRange(fleetClient(), binding.winerim_restaurant_id, range);
      return json(request, { ok: evidence.coverageComplete, mode: "HISTORICAL_RANGE_READ_ONLY", dryRun: true, state: evidence.coverageComplete ? "COMPLETE" : "SOURCE_INCOMPLETE", ...evidence }, evidence.coverageComplete ? 200 : 206);
    }
    const dryRun = asDryRun(body.dryRun); const binding = await activeBinding(db, connectionId);
    const saved = await checkpoint(db, connectionId, "sales_records");
    const maxPages = Math.max(1, Math.min(body.maxPages ?? MAX_PAGES, MAX_PAGES));
    const client = fleetClient(); let cursor = saved?.cursor ? String(saved.cursor) : undefined;
    let changedSince = cursor ? undefined : changedSinceFrom(saved?.last_complete_at ?? saved?.overlap_from);
    let pagesRead = 0; let records = 0; let deletions = 0; let complete = false; let finalCursor = cursor ?? "";
    if (!dryRun) { await claim(db, connectionId, "sales_records", owner); locked = true; }
    for (; pagesRead < maxPages; pagesRead += 1) {
      const page = await client.salesSync(binding.winerim_restaurant_id, { cursor, changedSince, limit: 100 });
      records += page.data.length; deletions += page.deletions.length;
      const nextCursor = page.sync!.nextCursor; const hasMore = page.sync!.hasMore;
      finalCursor = nextCursor;
      if (!dryRun) {
        const { error } = await db.rpc("reconciliation_v2_commit_sales_page", { p_connection_id: connectionId, p_restaurant_id: binding.winerim_restaurant_id, p_request_id: crypto.randomUUID(), p_records: page.data, p_deletions: page.deletions, p_next_cursor: nextCursor, p_has_more: hasMore, p_overlap_from: changedSince ?? saved?.overlap_from ?? new Date(Date.now() - 86_400_000).toISOString() });
        if (error) throw commitError("Falló el commit atómico de ventas", "SALES_PAGE_COMMIT_FAILED", error);
      }
      if (!hasMore) { complete = true; break; }
      cursor = nextCursor; changedSince = undefined;
    }
    let overlap = { attempted: false, complete: false, businessDay: null as string | null, pages: 0, records: 0 };
    if (complete) {
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: String(binding.metadata.timezone ?? "Europe/Madrid"), year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
      const overlapDay = body.overlapBusinessDay ?? addBusinessDays(today, -1);
      if (!validDay(overlapDay)) throw Object.assign(new Error("overlapBusinessDay inválido"), { status: 400, code: "INVALID_OVERLAP_DAY" });
      const window = businessWindow(binding, overlapDay); overlap.businessDay = overlapDay;
      if (!saved?.overlap_from || Date.parse(String(saved.overlap_from)) < Date.parse(window.to)) {
        overlap.attempted = true;
        for (let pageNo = 1; pageNo <= maxPages; pageNo += 1) {
          const page = await client.salesByDate(binding.winerim_restaurant_id, { from: window.from, to: window.to, page: pageNo });
          overlap.pages += 1; overlap.records += page.data.length; records += page.data.length;
          const hasMore = page.pagination!.hasMore;
          if (!dryRun) {
            const { error } = await db.rpc("reconciliation_v2_commit_sales_page", { p_connection_id: connectionId, p_restaurant_id: binding.winerim_restaurant_id, p_request_id: crypto.randomUUID(), p_records: page.data, p_deletions: [], p_next_cursor: finalCursor, p_has_more: hasMore, p_overlap_from: window.to });
            if (error) throw commitError("Falló el commit atómico del solape diario", "SALES_OVERLAP_COMMIT_FAILED", error);
          }
          if (!hasMore) { overlap.complete = true; break; }
        }
      } else overlap.complete = true;
    }
    const allComplete = complete && overlap.complete; const state = allComplete ? "COMPLETE" : "SOURCE_INCOMPLETE";
    return json(request, { ok: allComplete, mode: "AUDIT_ONLY", dryRun, state, pagesRead: pagesRead + (complete ? 1 : 0), records, deletions, overlap, calls: client.callCount }, allComplete ? 200 : 206);
  } catch (error) { return safeError(request, error); }
  finally { if (locked && dbRef) { try { await release(dbRef, connectionId, "sales_records", owner); } catch { /* lease expires; never mask the primary result */ } } }
});
