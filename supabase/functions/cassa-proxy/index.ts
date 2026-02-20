import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cn-signature, x-cn-operation",
};

const CASSA_API_BASE = "https://api.cassanova.com";
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 min
const RATE_LIMIT_MAX = 360;

// In-memory rate limiter per connection (edge function instance)
const rateLimitMap = new Map<string, { count: number; windowStart: number }>();

function checkRateLimit(connectionId: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(connectionId);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(connectionId, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX) return false;
  entry.count++;
  return true;
}

// ── Token cache ──
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

async function getToken(apiKey: string, connectionId: string): Promise<string> {
  const cached = tokenCache.get(connectionId);
  if (cached && Date.now() < cached.expiresAt - 30000) return cached.token;

  const res = await fetch(`${CASSA_API_BASE}/apikey/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token acquisition failed (${res.status}): ${body}`);
  }
  const data = await res.json();
  const token = data.access_token || data.token;
  const expiresIn = (data.expires_in || 3600) * 1000;
  tokenCache.set(connectionId, { token, expiresAt: Date.now() + expiresIn });
  return token;
}

// ── Classification (reuse same logic as agora) ──
const DEFAULT_WINE_FAMILIES = [
  "vino", "vinos", "bodega", "bodegas", "cava", "cavas", "champagne",
  "espumoso", "tinto", "blanco", "rosado", "crianza", "reserva", "wine", "wines",
  "prosecco", "lambrusco", "barolo", "brunello", "chianti", "amarone",
];
const DEFAULT_NON_WINE_FAMILIES = [
  "acqua", "water", "snack", "dolce", "dessert", "caffè", "coffee",
  "birra", "beer", "pizza", "pasta", "antipasto", "contorno", "frutta",
  "liquore", "cocktail", "gin", "whisky", "vodka", "rum", "amaro",
];

// deno-lint-ignore no-explicit-any
function classifyProductSimple(family: string, name: string, price: number): { isWine: boolean; score: number; reasons: string[] } {
  const f = family.toLowerCase();
  const n = name.toLowerCase();
  const reasons: string[] = [];
  let score = 0;

  for (const kw of DEFAULT_NON_WINE_FAMILIES) {
    if (f.includes(kw)) { score -= 50; reasons.push(`family_blacklist:${kw}`); break; }
  }
  for (const kw of DEFAULT_WINE_FAMILIES) {
    if (f.includes(kw)) { score += 50; reasons.push(`family_whitelist:${kw}`); break; }
  }

  const wineKw = ["vino", "tinto", "blanco", "rosado", "champagne", "brut", "barolo", "chianti", "prosecco", "botella", "bottiglia", "75cl", "copa"];
  for (const kw of wineKw) {
    if (n.includes(kw)) { score += 30; reasons.push(`keyword_wine:${kw}`); break; }
  }

  if (price >= 6 && price <= 600 && Math.abs(score) < 30) {
    score += 5; reasons.push(`price_range:${price}`);
  }

  score = Math.max(-100, Math.min(100, score));
  return { isWine: score >= 40, score, reasons };
}

// ── Fetch with rate limit and backoff ──
async function fetchCassa(
  url: string, token: string, connectionId: string, method = "GET", body?: unknown,
): Promise<Response> {
  if (!checkRateLimit(connectionId)) {
    throw new Error("Rate limit exceeded (360 calls/10min). Backing off.");
  }
  const opts: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Version": "1.0.0",
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  if (res.status === 429) {
    // Backoff and retry once after 5s
    await new Promise((r) => setTimeout(r, 5000));
    return fetch(url, opts);
  }
  return res;
}

// ── HMAC SHA-1 webhook verification ──
async function verifyWebhookSignature(payload: string, signature: string, apiKey: string): Promise<boolean> {
  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw", encoder.encode(apiKey), { name: "HMAC", hash: "SHA-1" }, false, ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
    const computed = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
    return computed === signature.toLowerCase();
  } catch {
    return false;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // ── WEBHOOK RECEIVER ──
    const url = new URL(req.url);
    if (url.pathname.endsWith("/webhook")) {
      const signature = req.headers.get("x-cn-signature") || "";
      const operation = req.headers.get("x-cn-operation") || "";
      const body = await req.text();

      // Find connections with provider CASSA_IN_CLOUD
      const { data: connections } = await supabase
        .from("pos_connections")
        .select("id, api_token")
        .eq("provider", "CASSA_IN_CLOUD")
        .eq("enabled", true);

      if (!connections || connections.length === 0) {
        return new Response(JSON.stringify({ error: "No active Cassa connections" }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // Try to verify against any active connection
      let matchedConnection = null;
      for (const conn of connections) {
        if (await verifyWebhookSignature(body, signature, conn.api_token)) {
          matchedConnection = conn;
          break;
        }
      }

      if (!matchedConnection) {
        console.error("[cassa-webhook] Signature verification failed");
        return new Response(JSON.stringify({ error: "Invalid signature" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // Parse webhook payload and enqueue processing
      let payload;
      try { payload = JSON.parse(body); } catch { payload = { raw: body }; }

      console.log(`[cassa-webhook] Received ${operation} for connection ${matchedConnection.id}`);

      // If it's a document/sale event, trigger a fetch
      if (operation === "EVENT" || operation === "ENTITY") {
        // We can process inline or queue - for now log it
        console.log(`[cassa-webhook] Payload:`, JSON.stringify(payload).substring(0, 500));
      }

      return new Response(JSON.stringify({ success: true, connectionId: matchedConnection.id }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── STANDARD ACTIONS ──
    const { action, connectionId, businessDay, daysBack, salesPointIds } = await req.json();

    const { data: connection, error: connError } = await supabase
      .from("pos_connections")
      .select("*")
      .eq("id", connectionId)
      .single();

    if (connError || !connection) {
      return new Response(
        JSON.stringify({ error: "Connection not found", details: connError?.message }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const apiKey = connection.api_token.trim();
    let token: string;
    try {
      token = await getToken(apiKey, connectionId);
    } catch (e) {
      const errMsg = (e as Error).message;
      return new Response(
        JSON.stringify({
          success: false,
          error: `Auth failed: ${errMsg}`,
          diagnostics: [{
            step: "token",
            url: `${CASSA_API_BASE}/apikey/token`,
            method: "POST",
            status: errMsg.match(/\((\d+)\)/)?.[1] ? parseInt(errMsg.match(/\((\d+)\)/)?.[1] || "0") : 0,
            body: errMsg.substring(0, 300),
          }],
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }


    // ── TEST ──
    if (action === "test") {
      const diagnostics: { step: string; url: string; method: string; status: number; body: string }[] = [];
      try {
        diagnostics.push({
          step: "token",
          url: `${CASSA_API_BASE}/apikey/token`,
          method: "POST",
          status: 200,
          body: "Token acquired successfully",
        });

        // Step 2: GET /salespoint?hasActiveLicense=true
        const spUrl = `${CASSA_API_BASE}/salespoint?hasActiveLicense=true`;
        const spRes = await fetchCassa(spUrl, token, connectionId);
        const spText = await spRes.text();
        diagnostics.push({
          step: "healthcheck",
          url: spUrl,
          method: "GET",
          status: spRes.status,
          body: spText.substring(0, 300),
        });

        if (!spRes.ok) {
          return new Response(
            JSON.stringify({ success: false, message: `Salespoint endpoint returned ${spRes.status}`, diagnostics }),
            { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }

        let salesPoints: unknown[] = [];
        let totalCount = 0;
        try {
          const parsed = JSON.parse(spText);
          salesPoints = parsed.salesPoint || parsed.salesPoints || (Array.isArray(parsed) ? parsed : []);
          totalCount = parsed.totalCount ?? salesPoints.length;
        } catch { /* */ }

        return new Response(
          JSON.stringify({ success: true, salesPointCount: totalCount, salesPoints, diagnostics }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      } catch (e) {
        return new Response(
          JSON.stringify({ success: false, message: (e as Error).message, diagnostics }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    // ── FETCH SALES POINTS ──
    if (action === "fetch-sales-points") {
      const spUrl = `${CASSA_API_BASE}/salespoint?hasActiveLicense=true`;
      const res = await fetchCassa(spUrl, token, connectionId);
      if (!res.ok) {
        return new Response(
          JSON.stringify({ error: `Cassa responded ${res.status}`, url: spUrl }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const data = await res.json();
      const salesPoints = data.salesPoint || data.salesPoints || (Array.isArray(data) ? data : []);
      const totalCount = data.totalCount ?? salesPoints.length;
      return new Response(
        JSON.stringify({ success: true, salesPoints, totalCount }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ── FETCH DOCUMENTS (SALES) ──
    if (action === "fetch-documents") {
      // Documents endpoint at root
      const day = businessDay;
      if (!day) {
        return new Response(JSON.stringify({ error: "businessDay is required" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // Build date range for the day
      const datetimeFrom = `${day}T00:00:00`;
      const datetimeTo = `${day}T23:59:59`;

      let allDocuments: unknown[] = [];
      let start = 0;
      const limit = 100;
      let hasMore = true;

      while (hasMore) {
        const params = new URLSearchParams({
          datetimeFrom,
          datetimeTo,
          start: String(start),
          limit: String(limit),
        });
        const res = await fetchCassa(`${CASSA_API_BASE}/documents?${params}`, token, connectionId);
        if (!res.ok) {
          return new Response(
            JSON.stringify({ error: `Cassa responded ${res.status}` }),
            { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
        const data = await res.json();
        const docs = Array.isArray(data) ? data : data.data || data.items || data.documents || [];
        allDocuments = allDocuments.concat(docs);
        if (docs.length < limit) {
          hasMore = false;
        } else {
          start += limit;
        }
      }

      // Normalize documents into SalesEvents
      const salesEvents = allDocuments.map((doc: any) => {
        const docId = String(doc.id || doc.documentId || doc.number || "");
        const items = doc.items || doc.lines || doc.details || [];
        const lines = items.map((item: any) => {
          const family = String(item.departmentName || item.categoryName || item.department || "");
          const name = String(item.description || item.name || item.productName || "");
          const price = Number(item.unitPrice || item.price || 0);
          const qty = Number(item.quantity || 1);
          const total = Number(item.totalAmount || item.amount || price * qty);
          const vatRate = Number(item.taxRate || item.vatRate || 0);
          const cls = classifyProductSimple(family, name, price);

          return {
            provider_product_id: String(item.productId || item.id || ""),
            name, format: "", family,
            quantity: qty, unit_price: price, total_amount: total,
            vat_rate: vatRate, is_wine_candidate: cls.isWine,
            wine_score: cls.score, wine_reasons: cls.reasons,
          };
        });

        return {
          provider_doc_id: docId,
          business_day: day,
          doc_type: String(doc.type || doc.documentType || "receipt"),
          total_amount: Number(doc.totalAmount || doc.total || 0),
          total_tax: Number(doc.totalTax || doc.taxAmount || 0),
          total_net: Number(doc.totalNet || doc.netAmount || 0),
          line_count: lines.length,
          lines,
        };
      });

      return new Response(
        JSON.stringify({ businessDay: day, documentCount: allDocuments.length, salesEvents }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ── SAVE SALES TO DB ──
    if (action === "save-sales") {
      const day = businessDay;
      if (!day) {
        return new Response(JSON.stringify({ error: "businessDay required" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // Fetch documents first
      const datetimeFrom = `${day}T00:00:00`;
      const datetimeTo = `${day}T23:59:59`;
      let allDocuments: any[] = [];
      let start = 0;
      const limit = 100;
      let hasMore = true;

      while (hasMore) {
        const params = new URLSearchParams({ datetimeFrom, datetimeTo, start: String(start), limit: String(limit) });
        const res = await fetchCassa(`${CASSA_API_BASE}/documents?${params}`, token, connectionId);
        if (!res.ok) break;
        const data = await res.json();
        const docs = Array.isArray(data) ? data : data.data || data.items || data.documents || [];
        allDocuments = allDocuments.concat(docs);
        hasMore = docs.length >= limit;
        start += limit;
      }

      let savedEvents = 0;
      let savedLines = 0;

      for (const doc of allDocuments) {
        const docId = String(doc.id || doc.documentId || doc.number || "");
        if (!docId) continue;
        const items = doc.items || doc.lines || doc.details || [];
        const lineData: Record<string, unknown>[] = [];
        let docTotal = 0;

        for (const item of items) {
          const family = String(item.departmentName || item.categoryName || item.department || "");
          const name = String(item.description || item.name || item.productName || "");
          const price = Number(item.unitPrice || item.price || 0);
          const qty = Number(item.quantity || 1);
          const total = Number(item.totalAmount || item.amount || price * qty);
          docTotal += total;
          const cls = classifyProductSimple(family, name, price);

          lineData.push({
            provider_product_id: String(item.productId || item.id || ""),
            name, format: "", family,
            quantity: qty, unit_price: price, total_amount: total,
            vat_rate: Number(item.taxRate || item.vatRate || 0),
            is_wine_candidate: cls.isWine,
          });
        }

        const { data: eventRow, error: eventErr } = await supabase
          .from("sales_events")
          .upsert({
            connection_id: connectionId, provider_doc_id: docId, business_day: day,
            doc_type: String(doc.type || doc.documentType || "receipt"),
            total_amount: Number(doc.totalAmount || doc.total || docTotal),
            total_tax: Number(doc.totalTax || doc.taxAmount || 0),
            total_net: Number(doc.totalNet || doc.netAmount || 0),
            line_count: lineData.length, raw_json: doc,
          }, { onConflict: "connection_id,provider_doc_id" })
          .select("id").single();

        if (eventErr || !eventRow) continue;
        savedEvents++;

        await supabase.from("sales_line_items").delete().eq("sales_event_id", eventRow.id);
        const linesToInsert = lineData.map((l) => ({ ...l, sales_event_id: eventRow.id, connection_id: connectionId }));
        if (linesToInsert.length > 0) {
          const { error: lineErr } = await supabase.from("sales_line_items").insert(linesToInsert);
          if (!lineErr) savedLines += linesToInsert.length;
        }
      }

      await supabase.from("pos_connections")
        .update({ last_business_day_synced: day, last_sync_at: new Date().toISOString() })
        .eq("id", connectionId);

      return new Response(
        JSON.stringify({ success: true, savedEvents, savedLines, businessDay: day }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ── FETCH PRODUCTS (CATALOG) ──
    if (action === "fetch-products") {
      // Products endpoint at root
      let allProducts: any[] = [];
      let start = 0;
      const limit = 100;
      let hasMore = true;

      while (hasMore) {
        const params = new URLSearchParams({ start: String(start), limit: String(limit) });
        const res = await fetchCassa(`${CASSA_API_BASE}/products?${params}`, token, connectionId);
        if (!res.ok) {
          return new Response(
            JSON.stringify({ error: `Cassa responded ${res.status}` }),
            { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
        const data = await res.json();
        const products = Array.isArray(data) ? data : data.data || data.items || data.products || [];
        allProducts = allProducts.concat(products);
        hasMore = products.length >= limit;
        start += limit;
      }

      return new Response(
        JSON.stringify({ success: true, productCount: allProducts.length, products: allProducts.slice(0, 10) }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ── SYNC PRODUCTS TO DB ──
    if (action === "sync-products") {
      // Sync products at root
      let allProducts: any[] = [];
      let start = 0;
      const limit = 100;
      let hasMore = true;

      while (hasMore) {
        const params = new URLSearchParams({ start: String(start), limit: String(limit) });
        const res = await fetchCassa(`${CASSA_API_BASE}/products?${params}`, token, connectionId);
        if (!res.ok) break;
        const data = await res.json();
        const products = Array.isArray(data) ? data : data.data || data.items || data.products || [];
        allProducts = allProducts.concat(products);
        hasMore = products.length >= limit;
        start += limit;
      }

      let upserted = 0;
      let wineCandidates = 0;

      for (const product of allProducts) {
        const prodId = String(product.id || product.productId || "");
        if (!prodId) continue;
        const name = String(product.description || product.name || "Unknown");
        const family = String(product.departmentName || product.categoryName || product.department || "");
        const price = Number(product.price || product.unitPrice || 0);
        const vatRate = Number(product.taxRate || product.vatRate || 0);
        const cls = classifyProductSimple(family, name, price);
        if (cls.isWine) wineCandidates++;

        await supabase.from("provider_products").upsert({
          connection_id: connectionId, provider_product_id: prodId,
          name, family, vat_rate: vatRate, sale_format: "", price,
          is_wine_candidate: cls.isWine,
          wine_score: cls.score, wine_reasons: cls.reasons,
          classification_override: "AUTO",
          last_score: cls.score, last_reasons: cls.reasons,
          raw_payload: product,
        }, { onConflict: "connection_id,provider_product_id" });
        upserted++;
      }

      await supabase.from("pos_connections").update({
        catalog_product_count: upserted,
        catalog_wine_candidate_count: wineCandidates,
        last_catalog_sync_at: new Date().toISOString(),
      }).eq("id", connectionId);

      return new Response(
        JSON.stringify({ success: true, totalProducts: upserted, wineCandidates }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ── BACKFILL ──
    if (action === "backfill") {
      const days = daysBack || 30;
      let totalSaved = 0;
      let totalLines = 0;
      const errors: string[] = [];

      for (let i = 0; i < days; i++) {
        const day = new Date(Date.now() - i * 86400000).toISOString().split("T")[0];
        try {
          const datetimeFrom = `${day}T00:00:00`;
          const datetimeTo = `${day}T23:59:59`;
          const params = new URLSearchParams({ datetimeFrom, datetimeTo, start: "0", limit: "500" });
          const res = await fetchCassa(`${CASSA_API_BASE}/documents?${params}`, token, connectionId);
          if (!res.ok) { errors.push(`${day}: HTTP ${res.status}`); continue; }
          const data = await res.json();
          const docs = Array.isArray(data) ? data : data.data || data.items || data.documents || [];
          if (docs.length === 0) continue;

          for (const doc of docs) {
            const docId = String(doc.id || doc.documentId || doc.number || "");
            if (!docId) continue;
            const items = doc.items || doc.lines || doc.details || [];
            const lineData: Record<string, unknown>[] = [];

            for (const item of items) {
              const family = String(item.departmentName || item.categoryName || "");
              const name = String(item.description || item.name || "");
              const price = Number(item.unitPrice || item.price || 0);
              const qty = Number(item.quantity || 1);
              const total = Number(item.totalAmount || item.amount || price * qty);
              const cls = classifyProductSimple(family, name, price);
              lineData.push({
                provider_product_id: String(item.productId || item.id || ""),
                name, format: "", family,
                quantity: qty, unit_price: price, total_amount: total,
                vat_rate: Number(item.taxRate || item.vatRate || 0),
                is_wine_candidate: cls.isWine,
              });
            }

            const { data: eventRow, error: eventErr } = await supabase
              .from("sales_events")
              .upsert({
                connection_id: connectionId, provider_doc_id: docId, business_day: day,
                doc_type: String(doc.type || "receipt"),
                total_amount: Number(doc.totalAmount || doc.total || 0),
                total_tax: Number(doc.totalTax || 0),
                total_net: Number(doc.totalNet || 0),
                line_count: lineData.length, raw_json: doc,
              }, { onConflict: "connection_id,provider_doc_id" })
              .select("id").single();

            if (eventErr || !eventRow) continue;
            totalSaved++;

            await supabase.from("sales_line_items").delete().eq("sales_event_id", eventRow.id);
            const linesToInsert = lineData.map((l) => ({ ...l, sales_event_id: eventRow.id, connection_id: connectionId }));
            if (linesToInsert.length > 0) {
              const { error: lineErr } = await supabase.from("sales_line_items").insert(linesToInsert);
              if (!lineErr) totalLines += linesToInsert.length;
            }
          }
        } catch (e) {
          errors.push(`${day}: ${(e as Error).message}`);
        }
      }

      await supabase.from("pos_connections")
        .update({ last_sync_at: new Date().toISOString() })
        .eq("id", connectionId);

      return new Response(
        JSON.stringify({ success: true, totalSaved, totalLines, daysProcessed: days, errors: errors.slice(0, 10) }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({ error: `Unknown action: ${action}` }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("[cassa-proxy] Error:", e);
    return new Response(
      JSON.stringify({ error: (e as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
