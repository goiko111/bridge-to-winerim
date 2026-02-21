import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// ── Wine classification constants ──
const DEFAULT_WINE_FAMILIES = [
  "wine","wines","red wine","white wine","rosé","sparkling","champagne","prosecco",
  "pinot","cabernet","merlot","chardonnay","sauvignon","zinfandel","syrah","shiraz",
  "riesling","malbec","tempranillo","sangiovese","nebbiolo","moscato",
  "bottle","glass","by the glass","btg","vino","tinto","blanco","rosado","cava","bodega",
];
const NON_WINE_FAMILIES = [
  "water","beer","cocktail","cocktails","spirit","spirits","coffee","tea","juice","soda",
  "soft drink","non-alcoholic","appetizer","entree","main","dessert","side","pizza","pasta",
  "salad","bread","soup","gin","whiskey","vodka","rum","tequila","bourbon","snack",
  "ice cream","fruit","birra","acqua","caffè","bibita",
];
const WINE_PRODUCT_KEYWORDS = [
  "reserve","reserva","riserva","gran","estate","red","white","rosé","sparkling","brut",
  "sec","demi-sec","cabernet","merlot","pinot","chardonnay","sauvignon","zinfandel","syrah",
  "shiraz","malbec","tempranillo","sangiovese","nebbiolo","champagne","prosecco","cava",
  "franciacorta","bottle","glass","btg","75cl","375ml","magnum","napa","sonoma","bordeaux",
  "burgundy","tuscany","rioja","vintage","blend","varietal",
];
const NON_WINE_PRODUCT_KEYWORDS = [
  "water","mineral","coke","pepsi","sprite","tonic","coffee","espresso","latte","cappuccino",
  "beer","ipa","lager","pizza","pasta","burger","fries","salad","bread","gin tonic","whiskey",
  "vodka","rum","mojito","margarita","cake","ice cream","dessert","cheesecake",
];
const WINE_FORMAT_KEYWORDS = [
  "bottle","glass","btg","magnum","jeroboam","75cl","375ml","150cl","by the glass","half bottle",
];
const WINE_PRICE_MIN = 5.0;
const WINE_PRICE_MAX = 500.0;

function computeWineScore(
  family: string | undefined, name: string | undefined,
  format: string | undefined, unitPrice: number,
  wineFamilies: string[], nonWineFamilies: string[],
): { score: number; reasons: string[] } {
  const f = (family || "").toLowerCase();
  const n = (name || "").toLowerCase();
  const fmt = (format || "").toLowerCase();
  let score = 0;
  const reasons: string[] = [];

  for (const wf of nonWineFamilies) {
    if (f.includes(wf)) { score -= 50; reasons.push(`family_non_wine:${wf}`); break; }
  }
  if (score >= 0) {
    for (const wf of wineFamilies) {
      if (f.includes(wf)) { score += 50; reasons.push(`family_wine:${wf}`); break; }
    }
  }
  for (const kw of NON_WINE_PRODUCT_KEYWORDS) {
    if (n.includes(kw)) { score -= 30; reasons.push(`name_non_wine:${kw}`); break; }
  }
  for (const kw of WINE_PRODUCT_KEYWORDS) {
    if (n.includes(kw)) { score += 30; reasons.push(`name_wine:${kw}`); break; }
  }
  for (const kw of WINE_FORMAT_KEYWORDS) {
    if (fmt.includes(kw) || n.includes(kw)) { score += 15; reasons.push(`format_wine:${kw}`); break; }
  }
  if (unitPrice > 0) {
    if (unitPrice >= WINE_PRICE_MIN && unitPrice <= WINE_PRICE_MAX) {
      score += 10; reasons.push(`price_range:${unitPrice}`);
    } else if (unitPrice < WINE_PRICE_MIN) {
      score -= 10; reasons.push(`price_too_low:${unitPrice}`);
    }
  }
  if (!f && score === 0) { score += 5; reasons.push("no_family_fallback"); }
  return { score: Math.max(-100, Math.min(100, score)), reasons };
}

function isWineCandidate(
  family: string | undefined, name: string | undefined, format: string | undefined,
  unitPrice: number, wineFamilies: string[], nonWineFamilies: string[],
) {
  const { score, reasons } = computeWineScore(family, name, format, unitPrice, wineFamilies, nonWineFamilies);
  return { candidate: score > 0, score, reasons };
}

function suggestFamilyClassification(familyName: string) {
  const f = familyName.toLowerCase();
  for (const kw of NON_WINE_FAMILIES) {
    if (f.includes(kw)) return { suggestedWine: false, confidence: "high" as const };
  }
  for (const kw of DEFAULT_WINE_FAMILIES) {
    if (f.includes(kw)) return { suggestedWine: true, confidence: "high" as const };
  }
  if (f.includes("beverage") || f.includes("drink") || f.includes("bar")) {
    return { suggestedWine: false, confidence: "medium" as const };
  }
  return { suggestedWine: false, confidence: "low" as const };
}

// ── Clover API helpers ──
function parseCloverOrders(raw: any): any[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (raw.elements && Array.isArray(raw.elements)) return raw.elements;
  return [];
}

function parseCloverItems(raw: any): any[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (raw.elements && Array.isArray(raw.elements)) return raw.elements;
  return [];
}

function mapCloverLineItem(item: any) {
  return {
    provider_product_id: String(item.item?.id || item.id || ""),
    name: String(item.name || item.item?.name || ""),
    format: "",
    family: String(item.item?.categories?.elements?.[0]?.name || ""),
    quantity: Number(item.unitQty || 1),
    unit_price: Number(item.price || 0) / 100,
    total_amount: Number(item.price || 0) * Number(item.unitQty || 1) / 100,
    vat_rate: 0,
  };
}

// Helper: get auth headers for a connection (uses provider_credentials if available)
async function getAuthHeaders(supabase: any, connection: any): Promise<Record<string, string>> {
  // Try OAuth credentials first
  const { data: cred } = await supabase
    .from("provider_credentials")
    .select("access_token_enc, status")
    .eq("connection_id", connection.id)
    .eq("status", "CONNECTED")
    .single();

  const token = cred?.access_token_enc || connection.api_token;

  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
}

// Rate-limit aware fetch with backoff
async function cloverFetch(url: string, headers: Record<string, string>, retries = 3): Promise<Response> {
  for (let attempt = 0; attempt < retries; attempt++) {
    const res = await fetch(url, { headers });
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get("Retry-After") || "5", 10);
      console.warn(`Rate limited (429). Waiting ${retryAfter}s before retry ${attempt + 1}/${retries}`);
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      continue;
    }
    return res;
  }
  // Final attempt
  return fetch(url, { headers });
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { action, connectionId, businessDay, daysBack, cursor } = await req.json();

    const { data: connection, error: connError } = await supabase
      .from("pos_connections")
      .select("*")
      .eq("id", connectionId)
      .single();

    if (connError || !connection) {
      return new Response(
        JSON.stringify({ error: "Connection not found", details: connError?.message }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const baseUrlClean = connection.base_url.replace(/\/+$/, "");
    const headers = await getAuthHeaders(supabase, connection);

    // ── TEST ──
    if (action === "test") {
      try {
        const res = await cloverFetch(baseUrlClean, headers);
        if (res.ok) {
          const merchant = await res.json();
          return new Response(
            JSON.stringify({ success: true, merchantName: merchant.name || "" }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        return new Response(
          JSON.stringify({ success: false, status: res.status, message: `Clover responded ${res.status}` }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      } catch (e) {
        return new Response(
          JSON.stringify({ success: false, message: e.message }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // ── FETCH CATALOG (Items) ──
    if (action === "fetch-catalog") {
      let allItems: any[] = [];
      let offset = 0;
      const limit = 100;

      while (true) {
        const url = `${baseUrlClean}/items?expand=categories&limit=${limit}&offset=${offset}`;
        const res = await cloverFetch(url, headers);
        if (!res.ok) {
          return new Response(
            JSON.stringify({ error: `Clover responded ${res.status}` }),
            { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        const body = await res.json();
        const items = parseCloverItems(body);
        allItems = allItems.concat(items);
        if (items.length < limit) break;
        offset += limit;
        if (offset > 10000) break;
      }

      // Load family rules
      const { data: familyRules } = await supabase
        .from("wine_family_rules")
        .select("family_name, is_wine")
        .eq("connection_id", connectionId);
      const customWineFamilies = familyRules
        ?.filter((r: any) => r.is_wine)
        .map((r: any) => r.family_name.toLowerCase()) || [];
      const wineFamilies = [...DEFAULT_WINE_FAMILIES, ...customWineFamilies];

      // Map to provider_products format
      const products = allItems.map((item: any) => {
        const name = String(item.name || "");
        const family = String(item.categories?.elements?.[0]?.name || "");
        const price = Number(item.price || 0) / 100;
        const wr = isWineCandidate(family, name, "", price, wineFamilies, NON_WINE_FAMILIES);

        return {
          provider_product_id: String(item.id),
          name,
          family,
          price,
          is_wine_candidate: wr.candidate,
          wine_score: wr.score,
          wine_reasons: wr.reasons,
          raw_payload: item,
        };
      });

      // Upsert into provider_products
      let synced = 0;
      for (const p of products) {
        const { error } = await supabase
          .from("provider_products")
          .upsert(
            {
              connection_id: connectionId,
              provider_product_id: p.provider_product_id,
              name: p.name,
              family: p.family || null,
              price: p.price,
              is_wine_candidate: p.is_wine_candidate,
              wine_score: p.wine_score,
              wine_reasons: p.wine_reasons,
              raw_payload: p.raw_payload,
              last_synced_at: new Date().toISOString(),
              sync_status: "SYNCED",
            },
            { onConflict: "connection_id,provider_product_id" }
          );
        if (!error) synced++;
      }

      // Update connection catalog stats
      const wineCandidates = products.filter((p: any) => p.is_wine_candidate).length;
      await supabase
        .from("pos_connections")
        .update({
          catalog_product_count: products.length,
          catalog_wine_candidate_count: wineCandidates,
          last_catalog_sync_at: new Date().toISOString(),
        })
        .eq("id", connectionId);

      return new Response(
        JSON.stringify({
          success: true,
          totalProducts: products.length,
          wineCandidates,
          synced,
          products,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── FIND LAST BUSINESS DAY WITH SALES ──
    if (action === "find-last-business-day") {
      const scanDays = daysBack || 60;
      const daysWithSales: string[] = [];
      let totalScanned = 0;
      let totalInvoicesFound = 0;

      for (let i = 0; i < scanDays; i++) {
        const dayDate = new Date(Date.now() - i * 86400000);
        const day = dayDate.toISOString().split("T")[0];
        totalScanned++;

        const startOfDay = new Date(day + "T00:00:00Z").getTime();
        const endOfDay = startOfDay + 86400000;

        try {
          const url = `${baseUrlClean}/orders?filter=createdTime>=${startOfDay}&filter=createdTime<${endOfDay}&limit=1`;
          const res = await cloverFetch(url, headers);
          if (res.ok) {
            const body = await res.json();
            const orders = parseCloverOrders(body);
            if (orders.length > 0) {
              daysWithSales.push(day);
              totalInvoicesFound += body.elements?.length || orders.length;
            }
          }
        } catch (_) { /* skip */ }
      }

      return new Response(
        JSON.stringify({ daysWithSales, totalScanned, totalInvoicesFound }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── FETCH & PARSE SALES FOR A BUSINESS DAY ──
    if (action === "fetch-day") {
      const day = businessDay;
      if (!day) {
        return new Response(
          JSON.stringify({ error: "businessDay is required" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const startOfDay = new Date(day + "T00:00:00Z").getTime();
      const endOfDay = startOfDay + 86400000;

      let allOrders: any[] = [];
      let offset = 0;
      const limit = 100;

      while (true) {
        const url = `${baseUrlClean}/orders?filter=createdTime>=${startOfDay}&filter=createdTime<${endOfDay}&expand=lineItems&limit=${limit}&offset=${offset}`;
        const res = await cloverFetch(url, headers);
        if (!res.ok) {
          return new Response(
            JSON.stringify({ error: `Clover responded ${res.status}` }),
            { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        const body = await res.json();
        const orders = parseCloverOrders(body);
        allOrders = allOrders.concat(orders);
        if (orders.length < limit) break;
        offset += limit;
        if (offset > 10000) break;
      }

      // Load wine family rules
      const { data: familyRules } = await supabase
        .from("wine_family_rules")
        .select("family_name, is_wine")
        .eq("connection_id", connectionId);
      const customWineFamilies = familyRules
        ?.filter((r: any) => r.is_wine)
        .map((r: any) => r.family_name.toLowerCase()) || [];
      const wineFamilies = [...DEFAULT_WINE_FAMILIES, ...customWineFamilies];

      const allFamilies = new Set<string>();

      const salesEvents = allOrders.map((order: any) => {
        const docId = String(order.id || "");
        const lineItems = order.lineItems?.elements || [];
        const lines: any[] = [];

        for (const item of lineItems) {
          const mapped = mapCloverLineItem(item);
          if (mapped.family) allFamilies.add(mapped.family);
          const lineTotal = mapped.total_amount > 0 ? mapped.total_amount : mapped.unit_price * mapped.quantity;
          const wr = isWineCandidate(mapped.family, mapped.name, mapped.format, mapped.unit_price, wineFamilies, NON_WINE_FAMILIES);
          lines.push({
            ...mapped,
            total_amount: lineTotal,
            is_wine_candidate: wr.candidate,
            wine_score: wr.score,
            wine_reasons: wr.reasons,
          });
        }

        const total = Number(order.total || 0) / 100;

        return {
          provider_doc_id: docId,
          business_day: day,
          doc_type: String(order.orderType?.label || order.state || "Order"),
          total_amount: total,
          total_tax: Number(order.taxRemoved === false ? (order.total - (order.total / 1.1)) : 0) / 100,
          total_net: total,
          line_count: lines.length,
          lines,
        };
      });

      const detectedFamilies = Array.from(allFamilies).map((f) => {
        const suggestion = suggestFamilyClassification(f);
        const itemCount = salesEvents.reduce((c: number, ev: any) =>
          c + ev.lines.filter((l: any) => l.family === f).length, 0);
        return { name: f, ...suggestion, itemCount };
      });

      return new Response(
        JSON.stringify({ businessDay: day, invoiceCount: allOrders.length, salesEvents, detectedFamilies }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── SAVE SALES TO DB ──
    if (action === "save-sales") {
      const day = businessDay;
      if (!day) {
        return new Response(
          JSON.stringify({ error: "businessDay required" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const startOfDay = new Date(day + "T00:00:00Z").getTime();
      const endOfDay = startOfDay + 86400000;

      let allOrders: any[] = [];
      let offset = 0;
      const limit = 100;

      while (true) {
        const url = `${baseUrlClean}/orders?filter=createdTime>=${startOfDay}&filter=createdTime<${endOfDay}&expand=lineItems&limit=${limit}&offset=${offset}`;
        const res = await cloverFetch(url, headers);
        if (!res.ok) {
          return new Response(
            JSON.stringify({ error: `Clover responded ${res.status}` }),
            { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        const body = await res.json();
        const orders = parseCloverOrders(body);
        allOrders = allOrders.concat(orders);
        if (orders.length < limit) break;
        offset += limit;
        if (offset > 10000) break;
      }

      const { data: familyRules } = await supabase
        .from("wine_family_rules")
        .select("family_name, is_wine")
        .eq("connection_id", connectionId);
      const customWineFamilies = familyRules
        ?.filter((r: any) => r.is_wine)
        .map((r: any) => r.family_name.toLowerCase()) || [];
      const wineFamilies = [...DEFAULT_WINE_FAMILIES, ...customWineFamilies];

      let savedEvents = 0;
      let savedLines = 0;

      for (const order of allOrders) {
        const docId = String(order.id || "");
        const lineItems = order.lineItems?.elements || [];
        const lineData: any[] = [];

        for (const item of lineItems) {
          const mapped = mapCloverLineItem(item);
          const lineTotal = mapped.total_amount > 0 ? mapped.total_amount : mapped.unit_price * mapped.quantity;
          const wr = isWineCandidate(mapped.family, mapped.name, mapped.format, mapped.unit_price, wineFamilies, NON_WINE_FAMILIES);
          lineData.push({
            ...mapped,
            total_amount: lineTotal,
            is_wine_candidate: wr.candidate,
          });
        }

        const total = Number(order.total || 0) / 100;

        const { data: eventRow, error: eventErr } = await supabase
          .from("sales_events")
          .upsert({
            connection_id: connectionId,
            provider_doc_id: docId,
            business_day: day,
            doc_type: String(order.orderType?.label || order.state || "Order"),
            total_amount: total,
            total_tax: 0,
            total_net: total,
            line_count: lineData.length,
            raw_json: order,
          }, { onConflict: "connection_id,provider_doc_id" })
          .select("id")
          .single();

        if (eventErr || !eventRow) continue;
        savedEvents++;

        await supabase.from("sales_line_items").delete().eq("sales_event_id", eventRow.id);

        const linesToInsert = lineData.map((l) => ({
          ...l,
          sales_event_id: eventRow.id,
          connection_id: connectionId,
        }));

        if (linesToInsert.length > 0) {
          const { error: lineErr } = await supabase.from("sales_line_items").insert(linesToInsert);
          if (!lineErr) savedLines += linesToInsert.length;
        }
      }

      await supabase
        .from("pos_connections")
        .update({ last_business_day_synced: day, last_sync_at: new Date().toISOString() })
        .eq("id", connectionId);

      return new Response(
        JSON.stringify({ success: true, savedEvents, savedLines, businessDay: day }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── BACKFILL: Bulk import N days of orders ──
    if (action === "backfill") {
      const days = daysBack || 30;
      let totalEvents = 0;
      let totalLines = 0;
      const errors: string[] = [];

      for (let i = 0; i < days; i++) {
        const dayDate = new Date(Date.now() - i * 86400000);
        const day = dayDate.toISOString().split("T")[0];
        const startOfDay = new Date(day + "T00:00:00Z").getTime();
        const endOfDay = startOfDay + 86400000;

        try {
          let allOrders: any[] = [];
          let offset = 0;
          const limit = 100;

          while (true) {
            const url = `${baseUrlClean}/orders?filter=createdTime>=${startOfDay}&filter=createdTime<${endOfDay}&expand=lineItems&limit=${limit}&offset=${offset}`;
            const res = await cloverFetch(url, headers);
            if (!res.ok) break;
            const body = await res.json();
            const orders = parseCloverOrders(body);
            allOrders = allOrders.concat(orders);
            if (orders.length < limit) break;
            offset += limit;
            if (offset > 5000) break;
          }

          if (allOrders.length === 0) continue;

          const { data: familyRules } = await supabase
            .from("wine_family_rules")
            .select("family_name, is_wine")
            .eq("connection_id", connectionId);
          const customWineFamilies = familyRules
            ?.filter((r: any) => r.is_wine)
            .map((r: any) => r.family_name.toLowerCase()) || [];
          const wineFamilies = [...DEFAULT_WINE_FAMILIES, ...customWineFamilies];

          for (const order of allOrders) {
            const docId = String(order.id || "");
            const lineItems = order.lineItems?.elements || [];
            const lineData: any[] = [];

            for (const item of lineItems) {
              const mapped = mapCloverLineItem(item);
              const lineTotal = mapped.total_amount > 0 ? mapped.total_amount : mapped.unit_price * mapped.quantity;
              const wr = isWineCandidate(mapped.family, mapped.name, mapped.format, mapped.unit_price, wineFamilies, NON_WINE_FAMILIES);
              lineData.push({ ...mapped, total_amount: lineTotal, is_wine_candidate: wr.candidate });
            }

            const total = Number(order.total || 0) / 100;
            const { data: eventRow, error: eventErr } = await supabase
              .from("sales_events")
              .upsert({
                connection_id: connectionId,
                provider_doc_id: docId,
                business_day: day,
                doc_type: String(order.orderType?.label || order.state || "Order"),
                total_amount: total, total_tax: 0, total_net: total,
                line_count: lineData.length, raw_json: order,
              }, { onConflict: "connection_id,provider_doc_id" })
              .select("id")
              .single();

            if (eventErr || !eventRow) continue;
            totalEvents++;

            await supabase.from("sales_line_items").delete().eq("sales_event_id", eventRow.id);
            const linesToInsert = lineData.map((l) => ({ ...l, sales_event_id: eventRow.id, connection_id: connectionId }));
            if (linesToInsert.length > 0) {
              const { error: lineErr } = await supabase.from("sales_line_items").insert(linesToInsert);
              if (!lineErr) totalLines += linesToInsert.length;
            }
          }
        } catch (e: any) {
          errors.push(`Day ${day}: ${e.message}`);
        }
      }

      await supabase
        .from("pos_connections")
        .update({ last_sync_at: new Date().toISOString() })
        .eq("id", connectionId);

      return new Response(
        JSON.stringify({ success: true, totalEvents, totalLines, daysProcessed: days, errors }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ error: "Unknown action" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ error: e.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
