import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { asDryRun, assertPost, json, parseJson, preflight, requirePlatformAdmin, safeError } from "../_shared/reconciliation-v2/edge.ts";
import { agoraProviderAmount, agoraProviderIdentity, classifyAgoraCoverage, classifyWineCandidate, resolveAgoraIdentity, type AgoraDbLine, type ProviderProductClassification } from "../_shared/reconciliation-v2/agoraReader.ts";
import { buildAnalytics, type AnalyticsCategory, type AnalyticsLine } from "../_shared/reconciliation-v2/analytics.ts";
import { reconcileLines } from "../_shared/reconciliation-v2/engine.ts";
import { sha256Hex } from "../_shared/reconciliation-v2/hash.ts";
import type { SaleDeletion, WinerimLine } from "../_shared/reconciliation-v2/types.ts";
import { activeBinding, bindingCutoffHour, businessWindow, checkpoint, claim, fleetClient, release } from "../_shared/reconciliation-v2/runtime.ts";
import { readHistoricalRange, validateHistoricalRange } from "../_shared/reconciliation-v2/historicalSales.ts";
import { rangeRecordsToWinerimLines, reconcileHistorical, validateHistoricalReconcileRequest } from "../_shared/reconciliation-v2/historicalReconcile.ts";

type Body = { connectionId: string; businessDay: string; dryRun?: boolean; salesSourceMode?: string };
const PAGE = 1000; const MAX_DB_PAGES = 100;
const validDay = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
const plusDays = (day: string, amount: number) => { const date = new Date(`${day}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + amount); return date.toISOString().slice(0, 10); };
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;
const definitiveDocument = (value: string) => /invoice|refund/i.test(value) && !/open|draft|ticket|order|void|cancelled|canceled/i.test(value);
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
      .select("id,connection_id,sales_event_id,provider_product_id,provider_sold_at,format,quantity,total_amount,winerim_product_id,mapped,is_wine_candidate,family,name")
      .in("sales_event_id", chunk).order("id").range(from, to));
    complete = complete && result.complete;
    for (const row of result.rows) {
      const event = eventMap.get(String(row.sales_event_id)); if (!event) continue;
      lines.push({ ...row, sales_event: event } as unknown as AgoraDbLine);
    }
  }
  return { lines, complete, eventCount: events.rows.length };
}

async function zeroSourceDiagnostic(db: SupabaseClient, connectionId: string, businessDay: string) {
  const from = plusDays(businessDay, -1); const to = plusDays(businessDay, 2);
  const { data, error } = await db.from("sales_events").select("business_day").eq("connection_id", connectionId).gte("business_day", from).lt("business_day", to).limit(5000);
  if (error) return { checked: true, code: "ADJACENT_DAY_DIAGNOSTIC_FAILED" };
  const counts = Object.fromEntries([from, businessDay, plusDays(businessDay, 1)].map((day) => [day, (data ?? []).filter((row) => row.business_day === day).length]));
  return { checked: true, code: "AGORA_ZERO_DAY_BOUNDED_DIAGNOSTIC", counts };
}

async function currentProductClassifications(db: SupabaseClient, connectionId: string, lines: AgoraDbLine[]) {
  const ids = [...new Set(lines.map((row) => row.provider_product_id).filter((value): value is string => Boolean(value)))];
  const rows: ProviderProductClassification[] = [];
  for (let offset = 0; offset < ids.length; offset += 200) {
    const { data, error } = await db.from("provider_products")
      .select("provider_product_id,is_wine_candidate,classification_override,winerim_wine_id")
      .eq("connection_id", connectionId).in("provider_product_id", ids.slice(offset, offset + 200));
    if (error) throw Object.assign(new Error("No se pudo leer la clasificación viva del catálogo"), { status: 500, code: "PRODUCT_CLASSIFICATION_READ_FAILED" });
    rows.push(...((data ?? []) as ProviderProductClassification[]));
  }
  return new Map(rows.map((row) => [row.provider_product_id, row]));
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
    connectionId = body.connectionId; const historical = body.salesSourceMode !== undefined; if (historical) validateHistoricalReconcileRequest(body); if (!validDay(body.businessDay)) throw Object.assign(new Error("businessDay inválido"), { status: 400, code: "INVALID_BUSINESS_DAY" });
    const dryRun = asDryRun(body.dryRun); const binding = await activeBinding(db, connectionId); const nextDay = plusDays(body.businessDay, 1); const cutoff = bindingCutoffHour(binding); const localFrom = `${body.businessDay}T${String(cutoff).padStart(2, "0")}:00:00`; const localTo = `${nextDay}T${String(cutoff).padStart(2, "0")}:00:00`;
    const salesCp = await checkpoint(db, connectionId, "sales_records"); const movementCp = await checkpoint(db, connectionId, "stock_movements");
    const source = await sourceRows(db, connectionId, body.businessDay, nextDay);
    const providerUnresolved = source.lines.filter((row) => !agoraProviderIdentity(row));
    const productClassifications = await currentProductClassifications(db, connectionId, source.lines);
    const classifiedSource = source.lines.map((row) => ({ row, classification: classifyWineCandidate(row, row.provider_product_id ? productClassifications.get(row.provider_product_id) ?? null : null) }));
    const wineCandidates = classifiedSource.filter((item) => item.classification === "WINE").map((item) => item.row);
    const unknownWineClassification = classifiedSource.filter((item) => item.classification === "UNKNOWN").map((item) => item.row);
    const unmappedWine = wineCandidates.filter((row) => row.mapped !== true || !row.winerim_product_id);
    const reconcilableWine = wineCandidates.filter((row) => row.mapped === true && Boolean(row.winerim_product_id));
    const resolutions = reconcilableWine.map((row) => ({ row, resolution: resolveAgoraIdentity(row, binding.winerim_restaurant_id) }));
    const unresolved = resolutions.filter((item) => item.resolution.missing.length).map((item) => ({ row: item.row, missing: item.resolution.missing }));
    const agora = resolutions.map((item) => item.resolution.line).filter((row): row is NonNullable<typeof row> => Boolean(row));
    const sourceCoverage = classifyAgoraCoverage({ eventCount: source.eventCount, lineCount: source.lines.length, pageComplete: source.complete, unresolvedCount: providerUnresolved.length + unresolved.length });
    if (unknownWineClassification.length) { sourceCoverage.complete = false; sourceCoverage.reasons.push("AGORA_WINE_CLASSIFICATION_INCOMPLETE"); }
    if (unmappedWine.length) { sourceCoverage.complete = false; sourceCoverage.reasons.push("AGORA_WINE_MAPPING_INCOMPLETE"); }
    const sourceDiagnostic = source.eventCount === 0 || source.lines.length === 0 ? await zeroSourceDiagnostic(db, connectionId, body.businessDay) : null;
    const winerim = await paged<Record<string, unknown>>((from, to) => db.from("winerim_sales_lines")
      .select("*,winerim_sales_records!inner(restaurant_id,status)").eq("connection_id", connectionId)
      .gte("effective_at", localFrom).lt("effective_at", localTo).order("sale_id").order("line_id").range(from, to));
    const deletions = await paged<Record<string, unknown>>((from, to) => db.from("winerim_sale_deletions").select("*")
      .eq("connection_id", connectionId).gte("effective_at", localFrom).lt("effective_at", localTo).order("deleted_at").range(from, to));
    const winerimRows = winerim.rows.map((row) => {
      const parent = row.winerim_sales_records as Record<string, unknown>; return { ...toWinerim({ ...row, restaurant_id: parent.restaurant_id, sale_status: parent.status }), businessDay: body.businessDay };
    });
    const deletionRows = deletions.rows.map((row) => ({ saleId: Number(row.sale_id), saleDetailId: row.sale_detail_id == null ? null : Number(row.sale_detail_id), lineId: String(row.line_id), reason: String(row.reason), deletedAt: String(row.deleted_at), effectiveAt: row.effective_at == null ? null : String(row.effective_at), externalOrderId: row.external_order_id == null ? null : String(row.external_order_id) })) as SaleDeletion[];
    const completeness = { agoraComplete: sourceCoverage.complete, winerimComplete: winerim.complete && deletions.complete && salesCp?.coverage_complete === true, stockComplete: movementCp?.coverage_complete === true, pagesRead: 0, expectedPages: null, reason: sourceCoverage.reasons.length ? sourceCoverage.reasons.join("+") : null };
    let results = historical ? [] : reconcileLines({ connectionId, agora, winerim: winerimRows, deletions: deletionRows, completeness });
    let historicalEvidence: Record<string, unknown> | null = null;
    if (historical) {
      // Manual AUDIT_ONLY: Winerim range read in memory; no checkpoint, cursor, lock or commit is touched.
      const window = businessWindow(binding, body.businessDay);
      const range = validateHistoricalRange({ historicalRange: true, dryRun: true, from: window.from, to: window.to, maxPages: 100 }, binding);
      const read = await readHistoricalRange(fleetClient(), binding.winerim_restaurant_id, range);
      const rangeLines = rangeRecordsToWinerimLines(read.records, binding.winerim_restaurant_id, body.businessDay, localFrom, localTo);
      completeness.winerimComplete = read.evidence.coverageComplete && winerim.complete && deletions.complete;
      const out = reconcileHistorical({ connectionId, agora, rangeLines, persistedLines: winerimRows, deletions: deletionRows, completeness });
      results = out.results;
      const { lineSummary: _omit, ...rangeEvidence } = read.evidence;
      historicalEvidence = { salesSourceMode: "historical_range", range: rangeEvidence, rangeLinesInDay: rangeLines.length, persistedOnlyLines: out.persistedOnlyLines, agoraRepresentations: agora.length, agoraEconomicLines: out.economicAgora.length, supersededOpen: out.supersededOpen };
    }
    const now = new Date().toISOString(); const runId = crypto.randomUUID();
    const resultRows = await Promise.all(results.map(async (row) => ({ ...row, revisionHash: await sha256Hex(row) })));

    const analyticsSource = await sourceRows(db, connectionId, plusDays(body.businessDay, -27), nextDay);
    const { data: rules, error: rulesError } = await db.from("reconciliation_v2_category_rules").select("provider_product_id,family_key,category").eq("connection_id", connectionId);
    if (rulesError) throw Object.assign(new Error("No se pudieron leer reglas de categoría"), { status: 500, code: "CATEGORY_RULE_READ_FAILED" });
    const categories = new Map((rules ?? []).map((rule) => [`${rule.provider_product_id ?? ""}|${rule.family_key ?? ""}`, rule.category as AnalyticsCategory]));
    const definitive = analyticsSource.lines.filter((row) => definitiveDocument(row.sales_event.doc_type)); const identities = definitive.map((row) => ({ row, identity: agoraProviderIdentity(row), amount: agoraProviderAmount(row) })); const analyticsMissingIdentity = identities.filter((item) => !item.identity).length; const analyticsMissingAmount = identities.filter((item) => item.amount == null).length;
    const unique = [...new Map(identities.filter((item): item is { row: AgoraDbLine; identity: string; amount: number } => Boolean(item.identity) && item.amount != null).map((item) => [item.identity, { ...item.row, provider_amount: item.amount }])).values()];
    const analyticsLines: AnalyticsLine[] = unique.map((row: AgoraDbLine & Record<string, unknown>) => {
      const explicit = categories.get(`${row.provider_product_id ?? ""}|${row.family ?? ""}`) ?? categories.get(`${row.provider_product_id ?? ""}|`) ?? categories.get(`|${row.family ?? ""}`);
      const category: AnalyticsCategory = row.mapped === true && row.winerim_product_id ? "WINE" : explicit ?? "UNCLASSIFIED";
      return { connectionId, effectiveAt: String(row.sales_event.business_day) + "T12:00:00Z", category, quantity: Number(row.quantity), revenueMinor: Math.round(Number(row.provider_amount ?? 0) * 100), costMinor: null, ticketId: row.sales_event.provider_doc_id, isReturn: row.sales_event.doc_type.toLowerCase().includes("refund"), currency: sourceCurrency(row) };
    });
    const buckets = buildAnalytics(analyticsLines, body.businessDay).map((row) => ({ ...row, freshnessAt: now }));
    const dayBuckets = buckets.filter((row) => row.period === "DAY" && row.periodStart === body.businessDay && row.category !== "ALL");
    const dayAnalytics = analyticsLines.filter((row) => row.effectiveAt.startsWith(body.businessDay)); const sourceCount = dayAnalytics.length;
    const analyticsCoverage = {
      complete: analyticsSource.complete && analyticsMissingIdentity === 0 && analyticsMissingAmount === 0,
      reasons: [analyticsSource.complete ? null : "ANALYTICS_SOURCE_INCOMPLETE", analyticsMissingIdentity ? "ANALYTICS_IDENTITY_FIELDS_MISSING" : null, analyticsMissingAmount ? "ANALYTICS_AMOUNT_MISSING" : null].filter((value): value is string => Boolean(value)),
      sourceLines: identities.length,
      includedLines: unique.length,
      missingIdentityLines: analyticsMissingIdentity,
      missingAmountLines: analyticsMissingAmount,
    };
    // Analytics spans 28 days and may legitimately include older rows written with
    // a previous payload shape. Report that coverage explicitly, but do not turn a
    // complete daily sales-reconciliation source into SOURCE_INCOMPLETE because of
    // unrelated historical dashboard rows.
    const analytics = { coverage: analyticsCoverage, series: dayBuckets.map((row) => ({ businessDay: row.periodStart, category: row.category, revenueMinor: row.revenueMinor, quantity: row.quantity, ticketCount: row.ticketCount, classifiedLineCount: dayAnalytics.filter((line) => line.category === row.category).length, sourceLineCount: sourceCount, currency: row.currency, freshnessAt: now })), aggregates: buckets };
    const metrics = { sourceLines: source.lines.length, providerIdentifiedLines: source.lines.length - providerUnresolved.length, wineCandidateLines: wineCandidates.length, mappedWineLines: reconcilableWine.length, unmappedWineLines: unmappedWine.length, unknownWineClassificationLines: unknownWineClassification.length, eligibleAgoraLines: agora.length, unresolvedSourceLines: providerUnresolved.length + unresolved.length, analyticsCoverage, winerimLines: winerimRows.length, states: Object.fromEntries(results.map((row) => row.state).map((state, _, all) => [state, all.filter((value) => value === state).length])) };
    if (!dryRun) {
      lockStream = `reconcile:${body.businessDay}`; await claim(db, connectionId, lockStream, owner); locked = true;
      const { error } = await db.rpc("reconciliation_v2_commit_run", { p_run_id: runId, p_connection_id: connectionId, p_restaurant_id: binding.winerim_restaurant_id, p_business_day: body.businessDay, p_source_cutoff_at: now, p_completeness: completeness, p_results: resultRows, p_metrics: metrics, p_analytics: analytics });
      if (error) throw Object.assign(new Error("Falló el commit atómico de conciliación"), { status: 500, code: "RECONCILIATION_COMMIT_FAILED" });
    }
    return json(request, { ok: completeness.agoraComplete && completeness.winerimComplete, mode: "AUDIT_ONLY", dryRun, runId, historical: historicalEvidence, completeness, sourceDiagnostic, metrics, results: resultRows, analytics }, completeness.agoraComplete && completeness.winerimComplete ? 200 : 206);
  } catch (error) { return safeError(request, error); }
  finally { if (locked && dbForFinally) { try { await release(dbForFinally, connectionId, lockStream, owner); } catch { /* TTL is the recovery path */ } } }
});
