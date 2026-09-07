import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  findEntryForVariant,
  findEntryForVariantOrFallback,
  normalizeWinerimVariant,
} from "../_shared/stockSyncUtils.ts";
import {
  extractWinerimWineFormats,
  isLegacyWinerimFormat,
  type WinerimWineFormatRow,
} from "../_shared/winerimFormats.ts";
import { isExtendedFormatsConnection } from "../_shared/winerimExtendedFormats.ts";
import {
  extractCommercialCodeFromName,
  normalizeCommercialCode,
} from "../_shared/productCodeMatching.ts";
import {
  decideCatalogChange,
  WINERIM_EXTENDED_FORMATS_FIELD,
  winerimExtendedFormatsDigest,
} from "../_shared/winerimCatalogFingerprint.ts";


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
  const posCommercialCode = extractCommercialCodeFromName(posName);
  if (posCommercialCode) {
    const exactCodeMatches = winerimWines.filter((wine) => {
      const codes = [
        extractCommercialCodeFromName(wine.name),
        wine.sku ? normalizeCommercialCode(wine.sku) : null,
        wine.ean ? normalizeCommercialCode(wine.ean) : null,
      ].filter(Boolean);

      return codes.includes(posCommercialCode);
    });

    if (exactCodeMatches.length === 1) {
      const wine = exactCodeMatches[0];
      return [{
        winerim_id: wine.winerim_id,
        winerim_name: wine.name,
        score: 100,
        method: "CODE_EXACT",
        reasons: [`commercial_code_exact:${posCommercialCode}`],
      }];
    }

    if (exactCodeMatches.length > 1) {
      return exactCodeMatches.slice(0, maxResults).map((wine) => ({
        winerim_id: wine.winerim_id,
        winerim_name: wine.name,
        score: 79,
        method: "CODE_AMBIGUOUS",
        reasons: [`commercial_code_ambiguous:${posCommercialCode}`],
      }));
    }
  }

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

// Result from fetchWineDetail including failure reason
interface WineDetailResult {
  wine: Record<string, unknown> | null;
  failureReason: string | null; // null = success, otherwise one of the pricing_missing_reason values
  httpStatus: number | null;
}

// Fetch individual wine detail to get pricing fields
// Tries multiple endpoint patterns and picks the richest payload (prefers one with prices)
// Includes exponential backoff retry for 503 errors
async function fetchWineDetail(
  wineId: string,
  headers: Record<string, string>,
  timeoutMs = 12000,
  maxRetries = 3,
): Promise<WineDetailResult> {
  const endpointsToTry = [
    `${WINERIM_BASE_URL}/wines/${wineId}`,
    `${WINERIM_BASE_URL}/wines/${wineId}?include=prices`,
    `${WINERIM_BASE_URL}/wine/${wineId}`,
    `${WINERIM_BASE_URL}/wines/${wineId}/detail`,
  ];

  function toPositiveNumber(val: unknown): number | null {
    if (val === null || val === undefined) return null;
    const n = Number(val);
    return n > 0 ? n : null;
  }

  function scorePayload(wine: Record<string, unknown>): number {
    let score = 0;
    const prices = Array.isArray(wine.prices) ? wine.prices as Array<Record<string, unknown>> : [];
    if (prices.length > 0) {
      score += 100;
      if (prices.some((p) => toPositiveNumber(p?.price) != null)) score += 25;
    }

    if (toPositiveNumber(wine.bottle_sale_price ?? wine.sale_price ?? wine.pvp ?? wine.price) != null) score += 20;
    if (toPositiveNumber(wine.glass_sale_price ?? wine.glass_price) != null) score += 12;
    if (toPositiveNumber(wine.magnum_sale_price) != null) score += 12;

    if (wine.showPrices !== undefined) score += 5;
    if (wine.name) score += 2;
    if (wine.type || wine.wine_type) score += 2;

    return score;
  }

  let bestWine: Record<string, unknown> | null = null;
  let bestScore = -1;
  let last503 = false;
  let lastHttpStatus: number | null = null;

  for (const url of endpointsToTry) {
    let retryCount = 0;
    while (retryCount <= maxRetries) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort("timeout"), timeoutMs);
      try {
        const res = await fetch(url, { headers, signal: controller.signal });
        lastHttpStatus = res.status;

        if (res.status === 503) {
          last503 = true;
          retryCount++;
          if (retryCount <= maxRetries) {
            const delay = Math.min(1000 * Math.pow(2, retryCount - 1), 8000);
            console.log(`[winerim-proxy] wine detail ${wineId}: 503 from ${url}, retry ${retryCount}/${maxRetries} in ${delay}ms`);
            clearTimeout(timeout);
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }
          console.log(`[winerim-proxy] wine detail ${wineId}: 503 exhausted retries on ${url}`);
          clearTimeout(timeout);
          break;
        }

        if (!res.ok) {
          console.log(`[winerim-proxy] wine detail ${wineId} (${url}): HTTP ${res.status}`);
          clearTimeout(timeout);
          break; // try next endpoint
        }

        const body = await res.text();
        try {
          const data = JSON.parse(body);
          const wine = (data?.wine || data) as Record<string, unknown>;
          const score = scorePayload(wine);
          const pricesCount = Array.isArray(wine.prices) ? wine.prices.length : 0;
          console.log(`[winerim-proxy] wine detail ${wineId} SUCCESS via ${url} score=${score} prices=${pricesCount}`);

          if (score > bestScore) {
            bestWine = wine;
            bestScore = score;
          }

          clearTimeout(timeout);
          // Good enough: if we found explicit prices, stop trying more endpoints
          if (pricesCount > 0) {
            return { wine: bestWine, failureReason: null, httpStatus: res.status };
          }
          break; // try next endpoint for richer data
        } catch {
          console.log(`[winerim-proxy] wine detail ${wineId}: non-JSON from ${url}`);
          clearTimeout(timeout);
          break;
        }
      } catch (e: unknown) {
        clearTimeout(timeout);
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.toLowerCase().includes("abort") || msg.toLowerCase().includes("timeout")) {
          console.log(`[winerim-proxy] wine detail ${wineId} (${url}) timed out after ${timeoutMs}ms`);
        } else {
          console.log(`[winerim-proxy] wine detail ${wineId} (${url}) failed: ${msg}`);
        }
        break; // try next endpoint
      }
    }
  }

  if (bestWine) {
    return { wine: bestWine, failureReason: null, httpStatus: lastHttpStatus };
  }

  // Determine failure reason
  const failureReason = last503 ? "503_from_winerim" : "detail_fetch_failed";
  return { wine: null, failureReason, httpStatus: lastHttpStatus };
}

interface FetchWineDetailsResult {
  details: Map<string, Record<string, unknown>>;
  failures: Map<string, string>; // wineId -> failureReason
  attempted: number;
  succeeded: number;
  failed: number;
}

// Batch fetch wine details with concurrency control + diagnostics
async function fetchWineDetails(
  wineIds: string[],
  headers: Record<string, string>,
  concurrency = 5,
): Promise<FetchWineDetailsResult> {
  const details = new Map<string, Record<string, unknown>>();
  const failures = new Map<string, string>();
  const attempted = wineIds.length;
  let succeeded = 0;
  let failed = 0;

  const totalBatches = Math.ceil(wineIds.length / concurrency);

  for (let i = 0; i < wineIds.length; i += concurrency) {
    const batch = wineIds.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (id) => {
        const result = await fetchWineDetail(id, headers);
        if (result.wine) {
          details.set(id, result.wine);
          succeeded++;
        } else {
          failures.set(id, result.failureReason || "unknown");
          failed++;
        }
      }),
    );

    const processed = Math.min(i + concurrency, wineIds.length);
    const batchNo = Math.floor(i / concurrency) + 1;
    console.log(
      `[winerim-proxy] detail progress batch ${batchNo}/${totalBatches} ` +
      `processed=${processed}/${wineIds.length} succeeded=${succeeded} failed=${failed}`,
    );

    // Small delay between batches to avoid rate limiting
    if (i + concurrency < wineIds.length) {
      await new Promise((r) => setTimeout(r, 120));
    }
  }

  return { details, failures, attempted, succeeded, failed };
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

    // ── FETCH WINE CATALOG (list sync + paginated detail enrichment) ──
    if (action === "fetch-catalog") {
      const mode = String(body.mode || "start"); // start | enrich
      const detailOffset = Math.max(0, Number(body.detailOffset || 0));
      const detailBatchSize = Math.min(200, Math.max(25, Number(body.detailBatchSize || 100)));
      const scheduleNextBatch = body.scheduleNextBatch !== false;
      const runSelfHealing = body.runSelfHealing !== false;

      function toPositiveNumber(val: unknown): number | null {
        if (val === null || val === undefined) return null;
        const n = Number(val);
        return n > 0 ? n : null;
      }

      function extractNormalizedFields(listWine: Record<string, unknown>, detail: Record<string, unknown> | null) {
        const w = { ...listWine, ...(detail || {}) };

        const rawType = w.type || w.wine_type || w.category || w.style || w.color || w.colour;
        const wineType = rawType && typeof rawType === "string" && rawType.length > 0 ? String(rawType).toLowerCase() : null;

        const prices = Array.isArray(w.prices) ? w.prices as { variant: string; price: number; erpStock?: { id?: number; stock?: number } }[] : [];
        const bottleEntry = findEntryForVariantOrFallback(prices, "botella");
        const glassEntry = findEntryForVariant(prices, "copa");
        const magnumEntry = findEntryForVariant(prices, "magnum");
        const { rows: formatRows, unknownVariants } = extractWinerimWineFormats(prices);

        const bottleSalePrice = toPositiveNumber(bottleEntry?.price) ?? toPositiveNumber(w.bottle_sale_price ?? w.sale_price ?? w.pvp ?? w.price);
        const bottlePurchasePrice = toPositiveNumber(w.bottle_purchase_price ?? w.purchase_price ?? w.cost_price ?? w.cost);
        const glassSalePrice = toPositiveNumber(glassEntry?.price) ?? toPositiveNumber(w.glass_sale_price ?? w.glass_price);
        const glassCostPrice = toPositiveNumber(w.glass_cost_price ?? w.glass_cost);
        const magnumSalePrice = toPositiveNumber(magnumEntry?.price) ?? toPositiveNumber(w.magnum_sale_price);
        const magnumPurchasePrice = toPositiveNumber(w.magnum_purchase_price ?? w.magnum_cost);

        const serveByGlass = !!glassEntry || w.serve_by_glass === true || w.by_glass === true || w.copa === true || false;
        const isActive = w.active !== false && w.is_active !== false && w.status !== "inactive";
        const stockQuantity = bottleEntry?.erpStock?.stock ?? null;

        const bottleStockId = Number.isFinite(Number(bottleEntry?.erpStock?.id)) ? Number(bottleEntry!.erpStock!.id) : null;
        const glassStockId  = Number.isFinite(Number(glassEntry?.erpStock?.id))  ? Number(glassEntry!.erpStock!.id)  : null;
        const magnumStockId = Number.isFinite(Number(magnumEntry?.erpStock?.id)) ? Number(magnumEntry!.erpStock!.id) : null;

        return {
          wineType,
          bottleSalePrice,
          bottlePurchasePrice,
          glassSalePrice,
          glassCostPrice,
          magnumSalePrice,
          magnumPurchasePrice,
          serveByGlass,
          isActive,
          stockQuantity,
          bottleStockId,
          glassStockId,
          magnumStockId,
          formatRows,
          unknownVariants,
        };
      }

      // ── FORMAT CATALOG PERSISTENCE (winerim_wine_formats) ──
      // One row per (wine, format). Formats that disappear from Winerim are
      // deleted so a retired variant can never keep an Agora button sellable.
      const persistWineFormats = async (
        winerimId: string,
        rows: WinerimWineFormatRow[],
      ): Promise<void> => {
        if (!Array.isArray(rows)) return;
        if (rows.length > 0) {
          const { error: formatsError } = await supabase
            .from("winerim_wine_formats")
            .upsert(
              rows.map((row) => ({ ...row, connection_id: connectionId, winerim_id: winerimId })),
              { onConflict: "connection_id,winerim_id,format_key" },
            );
          if (formatsError) {
            console.error(`[winerim-proxy] winerim_wine_formats upsert failed for ${winerimId}: ${formatsError.message}`);
            return;
          }
        }
        const keptKeys = rows.map((row) => row.format_key);
        let staleQuery = supabase
          .from("winerim_wine_formats")
          .delete()
          .eq("connection_id", connectionId)
          .eq("winerim_id", winerimId);
        if (keptKeys.length > 0) staleQuery = staleQuery.not("format_key", "in", `(${keptKeys.join(",")})`);
        const { error: staleError } = await staleQuery;
        if (staleError) {
          console.error(`[winerim-proxy] winerim_wine_formats cleanup failed for ${winerimId}: ${staleError.message}`);
        }
      };

      const extendedFormatsEnabled = isExtendedFormatsConnection(
        connectionId,
        (connection.provider_config || {}) as Record<string, unknown>,
      );
      const extendedDigestByWineId = new Map<string, string>();
      const unknownVariantsSeen = new Set<string>();

      const rememberExtendedFormats = (winerimId: string, rows: WinerimWineFormatRow[]) => {
        extendedDigestByWineId.set(
          winerimId,
          winerimExtendedFormatsDigest((rows || []).filter((row) => !isLegacyWinerimFormat(row.format_key))),
        );
      };

      const autoCreateCandidateIds = new Set<string>();
      const autoUpdateCandidateIds = new Set<string>();
      const fingerprintSkippedIds = new Set<string>();

      // ── SOURCE-CHANGE GATE (deterministic fingerprint) ──
      // Auto-push is only triggered for wineIds whose exportable Winerim fields
      // really changed (or that are brand new). Anything else — inherited Agora
      // drift, unpublished-but-unchanged wines, raw_payload/updated_at churn —
      // must NOT enter the evaluation, or enabling UPDATE would fire a bulk wave
      // during service. Fail-closed: an uncomputable fingerprint skips that wine.
      const classifyWineChange = (
        winerimId: string,
        previous: Record<string, unknown> | undefined,
        payload: Record<string, unknown>,
        pricingReady: boolean,
      ) => {
        const decision = decideCatalogChange({
          previous: previous
            ? { ...previous, [WINERIM_EXTENDED_FORMATS_FIELD]: previous[WINERIM_EXTENDED_FORMATS_FIELD] }
            : previous,
          payload: extendedFormatsEnabled && extendedDigestByWineId.has(winerimId)
            ? { ...payload, [WINERIM_EXTENDED_FORMATS_FIELD]: extendedDigestByWineId.get(winerimId) }
            : payload,
          pricingReady,
          includeExtendedFormats: extendedFormatsEnabled,
        });
        if (decision.outcome === "new") autoCreateCandidateIds.add(winerimId);
        else if (decision.outcome === "changed") autoUpdateCandidateIds.add(winerimId);
        else if (decision.outcome === "skipped" && decision.reason === "fingerprint_unavailable") {
          fingerprintSkippedIds.add(winerimId);
        } else if (decision.outcome === "skipped" && decision.reason === "previous_fingerprint_unavailable") {
          fingerprintSkippedIds.add(winerimId);
        }
        return decision;
      };


      const loadExistingWineRows = async (ids: string[]): Promise<Map<string, Record<string, unknown>>> => {
        const result = new Map<string, Record<string, unknown>>();
        const cleanIds = Array.from(new Set(ids.map(String).filter(Boolean)));
        for (let i = 0; i < cleanIds.length; i += 500) {
          const chunk = cleanIds.slice(i, i + 500);
          const { data: rows } = await supabase
            .from("winerim_wines")
            .select("winerim_id, name, wine_type, region, vintage, winery, serve_by_glass, is_active, bottle_sale_price, glass_sale_price, magnum_sale_price, pricing_status")
            .eq("connection_id", connectionId)
            .in("winerim_id", chunk);
          for (const row of (rows || []) as Record<string, unknown>[]) {
            result.set(String(row.winerim_id), row);
          }
          // Extended-format digest comes from the child table, so the
          // fingerprint compares like with like instead of always looking new.
          const { data: formatRows } = await supabase
            .from("winerim_wine_formats")
            .select("winerim_id, format_key, sale_price, stock_id, is_active")
            .eq("connection_id", connectionId)
            .in("winerim_id", chunk);
          const grouped = new Map<string, Record<string, unknown>[]>();
          for (const row of (formatRows || []) as Record<string, unknown>[]) {
            if (isLegacyWinerimFormat(row.format_key)) continue;
            const wineId = String(row.winerim_id);
            const group = grouped.get(wineId) || [];
            group.push(row);
            grouped.set(wineId, group);
          }
          for (const id of chunk) {
            const row = result.get(id);
            if (!row) continue;
            row[WINERIM_EXTENDED_FORMATS_FIELD] = winerimExtendedFormatsDigest(grouped.get(id) || []);
          }
        }
        return result;
      };


      let listWinesFetched = 0;
      let listWinesUpserted = 0;
      let totalWines = 0;
      let batchWineIds: string[] = [];
      // ── OSCILLATION GUARD (list vs detail) ──
      // The list payload is sparser than the enriched row (no prices, sometimes no
      // type). Classifying right after the list upsert made every identical pass
      // look "changed" (list wipes prices ⇒ diff, detail restores them ⇒ diff).
      // So in mode=start we snapshot the PRE-upsert row and the list payload, and
      // classify exactly ONCE against the FINAL merged list+detail state.
      let preUpsertRows = new Map<string, Record<string, unknown>>();
      const listPayloadsById = new Map<string, Record<string, unknown>>();
      // Cursor advance must follow the paginated page size, never the promoted
      // priority extras, so no wine is skipped by the walk.
      let batchPageSize = 0;
      const baseWineMap = new Map<string, Record<string, unknown>>();

      // ── CATALOG PRIORITY (canary / update allowlist) ──
      // Wines listed in provider_config.auto_push_update_winerim_ids (or the canary
      // alias) must be evaluated in the FIRST batch of the cycle. Otherwise a price
      // change on a wine sitting late in the pagination waits for the whole walk and
      // the SLA is missed. Fail-closed: empty allowlist ⇒ unchanged legacy ordering.
      const catalogProviderConfig = (connection.provider_config || {}) as Record<string, unknown>;
      const catalogPriorityWineIds = Array.from(new Set(
        [
          ...(Array.isArray(catalogProviderConfig.auto_push_update_winerim_ids)
            ? catalogProviderConfig.auto_push_update_winerim_ids as unknown[]
            : []),
          ...(Array.isArray(catalogProviderConfig.auto_push_update_canary_winerim_ids)
            ? catalogProviderConfig.auto_push_update_canary_winerim_ids as unknown[]
            : []),
        ].map((id) => String(id ?? "").trim()).filter(Boolean),
      ));
      const prioritizeFirstBatch = (ids: string[], allowedIds?: Set<string>): string[] => {
        if (catalogPriorityWineIds.length === 0 || detailOffset !== 0) return ids;
        const already = new Set(ids);
        const promoted = catalogPriorityWineIds.filter((id) =>
          !already.has(id) && (!allowedIds || allowedIds.has(id))
        );
        const priorityFirst = [
          ...catalogPriorityWineIds.filter((id) => already.has(id)),
          ...promoted,
          ...ids.filter((id) => !catalogPriorityWineIds.includes(id)),
        ];
        return priorityFirst.slice(0, Math.max(detailBatchSize, catalogPriorityWineIds.length));
      };

      if (mode === "start") {
        const wines = await fetchAllWines(winerimHeaders);
        listWinesFetched = wines.length;
        totalWines = wines.length;
        // Pre-upsert snapshot: the only valid "previous" state for this cycle.
        preUpsertRows = await loadExistingWineRows(
          wines.map((w) => String(w.id || "")).filter(Boolean),
        );

        console.log(`[winerim-proxy] fetch-catalog start: wines fetched from list=${listWinesFetched}`);

        for (const w of wines) {
          const winerimId = String(w.id || "");
          if (!winerimId) continue;

          baseWineMap.set(winerimId, w);

          let grapeVariety: string | null = null;
          const grapes = w.grapes as { name: string }[] | undefined;
          if (Array.isArray(grapes) && grapes.length > 0) {
            grapeVariety = grapes.map(g => g.name).join(", ");
          }

          const nf = extractNormalizedFields(w, null);

          // Determine pricing status from list data
          let pricingStatus = "MISSING";
          let pricingMissingReason: string | null = "no_prices_array"; // default: list endpoint rarely has prices
          
          const listPrices = Array.isArray(w.prices) ? w.prices as unknown[] : [];
          // A wine is READY if it has any usable price (bottle, glass, or magnum)
          if (nf.bottleSalePrice != null || nf.magnumSalePrice != null || nf.glassSalePrice != null) {
            pricingStatus = "READY";
            pricingMissingReason = null;
          } else if (listPrices.length > 0) {
            // Has prices array but no recognized price extracted
            const variants = listPrices.map((p: any) => p?.variant).filter(Boolean);
            const hasRecognized = variants.some((v: string) => normalizeWinerimVariant(v) !== null);
            pricingMissingReason = hasRecognized ? "sale_price_missing" : "format_not_recognized";
          } else if (Array.isArray(w.prices)) {
            pricingMissingReason = "prices_array_empty";
          }

          const upsertPayload: Record<string, unknown> = {
            connection_id: connectionId,
            winerim_id: winerimId,
            name: String(w.name || "Unknown"),
            sku: w.identifier ? String(w.identifier) : null,
            ean: w.ean ? String(w.ean) : null,
            vintage: w.vintage ? String(w.vintage) : null,
            winery: w.winery ? String(w.winery) : null,
            region: w.region ? String(w.region) : null,
            grape_variety: grapeVariety,
            format: w.subname ? String(w.subname) : null,
            raw_payload: w,
            serve_by_glass: nf.serveByGlass,
            is_active: nf.isActive,
            pricing_status: pricingStatus,
            pricing_missing_reason: pricingMissingReason,
          };

          if (nf.wineType) upsertPayload.wine_type = nf.wineType;
          if (nf.bottleSalePrice != null) {
            upsertPayload.bottle_sale_price = nf.bottleSalePrice;
            upsertPayload.price = nf.bottleSalePrice;
          }
          if (nf.bottlePurchasePrice != null) upsertPayload.bottle_purchase_price = nf.bottlePurchasePrice;
          if (nf.glassSalePrice != null) upsertPayload.glass_sale_price = nf.glassSalePrice;
          if (nf.glassCostPrice != null) upsertPayload.glass_cost_price = nf.glassCostPrice;
          if (nf.magnumSalePrice != null) upsertPayload.magnum_sale_price = nf.magnumSalePrice;
          if (nf.magnumPurchasePrice != null) upsertPayload.magnum_purchase_price = nf.magnumPurchasePrice;
          if (nf.stockQuantity != null) upsertPayload.stock_quantity = nf.stockQuantity;
          if (nf.bottleStockId != null) upsertPayload.bottle_stock_id = nf.bottleStockId;
          if (nf.glassStockId  != null) upsertPayload.glass_stock_id  = nf.glassStockId;
          if (nf.magnumStockId != null) upsertPayload.magnum_stock_id = nf.magnumStockId;

          // No classification here on purpose: the list row is sparse and would
          // oscillate against the enriched state. Only remember it.
          listPayloadsById.set(winerimId, { ...upsertPayload });

          for (const variant of nf.unknownVariants) unknownVariantsSeen.add(variant);
          // The list endpoint rarely carries prices; only persist formats when
          // it actually did, so an empty list never wipes enriched formats.
          if (nf.formatRows.length > 0) {
            await persistWineFormats(winerimId, nf.formatRows);
            rememberExtendedFormats(winerimId, nf.formatRows);
          }



          await supabase
            .from("winerim_wines")
            .upsert(upsertPayload, { onConflict: "connection_id,winerim_id" });

          listWinesUpserted++;
        }

        // ── RECONCILIATION: detect wines deleted from Winerim ──
        // Any wine in our DB (still is_active=true) that no longer appears in /wines
        // was deleted in Winerim → mark inactive and queue HIDE for Agora.
        const fetchedIds = new Set<string>(wines.map((w: any) => String(w.id || "")).filter(Boolean));
        const { data: dbActiveWines } = await supabase
          .from("winerim_wines")
          .select("winerim_id")
          .eq("connection_id", connectionId)
          .eq("is_active", true);
        const missingFromWinerim = (dbActiveWines || [])
          .map((r: any) => String(r.winerim_id))
          .filter((id: string) => id && !fetchedIds.has(id));

        if (missingFromWinerim.length > 0) {
          console.log(`[winerim-proxy] reconciliation: ${missingFromWinerim.length} wines deleted in Winerim → marking inactive`);
          await supabase
            .from("winerim_wines")
            .update({ is_active: false, pricing_status: "MISSING", pricing_missing_reason: "deleted_in_winerim" })
            .eq("connection_id", connectionId)
            .in("winerim_id", missingFromWinerim);

          try {
            const { data: hideResult } = await supabase.functions.invoke("agora-proxy", {
              body: { action: "evaluate-auto-push", connectionId, winerimWineIds: missingFromWinerim, eventType: "DELETE" },
            });
            console.log(`[winerim-proxy] reconciliation auto-hide: hidQueued=${hideResult?.hidQueued || 0}`);
            if ((hideResult?.hidQueued || 0) > 0) {
              await supabase.functions.invoke("agora-proxy", {
                body: { action: "process-xml-outbound-queue", connectionId, serverLoop: true },
              });
            }
          } catch (e) {
            console.error("[winerim-proxy] reconciliation auto-hide failed:", e);
          }
        }

        const allListedIds = wines.map((w) => String(w.id || "")).filter(Boolean);
        const listPage = allListedIds.slice(detailOffset, detailOffset + detailBatchSize);
        batchPageSize = listPage.length;
        batchWineIds = prioritizeFirstBatch(listPage, new Set(allListedIds));
      } else {
        const { count } = await supabase
          .from("winerim_wines")
          .select("winerim_id", { count: "exact", head: true })
          .eq("connection_id", connectionId);

        totalWines = count || 0;

        const { data: batchRows } = await supabase
          .from("winerim_wines")
          .select("winerim_id, raw_payload")
          .eq("connection_id", connectionId)
          .order("winerim_id")
          .range(detailOffset, detailOffset + detailBatchSize - 1);

        const rows = batchRows || [];
        const enrichPage = rows.map((r: any) => String(r.winerim_id)).filter(Boolean);
        batchPageSize = enrichPage.length;
        batchWineIds = prioritizeFirstBatch(enrichPage);
        for (const row of rows) {
          baseWineMap.set(String(row.winerim_id), (row.raw_payload as Record<string, unknown>) || {});
        }
        const missingPriorityIds = batchWineIds.filter((id) => !baseWineMap.has(id));
        if (missingPriorityIds.length > 0) {
          const { data: priorityRows } = await supabase
            .from("winerim_wines")
            .select("winerim_id, raw_payload")
            .eq("connection_id", connectionId)
            .in("winerim_id", missingPriorityIds);
          for (const row of (priorityRows || []) as any[]) {
            baseWineMap.set(String(row.winerim_id), (row.raw_payload as Record<string, unknown>) || {});
          }
          batchWineIds = batchWineIds.filter((id) => baseWineMap.has(id));
        }

        console.log(
          `[winerim-proxy] fetch-catalog enrich: offset=${detailOffset} batch=${detailBatchSize} ` +
          `target=${batchWineIds.length} total=${totalWines}`,
        );
      }

      const detailsResult = batchWineIds.length > 0
        ? await fetchWineDetails(batchWineIds, winerimHeaders, 5)
        : { details: new Map<string, Record<string, unknown>>(), failures: new Map<string, string>(), attempted: 0, succeeded: 0, failed: 0 };
      const existingBeforeDetails = await loadExistingWineRows(batchWineIds);

      console.log(
        `[winerim-proxy] detail diagnostics: attempted=${detailsResult.attempted} ` +
        `succeeded=${detailsResult.succeeded} failed=${detailsResult.failed}`,
      );

      let detailsUpdated = 0;
      let winesUpdatedWithBottlePrice = 0;
      let winesUpdatedWithGlassPrice = 0;

      for (const winerimId of batchWineIds) {
        const detail = detailsResult.details.get(winerimId);
        if (!detail) {
          // Mark failed wines with pricing status
          const failureReason = detailsResult.failures.get(winerimId) || "detail_fetch_failed";
          const pricingStatus = failureReason === "503_from_winerim" ? "RETRYING" : "FAILED";
          await supabase
            .from("winerim_wines")
            .update({ pricing_status: pricingStatus, pricing_missing_reason: failureReason })
            .eq("connection_id", connectionId)
            .eq("winerim_id", winerimId);
          continue;
        }

        const baseWine = baseWineMap.get(winerimId) || {};
        const mergedPayload = { ...baseWine, ...detail };
        const nf = extractNormalizedFields(baseWine, detail);

        let grapeVariety: string | null = null;
        const grapes = (detail.grapes || (baseWine as any).grapes) as { name: string }[] | undefined;
        if (Array.isArray(grapes) && grapes.length > 0) {
          grapeVariety = grapes.map(g => g.name).join(", ");
        }

        // Determine pricing status from parsed data
        // A wine is READY if it has any usable price (bottle, glass, or magnum)
        const prices = Array.isArray(detail.prices) ? detail.prices as unknown[] : [];
        let pricingStatus = "READY";
        let pricingMissingReason: string | null = null;

        if (nf.bottleSalePrice == null && nf.magnumSalePrice == null && nf.glassSalePrice == null) {
          pricingStatus = "MISSING";
          if (prices.length === 0) {
            pricingMissingReason = Array.isArray(detail.prices) ? "prices_array_empty" : "no_prices_array";
          } else {
            // Had prices but none had a valid sale price
            const variants = prices.map((p: any) => p?.variant).filter(Boolean);
            const hasRecognized = variants.some((v: string) => normalizeWinerimVariant(v) !== null);
            pricingMissingReason = hasRecognized ? "sale_price_missing" : "format_not_recognized";
          }
        }

        const updateData: Record<string, unknown> = {
          raw_payload: mergedPayload,
          serve_by_glass: nf.serveByGlass,
          is_active: nf.isActive,
          grape_variety: grapeVariety,
          pricing_status: pricingStatus,
          pricing_missing_reason: pricingMissingReason,
          // The detail endpoint is authoritative. Clearing removed variants here
          // prevents an old price from keeping a retired Agora button sellable.
          bottle_sale_price: nf.bottleSalePrice,
          price: nf.bottleSalePrice,
          bottle_purchase_price: nf.bottlePurchasePrice,
          glass_sale_price: nf.glassSalePrice,
          glass_cost_price: nf.glassCostPrice,
          magnum_sale_price: nf.magnumSalePrice,
          magnum_purchase_price: nf.magnumPurchasePrice,
        };

        if (detail.name || (baseWine as any).name) updateData.name = String(detail.name || (baseWine as any).name || "Unknown");
        if (nf.wineType) updateData.wine_type = nf.wineType;
        if (nf.bottleSalePrice != null) winesUpdatedWithBottlePrice++;
        if (nf.glassSalePrice != null) {
          winesUpdatedWithGlassPrice++;
        }
        if (nf.stockQuantity != null) updateData.stock_quantity = nf.stockQuantity;
        if (nf.bottleStockId != null) updateData.bottle_stock_id = nf.bottleStockId;
        if (nf.glassStockId  != null) updateData.glass_stock_id  = nf.glassStockId;
        if (nf.magnumStockId != null) updateData.magnum_stock_id = nf.magnumStockId;

        // The detail endpoint is authoritative for formats too.
        for (const variant of nf.unknownVariants) unknownVariantsSeen.add(variant);
        await persistWineFormats(winerimId, nf.formatRows);
        rememberExtendedFormats(winerimId, nf.formatRows);

        // Single classification point of the cycle, against the FINAL state.
        // start ⇒ previous is the pre-list-upsert row and the payload is the
        // merged list+detail state; enrich ⇒ previous is the pre-enrich row.
        const previous = mode === "start"
          ? preUpsertRows.get(winerimId)
          : existingBeforeDetails.get(winerimId);
        const finalPayload = mode === "start"
          ? { ...(listPayloadsById.get(winerimId) || {}), ...updateData }
          : updateData;
        classifyWineChange(winerimId, previous, finalPayload, pricingStatus === "READY");

        await supabase
          .from("winerim_wines")
          .update(updateData)
          .eq("connection_id", connectionId)
          .eq("winerim_id", winerimId);

        detailsUpdated++;
      }

      const processedDetails = Math.min(totalWines, detailOffset + batchPageSize);
      const remainingDetails = Math.max(totalWines - processedDetails, 0);
      const complete = remainingDetails === 0;

      const enrichmentCompletedAt = complete ? new Date().toISOString() : null;

      // NOTE: the former "READY but not tracked ⇒ CREATE" backfill was removed on
      // purpose. It re-evaluated every unpublished wine on every pass, which is
      // exactly the bulk wave we must not fire during service. Brand-new wines
      // still reach CREATE through the fingerprint gate above; deliberate mass
      // publishing stays a manual/explicit operation.


      // ── AUTO-PUSH TRIGGER (INCREMENTAL, differential) ──
      // Only queue wines that are new/unpublished or whose catalog-visible fields
      // actually changed. This keeps price/name updates automatic without reimporting
      // every processed batch on every cron pass.
      // Deploy marker 2026-06-10: required before re-enabling Sa Pedrera automatic catalog pushes.
      let autoPushResult: Record<string, unknown> | null = null;
      const autoCreateIds = Array.from(autoCreateCandidateIds);
      const autoUpdateIds = Array.from(autoUpdateCandidateIds)
        .filter((id) => !autoCreateCandidateIds.has(id));
      if (autoCreateIds.length > 0 || autoUpdateIds.length > 0) {
        try {
          const { data: conn } = await supabase
            .from("pos_connections")
            .select("provider, auto_push_on_create, auto_push_on_update")
            .eq("id", connectionId)
            .maybeSingle();

          if (conn?.provider === "agora") {
            const parts: Record<string, unknown>[] = [];
            let queuedTotal = 0;
            let hidQueuedTotal = 0;

            if (autoCreateIds.length > 0 && conn?.auto_push_on_create === true) {
              const { data: createData } = await supabase.functions.invoke("agora-proxy", {
                body: { action: "evaluate-auto-push", connectionId, winerimWineIds: autoCreateIds, eventType: "CREATE" },
              });
              parts.push({ eventType: "CREATE", ids: autoCreateIds.length, result: createData });
              queuedTotal += Number(createData?.queued || 0);
              hidQueuedTotal += Number(createData?.hidQueued || 0);
            }

            if (autoUpdateIds.length > 0 && conn?.auto_push_on_update === true) {
              const { data: updateData } = await supabase.functions.invoke("agora-proxy", {
                body: { action: "evaluate-auto-push", connectionId, winerimWineIds: autoUpdateIds, eventType: "UPDATE" },
              });
              parts.push({ eventType: "UPDATE", ids: autoUpdateIds.length, result: updateData });
              queuedTotal += Number(updateData?.queued || 0);
              hidQueuedTotal += Number(updateData?.hidQueued || 0);
            }

            autoPushResult = {
              success: true,
              differential: true,
              sourceChangeGated: true,
              createCandidates: autoCreateIds.length,
              updateCandidates: autoUpdateIds.length,
              fingerprintSkipped: fingerprintSkippedIds.size,
          unknownWinerimVariants: [...unknownVariantsSeen],
              unknownWinerimVariants: [...unknownVariantsSeen],
              parts,
            };
            console.log(`[winerim-proxy] differential auto-push: createCandidates=${autoCreateIds.length} updateCandidates=${autoUpdateIds.length} fingerprintSkipped=${fingerprintSkippedIds.size} queued=${queuedTotal} hidQueued=${hidQueuedTotal} complete=${complete}`);

            if (queuedTotal > 0 || hidQueuedTotal > 0) {
              await supabase.functions.invoke("agora-proxy", {
                body: { action: "process-xml-outbound-queue", connectionId, serverLoop: true },
              });
            }
          } else {
            autoPushResult = { skipped: true, reason: "non-agora provider" };
            console.log(`[winerim-proxy] differential auto-push skipped for ${connectionId}: non-agora provider`);
          }
        } catch (e) {
          console.error("[winerim-proxy] auto-push trigger failed:", e);
        }
      } else {
        autoPushResult = {
          skipped: true,
          reason: "no_source_changes_detected",
          fingerprintSkipped: fingerprintSkippedIds.size,
        };
      }


      // ── CHAIN NEXT BATCH via pg_net (fire-and-forget) ──
      // Without this, cron always restarts at offset=0 and only the first 100 wines ever get
      // re-enriched. Chaining lets a single cron tick walk the entire catalog over a few minutes.
      if (!complete && scheduleNextBatch) {
        try {
          const fnUrl = `${supabaseUrl}/functions/v1/winerim-proxy`;
          await supabase.rpc("schedule_next_catalog_batch" as never, {
            fn_url: fnUrl,
            service_key: supabaseKey,
            conn_id: connectionId,
            next_offset: detailOffset + batchPageSize,
            next_batch_size: detailBatchSize,
          } as never);
          console.log(`[winerim-proxy] chained next batch: offset=${detailOffset + batchPageSize}`);
        } catch (e) {
          console.error("[winerim-proxy] chain next batch failed:", e);
        }
      }

      // ── SELF-HEALING PASS ──
      // When the full linear walk finishes (complete=true), run a top-up pass that
      // re-enriches every wine still flagged MISSING / FAILED / RETRYING. This catches
      // wines whose detail fetch failed transiently in earlier cycles (Winerim 503s,
      // partial responses without `prices`, etc.) and wines whose price was added in
      // Winerim AFTER the original enrich. It is fire-and-forget so it never blocks
      // the current request.
      if (complete && runSelfHealing) {
        try {
          supabase.functions.invoke("winerim-proxy", {
            body: { action: "fetch-wine-details", connectionId },
          }).then(({ data, error }) => {
            if (error) {
              console.error("[winerim-proxy] self-healing pass failed:", error);
            } else {
              console.log(
                `[winerim-proxy] self-healing pass: requested=${data?.requested || 0} ` +
                `enriched=${data?.enriched || 0} autoQueued=${data?.autoQueued || 0}`,
              );
            }
          }).catch((e) => console.error("[winerim-proxy] self-healing invoke threw:", e));
          console.log(`[winerim-proxy] self-healing pass dispatched for ${connectionId}`);
        } catch (e) {
          console.error("[winerim-proxy] self-healing dispatch failed:", e);
        }

        const { error: catalogSyncTimestampError } = await supabase
          .from("pos_connections")
          .update({ last_catalog_sync_at: enrichmentCompletedAt })
          .eq("id", connectionId);

        if (catalogSyncTimestampError) {
          console.error(
            "[winerim-proxy] failed to update last_catalog_sync_at:",
            catalogSyncTimestampError,
          );
          throw new Error(
            `Catalog enrichment completed but last_catalog_sync_at could not be saved: ${catalogSyncTimestampError.message}`,
          );
        }
      }


      console.log(
        `[winerim-proxy] fetch-catalog result: listFetched=${listWinesFetched} ` +
        `detailProcessed=${processedDetails}/${totalWines} bottleUpdated=${winesUpdatedWithBottlePrice} ` +
        `glassUpdated=${winesUpdatedWithGlassPrice} complete=${complete}`,
      );

      return new Response(
        JSON.stringify({
          success: true,
          mode,
          totalWines,
          listWinesFetched,
          listWinesUpserted,
          detailOffset,
          detailBatchSize,
          processedDetails,
          remainingDetails,
          nextDetailOffset: complete ? null : processedDetails,
          complete,
          enrichmentCompletedAt,
          detailRequestsAttempted: detailsResult.attempted,
          detailRequestsSucceeded: detailsResult.succeeded,
          detailRequestsFailed: detailsResult.failed,
          winesUpdatedWithBottlePrice,
          winesUpdatedWithGlassPrice,
          detailsUpdated,
          detailsMissing: detailsResult.failed,
          newWines: autoCreateIds.length,
          changedWines: autoUpdateIds.length,
          autoPushResult,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── FETCH WINE DETAILS (standalone, for enriching existing wines) ──
    if (action === "fetch-wine-details") {
      const { winerimWineIds } = body;
      
      // If specific IDs provided, use those. Otherwise fetch wines with non-READY pricing.
      let targetIds: string[] = winerimWineIds || [];
      
      if (targetIds.length === 0) {
        const { data: missingWines } = await supabase
          .from("winerim_wines")
          .select("winerim_id, pricing_status")
          .eq("connection_id", connectionId)
          .in("pricing_status", ["MISSING", "RETRYING", "FAILED"])
          .limit(100);
        
        targetIds = (missingWines || []).map((w: any) => w.winerim_id);
      }

      if (targetIds.length === 0) {
        return new Response(
          JSON.stringify({ success: true, enriched: 0, requested: 0, message: "All wines already have pricing data" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      console.log(`Fetching details for ${targetIds.length} wines...`);
      const detailsResult = await fetchWineDetails(targetIds, winerimHeaders, 5);

      let enriched = 0;
      const failureReasons: Record<string, number> = {};
      const fieldsDiscovered: string[] = [];
      const newlyReadyWineIds: string[] = []; // wines that just transitioned to READY

      // Pre-fetch current pricing_status for the targets so we can detect transitions
      const { data: priorRows } = await supabase
        .from("winerim_wines")
        .select("winerim_id, pricing_status")
        .eq("connection_id", connectionId)
        .in("winerim_id", targetIds);
      const priorStatus = new Map<string, string>(
        (priorRows || []).map((r: any) => [String(r.winerim_id), String(r.pricing_status)])
      );

      // Process successful details
      for (const [winerimId, detail] of detailsResult.details) {
        if (enriched === 0) {
          fieldsDiscovered.push(...Object.keys(detail));
        }

        function toPositiveNumber(val: unknown): number | null {
          if (val === null || val === undefined) return null;
          const n = Number(val);
          return n > 0 ? n : null;
        }

        const prices = Array.isArray(detail.prices) ? detail.prices as { variant: string; price: number; erpStock?: { id?: number; stock?: number } }[] : [];
        const bottleEntry = findEntryForVariantOrFallback(prices, "botella");
        const glassEntry = findEntryForVariant(prices, "copa");
        const magnumEntry = findEntryForVariant(prices, "magnum");
        const { rows: detailFormatRows } = extractWinerimWineFormats(prices);

        const bottleStockId = Number.isFinite(Number(bottleEntry?.erpStock?.id)) ? Number(bottleEntry!.erpStock!.id) : undefined;
        const glassStockId  = Number.isFinite(Number(glassEntry?.erpStock?.id))  ? Number(glassEntry!.erpStock!.id)  : undefined;
        const magnumStockId = Number.isFinite(Number(magnumEntry?.erpStock?.id)) ? Number(magnumEntry!.erpStock!.id) : undefined;

        const bottleSalePrice = toPositiveNumber(bottleEntry?.price) ?? toPositiveNumber(detail.bottle_sale_price ?? detail.sale_price ?? detail.pvp ?? detail.price);
        const glassSalePrice = toPositiveNumber(glassEntry?.price) ?? toPositiveNumber(detail.glass_sale_price ?? detail.glass_price);
        const magnumSalePrice = toPositiveNumber(magnumEntry?.price) ?? toPositiveNumber(detail.magnum_sale_price);

        // Determine pricing status
        let pricingStatus = "READY";
        let pricingMissingReason: string | null = null;

        if (bottleSalePrice == null && glassSalePrice == null && magnumSalePrice == null) {
          pricingStatus = "MISSING";
          if (prices.length === 0) {
            pricingMissingReason = Array.isArray(detail.prices) ? "prices_array_empty" : "no_prices_array";
          } else {
            const variants = prices.map((p: any) => p?.variant).filter(Boolean);
            const hasRecognized = variants.some((v: string) => normalizeWinerimVariant(v) !== null);
            pricingMissingReason = hasRecognized ? "sale_price_missing" : "format_not_recognized";
          }
          failureReasons[pricingMissingReason] = (failureReasons[pricingMissingReason] || 0) + 1;
        }

        const rawType = detail.type || detail.wine_type || detail.category || detail.style || detail.color;
        const updateData: Record<string, unknown> = {
          raw_payload: detail,
          wine_type: rawType && typeof rawType === "string" ? String(rawType).toLowerCase() : undefined,
          bottle_sale_price: bottleSalePrice,
          bottle_purchase_price: toPositiveNumber(detail.bottle_purchase_price ?? detail.purchase_price ?? detail.cost_price ?? detail.cost),
          glass_sale_price: glassSalePrice,
          glass_cost_price: toPositiveNumber(detail.glass_cost_price ?? detail.glass_cost),
          magnum_sale_price: magnumSalePrice,
          magnum_purchase_price: toPositiveNumber(detail.magnum_purchase_price),
          serve_by_glass: !!glassEntry || detail.serve_by_glass === true || detail.by_glass === true || undefined,
          is_active: detail.active !== false && detail.is_active !== false ? true : false,
          stock_quantity: bottleEntry?.erpStock?.stock ?? undefined,
          bottle_stock_id: bottleStockId,
          glass_stock_id: glassStockId,
          magnum_stock_id: magnumStockId,
          pricing_status: pricingStatus,
          pricing_missing_reason: pricingMissingReason,
        };

        for (const key of Object.keys(updateData)) {
          if (updateData[key] === undefined) delete updateData[key];
        }

        await supabase.from("winerim_wines")
          .update(updateData)
          .eq("connection_id", connectionId)
          .eq("winerim_id", winerimId);

        // Keep the format catalog in sync on this path too.
        if (detailFormatRows.length > 0) {
          await supabase
            .from("winerim_wine_formats")
            .upsert(
              detailFormatRows.map((row) => ({ ...row, connection_id: connectionId, winerim_id: String(winerimId) })),
              { onConflict: "connection_id,winerim_id,format_key" },
            );
          await supabase
            .from("winerim_wine_formats")
            .delete()
            .eq("connection_id", connectionId)
            .eq("winerim_id", String(winerimId))
            .not("format_key", "in", `(${detailFormatRows.map((row) => row.format_key).join(",")})`);
        }
        if (pricingStatus === "READY") {
          enriched++;
          // Track transition: was MISSING/FAILED/RETRYING/NOT_PUSHED → now READY
          const prev = priorStatus.get(String(winerimId));
          if (prev && prev !== "READY") {
            newlyReadyWineIds.push(String(winerimId));
          }
        }
      }

      // Process failures - mark with reason
      for (const [winerimId, reason] of detailsResult.failures) {
        const pricingStatus = reason === "503_from_winerim" ? "RETRYING" : "FAILED";
        failureReasons[reason] = (failureReasons[reason] || 0) + 1;
        await supabase.from("winerim_wines")
          .update({ pricing_status: pricingStatus, pricing_missing_reason: reason })
          .eq("connection_id", connectionId)
          .eq("winerim_id", winerimId);
      }


      // ── AUTO-QUEUE newly-READY wines for push to the POS ──
      // When a wine transitions MISSING/FAILED/RETRYING → READY (because the client
      // just filled in the price), automatically queue it so it appears in the POS
      // without requiring manual intervention. Provider-agnostic: only queues for
      // providers whose proxy supports queue-xml-outbound (currently Agora).
      let autoQueued = 0;
      let autoQueueError: string | null = null;
      if (newlyReadyWineIds.length > 0) {
        try {
          const { data: conn } = await supabase
            .from("pos_connections")
            .select("provider")
            .eq("id", connectionId).maybeSingle();

          if (conn?.provider === "agora") {
            const { data: q, error: qErr } = await supabase.functions.invoke("agora-proxy", {
              body: {
                action: "evaluate-auto-push",
                connectionId,
                winerimWineIds: newlyReadyWineIds,
                eventType: "CREATE",
              },
            });
            if (qErr) autoQueueError = qErr.message || String(qErr);
            else autoQueued = q?.queued ?? newlyReadyWineIds.length;
            console.log(`[fetch-wine-details] Auto-queued ${autoQueued} newly-READY wines for ${connectionId}`);
          }
        } catch (e) {
          autoQueueError = String(e);
          console.error(`[fetch-wine-details] auto-queue failed:`, e);
        }
      }

      return new Response(
        JSON.stringify({
          success: true,
          requested: targetIds.length,
          enriched,
          detailsMissing: targetIds.length - enriched,
          detailRequestsAttempted: detailsResult.attempted,
          detailRequestsSucceeded: detailsResult.succeeded,
          detailRequestsFailed: detailsResult.failed,
          failureReasons,
          fieldsDiscovered: fieldsDiscovered.slice(0, 50),
          newlyReadyWineIds,
          autoQueued,
          autoQueueError,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── MATCH PRODUCTS (SKU + Fuzzy) ──
    if (action === "match-products") {
      // Fetch all POS wine candidates (paginated)
      const posProducts: any[] = [];
      let posFrom = 0;
      while (true) {
        const { data } = await supabase
          .from("provider_products")
          .select("provider_product_id, name, family, sale_format, price")
          .eq("connection_id", connectionId)
          .eq("is_wine_candidate", true)
          .range(posFrom, posFrom + 999);
        if (!data || data.length === 0) break;
        posProducts.push(...data);
        if (data.length < 1000) break;
        posFrom += 1000;
      }

      // Fetch all Winerim wines (paginated)
      const winerimWines: any[] = [];
      let wFrom = 0;
      while (true) {
        const { data } = await supabase
          .from("winerim_wines")
          .select("winerim_id, name, sku, ean, winery, grape_variety, format")
          .eq("connection_id", connectionId)
          .range(wFrom, wFrom + 999);
        if (!data || data.length === 0) break;
        winerimWines.push(...data);
        if (data.length < 1000) break;
        wFrom += 1000;
      }

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
        const responseBody = await res.text();
        let parsed;
        try { parsed = JSON.parse(responseBody); } catch { parsed = { raw: responseBody.substring(0, 500) }; }
        results.push({ success: res.ok, status: res.status, response: parsed });
      }

      const allOk = results.every((r) => r.success);
      return new Response(
        JSON.stringify({ success: allOk, results }),
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

    // ── DIAGNOSE UNKNOWN (reclassify wines with null pricing_missing_reason) ──
    if (action === "diagnose-unknown") {
      // Fetch all non-ready wines with null or empty pricing_missing_reason
      const allUnknown: any[] = [];
      let from = 0;
      while (true) {
        const { data, error } = await supabase
          .from("winerim_wines")
          .select("winerim_id, name, raw_payload, pricing_status, pricing_missing_reason, bottle_sale_price, glass_sale_price, magnum_sale_price")
          .eq("connection_id", connectionId)
          .neq("pricing_status", "READY")
          .range(from, from + 999);
        if (error || !data || data.length === 0) break;
        allUnknown.push(...data);
        if (data.length < 1000) break;
        from += 1000;
      }

      // Filter to only those with null/unknown reason
      const toReclassify = allUnknown.filter((w: any) => !w.pricing_missing_reason || w.pricing_missing_reason === "unknown");
      
      console.log(`[winerim-proxy] diagnose-unknown: total non-ready=${allUnknown.length} with null/unknown reason=${toReclassify.length}`);

      const results: Record<string, number> = {};
      let reclassified = 0;
      const debugSamples: any[] = [];

      for (const wine of toReclassify) {
        const raw = (wine.raw_payload || {}) as Record<string, unknown>;
        const rawPrices = Array.isArray(raw.prices) ? raw.prices as any[] : [];
        
        // Check if wine actually has pricing already (bottle, magnum, or glass)
        const hasBottlePrice = wine.bottle_sale_price != null && Number(wine.bottle_sale_price) > 0;
        const hasMagnumPrice = wine.magnum_sale_price != null && Number(wine.magnum_sale_price) > 0;
        const hasGlassPrice = wine.glass_sale_price != null && Number(wine.glass_sale_price) > 0;
        if (hasBottlePrice || hasMagnumPrice || hasGlassPrice) {
          await supabase.from("winerim_wines")
            .update({ pricing_status: "READY", pricing_missing_reason: null })
            .eq("connection_id", connectionId)
            .eq("winerim_id", wine.winerim_id);
          results["reclassified_to_ready"] = (results["reclassified_to_ready"] || 0) + 1;
          reclassified++;
          continue;
        }

        // Also check raw_payload for magnum prices that may not have been written to columns
        const magnumEntry = rawPrices.find((p: any) => p?.variant === "magnum");
        if (magnumEntry && Number(magnumEntry.price) > 0) {
          // Write the magnum price and mark READY
          await supabase.from("winerim_wines")
            .update({ 
              pricing_status: "READY", 
              pricing_missing_reason: null,
              magnum_sale_price: Number(magnumEntry.price),
            })
            .eq("connection_id", connectionId)
            .eq("winerim_id", wine.winerim_id);
          results["reclassified_to_ready"] = (results["reclassified_to_ready"] || 0) + 1;
          reclassified++;
          continue;
        }

        // Diagnose why no price
        const prices = rawPrices;
        let reason: string;

        if (!Array.isArray(raw.prices)) {
          reason = "no_prices_array";
        } else if (prices.length === 0) {
          reason = "prices_array_empty";
        } else {
          const variants = prices.map((p: any) => p?.variant).filter(Boolean);
          const hasRecognized = variants.some((v: string) => normalizeWinerimVariant(v) !== null);
          if (hasRecognized) {
            reason = "sale_price_missing";
          } else if (variants.length > 0) {
            reason = "format_not_recognized";
          } else {
            reason = "no_prices_array";
          }
        }

        // Collect debug samples (first 5)
        if (debugSamples.length < 5) {
          debugSamples.push({
            winerim_id: wine.winerim_id,
            name: wine.name,
            has_raw_payload: !!raw && Object.keys(raw).length > 0,
            has_prices_field: "prices" in raw,
            prices_is_array: Array.isArray(raw.prices),
            prices_length: Array.isArray(raw.prices) ? (raw.prices as unknown[]).length : null,
            price_variants: Array.isArray(raw.prices) ? (raw.prices as any[]).map((p: any) => p?.variant) : null,
            diagnosed_reason: reason,
            current_status: wine.pricing_status,
          });
        }

        await supabase.from("winerim_wines")
          .update({ pricing_missing_reason: reason })
          .eq("connection_id", connectionId)
          .eq("winerim_id", wine.winerim_id);
        
        results[reason] = (results[reason] || 0) + 1;
        reclassified++;
      }

      console.log(`[winerim-proxy] diagnose-unknown complete: reclassified=${reclassified} results=${JSON.stringify(results)}`);

      return new Response(
        JSON.stringify({ 
          success: true, 
          totalNonReady: allUnknown.length,
          toReclassify: toReclassify.length,
          reclassified, 
          results,
          debugSamples,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── CREATE MANUAL MAPPING ──
    // Creates or updates a product_mappings row linking an Agora product to a Winerim wine
    if (action === "create-manual-mapping") {
      const {
        providerProductId,
        providerProductName,
        winerimWineId,
        winerimWineName,
        formatType,
      } = body as {
        providerProductId?: string;
        providerProductName?: string;
        winerimWineId?: string;
        winerimWineName?: string;
        formatType?: string;
      };

      if (!connectionId || !providerProductId || !providerProductName || !winerimWineId) {
        return new Response(
          JSON.stringify({ error: "connectionId, providerProductId, providerProductName, winerimWineId required" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      // Try to find existing mapping for same provider product
      const { data: existing } = await supabase
        .from("product_mappings")
        .select("id")
        .eq("connection_id", connectionId)
        .eq("provider_product_id", providerProductId)
        .maybeSingle();

      const payload = {
        connection_id: connectionId,
        provider_product_id: providerProductId,
        provider_product_name: providerProductName,
        winerim_wine_id: winerimWineId,
        winerim_wine_name: winerimWineName || "",
        match_method: "MANUAL",
        match_score: 100,
        status: "CONFIRMED",
        format_type: formatType || "BOTTLE",
      };

      let mappingId: string | null = null;
      if (existing?.id) {
        const { error } = await supabase
          .from("product_mappings")
          .update(payload)
          .eq("id", existing.id);
        if (error) {
          return new Response(JSON.stringify({ error: error.message }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        mappingId = existing.id;
      } else {
        const { data: inserted, error } = await supabase
          .from("product_mappings")
          .insert(payload)
          .select("id")
          .single();
        if (error) {
          return new Response(JSON.stringify({ error: error.message }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        mappingId = inserted?.id ?? null;
      }

      // Backfill sales_line_items for this provider product
      await supabase.from("sales_line_items")
        .update({ winerim_product_id: winerimWineId, mapped: true })
        .eq("connection_id", connectionId)
        .eq("provider_product_id", providerProductId);

      return new Response(
        JSON.stringify({ success: true, mappingId, action: existing?.id ? "updated" : "created" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ── UNLINK MAPPING (clears the winerim link, keeps row as REJECTED) ──
    if (action === "unlink-mapping") {
      const { providerProductId } = body as { providerProductId?: string };
      if (!connectionId || !providerProductId) {
        return new Response(JSON.stringify({ error: "connectionId, providerProductId required" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      await supabase.from("product_mappings")
        .update({
          winerim_wine_id: null,
          winerim_wine_name: null,
          match_method: "MANUAL",
          match_score: 0,
          status: "REJECTED",
        })
        .eq("connection_id", connectionId)
        .eq("provider_product_id", providerProductId);

      await supabase.from("sales_line_items")
        .update({ winerim_product_id: null, mapped: false })
        .eq("connection_id", connectionId)
        .eq("provider_product_id", providerProductId);

      return new Response(JSON.stringify({ success: true }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } });
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
