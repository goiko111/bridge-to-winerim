import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { asDryRun, assertPost, json, parseJson, preflight, requirePlatformAdmin, safeError } from "../_shared/reconciliation-v2/edge.ts";
import { toAgoraLine, unresolvedAgoraEvidence, type AgoraDbLine } from "../_shared/reconciliation-v2/agoraReader.ts";
import { buildAnalytics, type AnalyticsCategory, type AnalyticsLine } from "../_shared/reconciliation-v2/analytics.ts";
import { reconcileLines } from "../_shared/reconciliation-v2/engine.ts";
import { sha256Hex } from "../_shared/reconciliation-v2/hash.ts";
import type { SaleDeletion, WinerimLine } from "../_shared/reconciliation-v2/types.ts";
import { activeBinding, bindingCutoffHour, checkpoint, claim, release } from "../_shared/reconciliation-v2/runtime.ts";

type Body = { connectionId: string; businessDay: string; dryRun?: boolean };
const PAGE = 1000; const MAX_DB_PAGES = 100;
const validDay = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
const plusDays = (day: string, amount: number) => { const date = new Date(`${day}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + amount); return date.toISOString().slice(0, 10); };
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;
const definitiveDocument = (value: string) => /invoice|refund/i.test(value) && !/open|draft|ticket|order|void|cancelled|canceled/i.test(value);
function analyticsIdentity(row: AgoraDbLine): string | null {
  const raw = object(row.sales_event.raw_json); const line = object(raw?.line) ?? object(raw?.saleLine) ?? object(raw?.item);
  const order = text(line?.externalOrderId) ?? text(raw?.externalOrderId) ?? text(raw?.orderId);
  const lineId = text(line?.sourceLineId) ?? text(line?.lineId) ?? text(line?.id);
  const effectiveAt = text(line?.effectiveAt) ?? text(line?.createdAt) ?? text(raw?.effectiveAt) ?? text(raw?.createdAt);
  if (!order || !lineId || !effectiveAt || !row.provider_product_id) return null;
  const polarity = row.sales_event.doc_type.toLowerCase().includes("refund") ? "REFUND" : "SALE";
  return [polarity, order, lineId, row.provider_product_id, row.format ?? "", row.quantity, row.total_amount ?? "", effectiveAt].join("|");
}
function sourceCurrency(row: AgoraDbLine): string | null { const raw = object(row.sales_event.raw_json); return text(raw?.currency) ?? text(object(raw?.amounts)?.currency); }

async function paged<T>(builder: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<{ rows: T[]; complete: boolean }> {
  const rows: T[] = [];
  for (let page = 0; page < MAX_DB_PAGES; page += 1) {
    const { data, error } = await builder(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw Object.assign(new Error("Lectura paginada fallida"), { status: 500, code: "DB_PAGE_READ_FAILED" });
    const batch = data ?? []; rows.push(...batch);
    if (batch.length < PAGE) return { rows, complete: true };
  }
  return { rows, complete: false };
}

async function sourceRows(db: SupabaseClient, connectionId: string, fromDay: string, toDay: string) {
  const events = await paged<Record<string, unknown>>((from, to) => db.from("sales_events")
    .select("id,provider_doc_id,business_day,doc_type,raw_json")
    .eq("connection_id", connectionId).gte("business_day", fromDay).lt("business_day", toDay)
    .order("business_day").order("id").range(from, to));
  const eventMap = new Map(events.rows.map((row) => [String(row.id), row])); const lines: AgoraDbLine[] = []; let complete = events.complete;
  const ids = [...eventMap.keys()];
  for (let offset = 0; offset < ids.length; offset += 200) {
    const chunk = ids.slice(offset, offset + 200);
    const result = await paged<Record<string, unknown>>((from, to) => db.from("sales_line_items")
      .select("id,connection_id,sales_event_id,provider_product_id,format,quantity,total_amount,winerim_product_id,mapped,is_wine_candidate,family,name")
      .in("sales_event_id", chunk).order("id").range(from, to));
    complete = complete && result.complete;
    for (const row of result.rows) {
      const event = eventMap.get(String(row.sales_event_id)); if (!event) continue;
      lines.push({ ...row, sales_event: event } as unknown as AgoraDbLine);
    }
  }
  return { lines, complete };
}

function toWinerim(row: Record<string, unknown>): WinerimLine {
  return {
    restaurantId: Number(row.restaurant_id), saleId: Number(row.sale_id), lineId: String(row.line_id), saleDetailId: row.sale_detail_id == null ? null : Number(row.sale_detail_id),
    saleStatus: String(row.sale_status) as WinerimLine["saleStatus"], sourceSystem: row.source_system == null ? null : String(row.source_system), externalOrderId: row.external_order_id == null ? null : String(row.external_order_id), orderId: row.order_id == null ? null : String(row.order_id), sourceLineId: row.source_line_id == null ? null : String(row.source_line_id), invoiceId: row.invoice_id == null ? null : String(row.invoice_id), receiptId: row.receipt_id == null ? null : String(row.receipt_id), wineId: String(row.wine_id), format: row.format_key == null ? null : String(row.format_key), quantity: Number(row.qty), amountMinor: row.total_amount_minor == null ? null : Number(row.total_amount_minor), effectiveAt: String(row.effective_at),
    stockEffect: { known: Boolean(row.stock_effect_known), status: String(row.stock_effect_status), stockApplied: row.stock_applied == null ? null : Boolean(row.stock_applied), receiptId: row.receipt_id == null ? null : String(row.receipt_id), movementIds: Array.isArray(row.stock_movement_ids) ? row.stock_movement_ids.map(Number) : [], movementDifference: row.stock_movement_difference == null ? null : Number(row.stock_movement_difference), unbackedQty: row.stock_unbacked_qty == null ? null : Number(row.stock_unbacked_qty) },
  };
}

Deno.serve(async (request) => {
  const options = preflight(request); if (options) return options;
  const owner = crypto.randomUUID(); let locked = false; let connectionId = ""; let lockStream = ""; let dbForFinally: SupabaseClient | null = null;
  try {
    assertPost(request); const { db } = await requirePlatformAdmin(request); dbForFinally = db; const body = await parseJson<Body>(request);
    connectionId = body.connectionId; if (!validDay(body.businessDay)) throw Object.assign(new Error("businessDay inválido"), { status: 400, code: "INVALID_BUSINESS_DAY" });
    const dryRun = asDryRun(body.dryRun); const binding = await activeBinding(db, connectionId); const nextDay = plusDays(body.businessDay, 1); const cutoff = bindingCutoffHour(binding); const localFrom = `${body.businessDay}T${String(cutoff).padStart(2, "0")}:00:00`; const localTo = `${nextDay}T${String(cutoff).padStart(2, "0")}:00:00`;
    const salesCp = await checkpoint(db, connectionId, "sales_records"); const movementCp = await checkpoint(db, connectionId, "stock_movements");
    const source = await sourceRows(db, connectionId, body.businessDay, nextDay);
    const unresolved = source.lines.map((row) => ({ row, missing: unresolvedAgoraEvidence(row) })).filter((row) => row.missing.length);
    const agora = source.lines.map((row) => toAgoraLine(row, binding.winerim_restaurant_id)).filter((row): row is NonNullable<typeof row> => Boolean(row));
    const winerim = await paged<Record<string, unknown>>((from, to) => db.from("winerim_sales_lines")
      .select("*,winerim_sales_records!inner(restaurant_id,status)").eq("connection_id", connectionId)
      .gte("effective_at", localFrom).lt("effective_at", localTo).order("sale_id").order("line_id").range(from, to));
    const deletions = await paged<Record<string, unknown>>((from, to) => db.from("winerim_sale_deletions").select("*")
      .eq("connection_id", connectionId).gte("effective_at", localFrom).lt("effective_at", localTo).order("deleted_at").range(from, to));
    const winerimRows = winerim.rows.map((row) => {
      const parent = row.winerim_sales_records as Record<string, unknown>; return { ...toWinerim({ ...row, restaurant_id: parent.restaurant_id, sale_status: parent.status }), businessDay: body.businessDay };
    });
    const deletionRows = deletions.rows.map((row) => ({ saleId: Number(row.sale_id), saleDetailId: row.sale_detail_id == null ? null : Number(row.sale_detail_id), lineId: String(row.line_id), reason: String(row.reason), deletedAt: String(row.deleted_at), effectiveAt: row.effective_at == null ? null : String(row.effective_at), externalOrderId: row.external_order_id == null ? null : String(row.external_order_id) })) as SaleDeletion[];
    const completeness = { agoraComplete: source.complete && unresolved.length === 0, winerimComplete: winerim.complete && deletions.complete && salesCp?.coverage_complete === true, stockComplete: movementCp?.coverage_complete === true, pagesRead: 0, expectedPages: null, reason: unresolved.length ? "AGORA_IDENTITY_FIELDS_MISSING" : null };
    const results = reconcileLines({ connectionId, agora, winerim: winerimRows, deletions: deletionRows, completeness });
    const now = new Date().toISOString(); const runId = crypto.randomUUID();
    const resultRows = await Promise.all(results.map(async (row) => ({ ...row, revisionHash: await sha256Hex(row) })));

    const analyticsSource = await sourceRows(db, connectionId, plusDays(body.businessDay, -27), nextDay);
    const { data: rules, error: rulesError } = await db.from("reconciliation_v2_category_rules").select("provider_product_id,family_key,category").eq("connection_id", connectionId);
    if (rulesError) throw Object.assign(new Error("No se pudieron leer reglas de categoría"), { status: 500, code: "CATEGORY_RULE_READ_FAILED" });
    const categories = new Map((rules ?? []).map((rule) => [`${rule.provider_product_id ?? ""}|${rule.family_key ?? ""}`, rule.category as AnalyticsCategory]));
    const definitive = analyticsSource.lines.filter((row) => definitiveDocument(row.sales_event.doc_type)); const identities = definitive.map((row) => ({ row, identity: analyticsIdentity(row) })); const analyticsMissingIdentity = identities.filter((item) => !item.identity).length; const analyticsMissingAmount = identities.filter((item) => item.row.total_amount == null).length;
    const unique = [...new Map(identities.filter((item): item is { row: AgoraDbLine; identity: string } => Boolean(item.identity) && item.row.total_amount != null).map((item) => [item.identity, item.row])).values()];
    const analyticsLines: AnalyticsLine[] = unique.map((row: AgoraDbLine & Record<string, unknown>) => {
      const explicit = categories.get(`${row.provider_product_id ?? ""}|${row.family ?? ""}`) ?? categories.get(`${row.provider_product_id ?? ""}|`) ?? categories.get(`|${row.family ?? ""}`);
      const category: AnalyticsCategory = row.mapped === true && row.winerim_product_id ? "WINE" : explicit ?? "UNCLASSIFIED";
      return { connectionId, effectiveAt: String(row.sales_event.business_day) + "T12:00:00Z", category, quantity: Number(row.quantity), revenueMinor: Math.round(Number(row.total_amount ?? 0) * 100), costMinor: null, ticketId: row.sales_event.provider_doc_id, isReturn: row.sales_event.doc_type.toLowerCase().includes("refund"), currency: sourceCurrency(row) };
    });
    const buckets = buildAnalytics(analyticsLines, body.businessDay).map((row) => ({ ...row, freshnessAt: now }));
    const dayBuckets = buckets.filter((row) => row.period === "DAY" && row.periodStart === body.businessDay && row.category !== "ALL");
    const dayAnalytics = analyticsLines.filter((row) => row.effectiveAt.startsWith(body.businessDay)); const sourceCount = dayAnalytics.length;
    const analytics = { series: dayBuckets.map((row) => ({ businessDay: row.periodStart, category: row.category, revenueMinor: row.revenueMinor, quantity: row.quantity, ticketCount: row.ticketCount, classifiedLineCount: dayAnalytics.filter((line) => line.category === row.category).length, sourceLineCount: sourceCount, currency: row.currency, freshnessAt: now })), aggregates: buckets };
    if (!analyticsSource.complete || analyticsMissingIdentity > 0 || analyticsMissingAmount > 0) { completeness.agoraComplete = false; completeness.reason = [completeness.reason, analyticsSource.complete ? null : "ANALYTICS_SOURCE_INCOMPLETE", analyticsMissingIdentity ? "ANALYTICS_IDENTITY_FIELDS_MISSING" : null, analyticsMissingAmount ? "ANALYTICS_AMOUNT_MISSING" : null].filter(Boolean).join("+"); }
    const metrics = { sourceLines: source.lines.length, eligibleAgoraLines: agora.length, unresolvedSourceLines: unresolved.length, winerimLines: winerimRows.length, states: Object.fromEntries(results.map((row) => row.state).map((state, _, all) => [state, all.filter((value) => value === state).length])) };
    if (!dryRun) {
      lockStream = `reconcile:${body.businessDay}`; await claim(db, connectionId, lockStream, owner); locked = true;
      const { error } = await db.rpc("reconciliation_v2_commit_run", { p_run_id: runId, p_connection_id: connectionId, p_restaurant_id: binding.winerim_restaurant_id, p_business_day: body.businessDay, p_source_cutoff_at: now, p_completeness: completeness, p_results: resultRows, p_metrics: metrics, p_analytics: analytics });
      if (error) throw Object.assign(new Error("Falló el commit atómico de conciliación"), { status: 500, code: "RECONCILIATION_COMMIT_FAILED" });
    }
    return json(request, { ok: completeness.agoraComplete && completeness.winerimComplete, mode: "AUDIT_ONLY", dryRun, runId, completeness, metrics, results: resultRows, analytics }, completeness.agoraComplete && completeness.winerimComplete ? 200 : 206);
  } catch (error) { return safeError(request, error); }
  finally { if (locked && dbForFinally) { try { await release(dbForFinally, connectionId, lockStream, owner); } catch { /* TTL is the recovery path */ } } }
});
