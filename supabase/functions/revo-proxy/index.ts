import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-revo-hmac-sha256, tenant",
};

const REVO_BASE = "https://revoxef.works/api/external";

// ── Rate limiter: 120 req/min per connection ──
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 120;
const rateMap = new Map<string, { count: number; start: number }>();

function checkRate(connId: string): boolean {
  const now = Date.now();
  const e = rateMap.get(connId);
  if (!e || now - e.start > RATE_WINDOW_MS) {
    rateMap.set(connId, { count: 1, start: now });
    return true;
  }
  if (e.count >= RATE_MAX) return false;
  e.count++;
  return true;
}

// ── Classification (shared logic) ──
const WINE_KW = [
  "vino", "tinto", "blanco", "rosado", "cava", "champagne", "brut",
  "reserva", "crianza", "botella", "75cl", "copa", "tempranillo",
  "garnacha", "cabernet", "merlot", "syrah", "chardonnay", "verdejo",
  "albariño", "rioja", "ribera", "prosecco", "lambrusco",
];
const NON_WINE_KW = [
  "agua", "water", "cerveza", "beer", "café", "coffee", "postre",
  "dessert", "pan", "bread", "refresco", "coca", "zumo", "menu",
  "menú", "ensalada", "carne", "pescado", "gin", "whisky", "vodka",
  "cocktail", "tapa", "ración", "helado",
];

function classify(
  name: string,
  family: string,
  price: number,
): { isWine: boolean; score: number; reasons: string[] } {
  const n = (name || "").toLowerCase();
  const f = (family || "").toLowerCase();
  const reasons: string[] = [];
  let score = 0;

  for (const kw of ["vino", "tinto", "blanco", "rosado", "cava", "champagne", "brut"]) {
    if (n.includes(kw)) { reasons.push(`hard_wine:${kw}`); return { isWine: true, score: 100, reasons }; }
  }
  if (/\b(botella|bot\.?\s|75\s?cl|copa de vino)\b/i.test(n)) {
    reasons.push("hard_wine_bottle"); return { isWine: true, score: 100, reasons };
  }

  for (const kw of NON_WINE_KW) {
    if (f.includes(kw) || n.includes(kw)) { score -= 50; reasons.push(`non_wine:${kw}`); break; }
  }
  for (const kw of WINE_KW) {
    if (f.includes(kw) || n.includes(kw)) { score += 40; reasons.push(`wine:${kw}`); break; }
  }
  if (price >= 6 && price <= 600 && Math.abs(score) < 20) { score += 5; reasons.push(`price_range:${price}`); }
  score = Math.max(-100, Math.min(100, score));
  return { isWine: score >= 40, score, reasons };
}

// ── Fetch with rate-limit + retry on 429 ──
async function revoFetch(
  url: string,
  headers: Record<string, string>,
  connId: string,
  method = "GET",
  body?: unknown,
): Promise<Response> {
  if (!checkRate(connId)) throw new Error("Rate limit 120 req/min exceeded. Back off.");
  const opts: RequestInit = { method, headers: { ...headers, Accept: "application/json", "Content-Type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);
  let res = await fetch(url, opts);
  if (res.status === 429) {
    await new Promise((r) => setTimeout(r, 5000));
    if (!checkRate(connId)) throw new Error("Rate limit exceeded after backoff.");
    res = await fetch(url, opts);
  }
  return res;
}

// ── HMAC SHA-256 webhook verification ──
async function verifyHmac(payload: string, signature: string, secret: string): Promise<boolean> {
  try {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
    const computed = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
    return computed === signature.toLowerCase();
  } catch { return false; }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // ── WEBHOOK RECEIVER ──
    const url = new URL(req.url);
    if (url.pathname.endsWith("/webhook")) {
      const signature = req.headers.get("x-revo-hmac-sha256") || "";
      const body = await req.text();

      const { data: connections } = await supabase
        .from("pos_connections")
        .select("id, api_token, base_url")
        .eq("provider", "REVO_XEF")
        .eq("enabled", true);

      if (!connections?.length) {
        return new Response(JSON.stringify({ error: "No active Revo connections" }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // api_token stores "tenant|access_token|client_token|webhook_secret"
      let matched: typeof connections[0] | null = null;
      for (const c of connections) {
        const parts = c.api_token.split("|");
        const webhookSecret = parts[3] || "";
        if (webhookSecret && await verifyHmac(body, signature, webhookSecret)) {
          matched = c; break;
        }
      }
      if (!matched) {
        return new Response(JSON.stringify({ error: "Invalid signature" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      let payload: unknown;
      try { payload = JSON.parse(body); } catch { payload = { raw: body }; }
      console.log(`[revo-webhook] Connection ${matched.id}:`, JSON.stringify(payload).substring(0, 500));

      return new Response(JSON.stringify({ success: true, connectionId: matched.id }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── STANDARD ACTIONS ──
    const reqBody = await req.json();
    const { action, connectionId, businessDay, daysBack, startDate, endDate } = reqBody;

    const { data: connection, error: connError } = await supabase
      .from("pos_connections")
      .select("*").eq("id", connectionId).single();

    if (connError || !connection) {
      return new Response(JSON.stringify({ error: "Connection not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Parse compound token: "tenant|access_token|client_token|webhook_secret"
    const tokenParts = connection.api_token.trim().split("|");
    const tenant = tokenParts[0] || "";
    const accessToken = tokenParts[1] || "";
    const clientToken = tokenParts[2] || "";

    const revoHeaders: Record<string, string> = {
      tenant,
      Authorization: `Bearer ${accessToken}`,
      "client-token": clientToken,
    };

    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    // ── TEST ──
    if (action === "test") {
      try {
        const res = await revoFetch(`${REVO_BASE}/v2/paymentMethods`, revoHeaders, connectionId);
        if (!res.ok) {
          const errBody = await res.text();
          return json({ success: false, status: res.status, message: `Revo responded ${res.status}: ${errBody.substring(0, 300)}` });
        }
        const data = await res.json();
        const items = Array.isArray(data) ? data : data.data || [];
        return json({ success: true, paymentMethodCount: items.length });
      } catch (e) {
        return json({ success: false, message: (e as Error).message });
      }
    }

    // ── FETCH ROOMS (lightweight test) ──
    if (action === "fetch-rooms") {
      const res = await revoFetch(`${REVO_BASE}/v2/rooms`, revoHeaders, connectionId);
      if (!res.ok) return json({ error: `Revo ${res.status}` }, 502);
      const data = await res.json();
      return json({ success: true, rooms: Array.isArray(data) ? data : data.data || [] });
    }

    // ── FETCH ORDERS REPORT (nightly backfill / incremental) ──
    if (action === "fetch-orders") {
      const start = startDate || businessDay || new Date().toISOString().split("T")[0];
      const end = endDate || start;
      let allOrders: unknown[] = [];
      let page = 1;
      let hasMore = true;

      while (hasMore) {
        const params = new URLSearchParams({
          start_date: start, end_date: end,
          withContents: "", withInvoices: "", withPayments: "",
          page: String(page), per_page: "200",
        });
        const res = await revoFetch(`${REVO_BASE}/v3/reports/orders?${params}`, revoHeaders, connectionId);
        if (!res.ok) return json({ error: `Revo ${res.status}` }, 502);
        const data = await res.json();
        const orders = Array.isArray(data) ? data : data.data || data.orders || [];
        allOrders = allOrders.concat(orders);
        // Check pagination
        const meta = data.meta || data.pagination || {};
        const lastPage = meta.last_page || meta.totalPages || 1;
        hasMore = page < lastPage;
        page++;
      }

      // Normalize orders into SalesEvents
      const salesEvents = allOrders.map((order: any) => {
        const orderId = String(order.id || order.orderId || "");
        const contents = order.contents || order.items || order.orderContents || [];
        const lines = contents.map((item: any) => {
          const name = String(item.name || item.productName || "");
          const family = String(item.categoryName || item.groupName || item.category || "");
          const price = Number(item.price || item.unitPrice || 0);
          const qty = Number(item.quantity || 1);
          const total = Number(item.total || item.totalAmount || price * qty);
          const vatRate = Number(item.taxPercentage || item.vatRate || 0);
          const cls = classify(name, family, price);
          return {
            provider_product_id: String(item.product_id || item.productId || item.id || ""),
            name, format: String(item.sellingFormatName || item.format || ""), family,
            quantity: qty, unit_price: price, total_amount: total,
            vat_rate: vatRate, is_wine_candidate: cls.isWine,
            wine_score: cls.score, wine_reasons: cls.reasons,
          };
        });

        const invoices = order.invoices || [];
        const totalAmount = invoices.length > 0
          ? invoices.reduce((s: number, inv: any) => s + Number(inv.total || inv.amount || 0), 0)
          : Number(order.total || order.sum || 0);

        return {
          provider_doc_id: orderId,
          business_day: start,
          doc_type: String(order.type || "order"),
          total_amount: totalAmount,
          total_tax: Number(order.totalTax || 0),
          total_net: Number(order.totalNet || totalAmount),
          line_count: lines.length,
          lines,
        };
      });

      return json({ businessDay: start, orderCount: allOrders.length, salesEvents });
    }

    // ── SAVE SALES TO DB ──
    if (action === "save-sales") {
      const day = businessDay;
      if (!day) return json({ error: "businessDay required" }, 400);

      // Fetch orders for this day
      const params = new URLSearchParams({
        start_date: day, end_date: day,
        withContents: "", withInvoices: "", withPayments: "",
        per_page: "200",
      });
      let allOrders: any[] = [];
      let page = 1;
      let hasMore = true;
      while (hasMore) {
        const res = await revoFetch(
          `${REVO_BASE}/v3/reports/orders?${params}&page=${page}`, revoHeaders, connectionId,
        );
        if (!res.ok) break;
        const data = await res.json();
        const orders = Array.isArray(data) ? data : data.data || data.orders || [];
        allOrders = allOrders.concat(orders);
        const lastPage = (data.meta || data.pagination || {}).last_page || 1;
        hasMore = page < lastPage;
        page++;
      }

      let savedEvents = 0, savedLines = 0;
      for (const order of allOrders) {
        const orderId = String(order.id || order.orderId || "");
        if (!orderId) continue;
        const contents = order.contents || order.items || order.orderContents || [];
        const lineData: Record<string, unknown>[] = [];
        let docTotal = 0;

        for (const item of contents) {
          const name = String(item.name || item.productName || "");
          const family = String(item.categoryName || item.groupName || "");
          const price = Number(item.price || item.unitPrice || 0);
          const qty = Number(item.quantity || 1);
          const total = Number(item.total || price * qty);
          docTotal += total;
          const cls = classify(name, family, price);
          lineData.push({
            provider_product_id: String(item.product_id || item.productId || ""),
            name, format: String(item.sellingFormatName || ""), family,
            quantity: qty, unit_price: price, total_amount: total,
            vat_rate: Number(item.taxPercentage || 0),
            is_wine_candidate: cls.isWine,
          });
        }

        const invoices = order.invoices || [];
        const totalAmount = invoices.length > 0
          ? invoices.reduce((s: number, inv: any) => s + Number(inv.total || 0), 0)
          : Number(order.total || docTotal);

        const { data: eventRow, error: eventErr } = await supabase
          .from("sales_events")
          .upsert({
            connection_id: connectionId, provider_doc_id: orderId, business_day: day,
            doc_type: String(order.type || "order"),
            total_amount: totalAmount,
            total_tax: Number(order.totalTax || 0),
            total_net: Number(order.totalNet || totalAmount),
            line_count: lineData.length, raw_json: order,
          }, { onConflict: "connection_id,provider_doc_id" })
          .select("id").single();

        if (eventErr || !eventRow) continue;
        savedEvents++;
        await supabase.from("sales_line_items").delete().eq("sales_event_id", eventRow.id);
        const rows = lineData.map((l) => ({ ...l, sales_event_id: eventRow.id, connection_id: connectionId }));
        if (rows.length > 0) {
          const { error } = await supabase.from("sales_line_items").insert(rows);
          if (!error) savedLines += rows.length;
        }
      }

      await supabase.from("pos_connections")
        .update({ last_business_day_synced: day, last_sync_at: new Date().toISOString() })
        .eq("id", connectionId);

      return json({ success: true, savedEvents, savedLines, businessDay: day });
    }

    // ── BACKFILL (multi-day) ──
    if (action === "backfill") {
      const days = daysBack || 30;
      let totalSaved = 0, totalLines = 0;
      const errors: string[] = [];

      for (let i = 0; i < days; i++) {
        const day = new Date(Date.now() - i * 86400000).toISOString().split("T")[0];
        try {
          const params = new URLSearchParams({
            start_date: day, end_date: day,
            withContents: "", withInvoices: "", withPayments: "",
            per_page: "200",
          });
          const res = await revoFetch(`${REVO_BASE}/v3/reports/orders?${params}`, revoHeaders, connectionId);
          if (!res.ok) { errors.push(`${day}: HTTP ${res.status}`); continue; }
          const data = await res.json();
          const orders = Array.isArray(data) ? data : data.data || data.orders || [];
          if (orders.length === 0) continue;

          for (const order of orders) {
            const orderId = String(order.id || "");
            if (!orderId) continue;
            const contents = order.contents || order.items || [];
            const lineData: Record<string, unknown>[] = [];

            for (const item of contents) {
              const name = String(item.name || "");
              const family = String(item.categoryName || item.groupName || "");
              const price = Number(item.price || 0);
              const qty = Number(item.quantity || 1);
              const cls = classify(name, family, price);
              lineData.push({
                provider_product_id: String(item.product_id || item.productId || ""),
                name, format: String(item.sellingFormatName || ""), family,
                quantity: qty, unit_price: price, total_amount: Number(item.total || price * qty),
                vat_rate: Number(item.taxPercentage || 0), is_wine_candidate: cls.isWine,
              });
            }

            const { data: eventRow } = await supabase
              .from("sales_events")
              .upsert({
                connection_id: connectionId, provider_doc_id: orderId, business_day: day,
                doc_type: "order",
                total_amount: Number(order.total || 0),
                total_tax: Number(order.totalTax || 0),
                total_net: Number(order.totalNet || 0),
                line_count: lineData.length, raw_json: order,
              }, { onConflict: "connection_id,provider_doc_id" })
              .select("id").single();

            if (!eventRow) continue;
            totalSaved++;
            await supabase.from("sales_line_items").delete().eq("sales_event_id", eventRow.id);
            const rows = lineData.map((l) => ({ ...l, sales_event_id: eventRow.id, connection_id: connectionId }));
            if (rows.length > 0) {
              const { error } = await supabase.from("sales_line_items").insert(rows);
              if (!error) totalLines += rows.length;
            }
          }
        } catch (e) { errors.push(`${day}: ${(e as Error).message}`); }
      }

      await supabase.from("pos_connections")
        .update({ last_sync_at: new Date().toISOString() })
        .eq("id", connectionId);

      return json({ success: true, totalSaved, totalLines, errors });
    }

    // ── SYNC CATALOG ──
    if (action === "sync-catalog") {
      // Fetch groups, categories, items
      const fetchAll = async (resource: string) => {
        let all: any[] = [];
        let page = 1;
        let hasMore = true;
        while (hasMore) {
          const res = await revoFetch(
            `${REVO_BASE}/v2/catalog/${resource}?page=${page}&per_page=200`, revoHeaders, connectionId,
          );
          if (!res.ok) break;
          const data = await res.json();
          const items = Array.isArray(data) ? data : data.data || [];
          all = all.concat(items);
          const lastPage = (data.meta || {}).last_page || 1;
          hasMore = page < lastPage;
          page++;
        }
        return all;
      };

      const [groups, categories, items] = await Promise.all([
        fetchAll("groups"),
        fetchAll("categories"),
        fetchAll("items"),
      ]);

      // Build lookup maps
      const groupMap = new Map(groups.map((g: any) => [String(g.id), g]));
      const catMap = new Map(categories.map((c: any) => [String(c.id), c]));

      let totalProducts = 0, wineCandidates = 0;

      for (const item of items) {
        const productId = String(item.id || "");
        if (!productId) continue;
        const name = String(item.name || "");
        const cat = catMap.get(String(item.category_id || ""));
        const group = cat ? groupMap.get(String(cat.group_id || "")) : null;
        const family = String(cat?.name || group?.name || "");
        const price = Number(item.price || item.sellingPrice || 0);
        const cls = classify(name, family, price);

        await supabase.from("provider_products").upsert({
          connection_id: connectionId,
          provider_product_id: productId,
          name,
          family,
          price,
          vat_rate: Number(item.tax || item.taxPercentage || 0),
          sale_format: String(item.sellingFormatName || item.format || ""),
          is_wine_candidate: cls.isWine,
          wine_score: cls.score,
          wine_reasons: cls.reasons,
          last_score: cls.score,
          last_reasons: cls.reasons,
          raw_payload: item,
          last_synced_at: new Date().toISOString(),
          sync_status: "SYNCED",
        }, { onConflict: "connection_id,provider_product_id" });

        totalProducts++;
        if (cls.isWine) wineCandidates++;
      }

      await supabase.from("pos_connections").update({
        last_catalog_sync_at: new Date().toISOString(),
        catalog_product_count: totalProducts,
        catalog_wine_candidate_count: wineCandidates,
      }).eq("id", connectionId);

      return json({ success: true, totalProducts, wineCandidates, groups: groups.length, categories: categories.length });
    }

    // ── VALIDATE WRITE DEPENDENCIES ──
    // Checks that required catalog dependencies exist before allowing a write.
    // Returns { valid, missing[], guidance[] }
    async function validateWriteDeps(itemData: any) {
      const missing: { dep: string; message: string; guidance: string }[] = [];

      // 1) Category must exist
      const categoryId = itemData.category_id;
      if (!categoryId) {
        missing.push({
          dep: "category_id",
          message: "No category_id provided. Items require a category in Revo.",
          guidance: "In Revo XEF back-office: Catálogo → Categorías. Create a category, then map it in the wizard Catalog step.",
        });
      } else {
        // Verify category exists in Revo
        try {
          const catRes = await revoFetch(`${REVO_BASE}/v2/catalog/categories/${categoryId}`, revoHeaders, connectionId);
          if (!catRes.ok) {
            missing.push({
              dep: "category_id",
              message: `Category ${categoryId} not found in Revo (HTTP ${catRes.status}).`,
              guidance: "Create the category in Revo XEF back-office first, or update the category_id mapping.",
            });
          } else {
            // Category exists — check it belongs to a group
            const cat = await catRes.json();
            const catData = cat.data || cat;
            if (!catData.group_id) {
              missing.push({
                dep: "group",
                message: `Category ${categoryId} has no parent group assigned.`,
                guidance: "In Revo XEF: Catálogo → Grupos. Assign the category to a group so items appear in the POS menu.",
              });
            }
          }
        } catch (e: any) {
          missing.push({
            dep: "category_id",
            message: `Could not verify category ${categoryId}: ${e.message}`,
            guidance: "Check network connectivity to Revo API.",
          });
        }
      }

      // 2) Tax / VAT rate must be positive
      const tax = Number(itemData.tax ?? itemData.vat_rate ?? 0);
      if (tax <= 0) {
        missing.push({
          dep: "tax",
          message: `Tax/VAT rate is ${tax}. Items need a valid VAT rate.`,
          guidance: "Set a default_vat_rate in the wizard Settings step, or pass tax > 0 in the item payload.",
        });
      }

      // 3) Price must be > 0
      const price = Number(itemData.price ?? 0);
      if (price <= 0) {
        missing.push({
          dep: "price",
          message: `Price is ${price}. Items must have a price > 0 to be sellable.`,
          guidance: "Ensure the Winerim wine has a bottle_sale_price or glass_sale_price set before pushing.",
        });
      }

      // 4) Selling format (optional but recommended)
      const sellingFormat = itemData.selling_format || itemData.sellingFormatName || "";
      if (!sellingFormat) {
        missing.push({
          dep: "selling_format",
          message: "No selling format specified. The item may default to the POS default format.",
          guidance: "In Revo XEF: Catálogo → Formatos de venta. Create formats like 'Botella' or 'Copa', then pass selling_format.",
        });
      }

      return { valid: missing.length === 0, missing };
    }

    // ── VALIDATE-WRITE-DEPS (standalone action) ──
    if (action === "validate-write-deps") {
      const { itemData } = reqBody;
      if (!itemData) return json({ error: "itemData required" }, 400);
      const result = await validateWriteDeps(itemData);
      return json(result);
    }

    // ── UPSERT ITEM (Outbound: Winerim → Revo) ──
    if (action === "upsert-item") {
      const { itemData, taskId, skipValidation } = reqBody;
      if (!itemData) return json({ error: "itemData required" }, 400);

      // Pre-write dependency validation (unless explicitly skipped)
      if (!skipValidation) {
        const deps = await validateWriteDeps(itemData);
        if (!deps.valid) {
          const errorMsg = deps.missing.map((m) => `[${m.dep}] ${m.message}`).join("; ");
          if (taskId) {
            await supabase.from("outbound_tasks").update({
              status: "BLOCKED",
              blocked_reason: errorMsg,
              last_error: `Dependency check failed: ${deps.missing.length} missing`,
            }).eq("id", taskId);
          }
          return json({
            success: false,
            blocked: true,
            error: "Write blocked: missing catalog dependencies",
            missing: deps.missing,
          });
        }
      }

      try {
        // Check if item exists (has external_id)
        let revoItemId = itemData.revo_item_id;
        let method = "POST";
        let endpoint = `${REVO_BASE}/v2/catalog/items`;

        if (revoItemId) {
          method = "PUT";
          endpoint = `${REVO_BASE}/v2/catalog/items/${revoItemId}`;
        }

        const payload = {
          name: itemData.name,
          category_id: itemData.category_id,
          price: itemData.price,
          tax: itemData.tax || 10,
          ...(itemData.extra || {}),
        };

        const res = await revoFetch(endpoint, revoHeaders, connectionId, method, payload);
        if (!res.ok) {
          const errBody = await res.text();
          if (taskId) {
            await supabase.from("outbound_tasks").update({
              status: "FAILED", last_error: `Revo ${res.status}: ${errBody.substring(0, 300)}`,
              attempts: (await supabase.from("outbound_tasks").select("attempts").eq("id", taskId).single()).data?.attempts || 0 + 1,
            } as any).eq("id", taskId);
          }
          return json({ success: false, error: errBody.substring(0, 300) });
        }

        const result = await res.json();
        const newId = String(result.id || result.data?.id || revoItemId || "");

        if (taskId) {
          await supabase.from("outbound_tasks").update({
            status: "SUCCESS", external_id: newId,
          }).eq("id", taskId);
        }

        return json({ success: true, revoItemId: newId });
      } catch (e) {
        if (taskId) {
          await supabase.from("outbound_tasks").update({
            status: "FAILED", last_error: (e as Error).message,
          }).eq("id", taskId);
        }
        return json({ success: false, error: (e as Error).message });
      }
    }

    // ── PROCESS OUTBOUND QUEUE ──
    if (action === "process-outbound-queue") {
      const { data: tasks } = await supabase
        .from("outbound_tasks")
        .select("*")
        .eq("connection_id", connectionId)
        .eq("status", "QUEUED")
        .order("created_at")
        .limit(20);

      if (!tasks?.length) return json({ processed: 0 });

      let processed = 0, blocked = 0;
      for (const task of tasks) {
        await supabase.from("outbound_tasks").update({ status: "RUNNING" }).eq("id", task.id);
        const payload = task.payload_json as any;

        // Pre-write dependency check
        const deps = await validateWriteDeps(payload);
        if (!deps.valid) {
          const reason = deps.missing.map((m) => `[${m.dep}] ${m.message}`).join("; ");
          await supabase.from("outbound_tasks").update({
            status: "BLOCKED",
            blocked_reason: reason,
            last_error: `Dependency check: ${deps.missing.length} missing`,
            attempts: task.attempts + 1,
          }).eq("id", task.id);
          blocked++;
          continue;
        }

        try {
          let method = "POST";
          let endpoint = `${REVO_BASE}/v2/catalog/items`;
          if (payload.revo_item_id) {
            method = "PUT";
            endpoint = `${REVO_BASE}/v2/catalog/items/${payload.revo_item_id}`;
          }
          const itemPayload = {
            name: payload.name || payload.Name,
            category_id: payload.category_id,
            price: payload.price || payload.Price,
            tax: payload.tax || 10,
          };
          const res = await revoFetch(endpoint, revoHeaders, connectionId, method, itemPayload);
          if (!res.ok) {
            const err = await res.text();
            await supabase.from("outbound_tasks").update({
              status: task.attempts + 1 >= task.max_attempts ? "FAILED" : "QUEUED",
              last_error: `Revo ${res.status}: ${err.substring(0, 300)}`,
              attempts: task.attempts + 1,
            }).eq("id", task.id);
          } else {
            const result = await res.json();
            await supabase.from("outbound_tasks").update({
              status: "SUCCESS",
              external_id: String(result.id || result.data?.id || ""),
              attempts: task.attempts + 1,
            }).eq("id", task.id);
            processed++;
          }
        } catch (e) {
          await supabase.from("outbound_tasks").update({
            status: task.attempts + 1 >= task.max_attempts ? "FAILED" : "QUEUED",
            last_error: (e as Error).message,
            attempts: task.attempts + 1,
          }).eq("id", task.id);
        }
      }
      return json({ success: true, processed, blocked });
    }

    // ── QUEUE OUTBOUND PRODUCTS ──
    if (action === "queue-outbound") {
      const { winerimWineIds } = reqBody;
      if (!winerimWineIds?.length) return json({ error: "winerimWineIds required" }, 400);

      const { data: wines } = await supabase
        .from("winerim_wines")
        .select("*")
        .eq("connection_id", connectionId)
        .in("winerim_id", winerimWineIds);

      if (!wines?.length) return json({ queued: 0 });

      let queued = 0;
      for (const wine of wines) {
        await supabase.from("outbound_tasks").insert({
          connection_id: connectionId,
          task_type: "REVO_UPSERT_ITEM",
          payload_json: {
            name: wine.name,
            price: wine.price || 0,
            winerim_id: wine.winerim_id,
            category_id: null, // User must configure
          },
          status: "QUEUED",
        });
        queued++;
      }
      return json({ success: true, queued });
    }

    // ── DETECT CAPABILITIES ──
    if (action === "detect-capabilities") {
      const results: { endpoint: string; status: number; writable: boolean }[] = [];

      // Test catalog read
      const catRes = await revoFetch(`${REVO_BASE}/v2/catalog/items?per_page=1`, revoHeaders, connectionId);
      results.push({ endpoint: "catalog/items", status: catRes.status, writable: false });

      // Test catalog write (try POST with empty body to see if we get 422 vs 403)
      try {
        const writeRes = await revoFetch(`${REVO_BASE}/v2/catalog/items`, revoHeaders, connectionId, "POST", { name: "__test_capability_check__" });
        // If we get 422 (validation error) or 201, write is supported
        const canWrite = writeRes.status === 422 || writeRes.status === 201 || writeRes.status === 200;
        results.push({ endpoint: "catalog/items (write)", status: writeRes.status, writable: canWrite });

        // If we accidentally created it, clean up
        if (writeRes.status === 201 || writeRes.status === 200) {
          try {
            const created = await writeRes.json();
            const createdId = created.id || created.data?.id;
            if (createdId) {
              await revoFetch(`${REVO_BASE}/v2/catalog/items/${createdId}`, revoHeaders, connectionId, "DELETE");
            }
          } catch { /* ignore */ }
        }

        await supabase.from("provider_capabilities").upsert({
          connection_id: connectionId,
          provider: "REVO_XEF",
          can_read_sales: true,
          can_read_catalog: catRes.ok,
          can_write_products: canWrite ? "YES" : "NO",
          write_endpoint: canWrite ? "/v2/catalog/items" : null,
          last_checked_at: new Date().toISOString(),
        }, { onConflict: "connection_id" });
      } catch (e) {
        results.push({ endpoint: "catalog/items (write)", status: 0, writable: false });
      }

      return json({ success: true, results });
    }

    // ── EXPORT PRODUCTS ──
    if (action === "export-products") {
      const { format: expFormat, winerimWineIds } = reqBody;
      let query = supabase.from("winerim_wines").select("*").eq("connection_id", connectionId);
      if (winerimWineIds?.length) query = query.in("winerim_id", winerimWineIds);
      const { data: wines } = await query;
      if (!wines) return json({ products: [] });

      if (expFormat === "csv") {
        const header = "name,winerim_id,price,format,grape_variety,region,winery,vintage\n";
        const rows = wines.map((w: any) =>
          `"${w.name}","${w.winerim_id}","${w.price || ""}","${w.format || ""}","${w.grape_variety || ""}","${w.region || ""}","${w.winery || ""}","${w.vintage || ""}"`
        ).join("\n");
        return new Response(header + rows, { headers: { ...corsHeaders, "Content-Type": "text/csv" } });
      }
      return json({ products: wines });
    }

    // ── VERIFY-WRITE (Post-write verification) ──
    if (action === "verify-write") {
      const { externalId, external_id, revo_item_id, expectedPrice, price, expectedCategory, category_id } = reqBody;
      const itemId = externalId || external_id || revo_item_id || "";

      const result = {
        success: false,
        verified_exists: false,
        verified_prices: false,
        verified_scope: false,
        errors: [] as { code: string; message: string; field?: string; context?: Record<string, unknown> }[],
        warnings: [] as { code: string; message: string; field?: string; context?: Record<string, unknown> }[],
      };

      // 1) Verify scope: can we still reach the catalog API?
      try {
        const scopeRes = await revoFetch(`${REVO_BASE}/v2/catalog/items?per_page=1`, revoHeaders, connectionId);
        if (scopeRes.ok) {
          result.verified_scope = true;
        } else if (scopeRes.status === 401 || scopeRes.status === 403) {
          result.errors.push({ code: "SCOPE_EXPIRED", message: `Catalog API returned ${scopeRes.status}. Token may be expired or permissions revoked.` });
          return json(result);
        } else {
          result.warnings.push({ code: "SCOPE_UNKNOWN", message: `Catalog API returned ${scopeRes.status}. Scope could not be fully verified.` });
          result.verified_scope = true;
        }
      } catch (e: any) {
        result.errors.push({ code: "SCOPE_ERROR", message: `Scope check failed: ${e.message}` });
        return json(result);
      }

      // 2) Verify item exists
      if (!itemId) {
        result.errors.push({ code: "NO_ITEM_ID", message: "No item ID provided for verification. Pass externalId or revo_item_id." });
        return json(result);
      }

      try {
        const itemRes = await revoFetch(`${REVO_BASE}/v2/catalog/items/${itemId}`, revoHeaders, connectionId);
        if (itemRes.ok) {
          result.verified_exists = true;
          const item = await itemRes.json();
          const itemData = item.data || item;

          // 3) Verify price > 0
          const actualPrice = Number(itemData.price || itemData.sellingPrice || 0);
          const expected = Number(expectedPrice || price || 0);
          if (actualPrice > 0) {
            result.verified_prices = true;
            if (expected > 0 && Math.abs(actualPrice - expected) > 0.01) {
              result.warnings.push({
                code: "PRICE_MISMATCH",
                message: `Expected price ${expected}, found ${actualPrice}`,
                field: "price",
                context: { expected, actual: actualPrice },
              });
            }
          } else {
            result.errors.push({
              code: "PRICE_ZERO",
              message: `Item exists but price is ${actualPrice}. Expected > 0.`,
              field: "price",
              context: { actual: actualPrice, expected },
            });
          }

          // 4) Verify family/category assignment
          const actualCategoryId = String(itemData.category_id || itemData.categoryId || "");
          const expectedCatId = String(expectedCategory || category_id || "");
          if (expectedCatId && actualCategoryId) {
            if (actualCategoryId !== expectedCatId) {
              result.warnings.push({
                code: "CATEGORY_MISMATCH",
                message: `Expected category ${expectedCatId}, found ${actualCategoryId}`,
                field: "category_id",
                context: { expected: expectedCatId, actual: actualCategoryId },
              });
            }
          } else if (!actualCategoryId) {
            result.warnings.push({
              code: "NO_CATEGORY",
              message: "Item has no category assigned. It may not appear in the correct menu section.",
              field: "category_id",
            });
          }

          // Check family/group if available
          const groupName = String(itemData.groupName || itemData.group_name || "");
          const categoryName = String(itemData.categoryName || itemData.category_name || "");
          if (groupName || categoryName) {
            result.warnings.push({
              code: "FAMILY_INFO",
              message: `Assigned to: ${[groupName, categoryName].filter(Boolean).join(" → ")}`,
              field: "family",
              context: { group: groupName, category: categoryName },
            });
            // Reclassify as info, not a real warning — remove from warnings if all is fine
          }
        } else if (itemRes.status === 404) {
          result.errors.push({
            code: "NOT_FOUND",
            message: `Item ${itemId} not found in Revo catalog after write.`,
            context: { itemId },
          });
        } else {
          const errText = await itemRes.text();
          result.errors.push({
            code: "FETCH_ERROR",
            message: `Revo returned ${itemRes.status} when verifying item ${itemId}: ${errText.substring(0, 200)}`,
            context: { itemId, status: itemRes.status },
          });
        }
      } catch (e: any) {
        result.errors.push({ code: "VERIFY_ERROR", message: `Verification request failed: ${e.message}` });
      }

      result.success = result.verified_exists && result.verified_prices && result.verified_scope && result.errors.length === 0;
      return json(result);
    }

    return json({ error: `Unknown action: ${action}` }, 400);

  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
