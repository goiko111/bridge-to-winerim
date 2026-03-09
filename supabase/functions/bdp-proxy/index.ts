import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getBdpConfig, type BdpEndpointRecord } from "../_shared/providerConfig.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function ok(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
function err(body: unknown, status = 400) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/** Build auth headers for BDP */
function bdpHeaders(userKey: string, password: string): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (userKey && password) {
    h["Authorization"] = `Basic ${btoa(`${userKey}:${password}`)}`;
  }
  return h;
}

/** Fetch with 30s timeout and optional retry with backoff */
async function bdpFetch(url: string, headers: Record<string, string>, method = "GET", body?: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const opts: RequestInit = { method, headers, signal: controller.signal };
    if (body) opts.body = body;
    const resp = await fetch(url, opts);
    clearTimeout(timeout);
    return resp;
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

/** Fetch with retry + exponential backoff (for discovery probes) */
async function bdpFetchWithRetry(
  url: string, headers: Record<string, string>, method = "GET",
  { retries = 2, baseDelayMs = 1000 } = {},
): Promise<{ resp: Response | null; attempts: number; lastError?: string }> {
  let lastError = "";
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      const resp = await bdpFetch(url, headers, method);
      // Retry on 502/503/504
      if ((resp.status === 502 || resp.status === 503 || resp.status === 504) && attempt <= retries) {
        lastError = `HTTP ${resp.status}`;
        await new Promise((r) => setTimeout(r, baseDelayMs * Math.pow(2, attempt - 1)));
        continue;
      }
      return { resp, attempts: attempt };
    } catch (e: any) {
      lastError = e.message || "Network error";
      if (attempt <= retries) {
        await new Promise((r) => setTimeout(r, baseDelayMs * Math.pow(2, attempt - 1)));
        continue;
      }
    }
  }
  return { resp: null, attempts: retries + 1, lastError };
}

/**
 * Parse BDP export documents into canonical SalesEvent + LineItems.
 * BDP Weblink REST returns an array of "documents", each with header, lines, payments.
 * We normalise into our canonical schema.
 */
interface BdpLine {
  line_index: number;
  provider_product_id: string;
  name: string;
  family: string | null;
  format: string | null;
  quantity: number;
  unit_price: number;
  total_amount: number;
  vat_rate: number;
}

interface CanonicalEvent {
  provider_doc_id: string;
  business_day: string; // closure day (YYYY-MM-DD)
  ticket_time: string | null; // actual ticket timestamp
  doc_type: string;
  total_amount: number;
  total_tax: number;
  total_net: number;
  line_count: number;
  lines: BdpLine[];
  raw_json: unknown;
}

function parseBdpDocuments(rawDocuments: any[]): CanonicalEvent[] {
  const events: CanonicalEvent[] = [];

  for (const doc of rawDocuments) {
    const header = doc.header || doc.Header || doc;
    const lines = doc.lines || doc.Lines || doc.details || doc.Details || [];
    const payments = doc.payments || doc.Payments || [];

    // BDP may use "ClosureDate" or "BusinessDay" for the closure day
    // and "Date" or "TicketDate" for the actual ticket time
    const closureDay = header.ClosureDate || header.closure_date || header.BusinessDay || header.business_day || null;
    const ticketTime = header.Date || header.date || header.TicketDate || header.ticket_date || null;

    // Derive business_day: prefer closure day, fall back to ticket date
    let businessDay = "";
    if (closureDay) {
      businessDay = String(closureDay).substring(0, 10);
    } else if (ticketTime) {
      businessDay = String(ticketTime).substring(0, 10);
    } else {
      businessDay = new Date().toISOString().substring(0, 10);
    }

    const docId = String(
      header.DocumentId || header.document_id || header.Id || header.id || header.Number || header.number || `bdp_${Date.now()}_${Math.random()}`
    );
    const docType = header.DocumentType || header.document_type || header.Type || header.type || "Sale";

    // Parse lines
    const parsedLines: BdpLine[] = [];
    let totalAmount = 0;
    let totalTax = 0;

    lines.forEach((line: any, idx: number) => {
      const qty = Number(line.Quantity || line.quantity || line.Qty || line.qty || 1);
      const unitPrice = Number(line.UnitPrice || line.unit_price || line.Price || line.price || 0);
      const lineTotal = Number(line.TotalAmount || line.total_amount || line.Total || line.total || qty * unitPrice);
      const vatRate = Number(line.VatRate || line.vat_rate || line.Tax || line.tax || 0);
      const lineTax = vatRate > 0 ? lineTotal - lineTotal / (1 + vatRate / 100) : 0;

      totalAmount += lineTotal;
      totalTax += lineTax;

      parsedLines.push({
        line_index: idx,
        provider_product_id: String(line.ProductId || line.product_id || line.ArticleId || line.article_id || `line_${idx}`),
        name: String(line.ProductName || line.product_name || line.Description || line.description || line.Name || line.name || "Unknown"),
        family: line.Family || line.family || line.Category || line.category || null,
        format: line.Format || line.format || line.Unit || line.unit || null,
        quantity: qty,
        unit_price: unitPrice,
        total_amount: lineTotal,
        vat_rate: vatRate,
      });
    });

    // Override totals if header has them
    const hdrTotal = Number(header.TotalAmount || header.total_amount || header.Total || header.total || totalAmount);
    const hdrTax = Number(header.TotalTax || header.total_tax || header.Tax || header.tax || totalTax);
    const hdrNet = Number(header.TotalNet || header.total_net || header.Net || header.net || hdrTotal - hdrTax);

    events.push({
      provider_doc_id: docId,
      business_day: businessDay,
      ticket_time: ticketTime ? String(ticketTime) : null,
      doc_type: docType,
      total_amount: hdrTotal,
      total_tax: hdrTax,
      total_net: hdrNet,
      line_count: parsedLines.length,
      lines: parsedLines,
      raw_json: doc,
    });
  }

  return events;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const payload = await req.json();
    const { action, connectionId } = payload;

    if (!connectionId) {
      return err({ success: false, message: "Missing connectionId" });
    }

    // Load connection
    const { data: conn, error: connErr } = await supabase
      .from("pos_connections")
      .select("*")
      .eq("id", connectionId)
      .single();

    if (connErr || !conn) {
      return err({ success: false, message: "Connection not found" }, 404);
    }

    const config = getBdpConfig(conn.provider_config);
    const baseUrl = (conn.base_url || "").replace(/\/+$/, "");
    const port = config.port ? String(config.port) : "";
    const userKey = config.user_key ? String(config.user_key) : "";
    const password = config.password ? String(config.password) : "";
    const exportProfileCode = config.export_profile_code ? String(config.export_profile_code) : "";
    const host = port ? `${baseUrl}:${port}` : baseUrl;
    const headers = bdpHeaders(userKey, password);

    // ── Persisted endpoint resolution ──
    const persistedEndpoints = config.discovered_endpoints || {};

    /** Resolve a URL: use persisted endpoint if available, otherwise default path */
    function resolveUrl(role: string, defaultPath: string): string {
      // Find the best persisted endpoint for this role
      for (const [, ep] of Object.entries(persistedEndpoints)) {
        if (ep.role === role && ep.path && ep.last_success_at) {
          return `${host}${ep.path}`;
        }
      }
      return `${host}${defaultPath}`;
    }

    /** Track endpoint success/error in config and persist */
    async function trackEndpoint(
      key: string, role: "auth" | "sales" | "catalog" | "write",
      path: string, resp: Response | null, errorMsg?: string,
    ) {
      const record: BdpEndpointRecord = persistedEndpoints[key] || { path, role };
      record.path = path;
      record.role = role;
      if (resp && resp.ok) {
        record.last_success_at = new Date().toISOString();
        record.last_success_status = resp.status;
      } else {
        record.last_error_at = new Date().toISOString();
        record.last_error_status = resp?.status || 0;
        if (errorMsg) record.last_error_body = errorMsg.substring(0, 2048);
      }
      persistedEndpoints[key] = record;
      // Persist back to provider_config (non-blocking)
      const updatedConfig = { ...config, discovered_endpoints: persistedEndpoints };
      supabase.from("pos_connections").update({ provider_config: updatedConfig }).eq("id", connectionId)
        .then(() => {});
    }

    // ── ACTION: test ──
    if (action === "test") {
      try {
        const testUrl = `${host}/api/v1/status`;
        const resp = await bdpFetch(testUrl, headers);
        const bodyText = await resp.text();
        return ok({
          success: resp.ok,
          status: resp.status,
          statusText: resp.statusText,
          contentType: resp.headers.get("content-type") || "unknown",
          bodyPreview: bodyText.substring(0, 2048),
          message: resp.ok ? "Connection successful" : `HTTP ${resp.status}: ${resp.statusText}`,
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Unknown error";
        return ok({
          success: false, status: 0, statusText: "Network Error",
          contentType: null, bodyPreview: null,
          message: msg.includes("abort") ? "Connection timed out (30s)" : msg,
        });
      }
    }

    // ── ACTION: discover ──
    // Probe endpoints with retry/backoff. Persist discovered routes per connection.
    if (action === "discover") {
      const today = new Date().toISOString().substring(0, 10);
      const endpoints = [
        { key: "auth",        label: "Auth / Status",   path: "/api/v1/status",      critical: true,  role: "auth" },
        { key: "articles",    label: "Catalog (Articles)", path: "/api/v1/articles",  critical: false, role: "catalog" },
        { key: "departments", label: "Departments",     path: "/api/v1/departments",  critical: false, role: "catalog" },
        { key: "export",      label: "Sales Export",    path: `/api/v1/export/${encodeURIComponent(exportProfileCode || "WEBLINK")}?dateFrom=${today}&dateTo=${today}`, critical: true, role: "sales" },
      ];

      const importCode = config.import_profile_code ? String(config.import_profile_code) : "";
      if (importCode) {
        endpoints.push({ key: "import", label: "Write (Import)", path: `/api/v1/import/${encodeURIComponent(importCode)}`, critical: false, role: "write" });
      }

      // Also probe direct write via PUT/POST articles
      endpoints.push({ key: "articles_write", label: "Write (REST)", path: "/api/v1/articles", critical: false, role: "write" });

      const results: Record<string, {
        ok: boolean; status: number; critical: boolean; role: string;
        label: string; path: string; bodyPreview?: string;
        attempts: number; lastError?: string;
      }> = {};

      // Probe all endpoints with retry
      for (const ep of endpoints) {
        const fullUrl = `${host}${ep.path}`;
        const { resp, attempts, lastError } = await bdpFetchWithRetry(fullUrl, headers, "GET", { retries: 2, baseDelayMs: 1500 });
        if (resp) {
          const body = await resp.text();
          const isOk = resp.ok || resp.status === 405; // 405 = method not allowed but endpoint exists
          results[ep.key] = {
            ok: isOk, status: resp.status, critical: ep.critical, role: ep.role,
            label: ep.label, path: ep.path,
            bodyPreview: isOk ? undefined : body.substring(0, 1024), // Only show body on failures
            attempts,
          };
        } else {
          results[ep.key] = {
            ok: false, status: 0, critical: ep.critical, role: ep.role,
            label: ep.label, path: ep.path,
            bodyPreview: undefined, attempts, lastError,
          };
        }
      }

      const canReadSales = results.export?.ok ?? false;
      const canReadCatalog = results.articles?.ok ?? false;
      const canWriteImport = importCode ? (results.import?.ok ?? false) : false;
      const canWriteRest = results.articles_write?.ok ?? false;
      const canWrite = canWriteImport || canWriteRest;
      const allCriticalPass = Object.values(results).filter(r => r.critical).every(r => r.ok);

      const writeMode = canWriteImport ? "IMPORT_PROFILE" : (canWriteRest ? "REST" : "NONE");

      // Build persisted endpoint records with rich metadata
      const discoveredEndpoints: Record<string, BdpEndpointRecord> = {};
      for (const [key, val] of Object.entries(results)) {
        const ep: BdpEndpointRecord = {
          path: val.path,
          role: val.role as BdpEndpointRecord["role"],
          verified_at: new Date().toISOString(),
        };
        if (val.ok) {
          ep.last_success_at = new Date().toISOString();
          ep.last_success_status = val.status;
        } else {
          ep.last_error_at = new Date().toISOString();
          ep.last_error_status = val.status;
          ep.last_error_body = (val.bodyPreview || val.lastError || "").substring(0, 2048);
        }
        discoveredEndpoints[key] = ep;
      }

      // Persist to provider_config
      const updatedConfig = {
        ...config,
        discovered_endpoints: discoveredEndpoints,
        last_discovery_at: new Date().toISOString(),
        // Keep legacy for backward compat
        discovered_routes: Object.fromEntries(
          Object.entries(discoveredEndpoints)
            .filter(([, v]) => v.last_success_at)
            .map(([k, v]) => [k, { path: v.path, status: v.last_success_status, verified_at: v.verified_at }])
        ),
      };
      await supabase.from("pos_connections").update({ provider_config: updatedConfig }).eq("id", connectionId);

      // Upsert provider_capabilities
      const writeEndpointsJson: Record<string, unknown> = {};
      if (canWriteImport) writeEndpointsJson.import = { path: `/api/v1/import/${encodeURIComponent(importCode)}`, mode: "IMPORT_PROFILE" };
      if (canWriteRest) writeEndpointsJson.rest = { path: "/api/v1/articles", mode: "REST" };

      await supabase.from("provider_capabilities").upsert({
        connection_id: connectionId,
        provider: "BDP_NET",
        can_read_sales: canReadSales,
        can_read_catalog: canReadCatalog,
        can_write_products: canWrite ? "YES" : "NO",
        write_mode: writeMode,
        write_endpoints_json: writeEndpointsJson,
        webhook_supported: false,
        readiness_status: allCriticalPass ? "CONNECTED" : "PARTIAL",
        last_checked_at: new Date().toISOString(),
      } as any, { onConflict: "connection_id" });

      return ok({
        success: allCriticalPass,
        endpoints: results,
        discoveredEndpoints,
        capabilities: { canReadSales, canReadCatalog, canWrite, writeMode },
      });
    }

    // ── ACTION: verify-product-v2 ──
    // Returns shared PostWriteVerificationResult contract
    if (action === "verify-product-v2") {
      const { productId } = payload;
      if (!productId) return err({ success: false, message: "Missing productId" });

      const errors: { code: string; message: string; field?: string }[] = [];
      const warnings: { code: string; message: string; field?: string }[] = [];
      let exists = false;
      let priceValid = false;

      try {
        // Try direct article fetch
        let product: any = null;
        const verifyUrl = `${host}/api/v1/articles/${encodeURIComponent(productId)}`;
        const resp = await bdpFetch(verifyUrl, headers);

        if (resp.ok) {
          product = JSON.parse(await resp.text());
        } else {
          // Fallback: list all
          const allResp = await bdpFetch(`${host}/api/v1/articles`, headers);
          if (allResp.ok) {
            const all = JSON.parse(await allResp.text());
            const arr = Array.isArray(all) ? all : (all.articles || all.Articles || all.data || []);
            product = arr.find((p: any) => String(p.Id || p.id || p.Code || p.code) === String(productId));
          }
        }

        if (!product) {
          errors.push({ code: "NOT_FOUND", message: `Product ${productId} not found in BDP` });
        } else {
          exists = true;
          const price = Number(product.Price || product.price || product.SalePrice || product.sale_price || product.PVP || 0);
          if (price > 0) {
            priceValid = true;
          } else {
            errors.push({ code: "PRICE_ZERO", message: "Price is 0 or missing", field: "price" });
          }
        }

        return ok({
          success: exists && priceValid,
          verified_exists: exists,
          verified_prices: priceValid,
          verified_scope: true,
          errors,
          warnings,
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Unknown error";
        return ok({
          success: false, verified_exists: false, verified_prices: false, verified_scope: true,
          errors: [{ code: "NETWORK_ERROR", message: msg }], warnings: [],
        });
      }
    }

    // ── ACTION: test-custom ──
    if (action === "test-custom") {
      const { path, method: httpMethod } = payload;
      const testUrl = `${host}${path || "/"}`;
      try {
        const resp = await bdpFetch(testUrl, headers, (httpMethod || "GET").toUpperCase());
        const bodyText = await resp.text();
        return ok({
          success: resp.ok, status: resp.status, statusText: resp.statusText,
          contentType: resp.headers.get("content-type") || "unknown",
          bodyPreview: bodyText.substring(0, 2048), url: testUrl,
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Unknown error";
        return ok({
          success: false, status: 0, url: testUrl,
          message: msg.includes("abort") ? "Connection timed out (30s)" : msg,
        });
      }
    }

    // ── ACTION: fetch-sales ──
    // Fetch documents for a given day (or date range) from BDP export endpoint
    if (action === "fetch-sales") {
      const { businessDay, dateFrom, dateTo } = payload;
      const from = dateFrom || businessDay;
      const to = dateTo || businessDay;

      if (!from) {
        return err({ success: false, message: "Missing businessDay or dateFrom" });
      }

      try {
        const defaultSalesPath = `/api/v1/export/${encodeURIComponent(exportProfileCode)}`;
        const salesBase = resolveUrl("sales", defaultSalesPath);
        const exportUrl = `${salesBase}?dateFrom=${from}&dateTo=${to}`;
        const resp = await bdpFetch(exportUrl, headers);
        const bodyText = await resp.text();
        await trackEndpoint("export", "sales", defaultSalesPath, resp, resp.ok ? undefined : bodyText);

        if (!resp.ok) {
          return ok({
            success: false,
            message: `BDP returned HTTP ${resp.status}: ${resp.statusText}`,
            bodyPreview: bodyText.substring(0, 2048),
          });
        }

        // Parse response — BDP may return JSON array or wrapped object
        let rawDocuments: any[];
        try {
          const parsed = JSON.parse(bodyText);
          rawDocuments = Array.isArray(parsed) ? parsed : (parsed.documents || parsed.Documents || parsed.data || parsed.Data || [parsed]);
        } catch {
          return ok({
            success: false,
            message: "BDP response is not valid JSON",
            bodyPreview: bodyText.substring(0, 2048),
          });
        }

        const salesEvents = parseBdpDocuments(rawDocuments);

        return ok({
          success: true,
          salesEvents,
          totalDocuments: rawDocuments.length,
          totalParsedEvents: salesEvents.length,
          dateRange: { from, to },
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Unknown error";
        return ok({ success: false, message: msg.includes("abort") ? "Request timed out (30s)" : msg });
      }
    }

    // ── ACTION: save-sales ──
    // Fetch + parse + upsert into sales_events and sales_line_items with idempotency
    if (action === "save-sales") {
      const { businessDay, dateFrom, dateTo } = payload;
      const from = dateFrom || businessDay;
      const to = dateTo || businessDay;

      if (!from) {
        return err({ success: false, message: "Missing businessDay or dateFrom" });
      }

      try {
        const defaultSalesPath = `/api/v1/export/${encodeURIComponent(exportProfileCode)}`;
        const salesBase = resolveUrl("sales", defaultSalesPath);
        const exportUrl = `${salesBase}?dateFrom=${from}&dateTo=${to}`;
        const resp = await bdpFetch(exportUrl, headers);
        const bodyText = await resp.text();
        await trackEndpoint("export", "sales", defaultSalesPath, resp, resp.ok ? undefined : bodyText);

        if (!resp.ok) {
          return ok({ success: false, message: `BDP HTTP ${resp.status}` });
        }

        let rawDocuments: any[];
        try {
          const parsed = JSON.parse(bodyText);
          rawDocuments = Array.isArray(parsed) ? parsed : (parsed.documents || parsed.Documents || parsed.data || parsed.Data || [parsed]);
        } catch {
          return ok({ success: false, message: "Invalid JSON from BDP" });
        }

        const salesEvents = parseBdpDocuments(rawDocuments);
        let savedEvents = 0;
        let savedLines = 0;
        const errors: string[] = [];

        for (const evt of salesEvents) {
          // Idempotency key: provider_doc_id + connection_id
          const idempotencyId = `bdp_${evt.provider_doc_id}`;

          // Upsert sales_event
          const { data: eventRow, error: evtErr } = await supabase
            .from("sales_events")
            .upsert(
              {
                connection_id: connectionId,
                provider_doc_id: idempotencyId,
                business_day: evt.business_day,
                doc_type: evt.doc_type,
                total_amount: evt.total_amount,
                total_tax: evt.total_tax,
                total_net: evt.total_net,
                line_count: evt.line_count,
                raw_json: evt.raw_json,
              },
              { onConflict: "connection_id,provider_doc_id" }
            )
            .select("id")
            .single();

          if (evtErr) {
            errors.push(`Event ${evt.provider_doc_id}: ${evtErr.message}`);
            continue;
          }
          savedEvents++;

          // Upsert line items with idempotency key: provider_doc_id + line_index
          for (const line of evt.lines) {
            const lineProviderId = `${idempotencyId}_L${line.line_index}`;

            const { error: lineErr } = await supabase
              .from("sales_line_items")
              .upsert(
                {
                  sales_event_id: eventRow.id,
                  connection_id: connectionId,
                  provider_product_id: lineProviderId,
                  name: line.name,
                  family: line.family,
                  format: line.format,
                  quantity: line.quantity,
                  unit_price: line.unit_price,
                  total_amount: line.total_amount,
                  vat_rate: line.vat_rate,
                  is_wine_candidate: false,
                  mapped: false,
                },
                { onConflict: "sales_event_id,provider_product_id" }
              );

            if (lineErr) {
              errors.push(`Line ${lineProviderId}: ${lineErr.message}`);
            } else {
              savedLines++;
            }
          }
        }

        // Update last sync timestamp
        await supabase
          .from("pos_connections")
          .update({ last_sync_at: new Date().toISOString(), last_business_day_synced: to })
          .eq("id", connectionId);

        return ok({ success: true, savedEvents, savedLines, totalParsed: salesEvents.length, errors });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Unknown error";
        return ok({ success: false, message: msg });
      }
    }

    // ── ACTION: backfill ──
    // Save sales for last N days
    if (action === "backfill") {
      const daysBack = Number(payload.daysBack || 30);
      let totalSaved = 0;
      let totalLines = 0;
      const errors: string[] = [];

      for (let i = 0; i < daysBack; i++) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const day = d.toISOString().substring(0, 10);

        try {
          const defaultSalesPath = `/api/v1/export/${encodeURIComponent(exportProfileCode)}`;
          const salesBase = resolveUrl("sales", defaultSalesPath);
          const exportUrl = `${salesBase}?dateFrom=${day}&dateTo=${day}`;
          const resp = await bdpFetch(exportUrl, headers);

          if (!resp.ok) {
            errors.push(`${day}: HTTP ${resp.status}`);
            continue;
          }

          const bodyText = await resp.text();
          let rawDocuments: any[];
          try {
            const parsed = JSON.parse(bodyText);
            rawDocuments = Array.isArray(parsed) ? parsed : (parsed.documents || parsed.Documents || parsed.data || parsed.Data || [parsed]);
          } catch {
            errors.push(`${day}: Invalid JSON`);
            continue;
          }

          // Skip empty days
          if (rawDocuments.length === 0) continue;

          const salesEvents = parseBdpDocuments(rawDocuments);

          for (const evt of salesEvents) {
            const idempotencyId = `bdp_${evt.provider_doc_id}`;

            const { data: eventRow, error: evtErr } = await supabase
              .from("sales_events")
              .upsert(
                {
                  connection_id: connectionId,
                  provider_doc_id: idempotencyId,
                  business_day: evt.business_day,
                  doc_type: evt.doc_type,
                  total_amount: evt.total_amount,
                  total_tax: evt.total_tax,
                  total_net: evt.total_net,
                  line_count: evt.line_count,
                  raw_json: evt.raw_json,
                },
                { onConflict: "connection_id,provider_doc_id" }
              )
              .select("id")
              .single();

            if (evtErr) {
              errors.push(`${day} doc ${evt.provider_doc_id}: ${evtErr.message}`);
              continue;
            }
            totalSaved++;

            for (const line of evt.lines) {
              const lineProviderId = `${idempotencyId}_L${line.line_index}`;

              const { error: lineErr } = await supabase
                .from("sales_line_items")
                .upsert(
                  {
                    sales_event_id: eventRow.id,
                    connection_id: connectionId,
                    provider_product_id: lineProviderId,
                    name: line.name,
                    family: line.family,
                    format: line.format,
                    quantity: line.quantity,
                    unit_price: line.unit_price,
                    total_amount: line.total_amount,
                    vat_rate: line.vat_rate,
                    is_wine_candidate: false,
                    mapped: false,
                  },
                  { onConflict: "sales_event_id,provider_product_id" }
                );

              if (lineErr) {
                errors.push(`Line ${lineProviderId}: ${lineErr.message}`);
              } else {
                totalLines++;
              }
            }
          }
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : "Unknown error";
          errors.push(`${day}: ${msg}`);
        }
      }

      // Update sync markers
      await supabase
        .from("pos_connections")
        .update({ last_sync_at: new Date().toISOString() })
        .eq("id", connectionId);

      return ok({ success: true, totalSaved, totalLines, daysProcessed: daysBack, errors });
    }

    // ── ACTION: incremental-sync ──
    // Fetch from last_business_day_synced until today
    if (action === "incremental-sync") {
      const lastSynced = conn.last_business_day_synced;
      const today = new Date().toISOString().substring(0, 10);
      const from = lastSynced || today;

      try {
        const defaultSalesPath = `/api/v1/export/${encodeURIComponent(exportProfileCode)}`;
        const salesBase = resolveUrl("sales", defaultSalesPath);
        const exportUrl = `${salesBase}?dateFrom=${from}&dateTo=${today}`;
        const resp = await bdpFetch(exportUrl, headers);
        await trackEndpoint("export", "sales", defaultSalesPath, resp, resp.ok ? undefined : `HTTP ${resp.status}`);

        if (!resp.ok) {
          return ok({ success: false, message: `BDP HTTP ${resp.status}` });
        }

        const bodyText = await resp.text();
        let rawDocuments: any[];
        try {
          const parsed = JSON.parse(bodyText);
          rawDocuments = Array.isArray(parsed) ? parsed : (parsed.documents || parsed.Documents || parsed.data || parsed.Data || [parsed]);
        } catch {
          return ok({ success: false, message: "Invalid JSON from BDP" });
        }

        const salesEvents = parseBdpDocuments(rawDocuments);
        let savedEvents = 0;
        let savedLines = 0;
        const errors: string[] = [];

        for (const evt of salesEvents) {
          const idempotencyId = `bdp_${evt.provider_doc_id}`;

          const { data: eventRow, error: evtErr } = await supabase
            .from("sales_events")
            .upsert(
              {
                connection_id: connectionId,
                provider_doc_id: idempotencyId,
                business_day: evt.business_day,
                doc_type: evt.doc_type,
                total_amount: evt.total_amount,
                total_tax: evt.total_tax,
                total_net: evt.total_net,
                line_count: evt.line_count,
                raw_json: evt.raw_json,
              },
              { onConflict: "connection_id,provider_doc_id" }
            )
            .select("id")
            .single();

          if (evtErr) {
            errors.push(`Event ${evt.provider_doc_id}: ${evtErr.message}`);
            continue;
          }
          savedEvents++;

          for (const line of evt.lines) {
            const lineProviderId = `${idempotencyId}_L${line.line_index}`;

            const { error: lineErr } = await supabase
              .from("sales_line_items")
              .upsert(
                {
                  sales_event_id: eventRow.id,
                  connection_id: connectionId,
                  provider_product_id: lineProviderId,
                  name: line.name,
                  family: line.family,
                  format: line.format,
                  quantity: line.quantity,
                  unit_price: line.unit_price,
                  total_amount: line.total_amount,
                  vat_rate: line.vat_rate,
                  is_wine_candidate: false,
                  mapped: false,
                },
                { onConflict: "sales_event_id,provider_product_id" }
              );

            if (lineErr) errors.push(`Line ${lineProviderId}: ${lineErr.message}`);
            else savedLines++;
          }
        }

        await supabase
          .from("pos_connections")
          .update({ last_sync_at: new Date().toISOString(), last_business_day_synced: today })
          .eq("id", connectionId);

        return ok({
          success: true, savedEvents, savedLines,
          dateRange: { from, to: today },
          totalParsed: salesEvents.length, errors,
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Unknown error";
        return ok({ success: false, message: msg });
      }
    }

    // ── ACTION: sync-catalog ──
    // Fetch products/articles + departments/families from BDP
    if (action === "sync-catalog") {
      const catalogProfileCode = config.catalog_profile_code
        ? String(config.catalog_profile_code)
        : exportProfileCode;

      try {
        // Try fetching articles/products
        const productsUrl = `${host}/api/v1/articles`;
        let products: any[] = [];
        let families: any[] = [];
        let rawProductsPreview = "";

        try {
          const pResp = await bdpFetch(productsUrl, headers);
          if (pResp.ok) {
            const pText = await pResp.text();
            rawProductsPreview = pText.substring(0, 2048);
            const parsed = JSON.parse(pText);
            products = Array.isArray(parsed)
              ? parsed
              : (parsed.articles || parsed.Articles || parsed.products || parsed.Products || parsed.data || []);
          }
        } catch { /* endpoint may not exist */ }

        // Try fetching departments/families
        try {
          const fResp = await bdpFetch(`${host}/api/v1/departments`, headers);
          if (fResp.ok) {
            const fText = await fResp.text();
            const parsed = JSON.parse(fText);
            families = Array.isArray(parsed)
              ? parsed
              : (parsed.departments || parsed.Departments || parsed.families || parsed.Families || parsed.data || []);
          }
        } catch { /* endpoint may not exist */ }

        // If articles endpoint didn't work, try export endpoint with catalog profile
        if (products.length === 0 && catalogProfileCode) {
          try {
            const catalogUrl = `${host}/api/v1/export/${encodeURIComponent(catalogProfileCode)}?type=articles`;
            const cResp = await bdpFetch(catalogUrl, headers);
            if (cResp.ok) {
              const cText = await cResp.text();
              rawProductsPreview = cText.substring(0, 2048);
              const parsed = JSON.parse(cText);
              products = Array.isArray(parsed)
                ? parsed
                : (parsed.articles || parsed.Articles || parsed.products || parsed.Products || parsed.data || []);
            }
          } catch { /* */ }
        }

        // Normalize products into provider_products
        const normalized = products.map((p: any) => {
          const id = String(p.Id || p.id || p.ArticleId || p.article_id || p.Code || p.code || "");
          const name = String(p.Name || p.name || p.Description || p.description || "Unknown");
          const family = p.Department || p.department || p.Family || p.family || p.Category || p.category || null;
          const price = Number(p.Price || p.price || p.SalePrice || p.sale_price || p.PVP || p.pvp || 0);
          const vatRate = Number(p.VatRate || p.vat_rate || p.Tax || p.tax || p.IVA || p.iva || 0);
          const format = p.Format || p.format || p.Unit || p.unit || null;

          return {
            provider_product_id: id,
            name,
            family: family ? String(family) : null,
            price,
            vat_rate: vatRate,
            sale_format: format ? String(format) : null,
            raw_payload: p,
          };
        });

        // Upsert into provider_products
        let upserted = 0;
        const errors: string[] = [];

        for (const prod of normalized) {
          if (!prod.provider_product_id) continue;
          const { error: upErr } = await supabase
            .from("provider_products")
            .upsert(
              {
                connection_id: connectionId,
                provider_product_id: prod.provider_product_id,
                name: prod.name,
                family: prod.family,
                price: prod.price,
                vat_rate: prod.vat_rate,
                sale_format: prod.sale_format,
                raw_payload: prod.raw_payload,
                last_synced_at: new Date().toISOString(),
                sync_status: "SYNCED",
              },
              { onConflict: "connection_id,provider_product_id" }
            );
          if (upErr) {
            errors.push(`${prod.provider_product_id}: ${upErr.message}`);
          } else {
            upserted++;
          }
        }

        // Update connection catalog metadata
        await supabase
          .from("pos_connections")
          .update({
            last_catalog_sync_at: new Date().toISOString(),
            catalog_product_count: normalized.length,
          })
          .eq("id", connectionId);

        return ok({
          success: true,
          totalProducts: normalized.length,
          upserted,
          totalFamilies: families.length,
          families: families.slice(0, 50).map((f: any) => ({
            id: String(f.Id || f.id || f.Code || f.code || ""),
            name: String(f.Name || f.name || f.Description || f.description || ""),
          })),
          rawProductsPreview,
          errors,
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Unknown error";
        return ok({ success: false, message: msg });
      }
    }

    // ── ACTION: write-product ──
    // Create or update a product in BDP
    if (action === "write-product") {
      const { product } = payload;
      if (!product) return err({ success: false, message: "Missing product payload" });

      const importProfileCode = config.import_profile_code
        ? String(config.import_profile_code)
        : exportProfileCode;

      try {
        // Try direct article endpoint first (PUT for update, POST for create)
        const articleId = product.provider_product_id || product.id;
        const articlePayload = {
          Id: articleId || undefined,
          Code: product.code || articleId || undefined,
          Name: product.name,
          Description: product.description || product.name,
          Department: product.family || product.department || undefined,
          Price: product.price || 0,
          SalePrice: product.price || 0,
          PVP: product.price || 0,
          VatRate: product.vat_rate || 0,
          IVA: product.vat_rate || 0,
          Format: product.format || undefined,
          Unit: product.format || undefined,
        };

        let writeResp: Response;
        let writeUrl: string;

        if (articleId) {
          // Update existing
          writeUrl = `${host}/api/v1/articles/${encodeURIComponent(articleId)}`;
          writeResp = await bdpFetch(writeUrl, { ...headers, "Content-Type": "application/json" }, "PUT");
          // If PUT not supported, try POST
          if (writeResp.status === 405 || writeResp.status === 404) {
            writeUrl = `${host}/api/v1/articles`;
            const bodyStr = JSON.stringify(articlePayload);
            const controller2 = new AbortController();
            const timeout2 = setTimeout(() => controller2.abort(), 30000);
            writeResp = await fetch(writeUrl, {
              method: "POST",
              headers: { ...headers, "Content-Type": "application/json" },
              body: bodyStr,
              signal: controller2.signal,
            });
            clearTimeout(timeout2);
          }
        } else {
          writeUrl = `${host}/api/v1/articles`;
          const bodyStr = JSON.stringify(articlePayload);
          const controller3 = new AbortController();
          const timeout3 = setTimeout(() => controller3.abort(), 30000);
          writeResp = await fetch(writeUrl, {
            method: "POST",
            headers: { ...headers, "Content-Type": "application/json" },
            body: bodyStr,
            signal: controller3.signal,
          });
          clearTimeout(timeout3);
        }

        const writeBody = await writeResp.text();

        // If direct API didn't work, try import endpoint
        if (!writeResp.ok && importProfileCode) {
          const importUrl = `${host}/api/v1/import/${encodeURIComponent(importProfileCode)}`;
          const importPayload = JSON.stringify({ articles: [articlePayload] });
          const controller4 = new AbortController();
          const timeout4 = setTimeout(() => controller4.abort(), 30000);
          const importResp = await fetch(importUrl, {
            method: "POST",
            headers: { ...headers, "Content-Type": "application/json" },
            body: importPayload,
            signal: controller4.signal,
          });
          clearTimeout(timeout4);
          const importBody = await importResp.text();

          return ok({
            success: importResp.ok,
            method: "import",
            status: importResp.status,
            bodyPreview: importBody.substring(0, 2048),
            product: articlePayload,
          });
        }

        return ok({
          success: writeResp.ok,
          method: articleId ? "update" : "create",
          status: writeResp.status,
          bodyPreview: writeBody.substring(0, 2048),
          product: articlePayload,
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Unknown error";
        return ok({ success: false, message: msg });
      }
    }

    // ── ACTION: verify-product ──
    // Confirm product exists in BDP and has price > 0
    if (action === "verify-product") {
      const { productId } = payload;
      if (!productId) return err({ success: false, message: "Missing productId" });

      try {
        // Try fetching the specific article
        const verifyUrl = `${host}/api/v1/articles/${encodeURIComponent(productId)}`;
        const resp = await bdpFetch(verifyUrl, headers);

        if (!resp.ok) {
          // Try listing all and filter
          const allUrl = `${host}/api/v1/articles`;
          const allResp = await bdpFetch(allUrl, headers);
          if (allResp.ok) {
            const allText = await allResp.text();
            const allParsed = JSON.parse(allText);
            const allProducts = Array.isArray(allParsed) ? allParsed : (allParsed.articles || allParsed.Articles || allParsed.data || []);
            const found = allProducts.find((p: any) =>
              String(p.Id || p.id || p.Code || p.code) === String(productId)
            );

            if (found) {
              const price = Number(found.Price || found.price || found.SalePrice || found.sale_price || found.PVP || 0);
              return ok({
                success: true,
                exists: true,
                priceValid: price > 0,
                price,
                name: String(found.Name || found.name || found.Description || ""),
                raw: found,
              });
            }
          }

          return ok({
            success: true,
            exists: false,
            priceValid: false,
            message: `Product ${productId} not found in BDP`,
          });
        }

        const bodyText = await resp.text();
        let product: any;
        try {
          product = JSON.parse(bodyText);
        } catch {
          return ok({ success: false, message: "Invalid JSON response from BDP verify" });
        }

        const price = Number(product.Price || product.price || product.SalePrice || product.sale_price || product.PVP || 0);
        const name = String(product.Name || product.name || product.Description || "");

        return ok({
          success: true,
          exists: true,
          priceValid: price > 0,
          price,
          name,
          raw: product,
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Unknown error";
        return ok({ success: false, message: msg });
      }
    }

    // ── ACTION: verify-write (shared PostWriteVerification contract) ──
    if (action === "verify-write") {
      const productId = payload.productId || payload.externalId || payload.external_id || "";
      if (!productId) return err({ success: false, verified_exists: false, verified_prices: false, verified_scope: true, errors: [{ code: "NO_ID", message: "Missing productId for verification" }], warnings: [] });

      const result = {
        success: false,
        verified_exists: false,
        verified_prices: false,
        verified_scope: true, // BDP doesn't have scope/auth expiry concept
        errors: [] as { code: string; message: string; field?: string; context?: Record<string, unknown> }[],
        warnings: [] as { code: string; message: string; field?: string; context?: Record<string, unknown> }[],
      };

      // 1) Scope: verify connectivity
      try {
        const testUrl = `${host}/api/v1/articles?limit=1`;
        const testResp = await bdpFetch(testUrl, headers);
        if (testResp.status === 401 || testResp.status === 403) {
          result.verified_scope = false;
          result.errors.push({ code: "SCOPE_EXPIRED", message: `BDP returned ${testResp.status}. Credentials may be invalid.` });
          return ok(result);
        }
      } catch (e: any) {
        result.errors.push({ code: "SCOPE_ERROR", message: `BDP connectivity check failed: ${e.message}` });
        return ok(result);
      }

      // 2) Verify product exists
      try {
        const verifyUrl = `${host}/api/v1/articles/${encodeURIComponent(productId)}`;
        const resp = await bdpFetch(verifyUrl, headers);

        let product: any = null;
        if (resp.ok) {
          const bodyText = await resp.text();
          try { product = JSON.parse(bodyText); } catch { /* invalid JSON */ }
        }

        if (!product) {
          // Fallback: list all and search
          const allUrl = `${host}/api/v1/articles`;
          const allResp = await bdpFetch(allUrl, headers);
          if (allResp.ok) {
            const allText = await allResp.text();
            const allParsed = JSON.parse(allText);
            const allProducts = Array.isArray(allParsed) ? allParsed : (allParsed.articles || allParsed.Articles || allParsed.data || []);
            product = allProducts.find((p: any) => String(p.Id || p.id || p.Code || p.code) === String(productId));
          }
        }

        if (!product) {
          result.errors.push({ code: "NOT_FOUND", message: `Product ${productId} not found in BDP after write`, context: { productId } });
          return ok(result);
        }

        result.verified_exists = true;

        // 3) Verify price
        const price = Number(product.Price || product.price || product.SalePrice || product.sale_price || product.PVP || 0);
        if (price > 0) {
          result.verified_prices = true;
          // Check expected price if provided
          const expected = Number(payload.expectedPrice || 0);
          if (expected > 0 && Math.abs(price - expected) > 0.01) {
            result.warnings.push({ code: "PRICE_MISMATCH", message: `Expected price ${expected}, found ${price}`, field: "price", context: { expected, actual: price } });
          }
        } else {
          result.errors.push({ code: "PRICE_ZERO", message: `Product exists but price is ${price}. Expected > 0.`, field: "price", context: { actual: price } });
        }

        // Provider-specific: check department/family
        const dept = product.Department || product.department || "";
        if (!dept) {
          result.warnings.push({ code: "NO_DEPARTMENT", message: "Product has no department/family assigned.", field: "department" });
        }
      } catch (e: any) {
        result.errors.push({ code: "VERIFY_ERROR", message: `Verification request failed: ${e.message}` });
      }

      result.success = result.verified_exists && result.verified_prices && result.verified_scope && result.errors.length === 0;
      return ok(result);
    }

    return err({ success: false, message: `Unknown action: ${action}` });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return err({ success: false, message: msg }, 500);
  }
});
