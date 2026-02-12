import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Default wine-like family names (case-insensitive match)
const DEFAULT_WINE_FAMILIES = [
  "vino", "vinos", "bodega", "bodegas", "cava", "cavas", "champagne",
  "espumoso", "espumosos", "tinto", "tintos", "blanco", "blancos",
  "rosado", "rosados", "crianza", "reserva", "bebidas", "wine", "wines",
  "jerez", "manzanilla", "rioja", "ribera", "verdejo", "albariño",
  "tempranillo", "garnacha", "monastrell", "prosecco", "lambrusco",
];

const NON_WINE_FAMILIES = [
  "agua", "water", "snack", "tarta", "postre", "postres", "café", "coffee",
  "té", "tea", "refresco", "refrescos", "zumo", "juice", "cerveza", "beer",
  "pan", "bread", "entrante", "entrantes", "ensalada", "sopa", "helado",
  "licor", "licores", "cocktail", "coctel", "gin", "whisky", "vodka", "ron",
];

const WINE_PRODUCT_KEYWORDS = [
  "reserva", "crianza", "gran reserva", "joven", "roble",
  "tinto", "blanco", "rosado", "cava", "champagne", "espumoso",
  "tempranillo", "garnacha", "cabernet", "merlot", "syrah", "chardonnay",
  "sauvignon", "pinot", "verdejo", "albariño", "monastrell", "godello",
  "rioja", "ribera", "rueda", "priorat", "penedès", "somontano",
  "magnum", "botella", "copa de vino", "75cl", "37.5cl",
];

const NON_WINE_PRODUCT_KEYWORDS = [
  "agua", "mineral", "coca", "fanta", "nestea", "tónica", "refresco",
  "café", "cortado", "infusión", "té", "zumo", "cerveza", "caña",
  "tapa", "ración", "postre", "tarta", "helado", "pan", "ensalada",
  "gin tonic", "whisky", "vodka", "ron", "mojito", "cocktail",
];

const WINE_FORMAT_KEYWORDS = [
  "botella", "copa", "magnum", "jeroboam", "75cl", "37.5cl", "150cl",
  "by the glass", "por copa",
];

// Price thresholds that suggest wine (in euros)
const WINE_PRICE_MIN = 3.0;  // Wines rarely cost less than €3
const WINE_PRICE_MAX = 500.0; // Cap for sanity

interface WineScore {
  score: number; // -100 to 100
  reasons: string[];
}

function computeWineScore(
  family: string | undefined,
  name: string | undefined,
  format: string | undefined,
  unitPrice: number,
  wineFamilies: string[],
  nonWineFamilies: string[],
): WineScore {
  const f = (family || "").toLowerCase();
  const n = (name || "").toLowerCase();
  const fmt = (format || "").toLowerCase();
  let score = 0;
  const reasons: string[] = [];

  // 1. Family matching (strongest signal: ±50)
  for (const wf of nonWineFamilies) {
    if (f.includes(wf)) {
      score -= 50;
      reasons.push(`family_non_wine:${wf}`);
      break;
    }
  }
  if (score >= 0) {
    for (const wf of wineFamilies) {
      if (f.includes(wf)) {
        score += 50;
        reasons.push(`family_wine:${wf}`);
        break;
      }
    }
  }

  // 2. Product name keywords (±30)
  for (const kw of NON_WINE_PRODUCT_KEYWORDS) {
    if (n.includes(kw)) {
      score -= 30;
      reasons.push(`name_non_wine:${kw}`);
      break;
    }
  }
  for (const kw of WINE_PRODUCT_KEYWORDS) {
    if (n.includes(kw)) {
      score += 30;
      reasons.push(`name_wine:${kw}`);
      break;
    }
  }

  // 3. Format keywords (±15)
  for (const kw of WINE_FORMAT_KEYWORDS) {
    if (fmt.includes(kw) || n.includes(kw)) {
      score += 15;
      reasons.push(`format_wine:${kw}`);
      break;
    }
  }

  // 4. Price heuristic (±10)
  if (unitPrice > 0) {
    if (unitPrice >= WINE_PRICE_MIN && unitPrice <= WINE_PRICE_MAX) {
      score += 10;
      reasons.push(`price_range:${unitPrice}`);
    } else if (unitPrice < WINE_PRICE_MIN) {
      score -= 10;
      reasons.push(`price_too_low:${unitPrice}`);
    }
  }

  // 5. No family info fallback: slight positive if name has wine keywords
  if (!f && score === 0) {
    score += 5; // Slight bias towards candidate when unknown
    reasons.push("no_family_fallback");
  }

  return { score: Math.max(-100, Math.min(100, score)), reasons };
}

function isWineCandidate(
  family: string | undefined,
  name: string | undefined,
  format: string | undefined,
  unitPrice: number,
  wineFamilies: string[],
  nonWineFamilies: string[],
): { candidate: boolean; score: number; reasons: string[] } {
  const { score, reasons } = computeWineScore(family, name, format, unitPrice, wineFamilies, nonWineFamilies);
  return { candidate: score > 0, score, reasons };
}

function suggestFamilyClassification(familyName: string): { suggestedWine: boolean; confidence: "high" | "medium" | "low" } {
  const f = familyName.toLowerCase();

  for (const kw of NON_WINE_FAMILIES) {
    if (f.includes(kw)) return { suggestedWine: false, confidence: "high" };
  }
  for (const kw of DEFAULT_WINE_FAMILIES) {
    if (f.includes(kw)) return { suggestedWine: true, confidence: "high" };
  }

  // Medium confidence guesses
  if (f.includes("bebida") || f.includes("drink") || f.includes("bar")) {
    return { suggestedWine: false, confidence: "medium" };
  }

  return { suggestedWine: false, confidence: "low" };
}

// deno-lint-ignore no-explicit-any
function parseInvoices(raw: any): any[] {
  if (!raw) return [];
  // Handle { Invoices: [...] } or direct array
  if (Array.isArray(raw)) return raw;
  if (raw.Invoices && Array.isArray(raw.Invoices)) return raw.Invoices;
  // Handle { Data: { Invoices: [...] } } or similar nested
  if (raw.Data?.Invoices && Array.isArray(raw.Data.Invoices)) return raw.Data.Invoices;
  // Try to find any array property
  for (const key of Object.keys(raw)) {
    if (Array.isArray(raw[key]) && raw[key].length > 0) return raw[key];
  }
  return [];
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
    const headers = { "Api-Token": api_token, Accept: "application/json" };

    // ── TEST ──
    if (action === "test") {
      const today = new Date().toISOString().split("T")[0];
      const url = `${baseUrlClean}/api/export/?business-day=${today}&filter=Invoices`;
      let res = await fetch(url, { headers });
      if (!res.ok) {
        res = await fetch(`${baseUrlClean}/api/export/tickets/`, { headers });
      }
      if (!res.ok) {
        return new Response(
          JSON.stringify({ success: false, status: res.status, message: `Agora responded ${res.status}` }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({ success: true }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
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
          const url = `${baseUrlClean}/api/export/?business-day=${day}&filter=Invoices`;
          const res = await fetch(url, { headers });
          if (res.ok) {
            const body = await res.text();
            const trimmed = body.trim();
            if (trimmed && trimmed !== "{}" && trimmed !== "[]") {
              const parsed = JSON.parse(trimmed);
              const invoices = parseInvoices(parsed);
              if (invoices.length > 0) {
                daysWithSales.push(day);
                totalInvoicesFound += invoices.length;
                consecutiveEmpty = 0;
                continue;
              }
            }
          }
        } catch (_) { /* skip */ }
        consecutiveEmpty++;
        // Stop after 10 consecutive days with no sales (no cash closure)
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

      const url = `${baseUrlClean}/api/export/?business-day=${day}&filter=Invoices`;
      const res = await fetch(url, { headers });
      if (!res.ok) {
        return new Response(
          JSON.stringify({ error: `Agora responded ${res.status}` }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const rawData = await res.json();
      const invoices = parseInvoices(rawData);

      // Load wine family rules for this connection
      const { data: familyRules } = await supabase
        .from("wine_family_rules")
        .select("family_name, is_wine")
        .eq("connection_id", connectionId);

      const customWineFamilies = familyRules
        ?.filter((r: { is_wine: boolean }) => r.is_wine)
        .map((r: { family_name: string }) => r.family_name.toLowerCase()) || [];
      const wineFamilies = [...DEFAULT_WINE_FAMILIES, ...customWineFamilies];

      // Collect all unique families for auto-detection
      const allFamilies = new Set<string>();

      const salesEvents = invoices.map((inv) => {
        const docId = String(inv.InvoiceId || inv.Id || "");
        const items = inv.InvoiceItems || [];
        const lines: {
          provider_product_id: string;
          name: string;
          format: string;
          family: string;
          quantity: number;
          unit_price: number;
          total_amount: number;
          vat_rate: number;
          is_wine_candidate: boolean;
          wine_score: number;
          wine_reasons: string[];
        }[] = [];

        let docTotal = 0;

        for (const item of items) {
          for (const line of (item.Lines || [])) {
            const family = String(line.FamilyName || "");
            if (family) allFamilies.add(family);

            const uPrice = Number(line.UnitPrice || 0);
            const qty = Number(line.Quantity || 0);
            const rawTotal = Number(line.TotalAmount || 0);
            const lineTotal = rawTotal > 0 ? rawTotal : uPrice * qty;
            docTotal += lineTotal;

            const productName = String(line.ProductName || "");
            const formatName = String(line.SaleFormatName || "");
            const uPrice = Number(line.UnitPrice || 0);
            const wineResult = isWineCandidate(family, productName, formatName, uPrice, wineFamilies, NON_WINE_FAMILIES);

            lines.push({
              provider_product_id: String(line.ProductId || ""),
              name: productName,
              format: formatName,
              family,
              quantity: Number(line.Quantity || 0),
              unit_price: uPrice,
              total_amount: lineTotal,
              vat_rate: Number(line.VatRate || 0),
              is_wine_candidate: wineResult.candidate,
              wine_score: wineResult.score,
              wine_reasons: wineResult.reasons,
            });
          }
        }

        return {
          provider_doc_id: docId,
          business_day: day,
          doc_type: String(inv.Type || "BasicInvoice"),
          total_amount: Number(inv.TotalAmount || docTotal),
          total_tax: Number(inv.TotalTaxAmount || 0),
          total_net: Number(inv.TotalNetAmount || 0),
          line_count: lines.length,
          lines,
        };
      });

      // Detect wine-like families with confidence
      const detectedFamilies = Array.from(allFamilies).map((f) => {
        const suggestion = suggestFamilyClassification(f);
        const itemCount = salesEvents.reduce((c: number, ev: { lines: { family: string }[] }) => 
          c + ev.lines.filter((l) => l.family === f).length, 0);
        return {
          name: f,
          ...suggestion,
          itemCount,
        };
      });

      return new Response(
        JSON.stringify({
          businessDay: day,
          invoiceCount: invoices.length,
          salesEvents,
          detectedFamilies,
        }),
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

      // First fetch the parsed data
      const fetchRes = await fetch(req.url, {
        method: "POST",
        headers: { ...Object.fromEntries(req.headers.entries()) },
        body: JSON.stringify({ action: "fetch-day", connectionId, businessDay: day }),
      });

      // Instead of self-calling, inline the fetch
      const url = `${baseUrlClean}/api/export/?business-day=${day}&filter=Invoices`;
      const res = await fetch(url, { headers });
      if (!res.ok) {
        return new Response(
          JSON.stringify({ error: `Agora responded ${res.status}` }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const rawData = await res.json();
      const invoices = parseInvoices(rawData);

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

      for (const inv of invoices) {
        const docId = String(inv.InvoiceId || inv.Id || "");
        const items = inv.InvoiceItems || [];
        let docTotal = 0;
        const lineData: Record<string, unknown>[] = [];

        for (const item of items) {
          for (const line of (item.Lines || [])) {
            const rawTotal = Number(line.TotalAmount || 0);
            const uP = Number(line.UnitPrice || 0);
            const qty = Number(line.Quantity || 0);
            const lineTotal = rawTotal > 0 ? rawTotal : uP * qty;
            docTotal += lineTotal;
            const pName = String(line.ProductName || "");
            const fName = String(line.SaleFormatName || "");
            const fam = String(line.FamilyName || "");
            const wr = isWineCandidate(fam, pName, fName, uP, wineFamilies, NON_WINE_FAMILIES);
            lineData.push({
              provider_product_id: String(line.ProductId || ""),
              name: pName,
              format: fName,
              family: fam,
              quantity: qty,
              unit_price: uP,
              total_amount: lineTotal,
              vat_rate: Number(line.VatRate || 0),
              is_wine_candidate: wr.candidate,
            });
          }
        }

        // Upsert event
        const { data: eventRow, error: eventErr } = await supabase
          .from("sales_events")
          .upsert({
            connection_id: connectionId,
            provider_doc_id: docId,
            business_day: day,
            doc_type: String(inv.Type || "BasicInvoice"),
            total_amount: Number(inv.TotalAmount || docTotal),
            total_tax: Number(inv.TotalTaxAmount || 0),
            total_net: Number(inv.TotalNetAmount || 0),
            line_count: lineData.length,
            raw_json: inv,
          }, { onConflict: "connection_id,provider_doc_id" })
          .select("id")
          .single();

        if (eventErr || !eventRow) continue;
        savedEvents++;

        // Delete old lines for this event then insert new
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

      // Update cursor
      await supabase
        .from("pos_connections")
        .update({ last_business_day_synced: day, last_sync_at: new Date().toISOString() })
        .eq("id", connectionId);

      return new Response(
        JSON.stringify({ success: true, savedEvents, savedLines, businessDay: day }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── DIAGNOSE (legacy) ──
    if (action === "diagnose" || action === "export") {
      const day = businessDay || new Date().toISOString().split("T")[0];
      const url = `${baseUrlClean}/api/export/?business-day=${day}&filter=Invoices`;
      const res = await fetch(url, { headers });
      const data = await res.json();
      return new Response(
        JSON.stringify({ data, status: res.status }),
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
