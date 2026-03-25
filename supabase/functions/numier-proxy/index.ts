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

function resolveTpvId(cfg: NumierConfig): { tpvId: string | null; source: "selected" | "fallback_single" | "none"; locationCount: number } {
  const locs = cfg.discovered_locations || [];
  if (cfg.selected_tpv_id) return { tpvId: cfg.selected_tpv_id, source: "selected", locationCount: locs.length };
  // Fallback ONLY if exactly one location discovered
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

async function handleReadSales(connId: string, businessDay: string, endDate?: string) {
  const conn = await getConnection(connId);
  const cfg = getNumierConfig(conn.provider_config);
  const baseUrl = resolveBaseUrl(conn, cfg);
  const headers = buildHeaders(conn.api_token);

  const { tpvId, source, locationCount } = resolveTpvId(cfg);
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

      allTickets.push(...(data.result || []));
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
      tpvId,
      tpvSource: source,
      salesEvents,
      count: salesEvents.length,
      totalPages,
      ticketsFetched: allTickets.length,
    });
  } catch (err) {
    return json({ success: false, message: `Failed: ${(err as Error).message}` }, 502);
  }
}

/**
 * SAVE_SALES — persist normalized sales to DB.
 * Uses deterministic line_key to avoid collisions between lines of the same product
 * within the same ticket, while keeping idempotency across re-runs.
 */
async function handleSaveSales(connId: string, businessDay: string, endDate?: string) {
  const fetchRes = await handleReadSales(connId, businessDay, endDate);
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

    // Delete existing lines for this event, then insert fresh.
    // This avoids collision issues from onConflict on non-unique combos.
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

  await sb().from("pos_connections").update({
    last_sync_at: new Date().toISOString(),
    last_business_day_synced: businessDay,
  }).eq("id", connId);

  return json({ success: true, savedEvents, savedLines, businessDay });
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
        const day = payload.businessDay || payload.date || payload.start_date;
        if (!day) return json({ error: "Missing businessDay" }, 400);
        return await handleReadSales(connectionId, day, payload.endDate || payload.end_date);
      }

      case "save-sales": {
        const day = payload.businessDay || payload.date;
        if (!day) return json({ error: "Missing businessDay" }, 400);
        return await handleSaveSales(connectionId, day, payload.endDate);
      }

      case "write-catalog":
        return json({ error: "write-catalog not demonstrated for Numier", status: "NOT_DEMONSTRATED" }, 501);

      case "verify-catalog":
        return json({ error: "verify-catalog not demonstrated for Numier", status: "NOT_DEMONSTRATED" }, 501);

      default:
        return json({ error: "Unknown action", available: [
          "test", "healthcheck", "read-locations", "read-categories",
          "read-products", "read-sales", "fetch-day", "save-sales",
        ] }, 400);
    }
  } catch (err) {
    console.error("numier-proxy error:", err);
    return json({ error: (err as Error).message }, 500);
  }
});
