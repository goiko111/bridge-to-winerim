import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// Wine detection keywords
const DEFAULT_WINE_FAMILIES = [
  "wine", "wines", "red wine", "white wine", "rosé", "sparkling",
  "champagne", "prosecco", "pinot", "cabernet", "merlot", "chardonnay",
  "sauvignon", "zinfandel", "syrah", "shiraz", "riesling", "malbec",
  "tempranillo", "sangiovese", "nebbiolo", "moscato",
  "bottle", "glass", "by the glass", "btg",
  "vino", "tinto", "blanco", "rosado", "cava", "bodega",
];

const NON_WINE_FAMILIES = [
  "water", "beer", "cocktail", "cocktails", "spirit", "spirits",
  "coffee", "tea", "juice", "soda", "soft drink", "non-alcoholic",
  "appetizer", "entree", "main", "dessert", "side",
  "pizza", "pasta", "salad", "bread", "soup",
  "gin", "whiskey", "vodka", "rum", "tequila", "bourbon",
  "snack", "ice cream", "fruit",
  "birra", "acqua", "caffè", "bibita",
];

const WINE_PRODUCT_KEYWORDS = [
  "reserve", "reserva", "riserva", "gran", "estate",
  "red", "white", "rosé", "sparkling", "brut", "sec", "demi-sec",
  "cabernet", "merlot", "pinot", "chardonnay", "sauvignon", "zinfandel",
  "syrah", "shiraz", "malbec", "tempranillo", "sangiovese", "nebbiolo",
  "champagne", "prosecco", "cava", "franciacorta",
  "bottle", "glass", "btg", "75cl", "375ml", "magnum",
  "napa", "sonoma", "bordeaux", "burgundy", "tuscany", "rioja",
  "vintage", "blend", "varietal",
];

const NON_WINE_PRODUCT_KEYWORDS = [
  "water", "mineral", "coke", "pepsi", "sprite", "tonic",
  "coffee", "espresso", "latte", "cappuccino", "beer", "ipa", "lager",
  "pizza", "pasta", "burger", "fries", "salad", "bread",
  "gin tonic", "whiskey", "vodka", "rum", "mojito", "margarita",
  "cake", "ice cream", "dessert", "cheesecake",
];

const WINE_FORMAT_KEYWORDS = [
  "bottle", "glass", "btg", "magnum", "75cl", "375ml", "150cl",
  "by the glass", "half bottle",
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

// Simphony check mapping
// deno-lint-ignore no-explicit-any
function mapSimphonyMenuItem(item: any) {
  return {
    provider_product_id: String(item.menuItemId || item.objectNum || ""),
    name: String(item.name || item.longDescriptor || ""),
    format: "",
    family: String(item.familyGroupName || item.majorGroupName || ""),
    quantity: Number(item.quantity || 1),
    unit_price: Number(item.price || 0),
    total_amount: Number(item.total || item.price || 0) * Number(item.quantity || 1),
    vat_rate: 0,
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
    // base_url stores the Simphony host (e.g. https://myorg.oracleindustry.com)
    // api_token stores the id_token (Bearer)
    // location_name stores orgShortName|locRef|rvcRef (pipe-separated)
    const baseUrlClean = base_url.replace(/\/+$/, "");

    // Parse org/loc/rvc from location_name (format: "LocationLabel|orgShortName|locRef|rvcRef")
    const parts = (connection.location_name || "").split("|");
    const locationLabel = parts[0] || "";
    const orgShortName = parts[1] || "";
    const locRef = parts[2] || "";
    const rvcRef = parts[3] || "";

    const stsHeaders: Record<string, string> = {
      "Authorization": `Bearer ${api_token}`,
      "Accept": "application/json",
      "Content-Type": "application/json",
      "Simphony-OrgShortName": orgShortName,
      "Simphony-LocRef": locRef,
      "Simphony-RvcRef": rvcRef,
    };

    // ── TEST ──
    if (action === "test") {
      try {
        // Test by fetching checks with a limit of 1
        const url = `${baseUrlClean}/api/v1/checks?includeClosed=true&limit=1`;
        const res = await fetch(url, { headers: stsHeaders });
        if (res.ok) {
          const body = await res.json();
          return new Response(
            JSON.stringify({
              success: true,
              merchantName: `${orgShortName} / ${locRef}`,
              checkCount: Array.isArray(body) ? body.length : (body.items?.length || 0),
            }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        const errBody = await res.text();
        return new Response(
          JSON.stringify({ success: false, status: res.status, message: `Simphony responded ${res.status}: ${errBody.slice(0, 200)}` }),
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
      let totalScanned = 0;
      let totalInvoicesFound = 0;

      // Simphony: use sinceTime and iterate day by day (or weekly chunks)
      for (let i = 0; i < scanDays; i += 7) {
        const sinceDate = new Date(Date.now() - Math.min(i + 7, scanDays) * 86400000);
        const untilDate = new Date(Date.now() - i * 86400000);

        try {
          const url = `${baseUrlClean}/api/v1/checks?includeClosed=true&sinceTime=${sinceDate.toISOString()}&limit=500`;
          const res = await fetch(url, { headers: stsHeaders });
          if (res.ok) {
            const body = await res.json();
            const checks = Array.isArray(body) ? body : (body.items || body.checks || []);
            totalInvoicesFound += checks.length;

            for (const check of checks) {
              const openTime = check.openTime || check.closedTime || check.createdAt;
              if (openTime) {
                const day = new Date(openTime).toISOString().split("T")[0];
                // Filter to within our scan window
                if (day <= untilDate.toISOString().split("T")[0] && !daysWithSales.includes(day)) {
                  daysWithSales.push(day);
                }
              }
            }
          } else {
            await res.text();
          }
        } catch (_) { /* skip */ }

        totalScanned += Math.min(7, scanDays - i);
      }

      daysWithSales.sort((a, b) => b.localeCompare(a));

      return new Response(
        JSON.stringify({ daysWithSales: daysWithSales.slice(0, 30), totalScanned, totalInvoicesFound }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── FETCH & PARSE SALES FOR A BUSINESS DAY ──
    if (action === "fetch-day") {
      const day = businessDay;
      if (!day) {
        return new Response(JSON.stringify({ error: "businessDay is required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      const sinceTime = `${day}T00:00:00Z`;
      // Fetch closed checks since start of day
      let allChecks: any[] = [];
      try {
        const url = `${baseUrlClean}/api/v1/checks?includeClosed=true&sinceTime=${sinceTime}&limit=1000`;
        const res = await fetch(url, { headers: stsHeaders });
        if (!res.ok) {
          const t = await res.text();
          return new Response(JSON.stringify({ error: `Simphony responded ${res.status}` }), {
            status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }
        const body = await res.json();
        allChecks = Array.isArray(body) ? body : (body.items || body.checks || []);
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      // Filter to just the requested day
      allChecks = allChecks.filter((check: any) => {
        const openTime = check.openTime || check.closedTime || "";
        return openTime.startsWith(day);
      });

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

      const salesEvents = allChecks.map((check: any) => {
        const docId = String(check.checkId || check.id || "");
        const menuItems = check.menuItems || check.detailLines || [];
        const lines: any[] = [];

        for (const item of menuItems) {
          const mapped = mapSimphonyMenuItem(item);
          if (mapped.family) allFamilies.add(mapped.family);

          const wr = isWineCandidate(mapped.family, mapped.name, mapped.format, mapped.unit_price, wineFamilies, NON_WINE_FAMILIES);
          lines.push({
            ...mapped,
            is_wine_candidate: wr.candidate,
            wine_score: wr.score,
            wine_reasons: wr.reasons,
          });
        }

        const totals = check.totals || {};
        const totalAmount = Number(totals.subtotal || totals.total || check.total || 0);
        const totalTax = Number(totals.tax || check.taxTotal || 0);

        return {
          provider_doc_id: docId,
          business_day: day,
          doc_type: check.checkType || "Check",
          total_amount: totalAmount,
          total_tax: totalTax,
          total_net: totalAmount - totalTax,
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
        JSON.stringify({ businessDay: day, invoiceCount: allChecks.length, salesEvents, detectedFamilies }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── SAVE SALES TO DB ──
    if (action === "save-sales") {
      const day = businessDay;
      if (!day) {
        return new Response(JSON.stringify({ error: "businessDay required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      const sinceTime = `${day}T00:00:00Z`;
      let allChecks: any[] = [];
      try {
        const url = `${baseUrlClean}/api/v1/checks?includeClosed=true&sinceTime=${sinceTime}&limit=1000`;
        const res = await fetch(url, { headers: stsHeaders });
        if (!res.ok) { await res.text(); }
        const body = await res.json();
        allChecks = Array.isArray(body) ? body : (body.items || body.checks || []);
      } catch (_) { /* skip */ }

      allChecks = allChecks.filter((check: any) => {
        const openTime = check.openTime || check.closedTime || "";
        return openTime.startsWith(day);
      });

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

      for (const check of allChecks) {
        const docId = String(check.checkId || check.id || "");
        const menuItems = check.menuItems || check.detailLines || [];
        const lineData: any[] = [];

        for (const item of menuItems) {
          const mapped = mapSimphonyMenuItem(item);
          const wr = isWineCandidate(mapped.family, mapped.name, mapped.format, mapped.unit_price, wineFamilies, NON_WINE_FAMILIES);
          lineData.push({ ...mapped, is_wine_candidate: wr.candidate });
        }

        const totals = check.totals || {};
        const totalAmount = Number(totals.subtotal || totals.total || check.total || 0);
        const totalTax = Number(totals.tax || check.taxTotal || 0);

        const { data: eventRow, error: eventErr } = await supabase
          .from("sales_events")
          .upsert({
            connection_id: connectionId,
            provider_doc_id: docId,
            business_day: day,
            doc_type: check.checkType || "Check",
            total_amount: totalAmount,
            total_tax: totalTax,
            total_net: totalAmount - totalTax,
            line_count: lineData.length,
            raw_json: check,
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
  } catch (e) {
    return new Response(
      JSON.stringify({ error: e.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
