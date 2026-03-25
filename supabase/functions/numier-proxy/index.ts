import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getNumierConfig, type NumierConfig } from "../_shared/providerConfig.ts";

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

function buildAuthHeaders(cfg: NumierConfig, apiToken: string): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };

  if (cfg.auth_mode === "BASIC") {
    // apiToken stored as "user:password"
    const encoded = btoa(apiToken);
    headers["Authorization"] = `Basic ${encoded}`;
  } else {
    // Default: API_KEY — use the api_token from connection
    headers["Authorization"] = `Bearer ${apiToken}`;
  }

  return headers;
}

function resolveBaseUrl(conn: { base_url: string }, cfg: NumierConfig): string {
  const raw = cfg.api_base_url || conn.base_url || "";
  let url = raw.trim().replace(/\/+$/, "");
  if (url && !url.startsWith("http")) url = `https://${url}`;
  return url;
}

// ── Action handlers ─────────────────────────────────────────

/**
 * HEALTHCHECK — verify connectivity & auth
 * Status: IMPLEMENTED (stub — validates URL + auth header)
 *
 * When Numier API docs are available, this should hit a lightweight
 * endpoint (e.g. GET /health or GET /api/v1/status).
 */
async function handleHealthcheck(connId: string) {
  const conn = await getConnection(connId);
  const cfg = getNumierConfig(conn.provider_config);
  const baseUrl = resolveBaseUrl(conn, cfg);

  if (!baseUrl) {
    return json({ success: false, message: "No base URL configured" }, 400);
  }

  const headers = buildAuthHeaders(cfg, conn.api_token);

  try {
    // Attempt a lightweight GET; adjust path when real API is known
    const res = await fetch(`${baseUrl}/api/v1/health`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(10_000),
    });

    const body = await res.text();

    if (res.ok) {
      // Persist verified capability
      const updatedCfg = {
        ...cfg,
        verified_capabilities: { ...(cfg.verified_capabilities || {}), healthcheck: true },
      };
      await sb().from("pos_connections").update({ provider_config: updatedCfg }).eq("id", connId);

      return json({ success: true, status: res.status, message: "Numier reachable" });
    }

    return json({
      success: false,
      status: res.status,
      message: `Numier responded with ${res.status}`,
      body: body.slice(0, 500),
    });
  } catch (err) {
    return json({ success: false, message: `Connection failed: ${(err as Error).message}` }, 502);
  }
}

/**
 * READ_LOCATIONS — discover stores/locations
 * Status: STUB — returns structure, needs real endpoint
 */
async function handleReadLocations(connId: string) {
  const conn = await getConnection(connId);
  const cfg = getNumierConfig(conn.provider_config);
  const baseUrl = resolveBaseUrl(conn, cfg);
  const headers = buildAuthHeaders(cfg, conn.api_token);

  try {
    const res = await fetch(`${baseUrl}/api/v1/locations`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const body = await res.text();
      return json({ success: false, message: `Locations API error (${res.status})`, body: body.slice(0, 500) });
    }

    const data = await res.json();

    // Normalize to common shape — adapt when real response is known
    const locations: { id: string; name: string; address?: string }[] = Array.isArray(data)
      ? data.map((loc: Record<string, unknown>) => ({
          id: String(loc.id || loc.locationId || ""),
          name: String(loc.name || loc.locationName || "Unknown"),
          address: loc.address ? String(loc.address) : undefined,
        }))
      : [];

    // Persist discovered locations
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

/**
 * READ_SALES — fetch sales for a business day
 * Status: STUB — returns normalized SalesEvent structure, needs real endpoint
 *
 * Expected to return data compatible with sales_events + sales_line_items tables.
 */
async function handleReadSales(connId: string, businessDay: string) {
  const conn = await getConnection(connId);
  const cfg = getNumierConfig(conn.provider_config);
  const baseUrl = resolveBaseUrl(conn, cfg);
  const headers = buildAuthHeaders(cfg, conn.api_token);

  const locationId = cfg.location_id || "";

  try {
    // Adjust endpoint path when Numier API docs are available
    const url = `${baseUrl}/api/v1/sales?date=${businessDay}${locationId ? `&locationId=${locationId}` : ""}`;
    const res = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(30_000) });

    if (!res.ok) {
      const body = await res.text();
      return json({ success: false, message: `Sales API error (${res.status})`, body: body.slice(0, 500) });
    }

    const rawSales = await res.json();

    // ── Normalize to canonical SalesEvent shape ──
    // This mapping is a stub — adjust field names to real Numier response
    const salesEvents = (Array.isArray(rawSales) ? rawSales : rawSales?.sales || rawSales?.data || []).map(
      (sale: Record<string, unknown>) => {
        const lines = (Array.isArray(sale.lines) ? sale.lines : sale.items || sale.details || []).map(
          (line: Record<string, unknown>) => ({
            provider_product_id: String(line.productId || line.product_id || line.id || ""),
            name: String(line.productName || line.name || line.description || ""),
            format: String(line.format || line.saleFormat || "UNIT"),
            family: String(line.family || line.familyName || line.category || ""),
            quantity: Number(line.quantity || line.qty || 0),
            unit_price: Number(line.unitPrice || line.price || 0),
            total_amount: Number(line.totalAmount || line.total || 0) || Number(line.quantity || 0) * Number(line.unitPrice || line.price || 0),
            vat_rate: Number(line.vatRate || line.taxRate || line.vat || 0),
            is_wine_candidate: false, // Will be classified by wine_family_rules
          }),
        );

        return {
          provider_doc_id: String(sale.id || sale.saleId || sale.documentId || ""),
          business_day: businessDay,
          doc_type: String(sale.type || sale.docType || "Sale"),
          total_amount: Number(sale.totalAmount || sale.total || 0),
          total_tax: Number(sale.totalTax || sale.tax || 0),
          total_net: Number(sale.totalNet || sale.net || 0),
          line_count: lines.length,
          lines,
        };
      },
    );

    // Update verified capabilities
    if (salesEvents.length > 0) {
      const updatedCfg = {
        ...cfg,
        verified_capabilities: { ...(cfg.verified_capabilities || {}), read_sales: true },
      };
      await sb().from("pos_connections").update({ provider_config: updatedCfg }).eq("id", connId);
    }

    return json({ success: true, businessDay, salesEvents, count: salesEvents.length });
  } catch (err) {
    return json({ success: false, message: `Failed: ${(err as Error).message}` }, 502);
  }
}

/**
 * SAVE_SALES — persist normalized sales to DB
 * Status: IMPLEMENTED — uses same pattern as other providers
 */
async function handleSaveSales(connId: string, businessDay: string) {
  // First fetch
  const fetchRes = await handleReadSales(connId, businessDay);
  const fetchBody = await fetchRes.clone().json();

  if (!fetchBody.success) return fetchRes;

  const salesEvents = fetchBody.salesEvents || [];
  let savedEvents = 0;
  let savedLines = 0;

  for (const ev of salesEvents) {
    // Upsert sales_event
    const { data: eventRow, error: evErr } = await sb()
      .from("sales_events")
      .upsert(
        {
          connection_id: connId,
          provider_doc_id: ev.provider_doc_id,
          business_day: businessDay,
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

    // Insert lines
    for (const line of ev.lines) {
      const { error: lineErr } = await sb().from("sales_line_items").upsert(
        {
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
        },
        { onConflict: "sales_event_id,provider_product_id" },
      );
      if (!lineErr) savedLines++;
    }
  }

  // Update last sync
  await sb().from("pos_connections").update({
    last_sync_at: new Date().toISOString(),
    last_business_day_synced: businessDay,
  }).eq("id", connId);

  return json({ success: true, savedEvents, savedLines, businessDay });
}

/**
 * TEST — alias for healthcheck, used by wizard step 1
 */
async function handleTest(connId: string) {
  return handleHealthcheck(connId);
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
        return await handleTest(connectionId);

      case "read-locations":
        return await handleReadLocations(connectionId);

      case "read-sales":
      case "fetch-day": {
        const day = payload.businessDay || payload.date;
        if (!day) return json({ error: "Missing businessDay" }, 400);
        return await handleReadSales(connectionId, day);
      }

      case "save-sales": {
        const day = payload.businessDay || payload.date;
        if (!day) return json({ error: "Missing businessDay" }, 400);
        return await handleSaveSales(connectionId, day);
      }

      // ── Future stubs (not implemented yet) ──
      case "read-catalog":
        return json({ error: "read-catalog not implemented yet", status: "STUB" }, 501);

      case "write-catalog":
        return json({ error: "write-catalog not implemented yet", status: "STUB" }, 501);

      case "verify-catalog":
        return json({ error: "verify-catalog not implemented yet", status: "STUB" }, 501);

      default:
        return json({ error: "Unknown action", available: [
          "test", "healthcheck", "read-locations", "read-sales", "fetch-day",
          "save-sales", "read-catalog (stub)", "write-catalog (stub)", "verify-catalog (stub)",
        ] }, 400);
    }
  } catch (err) {
    console.error("numier-proxy error:", err);
    return json({ error: (err as Error).message }, 500);
  }
});
