import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const WINERIM_BASE_URL = "https://app.winerim.com/api/v2";

// ── Fuzzy matching helpers ──
function normalize(s: string): string {
  return s.toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(s: string): Set<string> {
  return new Set(normalize(s).split(" ").filter(t => t.length > 1));
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  const intersection = new Set([...a].filter(x => b.has(x)));
  const union = new Set([...a, ...b]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return dp[m][n];
}

function levenshteinSimilarity(a: string, b: string): number {
  const na = normalize(a), nb = normalize(b);
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(na, nb) / maxLen;
}

interface MatchCandidate {
  winerim_id: string;
  winerim_name: string;
  score: number;
  method: string;
  reasons: string[];
}

function findBestMatches(
  posName: string,
  posSku: string | null,
  posFamily: string | null,
  winerimWines: { winerim_id: string; name: string; sku: string | null; ean: string | null; winery: string | null; grape_variety: string | null; format: string | null }[],
  maxResults = 3,
): MatchCandidate[] {
  const candidates: MatchCandidate[] = [];

  for (const wine of winerimWines) {
    let score = 0;
    const reasons: string[] = [];
    let method = "FUZZY";

    if (posSku && posSku.length > 2) {
      if (wine.sku && normalize(wine.sku) === normalize(posSku)) {
        score += 100;
        reasons.push("sku_exact_match");
        method = "SKU";
      }
      if (wine.ean && normalize(wine.ean) === normalize(posSku)) {
        score += 100;
        reasons.push("ean_exact_match");
        method = "SKU";
      }
    }

    const posTokens = tokenize(posName);
    const wineTokens = tokenize(wine.name);
    const jaccard = jaccardSimilarity(posTokens, wineTokens);
    if (jaccard > 0) {
      score += Math.round(jaccard * 60);
      reasons.push(`jaccard:${jaccard.toFixed(2)}`);
    }

    const levSim = levenshteinSimilarity(posName, wine.name);
    if (levSim > 0.3) {
      score += Math.round(levSim * 30);
      reasons.push(`levenshtein:${levSim.toFixed(2)}`);
    }

    if (wine.winery) {
      const wineryNorm = normalize(wine.winery);
      if (normalize(posName).includes(wineryNorm) && wineryNorm.length > 2) {
        score += 15;
        reasons.push(`winery_match:${wine.winery}`);
      }
    }

    if (wine.grape_variety) {
      const grapeNorm = normalize(wine.grape_variety);
      if (normalize(posName).includes(grapeNorm) && grapeNorm.length > 2) {
        score += 10;
        reasons.push(`grape_match:${wine.grape_variety}`);
      }
    }

    if (posFamily && wine.winery) {
      const famNorm = normalize(posFamily);
      const wineryNorm = normalize(wine.winery);
      if (famNorm.includes(wineryNorm) || wineryNorm.includes(famNorm)) {
        score += 5;
        reasons.push("family_winery_overlap");
      }
    }

    if (score > 10) {
      candidates.push({ winerim_id: wine.winerim_id, winerim_name: wine.name, score: Math.min(score, 100), method, reasons });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, maxResults);
}

// Helper to build Winerim headers with correct auth
function buildWinerimHeaders(token: string): Record<string, string> {
  return {
    "WINERIM-API-TOKEN": token,
    "Content-Type": "application/json",
    "Accept": "application/json",
  };
}

// Fetch all wines from Winerim with pagination
async function fetchAllWines(headers: Record<string, string>): Promise<Record<string, unknown>[]> {
  const allWines: Record<string, unknown>[] = [];
  let page = 1;
  const limit = 100;

  while (true) {
    const url = `${WINERIM_BASE_URL}/wines?page=${page}&limit=${limit}`;
    console.log(`Fetching wines page ${page}: ${url}`);
    const res = await fetch(url, { headers });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Winerim API error ${res.status}: ${errBody.substring(0, 500)}`);
    }

    const data = await res.json();

    // Response format: { success: true, pagination: {...}, wines: [...] }
    const wines = data?.wines || [];
    if (!Array.isArray(wines) || wines.length === 0) break;

    allWines.push(...wines);

    const totalPages = data?.pagination?.total_pages || 1;
    if (page >= totalPages) break;
    page++;
  }

  return allWines;
}

// Fetch individual wine detail to get pricing fields
// Tries multiple endpoint patterns since Winerim API may vary
async function fetchWineDetail(wineId: string, headers: Record<string, string>): Promise<Record<string, unknown> | null> {
  const endpointsToTry = [
    `${WINERIM_BASE_URL}/wines/${wineId}`,
    `${WINERIM_BASE_URL}/wine/${wineId}`,
    `${WINERIM_BASE_URL}/wines/${wineId}/detail`,
  ];

  for (const url of endpointsToTry) {
    try {
      const res = await fetch(url, { headers });
      const body = await res.text();
      if (!res.ok) {
        console.log(`Wine detail ${wineId} (${url}): HTTP ${res.status}`);
        continue;
      }
      try {
        const data = JSON.parse(body);
        const wine = data?.wine || data;
        console.log(`Wine detail ${wineId} SUCCESS via ${url}: keys=[${Object.keys(wine).join(",")}]`);
        return wine;
      } catch {
        console.log(`Wine detail ${wineId}: non-JSON from ${url}`);
        continue;
      }
    } catch (e) {
      console.error(`Wine detail ${wineId} (${url}) failed:`, e);
      continue;
    }
  }
  return null;
}

// Batch fetch wine details with concurrency control
async function fetchWineDetails(
  wineIds: string[],
  headers: Record<string, string>,
  concurrency = 5,
): Promise<Map<string, Record<string, unknown>>> {
  const results = new Map<string, Record<string, unknown>>();
  
  for (let i = 0; i < wineIds.length; i += concurrency) {
    const batch = wineIds.slice(i, i + concurrency);
    const promises = batch.map(async (id) => {
      const detail = await fetchWineDetail(id, headers);
      if (detail) results.set(id, detail);
    });
    await Promise.all(promises);
    // Small delay between batches to avoid rate limiting
    if (i + concurrency < wineIds.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  return results;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const body = await req.json();
    const { action, connectionId } = body;

    // Fetch connection
    const { data: connection, error: connError } = await supabase
      .from("pos_connections")
      .select("*")
      .eq("id", connectionId)
      .single();

    if (connError || !connection) {
      return new Response(
        JSON.stringify({ error: "Connection not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const winerimToken = (connection.winerim_api_token || "").trim();
    if (!winerimToken) {
      return new Response(
        JSON.stringify({ error: "No Winerim API token configured for this connection" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const winerimHeaders = buildWinerimHeaders(winerimToken);

    // ── FETCH WINE CATALOG ──
    if (action === "fetch-catalog") {
      const wines = await fetchAllWines(winerimHeaders);

      // Detail fetch is done separately via 'fetch-wine-details' action
      // The list endpoint provides: type, name, winery, region, vintage, country
      // Pricing requires the standalone detail fetch
      const detailMap = new Map<string, Record<string, unknown>>();
      const wineIds = wines.map(w => String(w.id || "")).filter(Boolean);

      // ── EXTRACT NORMALIZED POS-READY FIELDS ──
      // Parses Winerim's prices array: [{variant: "botella"|"copa"|"magnum"|..., price: N, erpStock: {...}}]
      function extractNormalizedFields(listWine: Record<string, unknown>, detail: Record<string, unknown> | null) {
        const w = { ...listWine, ...(detail || {}) };

        // Wine type
        const rawType = w.type || w.wine_type || w.category || w.style || w.color || w.colour;
        const wineType = rawType && typeof rawType === "string" && rawType.length > 0 ? String(rawType).toLowerCase() : null;

        // ── Parse prices array from Winerim API ──
        const prices = Array.isArray(w.prices) ? w.prices as { variant: string; price: number; erpStock?: { stock?: number } }[] : [];
        
        // Find prices by variant
        const bottleEntry = prices.find(p => p.variant === "botella" || p.variant === "botella-pequena" || p.variant === "media-botella");
        const glassEntry = prices.find(p => p.variant === "copa");
        const magnumEntry = prices.find(p => p.variant === "magnum");

        // Bottle pricing: from prices array, then fallback to explicit fields
        const bottleSalePrice = toPositiveNumber(bottleEntry?.price) ?? toPositiveNumber(w.bottle_sale_price ?? w.sale_price ?? w.pvp ?? w.price);
        const bottlePurchasePrice = toPositiveNumber(w.bottle_purchase_price ?? w.purchase_price ?? w.cost_price ?? w.cost);

        // Glass pricing: from prices array
        const glassSalePrice = toPositiveNumber(glassEntry?.price) ?? toPositiveNumber(w.glass_sale_price ?? w.glass_price);
        const glassCostPrice = toPositiveNumber(w.glass_cost_price ?? w.glass_cost);

        // Magnum pricing: from prices array
        const magnumSalePrice = toPositiveNumber(magnumEntry?.price) ?? toPositiveNumber(w.magnum_sale_price);
        const magnumPurchasePrice = toPositiveNumber(w.magnum_purchase_price ?? w.magnum_cost);

        // serve_by_glass: true if a 'copa' variant exists in prices
        const serveByGlass = !!glassEntry || w.serve_by_glass === true || w.by_glass === true || w.copa === true || false;

        // is_active: from 'active' field in detail response
        const isActive = w.active !== false && w.is_active !== false && w.status !== "inactive";

        // Stock from bottle entry
        const stockQuantity = bottleEntry?.erpStock?.stock ?? null;

        return { wineType, bottleSalePrice, bottlePurchasePrice, glassSalePrice, glassCostPrice, magnumSalePrice, magnumPurchasePrice, serveByGlass, isActive, stockQuantity };
      }

      function toPositiveNumber(val: unknown): number | null {
        if (val === null || val === undefined) return null;
        const n = Number(val);
        return n > 0 ? n : null;
      }

      // Load existing wines for change detection
      const { data: existingWines } = await supabase
        .from("winerim_wines")
        .select("winerim_id, name, wine_type, bottle_sale_price, bottle_purchase_price, glass_sale_price, glass_cost_price, is_active")
        .eq("connection_id", connectionId);
      const existingMap = new Map((existingWines || []).map((w: any) => [w.winerim_id, w]));

      // Track which wines actually changed exportable fields
      const changedWineIds: string[] = [];
      const newWineIds: string[] = [];
      let detailsFound = 0;

      let upserted = 0;
      for (const w of wines) {
        const winerimId = String(w.id || "");
        if (!winerimId) continue;

        const detail = detailMap.get(winerimId) || null;
        if (detail) detailsFound++;

        let grapeVariety: string | null = null;
        // Check both list and detail for grapes
        const grapes = (detail?.grapes || w.grapes) as { name: string }[] | undefined;
        if (Array.isArray(grapes) && grapes.length > 0) {
          grapeVariety = grapes.map(g => g.name).join(", ");
        }

        const nf = extractNormalizedFields(w, detail);
        const existing = existingMap.get(winerimId);

        // Detect if this is new or changed
        if (!existing) {
          newWineIds.push(winerimId);
        } else {
          const changed =
            String(w.name || "Unknown") !== existing.name ||
            nf.wineType !== existing.wine_type ||
            nf.bottleSalePrice !== (existing.bottle_sale_price ? Number(existing.bottle_sale_price) : null) ||
            nf.bottlePurchasePrice !== (existing.bottle_purchase_price ? Number(existing.bottle_purchase_price) : null) ||
            nf.glassSalePrice !== (existing.glass_sale_price ? Number(existing.glass_sale_price) : null) ||
            nf.glassCostPrice !== (existing.glass_cost_price ? Number(existing.glass_cost_price) : null) ||
            nf.isActive !== existing.is_active;
          if (changed) changedWineIds.push(winerimId);
        }

        // Merge raw_payload with detail data for reference
        const mergedPayload = { ...w, ...(detail || {}) };

        await supabase.from("winerim_wines").upsert({
          connection_id: connectionId,
          winerim_id: winerimId,
          name: String(detail?.name || w.name || "Unknown"),
          sku: (detail?.identifier || w.identifier) ? String(detail?.identifier || w.identifier) : null,
          ean: detail?.ean ? String(detail.ean) : null,
          vintage: (detail?.vintage || w.vintage) ? String(detail?.vintage || w.vintage) : null,
          winery: (detail?.winery || w.winery) ? String(detail?.winery || w.winery) : null,
          region: (detail?.region || w.region) ? String(detail?.region || w.region) : null,
          grape_variety: grapeVariety,
          format: (detail?.subname || w.subname) ? String(detail?.subname || w.subname) : null,
          price: nf.bottleSalePrice,
          stock_quantity: nf.stockQuantity != null ? nf.stockQuantity : toPositiveNumber(detail?.stock ?? w.stock),
          raw_payload: mergedPayload,
          // Normalized POS-ready fields
          wine_type: nf.wineType,
          bottle_sale_price: nf.bottleSalePrice,
          bottle_purchase_price: nf.bottlePurchasePrice,
          glass_sale_price: nf.glassSalePrice,
          glass_cost_price: nf.glassCostPrice,
          magnum_sale_price: nf.magnumSalePrice,
          magnum_purchase_price: nf.magnumPurchasePrice,
          serve_by_glass: nf.serveByGlass,
          is_active: nf.isActive,
        }, { onConflict: "connection_id,winerim_id" });
        upserted++;
      }

      // ── AUTO-PUSH TRIGGER (only on meaningful changes) ──
      try {
        const { data: agoraConnections } = await supabase
          .from("pos_connections")
          .select("id, auto_push_on_create, auto_push_on_update, write_mode, winerim_api_token")
          .eq("provider", "agora")
          .eq("write_mode", "XML_IMPORT")
          .eq("winerim_api_token", winerimToken);

        if (agoraConnections && agoraConnections.length > 0) {
          for (const agoraConn of agoraConnections) {
            if (!agoraConn.auto_push_on_create && !agoraConn.auto_push_on_update) continue;

            if (agoraConn.auto_push_on_create && newWineIds.length > 0) {
              await supabase.functions.invoke("agora-proxy", {
                body: { action: "evaluate-auto-push", connectionId: agoraConn.id, winerimWineIds: newWineIds, eventType: "CREATE" },
              }).catch((e: Error) => console.error("Auto-push CREATE failed:", e));
            }

            if (agoraConn.auto_push_on_update && changedWineIds.length > 0) {
              await supabase.functions.invoke("agora-proxy", {
                body: { action: "evaluate-auto-push", connectionId: agoraConn.id, winerimWineIds: changedWineIds, eventType: "UPDATE" },
              }).catch((e: Error) => console.error("Auto-push UPDATE failed:", e));
            }
          }
        }
      } catch (e) {
        console.error("Auto-push trigger failed (non-blocking):", e);
      }

      return new Response(
        JSON.stringify({
          success: true,
          totalWines: upserted,
          detailsFetched: detailsFound,
          detailsMissing: wineIds.length - detailsFound,
          newWines: newWineIds.length,
          changedWines: changedWineIds.length,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── FETCH WINE DETAILS (standalone, for enriching existing wines) ──
    if (action === "fetch-wine-details") {
      const { winerimWineIds } = body;
      
      // If specific IDs provided, use those. Otherwise fetch all wines missing pricing.
      let targetIds: string[] = winerimWineIds || [];
      
      if (targetIds.length === 0) {
        const { data: missingPricing } = await supabase
          .from("winerim_wines")
          .select("winerim_id")
          .eq("connection_id", connectionId)
          .is("bottle_sale_price", null)
          .limit(100);
        targetIds = (missingPricing || []).map((w: any) => w.winerim_id);
      }

      if (targetIds.length === 0) {
        return new Response(
          JSON.stringify({ success: true, enriched: 0, message: "All wines already have pricing data" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      console.log(`Fetching details for ${targetIds.length} wines...`);
      const detailMap = await fetchWineDetails(targetIds, winerimHeaders, 5);
      
      let enriched = 0;
      const fieldsDiscovered: string[] = [];

      for (const [winerimId, detail] of detailMap) {
        // Log first detail to discover available fields
        if (enriched === 0) {
          const keys = Object.keys(detail);
          fieldsDiscovered.push(...keys);
          console.log(`Wine detail fields discovered: ${keys.join(", ")}`);
        }

        function toPositiveNumber(val: unknown): number | null {
          if (val === null || val === undefined) return null;
          const n = Number(val);
          return n > 0 ? n : null;
        }

        // Parse prices array from Winerim detail response
        const prices = Array.isArray(detail.prices) ? detail.prices as { variant: string; price: number; erpStock?: { stock?: number } }[] : [];
        const bottleEntry = prices.find((p: any) => p.variant === "botella" || p.variant === "botella-pequena" || p.variant === "media-botella");
        const glassEntry = prices.find((p: any) => p.variant === "copa");
        const magnumEntry = prices.find((p: any) => p.variant === "magnum");

        const rawType = detail.type || detail.wine_type || detail.category || detail.style || detail.color;
        const updateData: Record<string, unknown> = {
          raw_payload: detail,
          wine_type: rawType && typeof rawType === "string" ? String(rawType).toLowerCase() : undefined,
          bottle_sale_price: toPositiveNumber(bottleEntry?.price) ?? toPositiveNumber(detail.bottle_sale_price ?? detail.sale_price ?? detail.pvp ?? detail.price),
          bottle_purchase_price: toPositiveNumber(detail.bottle_purchase_price ?? detail.purchase_price ?? detail.cost_price ?? detail.cost),
          glass_sale_price: toPositiveNumber(glassEntry?.price) ?? toPositiveNumber(detail.glass_sale_price ?? detail.glass_price),
          glass_cost_price: toPositiveNumber(detail.glass_cost_price ?? detail.glass_cost),
          magnum_sale_price: toPositiveNumber(magnumEntry?.price) ?? toPositiveNumber(detail.magnum_sale_price),
          magnum_purchase_price: toPositiveNumber(detail.magnum_purchase_price),
          serve_by_glass: !!glassEntry || detail.serve_by_glass === true || detail.by_glass === true || undefined,
          is_active: detail.active !== false && detail.is_active !== false ? true : false,
          stock_quantity: bottleEntry?.erpStock?.stock ?? undefined,
        };

        // Remove undefined values
        for (const key of Object.keys(updateData)) {
          if (updateData[key] === undefined) delete updateData[key];
        }

        await supabase.from("winerim_wines")
          .update(updateData)
          .eq("connection_id", connectionId)
          .eq("winerim_id", winerimId);
        enriched++;
      }

      return new Response(
        JSON.stringify({
          success: true,
          requested: targetIds.length,
          enriched,
          detailsMissing: targetIds.length - enriched,
          fieldsDiscovered: fieldsDiscovered.slice(0, 50),
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── MATCH PRODUCTS (SKU + Fuzzy) ──
    if (action === "match-products") {
      const { data: posProducts } = await supabase
        .from("provider_products")
        .select("provider_product_id, name, family, sale_format, price")
        .eq("connection_id", connectionId)
        .eq("is_wine_candidate", true)
        .limit(1000);

      const { data: winerimWines } = await supabase
        .from("winerim_wines")
        .select("winerim_id, name, sku, ean, winery, grape_variety, format")
        .eq("connection_id", connectionId)
        .limit(1000);

      if (!posProducts || posProducts.length === 0) {
        return new Response(
          JSON.stringify({ success: true, matched: 0, message: "No wine candidate products to match" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      if (!winerimWines || winerimWines.length === 0) {
        return new Response(
          JSON.stringify({ success: false, error: "No Winerim wines cached. Fetch catalog first." }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      let matched = 0;
      let skuMatched = 0;
      let fuzzyMatched = 0;
      let noMatch = 0;

      for (const pos of posProducts) {
        const { data: existing } = await supabase
          .from("product_mappings")
          .select("id, status")
          .eq("connection_id", connectionId)
          .eq("provider_product_id", pos.provider_product_id)
          .limit(1);

        if (existing && existing.length > 0 && existing[0].status === "CONFIRMED") continue;

        const candidates = findBestMatches(
          pos.name,
          pos.provider_product_id,
          pos.family,
          winerimWines as any[],
          3,
        );

        if (candidates.length === 0) {
          noMatch++;
          continue;
        }

        const best = candidates[0];
        const status = best.score >= 80 ? "CONFIRMED" : "PENDING";

        await supabase.from("product_mappings").upsert({
          connection_id: connectionId,
          provider_product_id: pos.provider_product_id,
          provider_product_name: pos.name,
          winerim_wine_id: best.winerim_id,
          winerim_wine_name: best.winerim_name,
          match_method: best.method,
          match_score: best.score,
          match_reasons: best.reasons,
          status,
        }, { onConflict: "connection_id,provider_product_id" });

        matched++;
        if (best.method === "SKU") skuMatched++;
        else fuzzyMatched++;

        if (status === "CONFIRMED") {
          await supabase.from("sales_line_items")
            .update({ winerim_product_id: best.winerim_id, mapped: true })
            .eq("connection_id", connectionId)
            .eq("provider_product_id", pos.provider_product_id);
        }
      }

      return new Response(
        JSON.stringify({ success: true, matched, skuMatched, fuzzyMatched, noMatch, totalPosProducts: posProducts.length, totalWinerimWines: winerimWines.length }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── AI MATCH (for low-confidence matches) ──
    if (action === "ai-match") {
      const lovableApiKey = Deno.env.get("LOVABLE_API_KEY");
      if (!lovableApiKey) {
        return new Response(
          JSON.stringify({ success: false, error: "AI gateway not configured" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const { data: pendingMappings } = await supabase
        .from("product_mappings")
        .select("id, provider_product_id, provider_product_name, winerim_wine_id, winerim_wine_name, match_score")
        .eq("connection_id", connectionId)
        .eq("status", "PENDING")
        .order("match_score", { ascending: true })
        .limit(20);

      if (!pendingMappings || pendingMappings.length === 0) {
        return new Response(
          JSON.stringify({ success: true, processed: 0, message: "No pending mappings to review" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const { data: winerimWines } = await supabase
        .from("winerim_wines")
        .select("winerim_id, name, winery, grape_variety, vintage, region")
        .eq("connection_id", connectionId)
        .limit(500);

      const wineList = (winerimWines || []).map((w: any) =>
        `${w.winerim_id}: ${w.name}${w.winery ? ` (${w.winery})` : ""}${w.vintage ? ` ${w.vintage}` : ""}`
      ).join("\n");

      const posItems = pendingMappings.map((m: any) =>
        `POS:"${m.provider_product_name}" current_match:"${m.winerim_wine_name}" score:${m.match_score}`
      ).join("\n");

      const prompt = `You are a wine product matching expert. Given POS product names and a wine catalog, determine the best match for each POS product.

WINE CATALOG:
${wineList}

POS PRODUCTS TO MATCH:
${posItems}

For each POS product, respond with a JSON array of objects:
[{"pos_name": "...", "best_winerim_id": "..." or null if no match, "confidence": 0-100, "reasoning": "..."}]

Consider: abbreviations (bot.=botella), formats (75cl, copa), wine names may be partial, different orderings.
If the current match looks correct, confirm it. If a better match exists, suggest it. If no match, return null.
Respond ONLY with the JSON array, no other text.`;

      const aiRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${lovableApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "google/gemini-3-flash-preview",
          messages: [{ role: "user", content: prompt }],
          temperature: 0.1,
        }),
      });

      if (!aiRes.ok) {
        const errText = await aiRes.text();
        return new Response(
          JSON.stringify({ success: false, error: `AI gateway error: ${aiRes.status}`, details: errText.substring(0, 500) }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const aiData = await aiRes.json();
      const content = aiData?.choices?.[0]?.message?.content || "";

      let aiResults: { pos_name: string; best_winerim_id: string | null; confidence: number; reasoning: string }[] = [];
      try {
        const jsonMatch = content.match(/\[[\s\S]*\]/);
        if (jsonMatch) aiResults = JSON.parse(jsonMatch[0]);
      } catch {
        return new Response(
          JSON.stringify({ success: false, error: "Failed to parse AI response", raw: content.substring(0, 1000) }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      let updated = 0;
      for (const aiMatch of aiResults) {
        const mapping = pendingMappings.find((m: any) => m.provider_product_name === aiMatch.pos_name);
        if (!mapping) continue;

        if (aiMatch.best_winerim_id && aiMatch.confidence >= 70) {
          const winerimWine = (winerimWines || []).find((w: any) => w.winerim_id === aiMatch.best_winerim_id);
          await supabase.from("product_mappings").update({
            winerim_wine_id: aiMatch.best_winerim_id,
            winerim_wine_name: winerimWine?.name || mapping.winerim_wine_name,
            match_method: "AI",
            match_score: aiMatch.confidence,
            match_reasons: [`ai:${aiMatch.reasoning}`],
            status: aiMatch.confidence >= 85 ? "CONFIRMED" : "PENDING",
          }).eq("id", mapping.id);

          if (aiMatch.confidence >= 85) {
            await supabase.from("sales_line_items")
              .update({ winerim_product_id: aiMatch.best_winerim_id, mapped: true })
              .eq("connection_id", connectionId)
              .eq("provider_product_id", mapping.provider_product_id);
          }
          updated++;
        } else if (!aiMatch.best_winerim_id) {
          await supabase.from("product_mappings").update({
            match_method: "AI",
            match_reasons: [`ai_no_match:${aiMatch.reasoning}`],
          }).eq("id", mapping.id);
          updated++;
        }
      }

      return new Response(
        JSON.stringify({ success: true, processed: pendingMappings.length, updated, aiResults }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── CONFIRM MAPPING ──
    if (action === "confirm-mapping") {
      const { mappingId, winerimWineId, winerimWineName } = body;
      if (!mappingId) {
        return new Response(JSON.stringify({ error: "mappingId required" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const updateData: Record<string, unknown> = { status: "CONFIRMED" };
      if (winerimWineId) {
        updateData.winerim_wine_id = winerimWineId;
        updateData.winerim_wine_name = winerimWineName || "";
        updateData.match_method = "MANUAL";
        updateData.match_score = 100;
      }

      const { error } = await supabase.from("product_mappings").update(updateData).eq("id", mappingId);
      if (error) {
        return new Response(JSON.stringify({ error: error.message }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const { data: mapping } = await supabase.from("product_mappings").select("*").eq("id", mappingId).single();
      if (mapping) {
        await supabase.from("sales_line_items")
          .update({ winerim_product_id: mapping.winerim_wine_id, mapped: true })
          .eq("connection_id", connectionId)
          .eq("provider_product_id", mapping.provider_product_id);
      }

      return new Response(
        JSON.stringify({ success: true }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── REJECT MAPPING ──
    if (action === "reject-mapping") {
      const { mappingId } = body;
      await supabase.from("product_mappings").update({ status: "REJECTED" }).eq("id", mappingId);
      return new Response(JSON.stringify({ success: true }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── IGNORE MAPPING ──
    if (action === "ignore-mapping") {
      const { mappingId } = body;
      await supabase.from("product_mappings").update({ status: "IGNORED" }).eq("id", mappingId);
      return new Response(JSON.stringify({ success: true }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── UPDATE STOCK ──
    // Uses PUT /api/v2/stock/{stockId} with { stock: N }
    if (action === "update-stock") {
      const { stockId, stock } = body;
      if (!stockId) {
        return new Response(JSON.stringify({ error: "stockId required" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const url = `${WINERIM_BASE_URL}/stock/${stockId}`;
      const res = await fetch(url, {
        method: "PUT",
        headers: winerimHeaders,
        body: JSON.stringify({ stock: Math.max(0, Math.round(stock)) }),
      });
      const responseBody = await res.text();
      let parsed;
      try { parsed = JSON.parse(responseBody); } catch { parsed = { raw: responseBody }; }
      return new Response(
        JSON.stringify({ success: res.ok, status: res.status, response: parsed }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── BULK UPDATE STOCK ──
    // Uses PUT /api/v2/stock/bulk with { items: [{ id, stock }, ...] }
    if (action === "bulk-update-stock") {
      const { items } = body; // [{ stockId, stock }]
      if (!items || !Array.isArray(items) || items.length === 0) {
        return new Response(JSON.stringify({ error: "items array required" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const bulkItems = items.map((i: { stockId: number; stock: number }) => ({
        id: i.stockId,
        stock: Math.max(0, Math.round(i.stock)),
      }));

      // Process in chunks of 100
      const results: any[] = [];
      for (let i = 0; i < bulkItems.length; i += 100) {
        const chunk = bulkItems.slice(i, i + 100);
        const url = `${WINERIM_BASE_URL}/stock/bulk`;
        const res = await fetch(url, {
          method: "PUT",
          headers: winerimHeaders,
          body: JSON.stringify({ items: chunk }),
        });
        const data = await res.json();
        results.push(data);
      }

      return new Response(
        JSON.stringify({ success: true, results }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── GET STOCK FOR WINE ──
    if (action === "get-stock") {
      const { wineId } = body;
      const url = `${WINERIM_BASE_URL}/stock/wine/${wineId}`;
      const res = await fetch(url, { headers: winerimHeaders });
      const data = await res.json();
      return new Response(
        JSON.stringify({ success: res.ok, status: res.status, data }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ error: "Unknown action" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("winerim-proxy error:", err);
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
