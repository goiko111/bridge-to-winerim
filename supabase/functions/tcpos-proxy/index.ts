import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// Wine family keywords (Italian-centric + international)
const DEFAULT_WINE_FAMILIES = [
  "vino", "vini", "vino rosso", "vino bianco", "rosato", "spumante",
  "prosecco", "champagne", "franciacorta", "lambrusco", "chianti",
  "barolo", "brunello", "amarone", "primitivo", "nero d'avola",
  "montepulciano", "sangiovese", "nebbiolo", "barbera", "dolcetto",
  "vermentino", "pinot grigio", "trebbiano", "moscato",
  "bollicine", "cantina", "bottiglia", "calice",
  "wine", "wines", "bodega", "cava", "tinto", "blanco",
];

const NON_WINE_FAMILIES = [
  "acqua", "water", "birra", "beer", "cocktail", "aperitivo",
  "caffè", "coffee", "tè", "tea", "succo", "juice",
  "bibita", "bibite", "soft drink", "soda",
  "antipasto", "primo", "secondo", "contorno", "dolce", "dessert",
  "pizza", "pasta", "insalata", "pane", "coperto",
  "gin", "whisky", "vodka", "rum", "amaro", "grappa", "limoncello",
  "snack", "gelato", "frutta",
];

const WINE_PRODUCT_KEYWORDS = [
  "riserva", "classico", "superiore", "gran selezione",
  "rosso", "bianco", "rosato", "spumante", "brut",
  "sangiovese", "nebbiolo", "barbera", "primitivo", "nero d'avola",
  "cabernet", "merlot", "syrah", "chardonnay", "pinot",
  "chianti", "barolo", "brunello", "amarone", "valpolicella",
  "prosecco", "franciacorta", "lambrusco", "moscato",
  "bottiglia", "calice", "75cl", "37.5cl", "magnum",
  "doc", "docg", "igt", "dop",
];

const NON_WINE_PRODUCT_KEYWORDS = [
  "acqua", "minerale", "coca", "fanta", "sprite", "tonica",
  "caffè", "espresso", "cappuccino", "birra", "peroni",
  "pizza", "pasta", "antipasto", "insalata", "pane",
  "gin tonic", "whisky", "vodka", "rum", "mojito", "spritz",
  "tiramisù", "gelato", "dolce", "coperto",
];

const WINE_FORMAT_KEYWORDS = [
  "bottiglia", "calice", "magnum", "jeroboam", "75cl", "37.5cl", "150cl",
  "by the glass", "al calice",
];

const WINE_PRICE_MIN = 3.0;
const WINE_PRICE_MAX = 500.0;

function computeWineScore(
  family: string | undefined,
  name: string | undefined,
  format: string | undefined,
  unitPrice: number,
  wineFamilies: string[],
  nonWineFamilies: string[],
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
  if (f.includes("bevanda") || f.includes("drink") || f.includes("bar")) {
    return { suggestedWine: false, confidence: "medium" as const };
  }
  return { suggestedWine: false, confidence: "low" as const };
}

// TCPOS / Kumo API helpers
function buildBasicAuth(user: string, password: string): string {
  return "Basic " + btoa(`${user}:${password}`);
}

// Parse TCPOS sales response - adapt to actual Kumo V8 structure
// deno-lint-ignore no-explicit-any
function parseTcposSales(raw: any): any[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  // Kumo API might return { value: [...] } or { items: [...] } or { data: [...] }
  if (raw.value && Array.isArray(raw.value)) return raw.value;
  if (raw.items && Array.isArray(raw.items)) return raw.items;
  if (raw.data && Array.isArray(raw.data)) return raw.data;
  if (raw.Data && Array.isArray(raw.Data)) return raw.Data;
  // Try any array property
  for (const key of Object.keys(raw)) {
    if (Array.isArray(raw[key]) && raw[key].length > 0) return raw[key];
  }
  return [];
}

// deno-lint-ignore no-explicit-any
function mapTcposLineItem(item: any) {
  return {
    provider_product_id: String(item.articleId || item.ArticleId || item.productId || item.id || ""),
    name: String(item.articleName || item.ArticleName || item.name || item.description || ""),
    format: String(item.formatName || item.format || item.unitName || ""),
    family: String(item.groupName || item.GroupName || item.familyName || item.category || ""),
    quantity: Number(item.quantity || item.Quantity || 0),
    unit_price: Number(item.unitPrice || item.UnitPrice || item.price || 0),
    total_amount: Number(item.totalAmount || item.TotalAmount || item.amount || 0),
    vat_rate: Number(item.vatRate || item.VatRate || item.taxRate || 0),
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { action, connectionId, businessDay, daysBack } = await req.json();

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

    const { base_url, api_token } = connection;
    const baseUrlClean = base_url.replace(/\/+$/, "");
    
    // TCPOS uses Basic auth: api_token stores "user:password"
    const authHeader = buildBasicAuth(
      api_token.split(":")[0] || "",
      api_token.split(":")[1] || ""
    );
    const headers: Record<string, string> = {
      "Authorization": authHeader,
      "Accept": "application/json",
      "Content-Type": "application/json",
    };

    // ── TEST ──
    if (action === "test") {
      try {
        // Try a lightweight endpoint to verify connectivity
        const testUrl = `${baseUrlClean}/api/v8/articles?$top=1`;
        const res = await fetch(testUrl, { headers });
        if (res.ok) {
          return new Response(
            JSON.stringify({ success: true }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        // Fallback: try root or info endpoint
        const fallbackUrl = `${baseUrlClean}/api/v8/info`;
        const res2 = await fetch(fallbackUrl, { headers });
        if (res2.ok) {
          return new Response(
            JSON.stringify({ success: true }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        return new Response(
          JSON.stringify({ success: false, status: res.status, message: `TCPOS responded ${res.status}` }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      } catch (e) {
        return new Response(
          JSON.stringify({ success: false, message: e.message }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // ── FIND LAST BUSINESS DAY WITH SALES ──
    if (action === "find-last-business-day") {
      const scanDays = daysBack || 60;
      const daysWithSales: string[] = [];
      let consecutiveEmpty = 0;
      let totalScanned = 0;
      let totalInvoicesFound = 0;

      for (let i = 0; i < scanDays; i++) {
        const day = new Date(Date.now() - i * 86400000).toISOString().split("T")[0];
        totalScanned++;
        try {
          // TCPOS Kumo V8: query sales/orders by date
          const url = `${baseUrlClean}/api/v8/sales?date=${day}`;
          const res = await fetch(url, { headers });
          if (res.ok) {
            const body = await res.text();
            const trimmed = body.trim();
            if (trimmed && trimmed !== "{}" && trimmed !== "[]") {
              const parsed = JSON.parse(trimmed);
              const sales = parseTcposSales(parsed);
              if (sales.length > 0) {
                daysWithSales.push(day);
                totalInvoicesFound += sales.length;
                consecutiveEmpty = 0;
                continue;
              }
            }
          }
        } catch (_) { /* skip */ }
        consecutiveEmpty++;
        if (consecutiveEmpty >= 10 && daysWithSales.length > 0) break;
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

      const url = `${baseUrlClean}/api/v8/sales?date=${day}`;
      const res = await fetch(url, { headers });
      if (!res.ok) {
        return new Response(
          JSON.stringify({ error: `TCPOS responded ${res.status}` }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const rawData = await res.json();
      const sales = parseTcposSales(rawData);

      // Load wine family rules
      const { data: familyRules } = await supabase
        .from("wine_family_rules")
        .select("family_name, is_wine")
        .eq("connection_id", connectionId);

      const customWineFamilies = familyRules
        ?.filter((r: { is_wine: boolean }) => r.is_wine)
        .map((r: { family_name: string }) => r.family_name.toLowerCase()) || [];
      const wineFamilies = [...DEFAULT_WINE_FAMILIES, ...customWineFamilies];

      const allFamilies = new Set<string>();

      const salesEvents = sales.map((sale: Record<string, unknown>) => {
        const docId = String(sale.id || sale.Id || sale.saleId || sale.receiptNumber || "");
        const items = (sale.items || sale.Items || sale.lines || sale.Lines || sale.details || []) as Record<string, unknown>[];
        const lines: Record<string, unknown>[] = [];
        let docTotal = 0;

        for (const item of items) {
          const mapped = mapTcposLineItem(item);
          if (mapped.family) allFamilies.add(mapped.family);

          const lineTotal = mapped.total_amount > 0 ? mapped.total_amount : mapped.unit_price * mapped.quantity;
          docTotal += lineTotal;

          const wr = isWineCandidate(mapped.family, mapped.name, mapped.format, mapped.unit_price, wineFamilies, NON_WINE_FAMILIES);

          lines.push({
            ...mapped,
            total_amount: lineTotal,
            is_wine_candidate: wr.candidate,
            wine_score: wr.score,
            wine_reasons: wr.reasons,
          });
        }

        return {
          provider_doc_id: docId,
          business_day: day,
          doc_type: String(sale.type || sale.Type || "Receipt"),
          total_amount: Number(sale.totalAmount || sale.TotalAmount || sale.total || docTotal),
          total_tax: Number(sale.totalTax || sale.TotalTax || sale.taxAmount || 0),
          total_net: Number(sale.totalNet || sale.TotalNet || sale.netAmount || 0),
          line_count: lines.length,
          lines,
        };
      });

      const detectedFamilies = Array.from(allFamilies).map((f) => {
        const suggestion = suggestFamilyClassification(f);
        const itemCount = salesEvents.reduce((c: number, ev: { lines: { family: string }[] }) =>
          c + ev.lines.filter((l: { family: string }) => l.family === f).length, 0);
        return { name: f, ...suggestion, itemCount };
      });

      return new Response(
        JSON.stringify({ businessDay: day, invoiceCount: sales.length, salesEvents, detectedFamilies }),
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

      const url = `${baseUrlClean}/api/v8/sales?date=${day}`;
      const res = await fetch(url, { headers });
      if (!res.ok) {
        return new Response(
          JSON.stringify({ error: `TCPOS responded ${res.status}` }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const rawData = await res.json();
      const sales = parseTcposSales(rawData);

      const { data: familyRules } = await supabase
        .from("wine_family_rules")
        .select("family_name, is_wine")
        .eq("connection_id", connectionId);

      const customWineFamilies = familyRules
        ?.filter((r: { is_wine: boolean }) => r.is_wine)
        .map((r: { family_name: string }) => r.family_name.toLowerCase()) || [];
      const wineFamilies = [...DEFAULT_WINE_FAMILIES, ...customWineFamilies];

      let savedEvents = 0;
      let savedLines = 0;

      for (const sale of sales) {
        const docId = String(sale.id || sale.Id || sale.saleId || sale.receiptNumber || "");
        const items = (sale.items || sale.Items || sale.lines || sale.Lines || sale.details || []) as Record<string, unknown>[];
        let docTotal = 0;
        const lineData: Record<string, unknown>[] = [];

        for (const item of items) {
          const mapped = mapTcposLineItem(item);
          const lineTotal = mapped.total_amount > 0 ? mapped.total_amount : mapped.unit_price * mapped.quantity;
          docTotal += lineTotal;
          const wr = isWineCandidate(mapped.family, mapped.name, mapped.format, mapped.unit_price, wineFamilies, NON_WINE_FAMILIES);
          lineData.push({
            ...mapped,
            total_amount: lineTotal,
            is_wine_candidate: wr.candidate,
          });
        }

        const { data: eventRow, error: eventErr } = await supabase
          .from("sales_events")
          .upsert({
            connection_id: connectionId,
            provider_doc_id: docId,
            business_day: day,
            doc_type: String(sale.type || sale.Type || "Receipt"),
            total_amount: Number(sale.totalAmount || sale.TotalAmount || sale.total || docTotal),
            total_tax: Number(sale.totalTax || sale.TotalTax || sale.taxAmount || 0),
            total_net: Number(sale.totalNet || sale.TotalNet || sale.netAmount || 0),
            line_count: lineData.length,
            raw_json: sale,
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

    return new Response(
      JSON.stringify({ error: "Unknown action" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
