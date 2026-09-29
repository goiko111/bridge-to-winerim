import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { asDryRun, assertPost, json, parseJson, preflight, requireAdminOrScheduler, safeError } from "../_shared/reconciliation-v2/edge.ts";
import { assertSchedulerRequest } from "../_shared/reconciliation-v2/scheduler.ts";
import { attributeByProviderLine, lineTimeAttributionMode } from "../_shared/reconciliation-v2/lineTimeAttribution.ts";
import { agoraProviderAmount, agoraProviderIdentity, classifyWineCandidate, splitSourceCoverage, resolveAgoraIdentity, type AgoraDbLine, type ProviderProductClassification } from "../_shared/reconciliation-v2/agoraReader.ts";
import { buildAnalytics, type AnalyticsCategory, type AnalyticsLine } from "../_shared/reconciliation-v2/analytics.ts";
import { reconcileLines } from "../_shared/reconciliation-v2/engine.ts";
import { sha256Hex } from "../_shared/reconciliation-v2/hash.ts";
import type { SaleDeletion, WinerimLine } from "../_shared/reconciliation-v2/types.ts";
import { activeBinding, bindingCutoffHour, bindingTimezone, businessWindow, checkpoint, claim, fleetClient, release } from "../_shared/reconciliation-v2/runtime.ts";
import { readHistoricalRange, validateHistoricalRange } from "../_shared/reconciliation-v2/historicalSales.ts";
import { rangeRecordsToWinerimLines, reconcileHistorical, validateHistoricalReconcileRequest } from "../_shared/reconciliation-v2/historicalReconcile.ts";
import { applyWriterReceipts, extractWriterReceipts, writerReceiptOverlayMode } from "../_shared/reconciliation-v2/writerReceipts.ts";

type Body = { connectionId: string; businessDay: string; dryRun?: boolean; salesSourceMode?: string; writerReceiptsOverlay?: unknown; analyticsEquivalenceDays?: number; analyticsProjectionBackfillDays?: number };
const PAGE = 1000; const MAX_DB_PAGES = 100;
const validDay = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
const plusDays = (day: string, amount: number) => { const date = new Date(`${day}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + amount); return date.toISOString().slice(0, 10); };
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;
const definitiveDocument = (value: string) => /invoice|refund/i.test(value) && !/open|draft|ticket|order|void|cancelled|canceled/i.test(value);
function sourceCurrency(row: AgoraDbLine): string | null { const raw = object(row.sales_event.raw_json); return text(raw?.currency) ?? text(object(raw?.amounts)?.currency); }

/** Rebuild buildAnalytics()-shaped buckets from the SQL aggregate (costs are never known → null). */
export function rpcBucketsToAnalytics(rows: Record<string, unknown>[]): ReturnType<typeof buildAnalytics> {
  const totals = new Map<string, number>();
  for (const row of rows) if (row.category === "ALL") totals.set(`${row.period}|${row.periodStart}`, Number(row.revenueMinor));
  return rows.map((row) => {
    const total = totals.get(`${row.period}|${row.periodStart}`) ?? 0; const revenueMinor = Number(row.revenueMinor);
    return { period: String(row.period) as never, periodStart: String(row.periodStart), category: String(row.category) as never, quantity: Number(row.quantity), revenueMinor, revenueShare: total === 0 ? null : row.category === "ALL" ? 1 : revenueMinor / total, costMinor: null, marginMinor: null, ticketCount: Number(row.ticketCount), currency: row.currency == null ? null : String(row.currency) };
  }).sort((a, b) => `${a.period}|${a.periodStart}|${a.category}`.localeCompare(`${b.period}|${b.periodStart}|${b.category}`));
}

/** Exact comparison except quantity float-summation noise (|Δ| ≤ 1e-9, documented). */
export function compareAnalytics(legacy: { coverage: Record<string, unknown>; series: Record<string, unknown>[]; aggregates: Record<string, unknown>[] }, sql: typeof legacy) {
  const diffs: string[] = []; let quantityNoise = 0;
  const same = (a: unknown, b: unknown, key: string, where: string) => {
    if (key === "quantity" && typeof a === "number" && typeof b === "number") { if (a === b) return; if (Math.abs(a - b) <= 1e-9) { quantityNoise += 1; return; } }
    if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push(`${where}.${key}`);
  };
  for (const key of new Set([...Object.keys(legacy.coverage), ...Object.keys(sql.coverage)])) same(legacy.coverage[key], sql.coverage[key], key, "coverage");
  for (const [name, a, b] of [["series", legacy.series, sql.series], ["aggregates", legacy.aggregates, sql.aggregates]] as const) {
    if (a.length !== b.length) { diffs.push(`${name}.length ${a.length}≠${b.length}`); continue; }
    a.forEach((row, index) => { for (const key of new Set([...Object.keys(row), ...Object.keys(b[index])])) same(row[key], b[index][key], key, `${name}[${index}]`); });
  }
  return { equal: diffs.length === 0, diffCount: diffs.length, diffs: diffs.slice(0, 50), quantityNoise, buckets: legacy.aggregates.length, coverage: { legacy: legacy.coverage, sql: sql.coverage } };
}

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

async function sourceRows(db: SupabaseClient, connectionId: string, fromDay: string, toDay: string, projected = false) {
  // projected=true (analytics only): PostgreSQL returns definitive documents with raw_json reduced
  // to the keys read by agoraProviderIdentity/agoraProviderAmount/sourceCurrency — never full payloads.
  const events = await paged<Record<string, unknown>>((from, to) => projected
    ? db.rpc("reconciliation_v2_analytics_events", { p_connection_id: connectionId, p_from: fromDay, p_to: toDay }).range(from, to)
    : db.from("sales_events")
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

async function readAcks(db: SupabaseClient, connectionId: string, businessDay: string) {
  return await paged<{ id: string; status: string | null; winerim_product_id: string | null; winerim_response: unknown }>((from, to) => db.from("stock_sync_log")
    .select("id,status,winerim_product_id,winerim_response").eq("connection_id", connectionId).eq("status", "SUCCESS")
    .eq("winerim_response->>businessDay", businessDay).order("created_at").order("id").range(from, to));
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
    assertPost(request); const auth = await requireAdminOrScheduler(request); const db = auth.db; dbForFinally = db; const body = await parseJson<Body>(request);
    if (auth.scheduler) assertSchedulerRequest({ connectionId: body.connectionId, dryRun: body.dryRun, historical: body.salesSourceMode !== undefined, businessDay: body.businessDay });
    connectionId = body.connectionId; const historical = body.salesSourceMode !== undefined; if (historical) validateHistoricalReconcileRequest(body); if (!validDay(body.businessDay)) throw Object.assign(new Error("businessDay inválido"), { status: 400, code: "INVALID_BUSINESS_DAY" });
    const dryRun = asDryRun(body.dryRun); const binding = await activeBinding(db, connectionId); const nextDay = plusDays(body.businessDay, 1); const cutoff = bindingCutoffHour(binding); const localFrom = `${body.businessDay}T${String(cutoff).padStart(2, "0")}:00:00`; const localTo = `${nextDay}T${String(cutoff).padStart(2, "0")}:00:00`;
    const salesCp = await checkpoint(db, connectionId, "sales_records"); const movementCp = await checkpoint(db, connectionId, "stock_movements");
    // Phase markers: timing + counts only, never row data.
    const t0 = performance.now(); const phase = (name: string, extra: Record<string, number> = {}) => console.log(`[rdr-phase] ${JSON.stringify({ phase: name, ms: Math.round(performance.now() - t0), dryRun, ...extra })}`);
    // Opt-in per-line attribution (AUDIT_ONLY normal path only): exact provider_sold_at vs cutoff; invalid → SOURCE_INCOMPLETE.
    const { data: connCfg, error: connCfgError } = await db.from("pos_connections").select("provider_config").eq("id", connectionId).single(); if (connCfgError) throw connCfgError;
    const lineAttribution = historical ? "EVENT_DAY" : lineTimeAttributionMode(connCfg?.provider_config);
    let lineAttributionMetrics: Record<string, unknown> = { mode: lineAttribution };
    let source = await (lineAttribution === "PROVIDER_LINE" ? sourceRows(db, connectionId, plusDays(body.businessDay, -1), plusDays(body.businessDay, 2)) : sourceRows(db, connectionId, body.businessDay, nextDay));
    if (lineAttribution === "PROVIDER_LINE") {
      const attributed = attributeByProviderLine(source.lines, { businessDay: body.businessDay, localFrom, localTo });
      lineAttributionMetrics = { mode: lineAttribution, loadedLines: source.lines.length, keptLines: attributed.lines.length, outsideWindow: attributed.outsideWindow, invalidTimestamp: attributed.invalidTimestamp };
      source = { lines: attributed.lines, complete: source.complete && attributed.complete, eventCount: new Set(attributed.lines.map((row) => String((row.sales_event as Record<string, unknown>).id ?? row.sales_event.provider_doc_id))).size };
    }
    phase("source_loaded", { events: source.eventCount, lines: source.lines.length });
    const providerUnresolved = source.lines.filter((row) => !agoraProviderIdentity(row));
    const productClassifications = await currentProductClassifications(db, connectionId, source.lines);
    phase("classifications_loaded", { products: productClassifications.size });
    const classifiedSource = source.lines.map((row) => ({ row, classification: classifyWineCandidate(row, row.provider_product_id ? productClassifications.get(row.provider_product_id) ?? null : null) }));
    const wineCandidates = classifiedSource.filter((item) => item.classification === "WINE").map((item) => item.row);
    const unknownWineClassification = classifiedSource.filter((item) => item.classification === "UNKNOWN").map((item) => item.row);
    const unmappedWine = wineCandidates.filter((row) => row.mapped !== true || !row.winerim_product_id);
    const reconcilableWine = wineCandidates.filter((row) => row.mapped === true && Boolean(row.winerim_product_id));
    const resolutions = reconcilableWine.map((row) => ({ row, resolution: resolveAgoraIdentity(row, binding.winerim_restaurant_id) }));
    const unresolved = resolutions.filter((item) => item.resolution.missing.length).map((item) => ({ row: item.row, missing: item.resolution.missing }));
    const agora = resolutions.map((item) => item.resolution.line).filter((row): row is NonNullable<typeof row> => Boolean(row));
    const split = splitSourceCoverage({ eventCount: source.eventCount, pageComplete: source.complete, classified: classifiedSource, hasProviderIdentity: (row) => Boolean(agoraProviderIdentity(row)), hasAmount: (row) => agoraProviderAmount(row) != null, unresolvedMappedWine: unresolved.length, unmappedWine: unmappedWine.length });
    // Operational gate = wine reconciliation coverage only; analytics coverage reported separately, never relaxed.
    const sourceCoverage = split.wineReconciliationCoverage;
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
    const overlayMode = writerReceiptOverlayMode({ requested: body.writerReceiptsOverlay, dryRun, scheduler: Boolean(auth.scheduler), historical });
    let writerReceiptEvidence: Record<string, unknown> = { mode: overlayMode };
    if (overlayMode === "NORMAL_DRY_RUN") {
      const acks = await readAcks(db, connectionId, body.businessDay);
      const extracted = extractWriterReceipts(acks.rows, { connectionId, businessDay: body.businessDay, timeZone: bindingTimezone(binding) });
      const applied = acks.complete && completeness.agoraComplete && completeness.winerimComplete ? applyWriterReceipts(results, extracted.receipts, winerimRows) : { results, usableReceipts: 0, excludedAlreadyInRange: 0, confirmed: 0 };
      results = applied.results;
      writerReceiptEvidence = { mode: overlayMode, logsRead: acks.rows.length, logsComplete: acks.complete, applied: acks.complete && completeness.agoraComplete && completeness.winerimComplete, receipts: extracted.receipts.length, rejected: extracted.rejected, excludedAlreadyInRange: applied.excludedAlreadyInRange, usable: applied.usableReceipts, confirmedLines: applied.confirmed };
    }
    if (historical) {
      // Manual AUDIT_ONLY: Winerim range read in memory; no checkpoint, cursor, lock or commit is touched.
      const window = businessWindow(binding, body.businessDay);
      const range = validateHistoricalRange({ historicalRange: true, dryRun: true, from: window.from, to: window.to, maxPages: 100 }, binding);
      const read = await readHistoricalRange(fleetClient(), binding.winerim_restaurant_id, range);
      const rangeLines = rangeRecordsToWinerimLines(read.records, binding.winerim_restaurant_id, body.businessDay, localFrom, localTo);
      completeness.winerimComplete = read.evidence.coverageComplete && winerim.complete && deletions.complete;
      const out = reconcileHistorical({ connectionId, agora, rangeLines, persistedLines: winerimRows, deletions: deletionRows, completeness });
      // Second causal source (read-only): persisted writer acknowledgements for this connection/day.
      const acks = await readAcks(db, connectionId, body.businessDay);
      const extracted = extractWriterReceipts(acks.rows, { connectionId, businessDay: body.businessDay, timeZone: window.timezone });
      const applied = acks.complete ? applyWriterReceipts(out.results, extracted.receipts, out.winerimLines) : { results: out.results, usableReceipts: 0, excludedAlreadyInRange: 0, confirmed: 0 };
      results = applied.results;
      const { lineSummary: _omit, ...rangeEvidence } = read.evidence;
      historicalEvidence = { salesSourceMode: "historical_range", range: rangeEvidence, rangeLinesInDay: rangeLines.length, persistedOnlyLines: out.persistedOnlyLines, agoraRepresentations: agora.length, agoraEconomicLines: out.economicAgora.length, supersededOpen: out.supersededOpen, writerReceipts: { logsRead: acks.rows.length, logsComplete: acks.complete, receipts: extracted.receipts.length, rejected: extracted.rejected, excludedAlreadyInRange: applied.excludedAlreadyInRange, usable: applied.usableReceipts, confirmedLines: applied.confirmed } };
    }
    const now = new Date().toISOString(); const runId = crypto.randomUUID();
    phase("reconciled", { results: results.length });
    const resultRows = await Promise.all(results.map(async (row) => ({ ...row, revisionHash: await sha256Hex(row) })));
    phase("hashed", { results: resultRows.length });

    // Operational/analytics split: a dryRun canary certifies only sources, checkpoints,
    // identity and classification for the requested business_day. Analytics are never
    // computed in dryRun; on the committing path they come from the bounded PostgreSQL
    // aggregate (reconciliation_v2_analytics_aggregate) — no historical raw_json reaches the Worker.
    type Bucket = ReturnType<typeof buildAnalytics>[number];
    const finishAnalytics = (buckets: Bucket[], stats: { complete: boolean; identityLines: number; included: number; missingIdentity: number; missingAmount: number; anchorLines: number; anchorCategoryLines: Record<string, number> }) => {
      const withFreshness = buckets.map((row) => ({ ...row, freshnessAt: now }));
      const dayBuckets = withFreshness.filter((row) => row.period === "DAY" && row.periodStart === body.businessDay && row.category !== "ALL");
      const analyticsCoverage = {
        complete: stats.complete && stats.missingIdentity === 0 && stats.missingAmount === 0,
        reasons: [stats.complete ? null : "ANALYTICS_SOURCE_INCOMPLETE", stats.missingIdentity ? "ANALYTICS_IDENTITY_FIELDS_MISSING" : null, stats.missingAmount ? "ANALYTICS_AMOUNT_MISSING" : null].filter((value): value is string => Boolean(value)),
        sourceLines: stats.identityLines,
        includedLines: stats.included,
        missingIdentityLines: stats.missingIdentity,
        missingAmountLines: stats.missingAmount,
      };
      const analytics = { coverage: analyticsCoverage, series: dayBuckets.map((row) => ({ businessDay: row.periodStart, category: row.category, revenueMinor: row.revenueMinor, quantity: row.quantity, ticketCount: row.ticketCount, classifiedLineCount: stats.anchorCategoryLines[row.category] ?? 0, sourceLineCount: stats.anchorLines, currency: row.currency, freshnessAt: now })), aggregates: withFreshness };
      return { analytics, analyticsCoverage };
    };
    // Legacy JS path — kept ONLY for the read-only equivalence check (dryRun + analyticsEquivalenceDays).
    const legacyAnalytics = async (days: number) => {
      const { data: rules, error: rulesError } = await db.from("reconciliation_v2_category_rules").select("provider_product_id,family_key,category").eq("connection_id", connectionId);
      if (rulesError) throw Object.assign(new Error("No se pudieron leer reglas de categoría"), { status: 500, code: "CATEGORY_RULE_READ_FAILED" });
      const categories = new Map((rules ?? []).map((rule) => [`${rule.provider_product_id ?? ""}|${rule.family_key ?? ""}`, rule.category as AnalyticsCategory]));
      const uniqueAnalytics = new Map<string, AnalyticsLine>(); let complete = true; let identityLines = 0; let missingIdentity = 0; let missingAmount = 0;
      for (let offsetDay = -(days - 1); offsetDay <= 0; offsetDay += 1) {
        const day = plusDays(body.businessDay, offsetDay);
        const chunk = offsetDay === 0 ? source : await sourceRows(db, connectionId, day, plusDays(day, 1), true);
        complete = complete && chunk.complete;
        for (const row of chunk.lines) {
          if (!definitiveDocument(row.sales_event.doc_type)) continue;
          identityLines += 1; const identity = agoraProviderIdentity(row); const amount = agoraProviderAmount(row);
          if (!identity) missingIdentity += 1; if (amount == null) missingAmount += 1;
          if (!identity || amount == null) continue;
          const explicit = categories.get(`${row.provider_product_id ?? ""}|${row.family ?? ""}`) ?? categories.get(`${row.provider_product_id ?? ""}|`) ?? categories.get(`|${row.family ?? ""}`);
          const category: AnalyticsCategory = row.mapped === true && row.winerim_product_id ? "WINE" : explicit ?? "UNCLASSIFIED";
          uniqueAnalytics.set(identity, { connectionId, effectiveAt: String(row.sales_event.business_day) + "T12:00:00Z", category, quantity: Number(row.quantity), revenueMinor: Math.round(Number(amount) * 100), costMinor: null, ticketId: row.sales_event.provider_doc_id, isReturn: row.sales_event.doc_type.toLowerCase().includes("refund"), currency: sourceCurrency(row) });
        }
      }
      const lines = [...uniqueAnalytics.values()]; const anchor = lines.filter((row) => row.effectiveAt.startsWith(body.businessDay));
      const anchorCategoryLines: Record<string, number> = {}; for (const row of anchor) anchorCategoryLines[row.category] = (anchorCategoryLines[row.category] ?? 0) + 1;
      return finishAnalytics(buildAnalytics(lines, body.businessDay), { complete, identityLines, included: lines.length, missingIdentity, missingAmount, anchorLines: anchor.length, anchorCategoryLines });
    };
    // Persistent path: bounded SQL aggregate over the compact projection (never raw_json). Any RPC failure throws → nothing is committed (fail-closed).
    const rpcAnalytics = async (days: number) => {
      const { data, error } = await db.rpc("reconciliation_v2_analytics_aggregate", { p_connection_id: connectionId, p_from: plusDays(body.businessDay, -(days - 1)), p_to: nextDay, p_anchor: body.businessDay });
      const agg = object(data);
      if (error || !agg || !Array.isArray(agg.buckets)) throw Object.assign(new Error(`Falló el agregado de analíticas${error ? ` (${(error as { code?: string }).code ?? "?"}: ${String((error as { message?: string }).message ?? "").slice(0, 160)})` : ""}`), { status: 500, code: "ANALYTICS_AGGREGATE_FAILED" });
      const buckets = rpcBucketsToAnalytics(agg.buckets as Record<string, unknown>[]);
      return finishAnalytics(buckets, { complete: source.complete, identityLines: Number(agg.identityLines), included: Number(agg.includedLines), missingIdentity: Number(agg.missingIdentityLines), missingAmount: Number(agg.missingAmountLines), anchorLines: Number(agg.anchorLines), anchorCategoryLines: (object(agg.anchorCategoryLines) ?? {}) as Record<string, number> });
    };
    // Incremental projection: refresh exactly one business_day slice (compact technical table).
    const refreshDay = async (day: string, onlyMissing: boolean) => {
      const { data, error } = await db.rpc("reconciliation_v2_analytics_refresh_day", { p_connection_id: connectionId, p_business_day: day, p_only_missing: onlyMissing });
      if (error || !object(data)) throw Object.assign(new Error(`Falló el refresco de la proyección ${day}${error ? ` (${(error as { code?: string }).code ?? "?"}: ${String((error as { message?: string }).message ?? "").slice(0, 160)})` : ""}`), { status: 500, code: "ANALYTICS_PROJECTION_REFRESH_FAILED", day });
      return object(data)!;
    };
    const backfillDays = body.analyticsProjectionBackfillDays;
    if (backfillDays !== undefined) {
      if (!dryRun || auth.scheduler || historical || !Number.isInteger(backfillDays) || Number(backfillDays) < 1 || Number(backfillDays) > 28) throw Object.assign(new Error("analyticsProjectionBackfillDays solo en dryRun manual, 1..28"), { status: 400, code: "ANALYTICS_BACKFILL_INVALID" });
      const journal: Record<string, unknown>[] = [];
      for (let offset = -(Number(backfillDays) - 1); offset <= 0; offset += 1) {
        const day = plusDays(body.businessDay, offset); const started = Date.now();
        try { journal.push({ ...(await refreshDay(day, true)), ms: Date.now() - started }); }
        catch (error) { return json(request, { ok: false, mode: "AUDIT_ONLY", dryRun: true, backfill: journal, stoppedAt: day, error: String((error as Error).message).slice(0, 240) }, 500); }
        phase("backfill_day", { offset, ms: Date.now() - started });
      }
      return json(request, { ok: true, mode: "AUDIT_ONLY", dryRun: true, backfill: journal });
    }
    const equivalenceDays = body.analyticsEquivalenceDays;
    if (equivalenceDays !== undefined) {
      if (!dryRun || auth.scheduler || historical || !Number.isInteger(equivalenceDays) || Number(equivalenceDays) < 1 || Number(equivalenceDays) > 28) throw Object.assign(new Error("analyticsEquivalenceDays solo en dryRun manual, 1..28"), { status: 400, code: "ANALYTICS_EQUIVALENCE_INVALID" });
      const legacy = await legacyAnalytics(Number(equivalenceDays)); phase("equivalence_legacy_done");
      const sql = await rpcAnalytics(Number(equivalenceDays)); phase("equivalence_rpc_done");
      return json(request, { ok: true, mode: "AUDIT_ONLY", dryRun: true, analyticsEquivalence: compareAnalytics(legacy.analytics, sql.analytics), days: equivalenceDays });
    }
    const ANALYTICS_SKIPPED = { complete: null, skipped: "DRY_RUN_OPERATIONAL_ONLY", reasons: [] as string[], sourceLines: 0, includedLines: 0, missingIdentityLines: 0, missingAmountLines: 0 };
    const { analytics, analyticsCoverage } = dryRun ? { analytics: { coverage: ANALYTICS_SKIPPED, series: [], aggregates: [] }, analyticsCoverage: ANALYTICS_SKIPPED } : await (async () => { await refreshDay(plusDays(body.businessDay, -1), false); await refreshDay(body.businessDay, false); phase("projection_refreshed"); return rpcAnalytics(28); })();
    phase("analytics_done");
    const metrics = { sourceLines: source.lines.length, providerIdentifiedLines: source.lines.length - providerUnresolved.length, wineCandidateLines: wineCandidates.length, mappedWineLines: reconcilableWine.length, unmappedWineLines: unmappedWine.length, unknownWineClassificationLines: unknownWineClassification.length, eligibleAgoraLines: agora.length, unresolvedSourceLines: providerUnresolved.length + unresolved.length, ...split.metrics, wineReconciliationCoverage: split.wineReconciliationCoverage, sourceAnalyticsCoverage: split.analyticsCoverage, analyticsCoverage, winerimLines: winerimRows.length, states: Object.fromEntries(results.map((row) => row.state).map((state, _, all) => [state, all.filter((value) => value === state).length])) };
    if (!dryRun) {
      lockStream = `reconcile:${body.businessDay}`; await claim(db, connectionId, lockStream, owner); locked = true;
      phase("commit_start", { results: resultRows.length });
      const { error } = await db.rpc("reconciliation_v2_commit_run", { p_run_id: runId, p_connection_id: connectionId, p_restaurant_id: binding.winerim_restaurant_id, p_business_day: body.businessDay, p_source_cutoff_at: now, p_completeness: completeness, p_results: resultRows, p_metrics: metrics, p_analytics: analytics });
      phase("commit_done");
      if (error) throw Object.assign(new Error("Falló el commit atómico de conciliación"), { status: 500, code: "RECONCILIATION_COMMIT_FAILED" });
    }
    return json(request, { ok: completeness.agoraComplete && completeness.winerimComplete, mode: "AUDIT_ONLY", dryRun, runId, historical: historicalEvidence, writerReceipts: writerReceiptEvidence, completeness, sourceDiagnostic, metrics, results: resultRows, analytics }, completeness.agoraComplete && completeness.winerimComplete ? 200 : 206);
  } catch (error) { return safeError(request, error); }
  finally { if (locked && dbForFinally) { try { await release(dbForFinally, connectionId, lockStream, owner); } catch { /* TTL is the recovery path */ } } }
});
