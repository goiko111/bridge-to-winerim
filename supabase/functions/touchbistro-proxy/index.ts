import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "content-type": "application/json" } });
}

function sb() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
}

// ── CSV parser ──
function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length < 1) return { headers: [], rows: [] };
  const sep = lines[0].includes(";") ? ";" : lines[0].includes("\t") ? "\t" : ",";
  const headers = lines[0].split(sep).map((h) => h.trim().replace(/^"|"$/g, "").toLowerCase());
  const rows = lines.slice(1).map((line) => {
    const vals = line.split(sep).map((v) => v.trim().replace(/^"|"$/g, ""));
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => (obj[h] = vals[i] || ""));
    return obj;
  });
  return { headers, rows };
}

async function getConnection(connId: string) {
  const { data, error } = await sb().from("pos_connections").select("*").eq("id", connId).single();
  if (error) throw new Error("Connection not found");
  return data;
}

async function downloadFile(filePath: string): Promise<string> {
  const { data, error } = await sb().storage.from("touchbistro-imports").download(filePath);
  if (error) throw new Error(`File download failed: ${error.message}`);
  return await data.text();
}

// ── Report type detection (TB3) ──
const HEADER_SIGNATURES: Record<string, string[][]> = {
  MENU_ITEM_SALES: [
    ["item", "qty", "gross"],
    ["menu item", "quantity", "total"],
    ["item name", "qty sold", "net"],
    ["product", "quantity", "amount"],
  ],
  BILLS: [
    ["bill", "subtotal", "tax", "total"],
    ["check", "subtotal", "tax"],
    ["bill id", "sub total", "tax"],
    ["check id", "amount", "tip"],
  ],
  PAYMENTS: [
    ["payment type", "amount"],
    ["payment method", "total"],
    ["tender", "amount"],
    ["type", "amount", "tip"],
  ],
  ITEMS: [
    ["item", "category", "price"],
    ["name", "category", "price"],
    ["menu item", "section", "price"],
    ["item name", "group", "cost"],
  ],
};

function detectReportType(headers: string[]): string {
  const lower = headers.map((h) => h.toLowerCase().trim());
  for (const [type, signatures] of Object.entries(HEADER_SIGNATURES)) {
    for (const sig of signatures) {
      if (sig.every((kw) => lower.some((h) => h.includes(kw)))) return type;
    }
  }
  return "UNKNOWN";
}

// ── Format normalization (TB8) ──
function classifyFormat(name: string): string | null {
  const n = name.trim().toUpperCase();
  if (n.startsWith("BOT.") || n.startsWith("BOT ")) return "BOTTLE";
  if (n.startsWith("COPA") || n.startsWith("GLASS")) return "GLASS";
  if (n.startsWith("MAGNUM") || n.startsWith("MAG.")) return "MAGNUM";
  return null;
}

// ═══════════════════════════════════════════════════════
// ACTION: test (TB1)
// ═══════════════════════════════════════════════════════
async function handleTest(connId: string) {
  const conn = await getConnection(connId);
  const cfg = conn.provider_config as any;
  if (!cfg?.integration_mode) {
    return json({ success: false, message: "Missing integration_mode in config" });
  }
  if (cfg.integration_mode === "PRIVATE_API" && cfg.private_api?.base_url) {
    try {
      const baseUrl = cfg.private_api.base_url.replace(/\/+$/, "");
      const res = await fetch(baseUrl, { method: "HEAD", headers: { Accept: "application/json" } });
      return json({ success: res.status < 500, message: `API responded with status ${res.status}` });
    } catch (e: any) {
      return json({ success: false, message: `API unreachable: ${e.message}` });
    }
  }
  // CSV mode — always OK if connection exists
  return json({ success: true, message: "CSV Reports mode configured. Ready for file uploads." });
}

// ═══════════════════════════════════════════════════════
// ACTION: detect-report (TB3)
// ═══════════════════════════════════════════════════════
async function handleDetectReport(connId: string, filePath: string) {
  await getConnection(connId);
  const text = await downloadFile(filePath);
  const { headers, rows } = parseCsv(text);
  const reportType = detectReportType(headers);
  return json({
    report_type: reportType,
    headers,
    row_count: rows.length,
    sample_row: rows[0] || null,
  });
}

// ═══════════════════════════════════════════════════════
// ACTION: import-sales — Menu Item Sales CSV (TB4)
// ═══════════════════════════════════════════════════════
async function handleImportSales(connId: string, filePaths: string[]) {
  const conn = await getConnection(connId);
  const cfg = conn.provider_config as any;
  const timezone = cfg?.timezone || "America/New_York";
  let totalEvents = 0, totalLines = 0, duplicatesSkipped = 0, rowsFailed = 0;
  const failReasons: string[] = [];

  for (const fp of filePaths) {
    const text = await downloadFile(fp);
    const { headers, rows } = parseCsv(text);
    const fileHash = text.length.toString(36) + rows.length.toString(36);

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      try {
        // Find relevant columns (flexible matching)
        const itemName = row["item"] || row["menu item"] || row["item name"] || row["product"] || row["name"] || "";
        const qty = parseFloat(row["qty"] || row["quantity"] || row["qty sold"] || "1") || 1;
        const total = parseFloat(row["gross"] || row["total"] || row["net"] || row["amount"] || "0") || 0;
        const unitPrice = parseFloat(row["price"] || row["unit price"] || "0") || (qty > 0 ? total / qty : 0);
        const dateStr = row["date"] || row["business date"] || row["day"] || new Date().toISOString().slice(0, 10);
        const businessDay = dateStr.slice(0, 10);
        const category = row["category"] || row["section"] || row["family"] || row["group"] || null;
        const checkId = row["check id"] || row["bill id"] || row["ticket"] || null;
        const format = classifyFormat(itemName);

        // Build idempotency key
        const lineKey = checkId
          ? `TB_${checkId}_${i}`
          : `TB_${businessDay}_${itemName}_${unitPrice}_${i}_${fileHash}`;
        const docId = checkId || `TB_${businessDay}_${fileHash}`;

        // Upsert SalesEvent
        const { data: evt } = await sb().from("sales_events")
          .upsert({
            connection_id: connId,
            provider_doc_id: docId,
            business_day: businessDay,
            total_amount: total,
            total_tax: 0,
            total_net: total,
            line_count: 1,
            doc_type: "TouchBistro_MenuItemSales",
          }, { onConflict: "connection_id,provider_doc_id" })
          .select("id").single();

        if (!evt) { rowsFailed++; failReasons.push(`Row ${i}: event upsert failed`); continue; }

        // Check duplicate line
        const { data: existing } = await sb().from("sales_line_items")
          .select("id").eq("connection_id", connId).eq("provider_product_id", lineKey).limit(1);
        if (existing && existing.length > 0) { duplicatesSkipped++; continue; }

        await sb().from("sales_line_items").insert({
          connection_id: connId,
          sales_event_id: evt.id,
          name: itemName,
          quantity: qty,
          unit_price: unitPrice,
          total_amount: total,
          vat_rate: 0,
          is_wine_candidate: false,
          provider_product_id: lineKey,
          family: category,
          format: format,
        });
        totalLines++;
        totalEvents++;
      } catch (e: any) {
        rowsFailed++;
        failReasons.push(`Row ${i}: ${e.message}`);
      }
    }
  }

  return json({
    success: true,
    totalEvents,
    totalLines,
    duplicatesSkipped,
    rowsFailed,
    failReasons: failReasons.slice(0, 50),
    message: `Imported ${totalLines} lines from ${filePaths.length} file(s). ${duplicatesSkipped} duplicates skipped.`,
  });
}

// ═══════════════════════════════════════════════════════
// ACTION: import-bills-payments (TB5)
// ═══════════════════════════════════════════════════════
async function handleImportBillsPayments(connId: string, billPaths: string[], paymentPaths: string[]) {
  const conn = await getConnection(connId);
  let totalEvents = 0, totalLines = 0, duplicatesSkipped = 0, rowsFailed = 0;
  const failReasons: string[] = [];
  const dailyBills: Record<string, number> = {};
  const dailyPayments: Record<string, number> = {};

  // Parse Bills
  for (const fp of billPaths) {
    const text = await downloadFile(fp);
    const { rows } = parseCsv(text);
    for (let i = 0; i < rows.length; i++) {
      try {
        const checkId = rows[i]["bill"] || rows[i]["bill id"] || rows[i]["check"] || rows[i]["check id"] || `bill_${i}`;
        const subtotal = parseFloat(rows[i]["subtotal"] || rows[i]["sub total"] || "0") || 0;
        const tax = parseFloat(rows[i]["tax"] || "0") || 0;
        const total = parseFloat(rows[i]["total"] || "0") || subtotal + tax;
        const dateStr = rows[i]["date"] || rows[i]["opened"] || rows[i]["closed"] || new Date().toISOString().slice(0, 10);
        const businessDay = dateStr.slice(0, 10);
        dailyBills[businessDay] = (dailyBills[businessDay] || 0) + total;

        const docId = `TB_BILL_${checkId}`;
        const { data: evt } = await sb().from("sales_events")
          .upsert({
            connection_id: connId,
            provider_doc_id: docId,
            business_day: businessDay,
            total_amount: total,
            total_tax: tax,
            total_net: subtotal,
            line_count: 1,
            doc_type: "TouchBistro_Bill",
          }, { onConflict: "connection_id,provider_doc_id" })
          .select("id").single();
        if (evt) totalEvents++;
        else { rowsFailed++; failReasons.push(`Bill row ${i}: upsert failed`); }
      } catch (e: any) {
        rowsFailed++;
        failReasons.push(`Bill row ${i}: ${e.message}`);
      }
    }
  }

  // Parse Payments
  for (const fp of paymentPaths) {
    const text = await downloadFile(fp);
    const { rows } = parseCsv(text);
    for (let i = 0; i < rows.length; i++) {
      try {
        const paymentType = rows[i]["payment type"] || rows[i]["payment method"] || rows[i]["tender"] || rows[i]["type"] || "unknown";
        const amount = parseFloat(rows[i]["amount"] || rows[i]["total"] || "0") || 0;
        const tip = parseFloat(rows[i]["tip"] || "0") || 0;
        const dateStr = rows[i]["date"] || new Date().toISOString().slice(0, 10);
        const businessDay = dateStr.slice(0, 10);
        dailyPayments[businessDay] = (dailyPayments[businessDay] || 0) + amount + tip;
        totalLines++;
      } catch (e: any) {
        rowsFailed++;
        failReasons.push(`Payment row ${i}: ${e.message}`);
      }
    }
  }

  // Reconciliation
  const allDates = new Set([...Object.keys(dailyBills), ...Object.keys(dailyPayments)]);
  const reconciliation: { date: string; billsTotal: number; paymentsTotal: number; diff: number; mismatch: boolean }[] = [];
  for (const d of Array.from(allDates).sort()) {
    const b = dailyBills[d] || 0;
    const p = dailyPayments[d] || 0;
    const diff = Math.round((b - p) * 100) / 100;
    reconciliation.push({ date: d, billsTotal: b, paymentsTotal: p, diff, mismatch: Math.abs(diff) > 0.01 });
  }

  return json({
    salesResult: { success: true, totalEvents, totalLines, duplicatesSkipped, rowsFailed, failReasons: failReasons.slice(0, 50), message: `Processed ${totalEvents} bills, ${totalLines} payments.` },
    reconciliation,
  });
}

// ═══════════════════════════════════════════════════════
// ACTION: import-catalog — Items CSV (TB6)
// ═══════════════════════════════════════════════════════
async function handleImportCatalog(connId: string, filePaths: string[]) {
  let totalProducts = 0, inserted = 0, updated = 0, matched = 0;
  for (const fp of filePaths) {
    const text = await downloadFile(fp);
    const { rows } = parseCsv(text);
    for (const row of rows) {
      const name = row["item"] || row["name"] || row["menu item"] || row["item name"] || "";
      if (!name) continue;
      const sku = row["sku"] || row["id"] || row["item id"] || "";
      const category = row["category"] || row["section"] || row["group"] || null;
      const price = parseFloat(row["price"] || row["cost"] || "0") || 0;
      const vatRate = parseFloat(row["tax"] || row["tax rate"] || row["vat"] || "0") || 0;
      const active = row["active"] !== "false" && row["active"] !== "0";
      const providerProductId = sku || `TB_${name.replace(/\s+/g, "_").slice(0, 50)}`;
      const format = classifyFormat(name);

      const { data: existing } = await sb().from("provider_products")
        .select("id").eq("connection_id", connId).eq("provider_product_id", providerProductId).limit(1);

      if (existing && existing.length > 0) {
        await sb().from("provider_products").update({
          name, family: category, price, vat_rate: vatRate, sale_format: format,
          raw_payload: row, updated_at: new Date().toISOString(),
        }).eq("id", existing[0].id);
        updated++;
      } else {
        await sb().from("provider_products").insert({
          connection_id: connId, provider_product_id: providerProductId,
          name, family: category, price, vat_rate: vatRate, sale_format: format,
          raw_payload: row, sync_status: "SYNCED",
        });
        inserted++;
      }

      // Try name match against winerim wines
      const { data: wines } = await sb().from("winerim_wines")
        .select("id, name").eq("connection_id", connId).ilike("name", `%${name.slice(0, 30)}%`).limit(1);
      if (wines && wines.length > 0) matched++;

      totalProducts++;
    }
  }
  return json({ success: true, totalProducts, inserted, updated, matched, message: `Imported ${totalProducts} items (${inserted} new, ${updated} updated, ${matched} matched to Winerim).` });
}

// ═══════════════════════════════════════════════════════
// ACTION: api-discover (TB10)
// ═══════════════════════════════════════════════════════
async function handleApiDiscover(connId: string) {
  const conn = await getConnection(connId);
  const cfg = conn.provider_config as any;
  const apiCfg = cfg?.private_api;
  if (!apiCfg?.base_url) return json({ success: false, endpoints: [], message: "No API base URL configured" });

  const baseUrl = apiCfg.base_url.replace(/\/+$/, "");
  const candidatePaths = [
    "/api/orders", "/api/v1/orders", "/api/v2/orders",
    "/api/payments", "/api/v1/payments",
    "/api/menu", "/api/v1/menu-items", "/api/v1/items",
    "/api/checks", "/api/v1/checks",
    "/api/reports", "/api/v1/reports",
    "/api/locations", "/api/v1/locations",
    "/health", "/api/health", "/api/v1/ping",
  ];

  const headers: Record<string, string> = { Accept: "application/json" };
  if (conn.api_token && conn.api_token !== "csv-mode") {
    headers["Authorization"] = `Bearer ${conn.api_token}`;
  }

  const endpoints: { path: string; status: number; snippet: string }[] = [];
  for (const path of candidatePaths) {
    try {
      const res = await fetch(`${baseUrl}${path}`, { method: "GET", headers, signal: AbortSignal.timeout(5000) });
      const body = await res.text();
      endpoints.push({ path, status: res.status, snippet: body.slice(0, 512) });
    } catch (e: any) {
      endpoints.push({ path, status: 0, snippet: e.message });
    }
  }

  // Store discovered endpoints
  await sb().from("provider_capabilities").upsert({
    connection_id: connId,
    provider: "TOUCHBISTRO",
    can_read_sales: endpoints.some((e) => e.status === 200 && (e.path.includes("order") || e.path.includes("check"))),
    can_read_catalog: endpoints.some((e) => e.status === 200 && (e.path.includes("menu") || e.path.includes("item"))),
    can_write_products: "UNKNOWN",
    write_endpoints_json: endpoints,
    last_checked_at: new Date().toISOString(),
  }, { onConflict: "connection_id" });

  return json({
    success: true,
    endpoints: endpoints.filter((e) => e.status > 0),
    message: `Probed ${candidatePaths.length} paths. ${endpoints.filter((e) => e.status === 200).length} responded OK.`,
  });
}

// ═══════════════════════════════════════════════════════
// ACTION: debug-bundle (TB9)
// ═══════════════════════════════════════════════════════
async function handleDebugBundle(connId: string) {
  const conn = await getConnection(connId);
  const cfg = conn.provider_config as any;

  // Sanitize: remove tokens
  const sanitizedSettings = { ...cfg };
  delete sanitizedSettings.sftp?.password;
  delete sanitizedSettings.private_api?.api_key;
  delete sanitizedSettings.private_api?.client_secret;

  // Get recent sales events for reconciliation
  const { data: events } = await sb().from("sales_events")
    .select("business_day, total_amount, doc_type").eq("connection_id", connId)
    .order("business_day", { ascending: false }).limit(30);

  // Get recent line items for parse error sampling
  const { data: lines } = await sb().from("sales_line_items")
    .select("name, format, family, provider_product_id").eq("connection_id", connId).limit(100);

  // Build reconciliation from events
  const dailySums: Record<string, { bills: number; sales: number }> = {};
  (events || []).forEach((e: any) => {
    if (!dailySums[e.business_day]) dailySums[e.business_day] = { bills: 0, sales: 0 };
    if (e.doc_type?.includes("Bill")) dailySums[e.business_day].bills += e.total_amount;
    else dailySums[e.business_day].sales += e.total_amount;
  });
  const reconciliation = Object.entries(dailySums).map(([date, sums]) => ({
    date,
    billsTotal: sums.bills,
    paymentsTotal: sums.sales,
    diff: Math.round((sums.bills - sums.sales) * 100) / 100,
    mismatch: Math.abs(sums.bills - sums.sales) > 0.01,
  }));

  const bundle = {
    connectionSettings: {
      id: connId,
      provider: "touchbistro",
      location_name: conn.location_name,
      integration_mode: cfg?.integration_mode,
      ingestion_method: cfg?.ingestion_method,
      timezone: cfg?.timezone,
    },
    importedFiles: [],
    parseErrors: [],
    reconciliation,
    sampleLineItems: (lines || []).slice(0, 50),
    generatedAt: new Date().toISOString(),
  };

  return json({ success: true, bundle });
}

// ═══════════════════════════════════════════════════════
// ROUTER
// ═══════════════════════════════════════════════════════
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const payload = await req.json();
    const { action, connection_id } = payload;

    switch (action) {
      case "test":
        return await handleTest(connection_id);
      case "detect-report":
        return await handleDetectReport(connection_id, payload.file_path);
      case "import-sales":
        return await handleImportSales(connection_id, payload.file_paths || []);
      case "import-bills-payments":
        return await handleImportBillsPayments(connection_id, payload.bill_paths || [], payload.payment_paths || []);
      case "import-catalog":
        return await handleImportCatalog(connection_id, payload.file_paths || []);
      case "api-discover":
        return await handleApiDiscover(connection_id);
      case "debug-bundle":
        return await handleDebugBundle(connection_id);
      default:
        return json({ error: `Unknown action: ${action}` }, 400);
    }
  } catch (e: any) {
    return json({ error: e.message }, 500);
  }
});
