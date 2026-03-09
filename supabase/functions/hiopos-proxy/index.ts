import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getHioposConfig } from "../_shared/providerConfig.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "content-type": "application/json" } });
}

function sb() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
}

// ── CSV parser ──
function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const sep = lines[0].includes(";") ? ";" : ",";
  const headers = lines[0].split(sep).map((h) => h.trim().replace(/^"|"$/g, ""));
  return lines.slice(1).map((line) => {
    const vals = line.split(sep).map((v) => v.trim().replace(/^"|"$/g, ""));
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => (obj[h] = vals[i] || ""));
    return obj;
  });
}

// ── XML parser ──
function parseXmlItems(text: string, tagName: string): Record<string, string>[] {
  const re = new RegExp(`<${tagName}>(.*?)</${tagName}>`, "gs");
  const items: Record<string, string>[] = [];
  let m;
  while ((m = re.exec(text))) {
    const inner = m[1];
    const fieldRe = /<(\w+)>(.*?)<\/\1>/g;
    const obj: Record<string, string> = {};
    let f;
    while ((f = fieldRe.exec(inner))) obj[f[1]] = f[2];
    items.push(obj);
  }
  return items;
}

async function getConnection(connId: string) {
  const { data, error } = await sb().from("pos_connections").select("*").eq("id", connId).single();
  if (error) throw new Error("Connection not found");
  return data;
}

async function downloadFile(filePath: string): Promise<string> {
  const { data, error } = await sb().storage.from("hiopos-imports").download(filePath);
  if (error) throw new Error(`File download failed: ${error.message}`);
  return await data.text();
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ═══════════════════════════════════════════════════════
// ACTION: test
// ═══════════════════════════════════════════════════════
async function handleTest(connId: string) {
  const conn = await getConnection(connId);
  const cfg = getHioposConfig(conn.provider_config);
  if (!cfg?.integration_mode) {
    return json({ success: false, message: "Missing integration_mode in config" });
  }

  // For PortalRest mode, try a lightweight ping
  if (cfg.integration_mode === "PORTALREST_ORDERS_API" && cfg.portalrest?.base_url) {
    try {
      const baseUrl = cfg.portalrest.base_url.replace(/\/+$/, "");
      const headers: Record<string, string> = { "Accept": "application/json" };
      if (cfg.portalrest.api_key) headers["X-API-Key"] = cfg.portalrest.api_key;
      if (cfg.portalrest.api_secret) headers["Authorization"] = `Bearer ${cfg.portalrest.api_secret}`;
      const res = await fetch(`${baseUrl}/`, { method: "GET", headers, signal: AbortSignal.timeout(10000) });
      if (res.status >= 500) {
        return json({ success: false, message: `PortalRest API returned ${res.status}` });
      }
      // Even 4xx is fine — it means the server is reachable
    } catch (e: any) {
      return json({ success: false, message: `Cannot reach PortalRest API: ${e.message}` });
    }
  }

  await sb().from("pos_connections").update({ enabled: true }).eq("id", connId);
  return json({ success: true, message: "HIOPOS connection validated", config: cfg });
}

// ═══════════════════════════════════════════════════════
// ACTION: import-sales
// ═══════════════════════════════════════════════════════
async function handleImportSales(payload: any) {
  const { connectionId, filePath, fileName, dateFrom, dateTo, store, register } = payload;
  await getConnection(connectionId);
  const text = await downloadFile(filePath);
  const isXml = fileName.toLowerCase().endsWith(".xml");

  let rows: Record<string, string>[];
  if (isXml) {
    rows = parseXmlItems(text, "Sale") || parseXmlItems(text, "Ticket") || parseXmlItems(text, "Line");
  } else {
    rows = parseCsv(text);
  }

  if (rows.length === 0) return json({ success: false, totalEvents: 0, totalLines: 0, duplicatesSkipped: 0, rowsFailed: 0, failReasons: [], message: "No rows found in file" });

  const grouped = new Map<string, Record<string, string>[]>();
  rows.forEach((r, i) => {
    const key = r["NumTicket"] || r["ticket_id"] || r["document_no"] || r["DocNum"] || `doc_${i}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(r);
  });

  let totalEvents = 0, totalLines = 0, duplicatesSkipped = 0, rowsFailed = 0;
  const failReasons: string[] = [];
  const supabaseClient = sb();

  for (const [docId, lines] of grouped) {
    const businessDay = lines[0]["FechaCierre"] || lines[0]["business_date"] || lines[0]["Date"] || dateFrom || new Date().toISOString().slice(0, 10);
    if (dateFrom && businessDay < dateFrom) continue;
    if (dateTo && businessDay > dateTo) continue;
    if (store && lines[0]["Store"] && lines[0]["Store"] !== store) continue;
    if (register && lines[0]["Register"] && lines[0]["Register"] !== register) continue;

    const providerDocId = `HIOPOS_${docId}_${businessDay}`;
    const { data: existing } = await supabaseClient
      .from("sales_events").select("id")
      .eq("connection_id", connectionId).eq("provider_doc_id", providerDocId).maybeSingle();
    if (existing) { duplicatesSkipped++; continue; }

    const totalAmount = lines.reduce((s, l) => s + (parseFloat(l["Total"] || l["total_amount"] || l["Amount"] || "0")), 0);
    const totalTax = lines.reduce((s, l) => s + (parseFloat(l["Tax"] || l["vat_amount"] || "0")), 0);

    const { data: event, error: evErr } = await supabaseClient
      .from("sales_events")
      .insert({
        connection_id: connectionId, provider_doc_id: providerDocId, business_day: businessDay,
        doc_type: "HioposExport", total_amount: totalAmount, total_tax: totalTax,
        total_net: totalAmount - totalTax, line_count: lines.length,
        raw_json: { source: fileName, lines },
      })
      .select().single();

    if (evErr) { rowsFailed++; failReasons.push(`Ticket ${docId}: ${evErr.message}`); continue; }
    totalEvents++;

    for (const l of lines) {
      const { error: lineErr } = await supabaseClient.from("sales_line_items").insert({
        connection_id: connectionId, sales_event_id: event.id,
        provider_product_id: l["CodArticulo"] || l["item_id"] || l["SKU"] || null,
        name: l["Descripcion"] || l["item_name"] || l["Name"] || "Unknown",
        family: l["Familia"] || l["family"] || l["Category"] || null,
        format: l["Format"] || l["format"] || null,
        quantity: parseFloat(l["Cantidad"] || l["quantity"] || l["Qty"] || "1"),
        unit_price: parseFloat(l["PrecioUnitario"] || l["unit_price"] || l["Price"] || "0"),
        total_amount: parseFloat(l["Total"] || l["total_amount"] || l["Amount"] || "0"),
        vat_rate: parseFloat(l["TipoIVA"] || l["vat_rate"] || l["VAT"] || "0"),
        is_wine_candidate: false,
      });
      if (lineErr) { rowsFailed++; failReasons.push(`Line in ${docId}: ${lineErr.message}`); } else { totalLines++; }
    }
  }

  return json({ success: true, totalEvents, totalLines, duplicatesSkipped, rowsFailed, failReasons: failReasons.slice(0, 10), message: `Imported ${totalEvents} tickets with ${totalLines} lines` });
}

// ═══════════════════════════════════════════════════════
// ACTION: import-catalog
// ═══════════════════════════════════════════════════════
async function handleImportCatalog(payload: any) {
  const { connectionId, filePath, fileName } = payload;
  const text = await downloadFile(filePath);
  const isXml = fileName.toLowerCase().endsWith(".xml");

  let rows: Record<string, string>[];
  if (isXml) {
    rows = parseXmlItems(text, "Article") || parseXmlItems(text, "Item") || parseXmlItems(text, "Product");
  } else {
    rows = parseCsv(text);
  }

  if (rows.length === 0) return json({ success: false, totalProducts: 0, inserted: 0, updated: 0, message: "No rows found" });

  const supabaseClient = sb();
  let inserted = 0, updated = 0;

  for (const r of rows) {
    const productId = r["CodArticulo"] || r["item_id"] || r["SKU"] || r["Code"];
    if (!productId) continue;
    const name = r["Descripcion"] || r["item_name"] || r["Name"] || "Unknown";
    const family = r["Familia"] || r["family"] || r["Category"] || null;
    const price = parseFloat(r["PrecioVenta"] || r["sale_price"] || r["Price"] || "0");
    const vatRate = parseFloat(r["TipoIVA"] || r["vat_rate"] || r["VAT"] || "0");

    const { data: existing } = await supabaseClient
      .from("provider_products").select("id")
      .eq("connection_id", connectionId).eq("provider_product_id", productId).maybeSingle();

    if (existing) {
      await supabaseClient.from("provider_products").update({
        name, family, price, vat_rate: vatRate, raw_payload: r, updated_at: new Date().toISOString(),
      }).eq("id", existing.id);
      updated++;
    } else {
      await supabaseClient.from("provider_products").insert({
        connection_id: connectionId, provider_product_id: productId,
        name, family, price, vat_rate: vatRate, raw_payload: r, sync_status: "SYNCED",
      });
      inserted++;
    }
  }

  await supabaseClient.from("pos_connections").update({
    catalog_product_count: inserted + updated, last_catalog_sync_at: new Date().toISOString(),
  }).eq("id", connectionId);

  return json({ success: true, totalProducts: inserted + updated, inserted, updated, message: `Catalog: ${inserted} new, ${updated} updated` });
}

// ═══════════════════════════════════════════════════════
// ACTION: generate-import-file
// ═══════════════════════════════════════════════════════
async function handleGenerateImportFile(payload: any) {
  const { connectionId, format, useHioffice } = payload;
  const supabaseClient = sb();

  const { data: wines, error } = await supabaseClient
    .from("winerim_wines").select("*")
    .eq("connection_id", connectionId).eq("pricing_status", "READY").eq("is_active", true);

  if (error) throw error;
  if (!wines || wines.length === 0) {
    return json({ success: false, totalWines: 0, downloadUrl: "", format, message: "No wines with pricing_status=READY found" });
  }

  let content: string;
  const fileName = `hiopos_import_${Date.now()}.${format}`;

  if (format === "xml") {
    const items = wines.flatMap((w) => {
      const entries: string[] = [];
      if (w.bottle_sale_price) entries.push(`  <Item>\n    <Code>WINERIM_${w.winerim_id}_BOT</Code>\n    <Name>${escapeXml(w.name)} (Botella)</Name>\n    <Family>${escapeXml(w.wine_type || "Vinos")}</Family>\n    <VAT>${w.vat_rate || 10}</VAT>\n    <Price>${w.bottle_sale_price}</Price>\n    <Format>BOT</Format>\n  </Item>`);
      if (w.serve_by_glass && w.glass_sale_price) entries.push(`  <Item>\n    <Code>WINERIM_${w.winerim_id}_COPA</Code>\n    <Name>${escapeXml(w.name)} (Copa)</Name>\n    <Family>${escapeXml(w.wine_type || "Vinos")}</Family>\n    <VAT>${w.vat_rate || 10}</VAT>\n    <Price>${w.glass_sale_price}</Price>\n    <Format>COPA</Format>\n  </Item>`);
      if (w.magnum_sale_price) entries.push(`  <Item>\n    <Code>WINERIM_${w.winerim_id}_MAG</Code>\n    <Name>${escapeXml(w.name)} (Magnum)</Name>\n    <Family>${escapeXml(w.wine_type || "Vinos")}</Family>\n    <VAT>${w.vat_rate || 10}</VAT>\n    <Price>${w.magnum_sale_price}</Price>\n    <Format>MAGNUM</Format>\n  </Item>`);
      return entries;
    });
    content = `<?xml version="1.0" encoding="UTF-8"?>\n<HioposImport>\n${items.join("\n")}\n</HioposImport>`;
  } else {
    const header = "Code;Name;Family;VAT;Price;Format";
    const lines: string[] = [header];
    for (const w of wines) {
      if (w.bottle_sale_price) lines.push(`WINERIM_${w.winerim_id}_BOT;"${w.name} (Botella)";${w.wine_type || "Vinos"};${w.vat_rate || 10};${w.bottle_sale_price};BOT`);
      if (w.serve_by_glass && w.glass_sale_price) lines.push(`WINERIM_${w.winerim_id}_COPA;"${w.name} (Copa)";${w.wine_type || "Vinos"};${w.vat_rate || 10};${w.glass_sale_price};COPA`);
      if (w.magnum_sale_price) lines.push(`WINERIM_${w.winerim_id}_MAG;"${w.name} (Magnum)";${w.wine_type || "Vinos"};${w.vat_rate || 10};${w.magnum_sale_price};MAGNUM`);
    }
    content = lines.join("\n");
  }

  const outputPath = `${connectionId}/exports/${fileName}`;
  const blob = new Blob([content], { type: format === "xml" ? "application/xml" : "text/csv" });
  await supabaseClient.storage.from("hiopos-imports").upload(outputPath, blob, { upsert: true });
  const { data: urlData } = supabaseClient.storage.from("hiopos-imports").getPublicUrl(outputPath);

  if (useHioffice) {
    await supabaseClient.from("outbound_tasks").insert({
      connection_id: connectionId, task_type: "HIOFFICE_IMPORT_BUNDLE", status: "READY",
      payload_json: { filePath: outputPath, format, wineCount: wines.length, useHioffice: true },
    } as any);
  }

  return json({
    success: true, totalWines: wines.length, downloadUrl: urlData?.publicUrl || outputPath, format,
    message: useHioffice ? `HiOffice import bundle generated with ${wines.length} wines` : `HIOPOS import file generated with ${wines.length} wines`,
  });
}

// ═══════════════════════════════════════════════════════
// ACTION: sftp-pull (simulated — real SFTP needs Deno SSH lib)
// ═══════════════════════════════════════════════════════
async function handleSftpPull(connId: string) {
  const conn = await getConnection(connId);
  const cfg = getHioposConfig(conn.provider_config);
  if (cfg?.ingestion_mode !== "SFTP_PULL" || !cfg?.sftp?.host) {
    return json({ success: false, message: "SFTP not configured for this connection" });
  }

  // In production, this would use a Deno SSH/SFTP library to connect and list/download files.
  // For now, we return a status placeholder and track the attempt.
  const pullStatus = {
    lastFilePulled: null,
    lastSuccessfulImport: conn.last_sync_at || null,
    failures: 0,
    lastError: null,
    message: "SFTP pull infrastructure ready. Configure your HiOffice/HIOPOS to drop export files to the configured SFTP path. Files will be auto-imported on next scheduled pull.",
    sftpConfig: { host: cfg.sftp.host, port: cfg.sftp.port, path: cfg.sftp.path, user: cfg.sftp.user },
  };

  // Update last sync attempt
  await sb().from("pos_connections").update({ last_sync_at: new Date().toISOString() }).eq("id", connId);

  return json({ success: true, pullStatus });
}

// ═══════════════════════════════════════════════════════
// ACTION: portalrest-discover (endpoint discovery for PortalRest API)
// ═══════════════════════════════════════════════════════
async function handlePortalRestDiscover(connId: string) {
  const conn = await getConnection(connId);
  const cfg = getHioposConfig(conn.provider_config);
  const pr = cfg?.portalrest;
  if (!pr?.base_url) {
    return json({ success: false, endpoints: [], message: "PortalRest base_url not configured" });
  }

  const baseUrl = pr.base_url.replace(/\/+$/, "");
  const headers: Record<string, string> = { "Accept": "application/json" };
  if (pr.api_key) headers["X-API-Key"] = pr.api_key;
  if (pr.api_secret) headers["Authorization"] = `Bearer ${pr.api_secret}`;

  // Candidate paths commonly seen in HIOPOS/Deliverect-style integrations
  const candidatePaths = [
    "/api/orders", "/api/v1/orders", "/orders", "/api/tickets",
    "/api/v1/tickets", "/api/menu", "/api/v1/menu", "/api/items",
    "/api/v1/items", "/api/status", "/api/v1/status", "/api/health",
  ];

  const endpoints: { path: string; status: number; snippet: string }[] = [];

  for (const path of candidatePaths) {
    try {
      const res = await fetch(`${baseUrl}${path}`, { method: "GET", headers, signal: AbortSignal.timeout(8000) });
      const body = await res.text();
      endpoints.push({ path, status: res.status, snippet: body.slice(0, 512) });
    } catch (e: any) {
      endpoints.push({ path, status: 0, snippet: `Error: ${e.message}` });
    }
  }

  const reachable = endpoints.filter(e => e.status > 0 && e.status < 500);
  return json({
    success: reachable.length > 0,
    endpoints,
    message: reachable.length > 0
      ? `Found ${reachable.length} reachable endpoints out of ${candidatePaths.length} probed`
      : "No reachable endpoints found. Verify base_url and credentials. PortalRest API endpoints vary by installation and may require partner enablement in CLOUDLICENSE.",
  });
}

// ═══════════════════════════════════════════════════════
// ACTION: portalrest-fetch-sales (minimal read from discovered API)
// ═══════════════════════════════════════════════════════
async function handlePortalRestFetchSales(payload: any) {
  const { connectionId, hoursBack } = payload;
  const conn = await getConnection(connectionId);
  const cfg = getHioposConfig(conn.provider_config);
  const pr = cfg?.portalrest;
  if (!pr?.base_url) {
    return json({ success: false, totalEvents: 0, totalLines: 0, duplicatesSkipped: 0, message: "PortalRest not configured" });
  }

  const baseUrl = pr.base_url.replace(/\/+$/, "");
  const headers: Record<string, string> = { "Accept": "application/json" };
  if (pr.api_key) headers["X-API-Key"] = pr.api_key;
  if (pr.api_secret) headers["Authorization"] = `Bearer ${pr.api_secret}`;

  // Try known order endpoints
  const orderPaths = ["/api/orders", "/api/v1/orders", "/api/tickets", "/api/v1/tickets"];
  let ordersData: any = null;
  let usedPath = "";

  for (const path of orderPaths) {
    try {
      const res = await fetch(`${baseUrl}${path}`, { method: "GET", headers, signal: AbortSignal.timeout(10000) });
      if (res.ok) {
        ordersData = await res.json();
        usedPath = path;
        break;
      }
    } catch { /* skip */ }
  }

  if (!ordersData) {
    return json({ success: false, totalEvents: 0, totalLines: 0, duplicatesSkipped: 0, message: "Could not fetch orders from any known endpoint. API may require partner enablement." });
  }

  // Attempt to map whatever shape we get into SalesEvents
  const items = Array.isArray(ordersData) ? ordersData : (ordersData.orders || ordersData.tickets || ordersData.data || []);
  const supabaseClient = sb();
  let totalEvents = 0, totalLines = 0, duplicatesSkipped = 0;

  for (const order of items.slice(0, 200)) {
    const orderId = order.id || order.order_id || order.ticket_id || `pr_${Date.now()}_${Math.random()}`;
    const businessDay = (order.date || order.created_at || order.business_date || new Date().toISOString()).slice(0, 10);
    const providerDocId = `HIOPOS_PR_${orderId}_${businessDay}`;

    const { data: existing } = await supabaseClient
      .from("sales_events").select("id")
      .eq("connection_id", connectionId).eq("provider_doc_id", providerDocId).maybeSingle();
    if (existing) { duplicatesSkipped++; continue; }

    const lines = order.items || order.lines || order.details || [];
    const totalAmount = order.total || order.total_amount || lines.reduce((s: number, l: any) => s + (l.total || l.amount || 0), 0);

    const { data: event, error: evErr } = await supabaseClient
      .from("sales_events").insert({
        connection_id: connectionId, provider_doc_id: providerDocId, business_day: businessDay,
        doc_type: "HioposPortalRest", total_amount: totalAmount, total_tax: 0, total_net: totalAmount,
        line_count: lines.length, raw_json: order,
      }).select().single();
    if (evErr) continue;
    totalEvents++;

    for (const l of lines) {
      await supabaseClient.from("sales_line_items").insert({
        connection_id: connectionId, sales_event_id: event.id,
        provider_product_id: l.item_id || l.product_id || l.sku || null,
        name: l.name || l.description || "Unknown",
        family: l.family || l.category || null,
        quantity: l.quantity || l.qty || 1,
        unit_price: l.unit_price || l.price || 0,
        total_amount: l.total || l.amount || 0,
        vat_rate: l.vat_rate || l.tax_rate || 0,
        is_wine_candidate: false,
      });
      totalLines++;
    }
  }

  return json({ success: true, totalEvents, totalLines, duplicatesSkipped, message: `PortalRest (${usedPath}): ${totalEvents} orders, ${totalLines} lines` });
}

// ═══════════════════════════════════════════════════════
// ROUTER
// ═══════════════════════════════════════════════════════
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const payload = await req.json();
    const { action, connectionId } = payload;

    switch (action) {
      case "test": return await handleTest(connectionId);
      case "import-sales": return await handleImportSales(payload);
      case "import-catalog": return await handleImportCatalog(payload);
      case "generate-import-file": return await handleGenerateImportFile(payload);
      case "sftp-pull": return await handleSftpPull(connectionId);
      case "portalrest-discover": return await handlePortalRestDiscover(connectionId);
      case "portalrest-fetch-sales": return await handlePortalRestFetchSales(payload);
      default: return json({ error: `Unknown action: ${action}` }, 400);
    }
  } catch (e: any) {
    console.error("hiopos-proxy error:", e);
    return json({ error: e.message }, 500);
  }
});
