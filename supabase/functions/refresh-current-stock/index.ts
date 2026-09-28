import { asDryRun, assertPost, json, parseJson, preflight, requirePlatformAdmin, safeError } from "../_shared/reconciliation-v2/edge.ts";
import { sha256Hex } from "../_shared/reconciliation-v2/hash.ts";
import { activeBinding, claim, fleetClient, MAX_PAGES, release } from "../_shared/reconciliation-v2/runtime.ts";

type Body = { connectionId: string; dryRun?: boolean; maxPages?: number };
Deno.serve(async (request) => {
  const options = preflight(request); if (options) return options;
  const owner = crypto.randomUUID(); let locked = false; let connectionId = "";
  try {
    assertPost(request); const { db } = await requirePlatformAdmin(request); const body = await parseJson<Body>(request);
    connectionId = body.connectionId; const dryRun = asDryRun(body.dryRun);
    if (Deno.env.get("WINERIM_STOCK_CONTRACT_ACK") !== "api-v2-stock-v1") throw Object.assign(new Error("/api/v2/stock bloqueado hasta confirmar paridad OpenAPI"), { status: 503, code: "STOCK_CONTRACT_NOT_ACKNOWLEDGED" });
    const binding = await activeBinding(db, connectionId); const client = fleetClient(); const items: unknown[] = [];
    const maxPages = Math.max(1, Math.min(body.maxPages ?? MAX_PAGES, MAX_PAGES)); let pagesRead = 0; let complete = false;
    if (!dryRun) { await claim(db, connectionId, "stock_snapshot", owner); locked = true; }
    for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
      const page = await client.stock(binding.winerim_restaurant_id, pageNumber); pagesRead += 1; items.push(...page.stocks);
      if (pageNumber >= page.pagination.total_pages) { complete = true; break; }
    }
    if (!complete) return json(request, { ok: false, mode: "AUDIT_ONLY", dryRun, state: "SOURCE_INCOMPLETE", pagesRead, itemCount: items.length, calls: client.callCount }, 206);
    if (!dryRun) {
      const capturedAt = new Date().toISOString(); const contentHash = await sha256Hex(items);
      const { error } = await db.rpc("reconciliation_v2_commit_stock_snapshot", { p_connection_id: connectionId, p_restaurant_id: binding.winerim_restaurant_id, p_request_id: crypto.randomUUID(), p_captured_at: capturedAt, p_content_hash: contentHash, p_complete: true, p_page_count: pagesRead, p_items: items });
      if (error) throw Object.assign(new Error("Falló el commit atómico de stock"), { status: 500, code: "STOCK_SNAPSHOT_COMMIT_FAILED" });
    }
    return json(request, { ok: true, mode: "AUDIT_ONLY", dryRun, state: "COMPLETE", pagesRead, itemCount: items.length, calls: client.callCount });
  } catch (error) { return safeError(request, error); }
  finally { if (locked) { try { const { db } = await requirePlatformAdmin(request); await release(db, connectionId, "stock_snapshot", owner); } catch { /* TTL is the recovery path */ } } }
});
