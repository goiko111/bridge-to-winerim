import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getNumierConfig, type NumierConfig } from "../_shared/providerConfig.ts";
import { isConnectionPaused } from "../_shared/resilience.ts";

const NUMIER_BASE = "https://www.numier.com/api/public/index.php/api";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function sb() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

async function getConnection(id: string) {
  const { data, error } = await sb()
    .from("pos_connections")
    .select("*")
    .eq("id", id)
    .single();
  if (error || !data) throw new Error(`Connection ${id} not found`);
  return data;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ── Auth helpers ────────────────────────────────────────────

function buildHeaders(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "apiKey": apiKey,
  };
}

function resolveBaseUrl(conn: { base_url: string }, cfg: NumierConfig): string {
  const raw = cfg.api_base_url || conn.base_url || "";
  if (!raw || raw === NUMIER_BASE) return NUMIER_BASE;
  let url = raw.trim().replace(/\/+$/, "");
  if (url && !url.startsWith("http")) url = `https://${url}`;
  return url;
}

function resolveTpvId(cfg: NumierConfig, manualOverride?: string): { tpvId: string | null; source: "manual_override" | "selected" | "none"; locationCount: number } {
  if (manualOverride) return { tpvId: manualOverride, source: "manual_override", locationCount: (cfg.discovered_locations || []).length };
  // Check manual_tpv_override persisted in config
  if (cfg.manual_tpv_override) return { tpvId: cfg.manual_tpv_override, source: "manual_override", locationCount: (cfg.discovered_locations || []).length };
  const locs = cfg.discovered_locations || [];
  if (cfg.selected_tpv_id) return { tpvId: cfg.selected_tpv_id, source: "selected", locationCount: locs.length };
  // Explicitly do NOT fall back to discovered_locations[0].id — location_id ≠ tpv_id
  return { tpvId: null, source: "none", locationCount: locs.length };
}

// ── Action handlers ─────────────────────────────────────────

async function handleHealthcheck(connId: string) {
  const conn = await getConnection(connId);
  const cfg = getNumierConfig(conn.provider_config);
  const baseUrl = resolveBaseUrl(conn, cfg);
  const headers = buildHeaders(conn.api_token);

  try {
    const url = `${baseUrl}/getLocales`;
    console.log("[numier-proxy] healthcheck URL:", url);
    const res = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(10_000),
    });

    const rawText = await res.text();
    console.log("[numier-proxy] healthcheck status:", res.status, "body:", rawText.slice(0, 500));

    let body: Record<string, unknown> = {};
    try { body = JSON.parse(rawText); } catch { /* non-JSON */ }

    // Accept: response===true (production) OR res.ok with any valid body (sandbox)
    if (res.ok && (body.response === true || body.result || Array.isArray(body))) {
      const locales = body.result || (Array.isArray(body) ? body : []);
      const updatedCfg = {
        ...cfg,
        verified_capabilities: { ...(cfg.verified_capabilities || {}), healthcheck: true },
      };
      await sb().from("pos_connections").update({ provider_config: updatedCfg }).eq("id", connId);

      return json({
        success: true,
        status: res.status,
        message: "Numier reachable",
        localesCount: Array.isArray(locales) ? locales.length : 0,
      });
    }

    return json({
      success: false,
      status: res.status,
      message: body.message || `Unexpected response shape: ${rawText.slice(0, 200)}`,
      rawPreview: rawText.slice(0, 300),
    });
  } catch (err) {
    return json({ success: false, message: `Connection failed: ${(err as Error).message}` }, 502);
  }
}

async function handleReadLocations(connId: string) {
  const conn = await getConnection(connId);
  const cfg = getNumierConfig(conn.provider_config);
  const baseUrl = resolveBaseUrl(conn, cfg);
  const headers = buildHeaders(conn.api_token);

  try {
    const res = await fetch(`${baseUrl}/getLocales`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const body = await res.text();
      return json({ success: false, message: `Locales API error (${res.status})`, body: body.slice(0, 500) });
    }

    const data = await res.json();

    if (!data.response) {
      return json({ success: false, message: data.message || "API returned response=false" });
    }

    const locations = (data.result || []).map((loc: Record<string, unknown>) => ({
      id: String(loc.id || ""),
      name: String(loc.establishmentName || "Unknown"),
    }));

    const updatedCfg = {
      ...cfg,
      discovered_locations: locations,
      verified_capabilities: { ...(cfg.verified_capabilities || {}), read_locations: true },
    };
    await sb().from("pos_connections").update({ provider_config: updatedCfg }).eq("id", connId);

    return json({ success: true, locations, count: locations.length });
  } catch (err) {
    return json({ success: false, message: `Failed: ${(err as Error).message}` }, 502);
  }
}

// ── Date chunking helpers ───────────────────────────────────

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(start: string, end: string): number {
  const a = new Date(start + "T00:00:00Z");
  const b = new Date(end + "T00:00:00Z");
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

function buildChunks(start: string, end: string, chunkDays: number): { start: string; end: string }[] {
  const chunks: { start: string; end: string }[] = [];
  let cur = start;
  while (cur <= end) {
    const chunkEnd = addDays(cur, chunkDays - 1);
    chunks.push({ start: cur, end: chunkEnd > end ? end : chunkEnd });
    cur = addDays(chunkEnd > end ? end : chunkEnd, 1);
  }
  return chunks;
}

function isRangeTooLargeError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("intervalo temporal demasiado amplio") ||
    lower.includes("range too large") ||
    lower.includes("fechas más cercanas") ||
    lower.includes("too wide");
}

// ── Shared: fetch one date range worth of sales (all pages) ──

interface ChunkResult {
  start: string;
  end: string;
  success: boolean;
  error_type?: "range_too_large" | "api_error" | "permission_error" | "network_error";
  error_message?: string;
  tickets: Record<string, unknown>[];
  pages_read: number;
  total_pages: number;
  unique_ticket_ids: number;
  duplicate_count: number;
}

async function fetchSalesChunk(
  baseUrl: string, tpvId: string, headers: Record<string, string>,
  startDate: string, endDate: string
): Promise<ChunkResult> {
  const result: ChunkResult = {
    start: startDate, end: endDate, success: false,
    tickets: [], pages_read: 0, total_pages: 1,
    unique_ticket_ids: 0, duplicate_count: 0,
  };
  const ticketIdSet = new Set<string>();

  try {
    let page = 1;
    let totalPages = 1;

    do {
      const url = `${baseUrl}/v2/sales/${tpvId}?start_date=${startDate}&end_date=${endDate}&pag=${page}`;
      console.log(`[numier] Fetching sales chunk ${startDate}→${endDate} page ${page}: ${url}`);

      const res = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(30_000) });

      if (!res.ok) {
        const body = await res.text();
        result.error_type = "api_error";
        result.error_message = `HTTP ${res.status}: ${body.slice(0, 300)}`;
        return result;
      }

      const data = await res.json();

      if (!data.response) {
        const msg = data.message || "API returned response=false";
        if (isRangeTooLargeError(msg)) {
          result.error_type = "range_too_large";
          result.error_message = msg;
        } else if (msg.includes("no pertenece") || msg.includes("not belong")) {
          result.error_type = "permission_error";
          result.error_message = msg;
        } else {
          result.error_type = "api_error";
          result.error_message = msg;
        }
        return result;
      }

      const pageTickets = data.result || [];
      for (const t of pageTickets) {
        const tid = String(t.TaxDocumentNumber || `${t.Serie}-${t.Number}`);
        if (ticketIdSet.has(tid)) result.duplicate_count++;
        else ticketIdSet.add(tid);
      }
      result.tickets.push(...pageTickets);
      totalPages = data.totalpages || data.totalPages || 1;
      result.pages_read++;
      page++;
    } while (page <= totalPages);

    result.total_pages = totalPages;
    result.unique_ticket_ids = ticketIdSet.size;
    result.success = true;
    return result;
  } catch (err) {
    result.error_type = "network_error";
    result.error_message = (err as Error).message;
    return result;
  }
}

// ── Normalize tickets to canonical shape ────────────────────

function normalizeTickets(tickets: Record<string, unknown>[], fallbackDay: string) {
  const salesEvents = tickets.map((ticket) => {
    const invoiceItems = (ticket.InvoiceItems || []) as Record<string, unknown>[];
    const totals = (ticket.Totals || {}) as Record<string, unknown>;

    const lines = invoiceItems.map((item, idx) => ({
      provider_product_id: String(item.idProduct || ""),
      name: String(item.name || ""),
      format: "UNIT",
      family: String(item.idCategory || ""),
      quantity: Number(item.units || 0),
      unit_price: Number(item.price || 0),
      total_amount: Number(item.amount || 0) || Number(item.units || 0) * Number(item.price || 0),
      vat_rate: Number(item.vatType || 0),
      is_wine_candidate: false,
      _ordinal: idx,
    }));

    const serie = String(ticket.Serie || "");
    const number = String(ticket.Number || "");

    return {
      provider_doc_id: ticket.TaxDocumentNumber
        ? String(ticket.TaxDocumentNumber)
        : `${serie}-${number}`,
      business_day: String(ticket.BusinessDay || fallbackDay),
      doc_type: String(ticket.DocumentType || "FS"),
      total_amount: Number(totals.GrossAmount || 0),
      total_tax: Number(totals.VatAmount || 0),
      total_net: Number(totals.NetAmount || 0),
      line_count: lines.length,
      lines,
    };
  });

  const ticketsWithNoLines = salesEvents.filter((e) => e.line_count === 0).length;
  const allLines = salesEvents.flatMap((e) => e.lines);
  const linesWithZeroPrice = allLines.filter((l) => l.unit_price === 0).length;
  const linesWithoutProductId = allLines.filter((l) => !l.provider_product_id).length;
  const businessDays = [...new Set(salesEvents.map((e) => e.business_day))].sort();

  return {
    salesEvents,
    normalization: {
      events_count: salesEvents.length,
      total_lines: allLines.length,
      tickets_without_lines: ticketsWithNoLines,
      lines_with_zero_price: linesWithZeroPrice,
      lines_without_product_id: linesWithoutProductId,
      business_day_range: businessDays.length > 0
        ? { min: businessDays[0], max: businessDays[businessDays.length - 1] }
        : null,
    },
  };
}

// ── Read Sales (single range) ───────────────────────────────

async function handleReadSales(connId: string, businessDay: string, endDate?: string, manualTpvOverride?: string) {
  const conn = await getConnection(connId);
  const cfg = getNumierConfig(conn.provider_config);
  const baseUrl = resolveBaseUrl(conn, cfg);
  const headers = buildHeaders(conn.api_token);

  const { tpvId, source, locationCount } = resolveTpvId(cfg, manualTpvOverride);
  if (!tpvId) {
    const msg = locationCount > 1
      ? `Multiple locations discovered (${locationCount}) but no TPV explicitly selected. Please select one in the wizard.`
      : "No TPV available. Discover locations first.";
    return json({ success: false, message: msg }, 400);
  }

  const startDate = businessDay;
  const end = endDate || businessDay;

  const chunk = await fetchSalesChunk(baseUrl, tpvId, headers, startDate, end);

  if (!chunk.success) {
    return json({
      success: false,
      error_type: chunk.error_type,
      message: chunk.error_message,
      tpvId,
      tpvSource: source,
      startDate,
      endDate: end,
    });
  }

  const { salesEvents, normalization } = normalizeTickets(chunk.tickets, startDate);

  if (salesEvents.length > 0) {
    const updatedCfg = {
      ...cfg,
      verified_capabilities: { ...(cfg.verified_capabilities || {}), read_sales: true },
    };
    await sb().from("pos_connections").update({ provider_config: updatedCfg }).eq("id", connId);
  }

  return json({
    success: true,
    businessDay: startDate,
    endDate: end,
    baseUrl,
    tpvId,
    tpvSource: source,
    salesEvents,
    count: salesEvents.length,
    pagination: {
      pages_read: chunk.pages_read,
      tickets_seen: chunk.tickets.length,
      unique_ticket_ids: chunk.unique_ticket_ids,
      duplicate_ticket_ids_count: chunk.duplicate_count,
    },
    normalization,
  });
}

// ── Read Sales Chunked ──────────────────────────────────────

async function handleReadSalesChunked(connId: string, startDate: string, endDate: string, chunkDays: number, manualTpvOverride?: string) {
  const conn = await getConnection(connId);
  const cfg = getNumierConfig(conn.provider_config);
  const baseUrl = resolveBaseUrl(conn, cfg);
  const headers = buildHeaders(conn.api_token);

  const { tpvId, source, locationCount } = resolveTpvId(cfg, manualTpvOverride);
  if (!tpvId) {
    const msg = locationCount > 1
      ? `Multiple locations discovered (${locationCount}) but no TPV explicitly selected.`
      : "No TPV available. Discover locations first.";
    return json({ success: false, message: msg }, 400);
  }

  const chunks = buildChunks(startDate, endDate, chunkDays);
  const chunkResults: ChunkResult[] = [];
  const allTickets: Record<string, unknown>[] = [];
  const globalTicketIds = new Set<string>();
  let globalDuplicates = 0;

  for (const c of chunks) {
    const result = await fetchSalesChunk(baseUrl, tpvId, headers, c.start, c.end);
    chunkResults.push(result);

    if (result.success) {
      for (const t of result.tickets) {
        const tid = String((t as any).TaxDocumentNumber || `${(t as any).Serie}-${(t as any).Number}`);
        if (globalTicketIds.has(tid)) globalDuplicates++;
        else globalTicketIds.add(tid);
      }
      allTickets.push(...result.tickets);
    }
  }

  const { salesEvents, normalization } = normalizeTickets(allTickets, startDate);
  const successfulChunks = chunkResults.filter((c) => c.success).length;
  const failedChunks = chunkResults.filter((c) => !c.success);

  if (salesEvents.length > 0) {
    const updatedCfg = {
      ...cfg,
      verified_capabilities: { ...(cfg.verified_capabilities || {}), read_sales: true },
    };
    await sb().from("pos_connections").update({ provider_config: updatedCfg }).eq("id", connId);
  }

  return json({
    success: true,
    mode: "chunked",
    businessDay: startDate,
    endDate,
    chunkDays,
    tpvId,
    tpvSource: source,
    salesEvents,
    count: salesEvents.length,
    chunking: {
      total_chunks: chunks.length,
      successful_chunks: successfulChunks,
      failed_chunks: failedChunks.length,
      chunk_details: chunkResults.map((c) => ({
        start: c.start,
        end: c.end,
        success: c.success,
        error_type: c.error_type || null,
        error_message: c.error_message || null,
        tickets: c.tickets.length,
        pages_read: c.pages_read,
        unique_ticket_ids: c.unique_ticket_ids,
        duplicate_count: c.duplicate_count,
      })),
    },
    pagination: {
      pages_read: chunkResults.reduce((s, c) => s + c.pages_read, 0),
      tickets_seen: allTickets.length,
      unique_ticket_ids: globalTicketIds.size,
      duplicate_ticket_ids_count: globalDuplicates,
    },
    normalization,
  });
}

/**
 * SAVE_SALES — persist normalized sales to DB.
 * Delete + insert per event for idempotency without collisions.
 */
async function handleSaveSales(connId: string, businessDay: string, endDate?: string, manualTpvOverride?: string) {
  const fetchRes = await handleReadSales(connId, businessDay, endDate, manualTpvOverride);
  const fetchBody = await fetchRes.clone().json();

  if (!fetchBody.success) return fetchRes;

  const salesEvents = fetchBody.salesEvents || [];
  let savedEvents = 0;
  let savedLines = 0;

  for (const ev of salesEvents) {
    const { data: eventRow, error: evErr } = await sb()
      .from("sales_events")
      .upsert(
        {
          connection_id: connId,
          provider_doc_id: ev.provider_doc_id,
          business_day: ev.business_day,
          doc_type: ev.doc_type,
          total_amount: ev.total_amount,
          total_tax: ev.total_tax,
          total_net: ev.total_net,
          line_count: ev.line_count,
        },
        { onConflict: "connection_id,provider_doc_id" },
      )
      .select("id")
      .single();

    if (evErr || !eventRow) continue;
    savedEvents++;

    await sb()
      .from("sales_line_items")
      .delete()
      .eq("sales_event_id", eventRow.id);

    const lineRows = ev.lines.map((line: any) => ({
      sales_event_id: eventRow.id,
      connection_id: connId,
      provider_product_id: line.provider_product_id,
      name: line.name,
      format: line.format,
      family: line.family,
      quantity: line.quantity,
      unit_price: line.unit_price,
      total_amount: line.total_amount,
      vat_rate: line.vat_rate,
      is_wine_candidate: line.is_wine_candidate,
    }));

    if (lineRows.length > 0) {
      const { error: lineErr } = await sb().from("sales_line_items").insert(lineRows);
      if (!lineErr) savedLines += lineRows.length;
    }
  }

  const lastDay = endDate || businessDay;
  await sb().from("pos_connections").update({
    last_sync_at: new Date().toISOString(),
    last_business_day_synced: lastDay,
  }).eq("id", connId);

  return json({
    success: true,
    savedEvents,
    savedLines,
    businessDay,
    pagination: fetchBody.pagination,
    normalization: {
      ...fetchBody.normalization,
      events_saved: savedEvents,
      lines_saved: savedLines,
    },
  });
}

async function handleReadCategories(connId: string) {
  const conn = await getConnection(connId);
  const cfg = getNumierConfig(conn.provider_config);
  const baseUrl = resolveBaseUrl(conn, cfg);
  const headers = buildHeaders(conn.api_token);

  const { tpvId, locationCount } = resolveTpvId(cfg);
  if (!tpvId) {
    const msg = locationCount > 1
      ? `Multiple locations (${locationCount}) but no TPV selected.`
      : "No TPV available. Discover locations first.";
    return json({ success: false, message: msg }, 400);
  }

  try {
    const res = await fetch(`${baseUrl}/getCategoriesByTpv/${tpvId}`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const body = await res.text();
      return json({ success: false, message: `Categories API error (${res.status})`, body: body.slice(0, 500) });
    }

    const data = await res.json();
    if (!data.response) {
      return json({ success: false, message: data.message || "API returned response=false" });
    }

    const categories = (data.result || []).map((cat: Record<string, unknown>) => ({
      id: String(cat.id || ""),
      name: String(cat.name || ""),
    }));

    const updatedCfg = {
      ...cfg,
      verified_capabilities: { ...(cfg.verified_capabilities || {}), read_categories: true },
    };
    await sb().from("pos_connections").update({ provider_config: updatedCfg }).eq("id", connId);

    return json({ success: true, categories, count: categories.length });
  } catch (err) {
    return json({ success: false, message: `Failed: ${(err as Error).message}` }, 502);
  }
}

async function handleReadProducts(connId: string) {
  const conn = await getConnection(connId);
  const cfg = getNumierConfig(conn.provider_config);
  const baseUrl = resolveBaseUrl(conn, cfg);
  const headers = buildHeaders(conn.api_token);

  const { tpvId, locationCount } = resolveTpvId(cfg);
  if (!tpvId) {
    const msg = locationCount > 1
      ? `Multiple locations (${locationCount}) but no TPV selected.`
      : "No TPV available. Discover locations first.";
    return json({ success: false, message: msg }, 400);
  }

  try {
    const allProducts: Record<string, unknown>[] = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const url = `${baseUrl}/getProducts/${tpvId}?pag=${page}`;
      const res = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(30_000) });

      if (!res.ok) {
        const body = await res.text();
        return json({ success: false, message: `Products API error (${res.status})`, body: body.slice(0, 500) });
      }

      const data = await res.json();
      if (!data.response) {
        return json({ success: false, message: data.message || "API returned response=false" });
      }

      const batch = data.result || [];
      allProducts.push(...batch);
      hasMore = batch.length >= 50;
      page++;
    }

    const products = allProducts.map((p: Record<string, unknown>) => ({
      id: String(p.id || ""),
      name: String(p.name || ""),
      category_id: String(p.idCategory || ""),
      category_name: String(p.nameCategory || ""),
      price: Number(p.price1 || 0),
      price2: Number(p.price2 || 0),
      price3: Number(p.price3 || 0),
      price4: Number(p.price4 || 0),
      vat_type: Number(p.vatType || 0),
      is_active: p.isActive === true || p.isActive === "true",
    }));

    const updatedCfg = {
      ...cfg,
      verified_capabilities: { ...(cfg.verified_capabilities || {}), read_products: true },
    };
    await sb().from("pos_connections").update({ provider_config: updatedCfg }).eq("id", connId);

    return json({ success: true, products, count: products.length });
  } catch (err) {
    return json({ success: false, message: `Failed: ${(err as Error).message}` }, 502);
  }
}

// ── Probe Sales Page 1 (read-only, no save) ────────────────

async function handleProbeSales(connId: string, startDate: string, endDate: string, manualTpvOverride?: string) {
  const conn = await getConnection(connId);
  const cfg = getNumierConfig(conn.provider_config);
  const baseUrl = resolveBaseUrl(conn, cfg);
  const headers = buildHeaders(conn.api_token);

  const { tpvId, source } = resolveTpvId(cfg, manualTpvOverride);
  if (!tpvId) return json({ success: false, message: "No TPV id available for probe." }, 400);

  const url = `${baseUrl}/v2/sales/${tpvId}?start_date=${startDate}&end_date=${endDate}&pag=1`;
  try {
    const res = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(15_000) });
    const rawText = await res.text();
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(rawText); } catch { /* non-JSON */ }

    const tickets = (body.result || []) as Record<string, unknown>[];
    const firstTicket = tickets[0] || null;
    const firstTicketLines = firstTicket ? ((firstTicket as any).InvoiceItems || []).length : 0;

    return json({
      success: true,
      probe: {
        effective_url: url,
        http_status: res.status,
        api_response: body.response ?? null,
        api_message: body.message ?? null,
        top_level_keys: Object.keys(body),
        total_pages: body.totalpages ?? 1,
        tickets_in_page1: tickets.length,
        first_ticket_lines: firstTicketLines,
        first_ticket_sample: firstTicket ? JSON.stringify(firstTicket).slice(0, 800) : null,
        tpv_id: tpvId,
        tpv_source: source,
        start_date: startDate,
        end_date: endDate,
      },
    });
  } catch (err) {
    return json({ success: false, message: `Probe failed: ${(err as Error).message}` }, 502);
  }
}

// ── Diagnose TPV ────────────────────────────────────────────

interface DiagnoseProbe {
  endpoint: string;
  http_status: number | null;
  success: boolean;
  error: string | null;
  detail: Record<string, unknown>;
}

async function handleDiagnoseTpv(connId: string, overrideTpvId?: string, startDate?: string, endDate?: string) {
  const conn = await getConnection(connId);
  const cfg = getNumierConfig(conn.provider_config);
  const baseUrl = resolveBaseUrl(conn, cfg);
  const headers = buildHeaders(conn.api_token);

  const tpvId = overrideTpvId || cfg.selected_tpv_id;
  if (!tpvId) {
    return json({ success: false, message: "No TPV id provided for diagnosis." }, 400);
  }

  // Use provided date range, fallback to yesterday only as last resort
  const diagStart = startDate || (() => { const d = new Date(); d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10); })();
  const diagEnd = endDate || diagStart;
  const usingProvidedRange = !!startDate;

  const probes: DiagnoseProbe[] = [];

  // ── Probe 1: getLocales ──
  try {
    const res = await fetch(`${baseUrl}/getLocales`, { method: "GET", headers, signal: AbortSignal.timeout(10_000) });
    const body = await res.json();
    const locIds = (body.result || []).map((l: any) => String(l.id));
    probes.push({
      endpoint: "getLocales",
      http_status: res.status,
      success: res.ok && body.response === true,
      error: null,
      detail: {
        location_count: locIds.length,
        location_ids: locIds,
        tpv_id_found_in_locales: locIds.includes(tpvId),
      },
    });
  } catch (err) {
    probes.push({ endpoint: "getLocales", http_status: null, success: false, error: (err as Error).message, detail: {} });
  }

  // ── Probe 2: v2/sales/{idTpv} ──
  try {
    const url = `${baseUrl}/v2/sales/${tpvId}?start_date=${diagStart}&end_date=${diagEnd}&pag=1`;
    const res = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(15_000) });
    const body = await res.json();
    const tickets = body.result || [];
    const totalPages = body.totalpages || 1;

    const ticketIdSet = new Set<string>();
    let duplicatesFound = 0;
    for (const t of tickets) {
      const tid = String(t.TaxDocumentNumber || `${t.Serie}-${t.Number}`);
      if (ticketIdSet.has(tid)) duplicatesFound++;
      else ticketIdSet.add(tid);
    }

    let totalLines = 0, linesZeroPrice = 0, linesNoProductId = 0, ticketsNoLines = 0;
    for (const t of tickets) {
      const items = t.InvoiceItems || [];
      if (items.length === 0) ticketsNoLines++;
      totalLines += items.length;
      for (const item of items) {
        if (!item.idProduct) linesNoProductId++;
        if (Number(item.price || 0) === 0) linesZeroPrice++;
      }
    }

    // Check if the API returned an error message (permission denied etc.)
    const isPermissionError = !body.response && body.message && (
      String(body.message).includes("no pertenece") ||
      String(body.message).includes("not belong") ||
      String(body.message).includes("Tpv no pertenece")
    );

    probes.push({
      endpoint: `v2/sales/${tpvId}`,
      http_status: res.status,
      success: res.ok && body.response === true,
      error: (!res.ok || !body.response) ? (body.message || `HTTP ${res.status}`) : null,
      detail: {
        date_range: `${diagStart} → ${diagEnd}`,
        date_source: usingProvidedRange ? "wizard_selection" : "yesterday_fallback",
        total_pages_reported: totalPages,
        tickets_page1: tickets.length,
        unique_ticket_ids: ticketIdSet.size,
        duplicate_ticket_ids: duplicatesFound,
        total_lines_page1: totalLines,
        tickets_without_lines: ticketsNoLines,
        lines_with_zero_price: linesZeroPrice,
        lines_without_product_id: linesNoProductId,
        is_permission_error: isPermissionError || false,
      },
    });
  } catch (err) {
    probes.push({ endpoint: `v2/sales/${tpvId}`, http_status: null, success: false, error: (err as Error).message, detail: {} });
  }

  // ── Probe 3: getCategoriesByTpv ──
  try {
    const res = await fetch(`${baseUrl}/getCategoriesByTpv/${tpvId}`, { method: "GET", headers, signal: AbortSignal.timeout(10_000) });
    const body = await res.json();
    const cats = body.result || [];
    probes.push({
      endpoint: `getCategoriesByTpv/${tpvId}`,
      http_status: res.status,
      success: res.ok && body.response === true,
      error: (!res.ok || !body.response) ? (body.message || `HTTP ${res.status}`) : null,
      detail: { categories_count: cats.length, sample: cats.slice(0, 3).map((c: any) => ({ id: c.id, name: c.name })) },
    });
  } catch (err) {
    probes.push({ endpoint: `getCategoriesByTpv/${tpvId}`, http_status: null, success: false, error: (err as Error).message, detail: {} });
  }

  // ── Probe 4: getProducts (page 1 only) ──
  try {
    const res = await fetch(`${baseUrl}/getProducts/${tpvId}?pag=1`, { method: "GET", headers, signal: AbortSignal.timeout(10_000) });
    const body = await res.json();
    const prods = body.result || [];
    probes.push({
      endpoint: `getProducts/${tpvId}`,
      http_status: res.status,
      success: res.ok && body.response === true,
      error: (!res.ok || !body.response) ? (body.message || `HTTP ${res.status}`) : null,
      detail: { products_page1: prods.length, sample: prods.slice(0, 3).map((p: any) => ({ id: p.id, name: p.name })) },
    });
  } catch (err) {
    probes.push({ endpoint: `getProducts/${tpvId}`, http_status: null, success: false, error: (err as Error).message, detail: {} });
  }

  // ── Conclusion ──
  const salesProbe = probes.find((p) => p.endpoint.startsWith("v2/sales"));
  const catProbe = probes.find((p) => p.endpoint.startsWith("getCategoriesByTpv"));
  const prodProbe = probes.find((p) => p.endpoint.startsWith("getProducts"));
  const locProbe = probes.find((p) => p.endpoint === "getLocales");

  let conclusion: "valid" | "valid_no_sales_in_range" | "suspicious" | "invalid" | "wrong_tpv_mapping" | "range_too_large" = "valid";
  const warnings: string[] = [];

  const localesOk = locProbe?.success === true;
  const catOk = catProbe?.success === true;
  const prodOk = prodProbe?.success === true;
  const salesOk = salesProbe?.success === true;
  const salesPermissionError = salesProbe?.detail?.is_permission_error === true;
  const salesRangeTooLarge = !salesOk && salesProbe?.error && isRangeTooLargeError(salesProbe.error);
  const catPermissionError = catProbe && !catProbe.success && catProbe.error && (
    catProbe.error.includes("no pertenece") || catProbe.error.includes("not belong")
  );
  const prodPermissionError = prodProbe && !prodProbe.success && prodProbe.error && (
    prodProbe.error.includes("no pertenece") || prodProbe.error.includes("not belong")
  );

  // Case 0: Range too large — not a TPV problem
  if (catOk && prodOk && salesRangeTooLarge) {
    conclusion = "range_too_large";
    warnings.push(`TPV ${tpvId} is valid (categories: ✅, products: ✅) but the date range is too large for Numier. Use chunked fetch or a shorter range.`);
  }
  // Case 1: TPV-based endpoints all fail with permission errors
  else if (localesOk && (salesPermissionError || catPermissionError || prodPermissionError)) {
    if (!catOk && !prodOk) {
      conclusion = "wrong_tpv_mapping";
      const locIds = (locProbe?.detail?.location_ids || []) as string[];
      warnings.push(
        `getLocales returned location IDs [${locIds.join(", ")}] but TPV ${tpvId} is rejected. ` +
        `Set the correct idTpv in the Manual TPV Override field.`
      );
    } else if (catOk && prodOk && salesPermissionError) {
      conclusion = "wrong_tpv_mapping";
      warnings.push(`Categories and products work but sales endpoint rejects TPV ${tpvId}. Ask Numier for the correct sales idTpv.`);
    }
  }
  // Case 2: Categories & products work, sales returns 0 tickets
  else if (catOk && prodOk && salesOk && (salesProbe?.detail?.tickets_page1 as number) === 0) {
    conclusion = "valid_no_sales_in_range";
    warnings.push(`TPV ${tpvId} is valid (categories: ✅, products: ✅) but 0 sales found in range ${diagStart} → ${diagEnd}. Try a different date range.`);
  }
  // Case 3: Sales failed for non-permission reason
  else if (!salesOk && conclusion === "valid") {
    if (catOk && prodOk) {
      conclusion = "valid_no_sales_in_range";
      warnings.push(`Categories and products work but sales endpoint returned an error for ${diagStart} → ${diagEnd}: ${salesProbe?.error || "unknown"}`);
    } else {
      conclusion = "invalid";
      warnings.push(`Sales endpoint failed — TPV ${tpvId} may not be valid. Error: ${salesProbe?.error || "unknown"}`);
    }
  }

  // Additional warnings (non-blocking if cat+prod work)
  if (salesProbe?.detail?.duplicate_ticket_ids && (salesProbe.detail.duplicate_ticket_ids as number) > 0) {
    warnings.push(`${salesProbe.detail.duplicate_ticket_ids} duplicate ticket IDs found.`);
    if (conclusion === "valid") conclusion = "suspicious";
  }
  if (!catOk && conclusion !== "wrong_tpv_mapping") {
    warnings.push(`Categories endpoint failed for TPV ${tpvId}. Error: ${catProbe?.error || "unknown"}`);
    if (conclusion === "valid") conclusion = "suspicious";
  }
  if (!prodOk && conclusion !== "wrong_tpv_mapping") {
    warnings.push(`Products endpoint failed for TPV ${tpvId}. Error: ${prodProbe?.error || "unknown"}`);
    if (conclusion === "valid") conclusion = "suspicious";
  }
  if (locProbe?.success && !(locProbe.detail.tpv_id_found_in_locales as boolean) && conclusion !== "wrong_tpv_mapping") {
    warnings.push("TPV id not found in getLocales — this is normal if location_id ≠ tpv_id.");
  }

  // Persist
  const diagResult = { conclusion, warnings, probes, diagnosed_at: new Date().toISOString() };
  const updatedCfg = {
    ...cfg,
    last_diagnosis: diagResult,
    verified_capabilities: {
      ...(cfg.verified_capabilities || {}),
      tpv_diagnosis: conclusion,
    },
  };
  await sb().from("pos_connections").update({ provider_config: updatedCfg }).eq("id", connId);

  return json({
    success: true,
    tpv_id: tpvId,
    conclusion,
    warnings,
    probes,
    date_range: { start: diagStart, end: diagEnd, source: usingProvidedRange ? "wizard" : "yesterday" },
    location_ids_from_locales: locProbe?.detail?.location_ids || [],
  });
}

// ── Main router ─────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const payload = await req.json();
    const { action, connectionId } = payload;

    if (!connectionId) return json({ error: "Missing connectionId" }, 400);

    switch (action) {
      case "test":
      case "healthcheck":
        return await handleHealthcheck(connectionId);

      case "read-locations":
        return await handleReadLocations(connectionId);

      case "read-categories":
        return await handleReadCategories(connectionId);

      case "read-products":
        return await handleReadProducts(connectionId);

      case "read-sales":
      case "fetch-day": {
        const day = payload.businessDay || payload.startDate || payload.date || payload.start_date;
        if (!day) return json({ error: "Missing businessDay or startDate" }, 400);
        return await handleReadSales(connectionId, day, payload.endDate || payload.end_date, payload.manualTpvOverride);
      }

      case "save-sales": {
        const day = payload.businessDay || payload.startDate || payload.date;
        if (!day) return json({ error: "Missing businessDay or startDate" }, 400);
        return await handleSaveSales(connectionId, day, payload.endDate, payload.manualTpvOverride);
      }

      case "diagnose-tpv":
        return await handleDiagnoseTpv(connectionId, payload.tpvId || payload.selected_tpv_id, payload.startDate, payload.endDate);

      case "fetch-chunked": {
        const cs = payload.startDate || payload.businessDay;
        const ce = payload.endDate;
        if (!cs || !ce) return json({ error: "Missing startDate or endDate" }, 400);
        const chunkDays = payload.chunkDays || 7;
        return await handleReadSalesChunked(connectionId, cs, ce, chunkDays, payload.manualTpvOverride);
      }

      case "probe-sales": {
        const ps = payload.startDate || payload.businessDay;
        const pe = payload.endDate || ps;
        if (!ps) return json({ error: "Missing startDate" }, 400);
        return await handleProbeSales(connectionId, ps, pe, payload.manualTpvOverride);
      }

      case "write-catalog":
        return json({ error: "write-catalog not demonstrated for Numier", status: "NOT_DEMONSTRATED" }, 501);

      case "verify-catalog":
        return json({ error: "verify-catalog not demonstrated for Numier", status: "NOT_DEMONSTRATED" }, 501);

      default:
        return json({ error: "Unknown action", available: [
          "test", "healthcheck", "read-locations", "read-categories",
          "read-products", "read-sales", "fetch-day", "save-sales", "diagnose-tpv",
        ] }, 400);
    }
  } catch (err) {
    console.error("numier-proxy error:", err);
    return json({ error: (err as Error).message }, 500);
  }
});
