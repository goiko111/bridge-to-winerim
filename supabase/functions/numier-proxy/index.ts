import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getNumierConfig, type NumierConfig } from "../_shared/providerConfig.ts";

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
    "API-KEY": apiKey,
  };
}

function resolveBaseUrl(conn: { base_url: string }, cfg: NumierConfig): string {
  const raw = cfg.api_base_url || conn.base_url || "";
  if (!raw || raw === NUMIER_BASE) return NUMIER_BASE;
  let url = raw.trim().replace(/\/+$/, "");
  if (url && !url.startsWith("http")) url = `https://${url}`;
  return url;
}

function resolveTpvId(cfg: NumierConfig, manualOverride?: string): { tpvId: string | null; source: "manual_override" | "selected" | "fallback_single" | "none"; locationCount: number } {
  if (manualOverride) return { tpvId: manualOverride, source: "manual_override", locationCount: (cfg.discovered_locations || []).length };
  const locs = cfg.discovered_locations || [];
  if (cfg.selected_tpv_id) return { tpvId: cfg.selected_tpv_id, source: "selected", locationCount: locs.length };
  if (locs.length === 1 && locs[0]?.id) return { tpvId: locs[0].id, source: "fallback_single", locationCount: 1 };
  return { tpvId: null, source: "none", locationCount: locs.length };
}

// ── Action handlers ─────────────────────────────────────────

async function handleHealthcheck(connId: string) {
  const conn = await getConnection(connId);
  const cfg = getNumierConfig(conn.provider_config);
  const baseUrl = resolveBaseUrl(conn, cfg);
  const headers = buildHeaders(conn.api_token);

  try {
    const res = await fetch(`${baseUrl}/getLocales`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(10_000),
    });

    const body = await res.json();

    if (res.ok && body.response === true) {
      const updatedCfg = {
        ...cfg,
        verified_capabilities: { ...(cfg.verified_capabilities || {}), healthcheck: true },
      };
      await sb().from("pos_connections").update({ provider_config: updatedCfg }).eq("id", connId);

      return json({
        success: true,
        status: res.status,
        message: "Numier reachable",
        localesCount: body.result?.length || 0,
      });
    }

    return json({
      success: false,
      status: res.status,
      message: body.message || `Numier responded with ${res.status}`,
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

  try {
    const allTickets: Record<string, unknown>[] = [];
    const allTicketIds = new Set<string>();
    let duplicateCount = 0;
    let page = 1;
    let totalPages = 1;

    do {
      const url = `${baseUrl}/v2/sales/${tpvId}?start_date=${startDate}&end_date=${end}&pag=${page}`;
      console.log(`[numier] Fetching sales page ${page}: ${url}`);

      const res = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(30_000) });

      if (!res.ok) {
        const body = await res.text();
        return json({ success: false, message: `Sales API error (${res.status})`, body: body.slice(0, 500) });
      }

      const data = await res.json();

      if (!data.response) {
        return json({ success: false, message: data.message || "API returned response=false" });
      }

      const pageTickets = data.result || [];
      for (const t of pageTickets) {
        const tid = String(t.TaxDocumentNumber || `${t.Serie}-${t.Number}`);
        if (allTicketIds.has(tid)) {
          duplicateCount++;
        } else {
          allTicketIds.add(tid);
        }
      }
      allTickets.push(...pageTickets);
      totalPages = data.totalpages || 1;
      page++;
    } while (page <= totalPages);

    // ── Normalize to canonical SalesEvent shape ──
    const salesEvents = allTickets.map((ticket) => {
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
        business_day: String(ticket.BusinessDay || businessDay),
        doc_type: String(ticket.DocumentType || "FS"),
        total_amount: Number(totals.GrossAmount || 0),
        total_tax: Number(totals.VatAmount || 0),
        total_net: Number(totals.NetAmount || 0),
        line_count: lines.length,
        lines,
      };
    });

    // ── Pagination & normalization metrics ──
    const ticketsWithNoLines = salesEvents.filter((e) => e.line_count === 0).length;
    const allLines = salesEvents.flatMap((e) => e.lines);
    const linesWithZeroPrice = allLines.filter((l) => l.unit_price === 0).length;
    const linesWithoutProductId = allLines.filter((l) => !l.provider_product_id).length;
    const businessDays = [...new Set(salesEvents.map((e) => e.business_day))].sort();

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
      // Pagination metrics
      pagination: {
        pages_read: totalPages,
        tickets_seen: allTickets.length,
        unique_ticket_ids: allTicketIds.size,
        duplicate_ticket_ids_count: duplicateCount,
      },
      // Normalization metrics
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
    });
  } catch (err) {
    return json({ success: false, message: `Failed: ${(err as Error).message}` }, 502);
  }
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

// ── Diagnose TPV ────────────────────────────────────────────
// Validates that a given TPV id actually works for sales, categories and products endpoints.

interface DiagnoseProbe {
  endpoint: string;
  http_status: number | null;
  success: boolean;
  error: string | null;
  detail: Record<string, unknown>;
}

async function handleDiagnoseTpv(connId: string, overrideTpvId?: string) {
  const conn = await getConnection(connId);
  const cfg = getNumierConfig(conn.provider_config);
  const baseUrl = resolveBaseUrl(conn, cfg);
  const headers = buildHeaders(conn.api_token);

  const tpvId = overrideTpvId || cfg.selected_tpv_id;
  if (!tpvId) {
    return json({ success: false, message: "No TPV id provided for diagnosis." }, 400);
  }

  // Yesterday as a safe short range
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const diagDay = yesterday.toISOString().slice(0, 10);

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

  // ── Probe 2: v2/sales/{idTpv} (1 day, page 1) ──
  try {
    const url = `${baseUrl}/v2/sales/${tpvId}?start_date=${diagDay}&end_date=${diagDay}&pag=1`;
    const res = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(15_000) });
    const body = await res.json();
    const tickets = body.result || [];
    const totalPages = body.totalpages || 1;

    // Pagination integrity: read ALL pages and check for duplicates
    const allTicketIds: string[] = [];
    const ticketIdSet = new Set<string>();
    let duplicatesFound = 0;
    let pagesRead = 1;

    for (const t of tickets) {
      const tid = String(t.TaxDocumentNumber || `${t.Serie}-${t.Number}`);
      if (ticketIdSet.has(tid)) duplicatesFound++;
      else ticketIdSet.add(tid);
      allTicketIds.push(tid);
    }

    // Read remaining pages if any
    if (totalPages > 1) {
      for (let p = 2; p <= Math.min(totalPages, 5); p++) {
        try {
          const pageUrl = `${baseUrl}/v2/sales/${tpvId}?start_date=${diagDay}&end_date=${diagDay}&pag=${p}`;
          const pageRes = await fetch(pageUrl, { method: "GET", headers, signal: AbortSignal.timeout(15_000) });
          const pageBody = await pageRes.json();
          pagesRead++;
          for (const t of (pageBody.result || [])) {
            const tid = String(t.TaxDocumentNumber || `${t.Serie}-${t.Number}`);
            if (ticketIdSet.has(tid)) duplicatesFound++;
            else ticketIdSet.add(tid);
            allTicketIds.push(tid);
          }
        } catch (_e) {
          // swallow page errors — report what we got
        }
      }
    }

    // Line-level analysis on first page tickets
    let totalLines = 0;
    let linesZeroPrice = 0;
    let linesNoProductId = 0;
    let ticketsNoLines = 0;
    for (const t of tickets) {
      const items = t.InvoiceItems || [];
      if (items.length === 0) ticketsNoLines++;
      totalLines += items.length;
      for (const item of items) {
        if (!item.idProduct) linesNoProductId++;
        if (Number(item.price || 0) === 0) linesZeroPrice++;
      }
    }

    probes.push({
      endpoint: `v2/sales/${tpvId}`,
      http_status: res.status,
      success: res.ok && body.response === true,
      error: (!res.ok || !body.response) ? (body.message || `HTTP ${res.status}`) : null,
      detail: {
        date_queried: diagDay,
        total_pages_reported: totalPages,
        pages_read: pagesRead,
        tickets_page1: tickets.length,
        tickets_all_pages: allTicketIds.length,
        unique_ticket_ids: ticketIdSet.size,
        duplicate_ticket_ids: duplicatesFound,
        // Line-level (page 1 only for speed)
        total_lines_page1: totalLines,
        tickets_without_lines: ticketsNoLines,
        lines_with_zero_price: linesZeroPrice,
        lines_without_product_id: linesNoProductId,
        sample_ticket_id: allTicketIds[0] || null,
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

  let conclusion: "valid" | "suspicious" | "invalid" = "valid";
  const warnings: string[] = [];

  if (!salesProbe?.success) {
    conclusion = "invalid";
    warnings.push("Sales endpoint failed — this TPV id may not be valid for /v2/sales.");
  }
  if (salesProbe?.success && (salesProbe.detail.tickets_page1 as number) === 0) {
    warnings.push("Sales returned 0 tickets for yesterday. Possibly no sales or wrong TPV.");
    if (conclusion === "valid") conclusion = "suspicious";
  }
  if (salesProbe?.detail.duplicate_ticket_ids && (salesProbe.detail.duplicate_ticket_ids as number) > 0) {
    warnings.push(`${salesProbe.detail.duplicate_ticket_ids} duplicate ticket IDs found across pages.`);
    if (conclusion === "valid") conclusion = "suspicious";
  }
  if (!catProbe?.success) {
    warnings.push("Categories endpoint failed for this TPV id.");
    if (conclusion === "valid") conclusion = "suspicious";
  }
  if (!prodProbe?.success) {
    warnings.push("Products endpoint failed for this TPV id.");
    if (conclusion === "valid") conclusion = "suspicious";
  }
  if (locProbe?.success && !(locProbe.detail.tpv_id_found_in_locales as boolean)) {
    warnings.push("Selected TPV id was NOT found in getLocales results.");
    if (conclusion === "valid") conclusion = "suspicious";
  }

  // Persist diagnosis result
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
        return await handleDiagnoseTpv(connectionId, payload.tpvId || payload.selected_tpv_id);

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
