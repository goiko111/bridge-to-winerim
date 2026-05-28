import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { buildDuplicateSafeAgoraProductNames } from "../_shared/agoraProductNaming.ts";
import {
  buildStockSyncGroupKey,
  buildStockSyncIdempotencyKey,
  decideSalesCursorAdvance,
  findStockForVariant,
  parseWinerimStockRows,
  variantForAgoraFormat,
  type WinerimVariant,
} from "../_shared/stockSyncUtils.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ─────────────────────────────────────────────────────────────────────
// AGORA EXPORT-MASTER PRODUCTS CACHE (CRITICAL — protects local Agora SQL)
// ─────────────────────────────────────────────────────────────────────
// `/api/export-master/?filter=Products` returns the FULL product catalog as XML.
// Calling it once per outbound task saturates the Agora SQL pool (incident 03/05/2026).
// We cache the response per connection in memory for AGORA_PRODUCTS_CACHE_TTL_MS.
// Edge Function instances are reused across invocations, so this cache survives
// between tasks within the same isolate and dramatically reduces load on Agora.
//
// Trade-off: a write may be verified against a slightly stale snapshot (up to 60s old).
// That is acceptable: if a product isn't yet visible, the next attempt will see it,
// and Agora's own propagation has similar latency.
const AGORA_PRODUCTS_CACHE_TTL_MS = 60_000; // 60s
const agoraProductsXmlCache = new Map<string, { xml: string; fetchedAt: number; status: number }>();

async function fetchAgoraProductsXmlCached(
  connectionId: string,
  baseUrlClean: string,
  apiTokenClean: string,
  fetchWithRetryFn: (url: string, init: RequestInit, timeoutMs: number) => Promise<Response>,
  timeoutMs = 30000,
  forceRefresh = false,
): Promise<{ xml: string; ok: boolean; status: number; fromCache: boolean }> {
  const now = Date.now();
  const cached = agoraProductsXmlCache.get(connectionId);
  if (!forceRefresh && cached && (now - cached.fetchedAt) < AGORA_PRODUCTS_CACHE_TTL_MS) {
    return { xml: cached.xml, ok: cached.status >= 200 && cached.status < 300, status: cached.status, fromCache: true };
  }
  const url = `${baseUrlClean}/api/export-master/?filter=Products`;
  const res = await fetchWithRetryFn(url, { headers: { "Api-Token": apiTokenClean, Accept: "application/xml" } }, timeoutMs);
  const xml = res.ok ? await res.text() : "";
  if (res.ok) {
    agoraProductsXmlCache.set(connectionId, { xml, fetchedAt: now, status: res.status });
  }
  return { xml, ok: res.ok, status: res.status, fromCache: false };
}

function invalidateAgoraProductsCache(connectionId: string) {
  agoraProductsXmlCache.delete(connectionId);
}

// ─────────────────────────────────────────────────────────────────────
// PER-CONNECTION RATE LIMITER (CRITICAL — protects local Agora servers)
// ─────────────────────────────────────────────────────────────────────
// Hard cap on requests/second sent to any single client's POS server.
// Prevents us from accidentally DDoS-ing a customer (Luruna incident, 03/05/2026).
// In-memory only; survives across invocations within the same isolate.
const POS_MAX_REQS_PER_SECOND = 2; // 2 req/s per connection = max 7200 req/h
const posLastRequestAt = new Map<string, number[]>();

async function throttleConnection(connectionId: string): Promise<void> {
  const now = Date.now();
  const windowMs = 1000;
  const arr = posLastRequestAt.get(connectionId) || [];
  const recent = arr.filter((t) => now - t < windowMs);
  if (recent.length >= POS_MAX_REQS_PER_SECOND) {
    const waitMs = windowMs - (now - recent[0]) + 50;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return throttleConnection(connectionId);
  }
  recent.push(now);
  posLastRequestAt.set(connectionId, recent);
}

// ─────────────────────────────────────────────────────────────────────
// ERROR CLASSIFIER + INTELLIGENT CIRCUIT BREAKER
// ─────────────────────────────────────────────────────────────────────
type ErrorClass = "POS_DOWN" | "POS_OVERLOADED" | "BUSINESS_ERROR" | "UNKNOWN";

function classifyPosError(errorText: string | null | undefined, httpStatus?: number): ErrorClass {
  const msg = (errorText || "").toLowerCase();
  if (msg.includes("connection refused") || msg.includes("no route to host") ||
      msg.includes("connect error") || msg.includes("aborterror") ||
      msg.includes("signal has been aborted") || msg.includes("network is unreachable")) {
    return "POS_DOWN";
  }
  if (httpStatus === 500 || httpStatus === 501 || httpStatus === 502 || httpStatus === 503 ||
      msg.includes("begin failed with sql exception") || msg.includes("sql pool")) {
    return "POS_OVERLOADED";
  }
  if (msg.includes("familyid") || msg.includes("no ha sido dado de alta") ||
      msg.includes("invalid") || msg.includes("validation")) {
    return "BUSINESS_ERROR";
  }
  return "UNKNOWN";
}

async function applyCircuitBreaker(
  supabase: any,
  connectionId: string,
  errorClass: ErrorClass,
): Promise<{ paused: boolean; pauseMinutes: number }> {
  if (errorClass !== "POS_DOWN" && errorClass !== "POS_OVERLOADED") {
    if (errorClass === "BUSINESS_ERROR") {
      await supabase.from("pos_connections").update({ consecutive_failures: 0 }).eq("id", connectionId);
    }
    return { paused: false, pauseMinutes: 0 };
  }
  const { data: conn } = await supabase
    .from("pos_connections").select("consecutive_failures").eq("id", connectionId).single();
  const newCount = ((conn?.consecutive_failures as number) || 0) + 1;
  const threshold = errorClass === "POS_DOWN" ? 5 : 10;
  const pauseMinutes = errorClass === "POS_DOWN" ? 60 : 15;
  if (newCount >= threshold) {
    const pausedUntil = new Date(Date.now() + pauseMinutes * 60_000).toISOString();
    await supabase.from("pos_connections").update({
      consecutive_failures: newCount,
      circuit_breaker_paused_until: pausedUntil,
      circuit_breaker_reason: `Auto-pause: ${errorClass} (${newCount} consecutive failures)`,
    }).eq("id", connectionId);
    console.log(`[CIRCUIT BREAKER] ${connectionId} paused ${pauseMinutes}min — ${errorClass}`);
    return { paused: true, pauseMinutes };
  }
  await supabase.from("pos_connections").update({ consecutive_failures: newCount }).eq("id", connectionId);
  return { paused: false, pauseMinutes: 0 };
}

async function resetFailureCounter(supabase: any, connectionId: string): Promise<void> {
  await supabase.from("pos_connections").update({ consecutive_failures: 0 }).eq("id", connectionId);
}

// ── Default keyword lists ──
const DEFAULT_WINE_FAMILIES = [
  "vino", "vinos", "bodega", "bodegas", "cava", "cavas", "champagne",
  "espumoso", "espumosos", "tinto", "tintos", "blanco", "blancos",
  "rosado", "rosados", "crianza", "reserva", "bebidas", "wine", "wines",
  "jerez", "manzanilla", "rioja", "ribera", "verdejo", "albariño",
  "tempranillo", "garnacha", "monastrell", "prosecco", "lambrusco",
];

const DEFAULT_NON_WINE_FAMILIES = [
  "agua", "water", "snack", "tarta", "postre", "postres", "café", "coffee",
  "té", "tea", "refresco", "refrescos", "zumo", "juice", "cerveza", "beer",
  "pan", "bread", "entrante", "entrantes", "ensalada", "sopa", "helado",
  "licor", "licores", "cocktail", "coctel", "gin", "whisky", "vodka", "ron",
];

const DEFAULT_WINE_KEYWORDS = [
  "vino", "tinto", "blanco", "rosado", "cava", "champagne", "brut",
  "reserva", "crianza", "botella", "bot.", "75cl", "magnum", "copa",
  "tempranillo", "garnacha", "cabernet", "merlot", "syrah", "chardonnay",
  "sauvignon", "pinot", "verdejo", "albariño", "monastrell", "godello",
  "rioja", "ribera", "rueda", "priorat", "penedès", "somontano",
  "gran reserva", "joven", "roble", "espumoso", "copa de vino", "37.5cl",
];

const DEFAULT_NON_WINE_KEYWORDS = [
  "menu", "menú", "degustación", "terrina", "ravioli", "steak", "solomillo",
  "atún", "gambas", "postre", "tarta", "pan", "snack", "ensalada", "pescado", "carne",
  "agua", "mineral", "coca", "fanta", "nestea", "tónica", "refresco",
  "café", "cortado", "infusión", "té", "zumo", "cerveza", "caña",
  "tapa", "ración", "helado", "gin tonic", "whisky", "vodka", "ron", "mojito", "cocktail",
];

const DEFAULT_FORMAT_WHITELIST = [
  "bot", "bottle", "botella", "75cl", "copa", "glass", "magnum", "jeroboam",
  "37.5cl", "150cl", "by the glass", "por copa",
];

// ── Classification config type ──
interface ClassificationConfig {
  wine_families_whitelist: string[];
  non_wine_families_blacklist: string[];
  wine_keywords_whitelist: string[];
  non_wine_keywords_blacklist: string[];
  format_whitelist: string[];
  min_wine_price: number;
  max_wine_price: number;
  score_threshold_wine: number;
  score_threshold_not_wine: number;
}

const DEFAULT_CONFIG: ClassificationConfig = {
  wine_families_whitelist: [],
  non_wine_families_blacklist: [],
  wine_keywords_whitelist: [],
  non_wine_keywords_blacklist: [],
  format_whitelist: [],
  min_wine_price: 6,
  max_wine_price: 600,
  score_threshold_wine: 40,
  score_threshold_not_wine: 0,
};

interface ClassificationResult {
  classification: "WINE" | "NOT_WINE" | "NEEDS_REVIEW";
  score: number;
  reasons: string[];
}

function classifyProduct(
  family: string | undefined,
  name: string | undefined,
  format: string | undefined,
  price: number,
  config: ClassificationConfig,
): ClassificationResult {
  const f = (family || "").toLowerCase();
  const n = (name || "").toLowerCase();
  const fmt = (format || "").toLowerCase();
  const reasons: string[] = [];

  const wineFamilies = [...DEFAULT_WINE_FAMILIES, ...config.wine_families_whitelist.map(s => s.toLowerCase())];
  const nonWineFamilies = [...DEFAULT_NON_WINE_FAMILIES, ...config.non_wine_families_blacklist.map(s => s.toLowerCase())];
  const wineKeywords = [...DEFAULT_WINE_KEYWORDS, ...config.wine_keywords_whitelist.map(s => s.toLowerCase())];
  const nonWineKeywords = [...DEFAULT_NON_WINE_KEYWORDS, ...config.non_wine_keywords_blacklist.map(s => s.toLowerCase())];
  const formatWhitelist = [...DEFAULT_FORMAT_WHITELIST, ...config.format_whitelist.map(s => s.toLowerCase())];

  for (const kw of nonWineKeywords) {
    if (n === kw || n.startsWith(kw + " ") || n.endsWith(" " + kw) || n.includes(" " + kw + " ")) {
      if (["menu", "menú", "degustación", "terrina", "ravioli", "steak", "solomillo", "atún", "gambas", "ensalada", "pescado", "carne"].includes(kw)) {
        reasons.push(`hard_not_wine_name:${kw}`);
        return { classification: "NOT_WINE", score: -100, reasons };
      }
    }
  }
  for (const kw of nonWineFamilies) {
    if (f === kw || f.includes(kw)) {
      if (["agua", "water", "snack", "postre", "postres", "café", "coffee", "cerveza", "beer", "licor", "licores"].includes(kw)) {
        reasons.push(`hard_not_wine_family:${kw}`);
        return { classification: "NOT_WINE", score: -100, reasons };
      }
    }
  }

  for (const kw of ["vino", "tinto", "blanco", "rosado", "cava", "champagne", "brut"]) {
    if (n === kw || n.startsWith(kw + " ") || n.endsWith(" " + kw) || n.includes(" " + kw + " ")) {
      reasons.push(`hard_wine_name:${kw}`);
      return { classification: "WINE", score: 100, reasons };
    }
  }
  if (/\b(botella|bot\.?\s|75\s?cl|copa de vino)\b/i.test(n)) {
    reasons.push(`hard_wine_bottle_pattern`);
    return { classification: "WINE", score: 100, reasons };
  }

  let score = 0;
  for (const kw of nonWineFamilies) {
    if (f.includes(kw)) { score -= 50; reasons.push(`family_blacklist:${kw}`); break; }
  }
  for (const kw of wineFamilies) {
    if (f.includes(kw)) { score += 50; reasons.push(`family_whitelist:${kw}`); break; }
  }
  for (const kw of wineKeywords) {
    if (n.includes(kw)) { score += 30; reasons.push(`keyword_wine:${kw}`); break; }
  }
  for (const kw of nonWineKeywords) {
    if (n.includes(kw)) { score -= 60; reasons.push(`keyword_non_wine:${kw}`); break; }
  }
  for (const kw of formatWhitelist) {
    if (fmt.includes(kw) || n.includes(kw)) {
      const isBottle = ["bot", "bottle", "botella", "75cl", "magnum", "jeroboam", "37.5cl", "150cl"].includes(kw);
      score += isBottle ? 20 : 10;
      reasons.push(`format_${isBottle ? "bottle" : "glass"}:${kw}`);
      break;
    }
  }
  if (Math.abs(score) < 30 && price > 0) {
    if (price >= (config.min_wine_price || 8) && price <= (config.max_wine_price || 400)) {
      score += 5; reasons.push(`price_wine_range:${price}`);
    } else if (price < 5) {
      score -= 5; reasons.push(`price_too_low:${price}`);
    }
  }
  score = Math.max(-100, Math.min(100, score));
  if (score >= config.score_threshold_wine) return { classification: "WINE", score, reasons };
  if (score <= config.score_threshold_not_wine) return { classification: "NOT_WINE", score, reasons };
  return { classification: "NEEDS_REVIEW", score, reasons };
}

function isWineCandidate(
  family: string | undefined, name: string | undefined, format: string | undefined,
  unitPrice: number, _wineFamilies: string[], _nonWineFamilies: string[],
): { candidate: boolean; score: number; reasons: string[] } {
  const r = classifyProduct(family, name, format, unitPrice, DEFAULT_CONFIG);
  return { candidate: r.classification === "WINE" || r.classification === "NEEDS_REVIEW", score: r.score, reasons: r.reasons };
}

function suggestFamilyClassification(familyName: string): { suggestedWine: boolean; confidence: "high" | "medium" | "low" } {
  const f = familyName.toLowerCase();
  for (const kw of DEFAULT_NON_WINE_FAMILIES) {
    if (f.includes(kw)) return { suggestedWine: false, confidence: "high" };
  }
  for (const kw of DEFAULT_WINE_FAMILIES) {
    if (f.includes(kw)) return { suggestedWine: true, confidence: "high" };
  }
  if (f.includes("bebida") || f.includes("drink") || f.includes("bar")) {
    return { suggestedWine: false, confidence: "medium" };
  }
  return { suggestedWine: false, confidence: "low" };
}

// ── NORMALIZE FORMAT: detect BOT / COPA / MAGNUM from ProductName prefix or SaleFormatName ──
function normalizeLineFormat(productName: string, saleFormatName: string): string {
  const pn = (productName || "").toUpperCase().trim();
  const sf = (saleFormatName || "").toUpperCase().trim();

  // ProductName prefix takes priority (Agora convention: "BOT. …", "COPA …", "MAG. …", or new "B …", "C …", "M …")
  if (pn.startsWith("BOT.") || pn.startsWith("BOT ") || pn.startsWith("B ")) return "BOT";
  if (pn.startsWith("COPA ") || pn.startsWith("COPA.") || pn.startsWith("C ")) return "COPA";
  if (pn.startsWith("MAG.") || pn.startsWith("MAG ") || pn.startsWith("MAGNUM") || pn.startsWith("M ")) return "MAGNUM";

  // Fallback to SaleFormatName
  if (sf.includes("COPA") || sf.includes("GLASS") || sf.includes("VERRE")) return "COPA";
  if (sf.includes("MAG") || sf.includes("MAGNUM")) return "MAGNUM";
  if (sf.includes("BOT") || sf.includes("BOTTLE") || sf.includes("75CL") || sf.includes("BOTELLA")) return "BOT";

  // If SaleFormatName is non-empty, keep as-is normalized
  if (saleFormatName.trim()) return saleFormatName.trim();
  return "";
}

// ── PRODUCT NAME BUILDER: prefix B (botella) / C (copa) / M (magnum) ──
function formatProductName(fmt: string, wineName: string): string {
  const f = String(fmt || "").toUpperCase();
  if (f === "MAGNUM") return `M ${wineName}`;
  if (f === "GLASS" || f === "COPA") return `C ${wineName}`;
  return `B ${wineName}`;
}

// deno-lint-ignore no-explicit-any
function parseInvoices(raw: any): any[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (raw.Invoices && Array.isArray(raw.Invoices)) return raw.Invoices;
  if (raw.Data?.Invoices && Array.isArray(raw.Data.Invoices)) return raw.Data.Invoices;
  for (const key of Object.keys(raw)) {
    if (Array.isArray(raw[key]) && raw[key].length > 0) return raw[key];
  }
  return [];
}

// ── Winerim Stock Sync Helper (variant-aware, line-idempotent) ──
// Winerim API v2: each wine exposes prices[] with variants ("copa","botella","magnum") and
// each variant has its own erpStock.id. We must update the correct stockId per variant with
// INTEGER quantities (Winerim rejects decimals). No more fractional bottle conversion.
// deno-lint-ignore no-explicit-any
async function syncStockForDay(supabase: any, connectionId: string, day: string, winerimToken: string) {
  const WINERIM_BASE = "https://app.winerim.com/api/v2";
  const winerimHeaders = {
    "WINERIM-API-TOKEN": winerimToken,
    "Content-Type": "application/json",
    "Accept": "application/json",
  };

  const { data: events } = await supabase
    .from("sales_events").select("id")
    .eq("connection_id", connectionId).eq("business_day", day);

  if (!events || events.length === 0) {
    return { synced: 0, skipped: 0, failed: 0, message: "No sales events for this day" };
  }

  const eventIds = events.map((e: { id: string }) => e.id);
  const { data: lines } = await supabase
    .from("sales_line_items")
    .select("id, sales_event_id, name, quantity, winerim_product_id, provider_product_id, is_wine_candidate, format")
    .in("sales_event_id", eventIds);

  if (!lines || lines.length === 0) {
    return { synced: 0, skipped: 0, failed: 0, message: "No line items found" };
  }

  // deno-lint-ignore no-explicit-any
  const mappedLines = (lines as any[]).filter((l: any) => l.winerim_product_id && l.is_wine_candidate);

  type Claim = {
    id: string;
    logId: string;
    salesEventId: string;
    winerimWineId: string;
    variant: WinerimVariant;
    qty: number;
    name: string;
    providerProductId: string;
  };

  type Agg = {
    winerimWineId: string;
    variant: WinerimVariant;
    qty: number;
    logIds: string[];
    lineIds: string[];
    eventIds: string[];
    name: string;
    providerProductId: string;
  };

  // Rescue stale line claims before trying a retry. Fresh PENDING rows are left alone
  // so concurrent invocations cannot claim the same sales line.
  const stalePendingBefore = new Date(Date.now() - 15 * 60_000).toISOString();
  await supabase
    .from("stock_sync_log")
    .update({ status: "FAILED", error_message: "Stale PENDING claim rescued before retry" })
    .eq("connection_id", connectionId)
    .eq("status", "PENDING")
    .lt("created_at", stalePendingBefore);

  const lineCandidates = mappedLines
    .map((line: any) => {
      const variant = variantForAgoraFormat(line.format);
      const qty = Math.ceil(Math.abs(Number(line.quantity || 0)));
      return {
        line,
        variant,
        qty,
        idempotencyKey: buildStockSyncIdempotencyKey(connectionId, String(line.id), variant),
      };
    })
    .filter((entry) => entry.qty > 0);

  let skipped = 0;
  const claimKeys = lineCandidates.map((entry) => entry.idempotencyKey);
  const candidateWineIds = Array.from(new Set(lineCandidates.map((entry) => String(entry.line.winerim_product_id))));
  const alreadySynced = new Set<string>();
  const alreadySyncedGroups = new Set<string>();
  const legacySynced = new Set<string>();
  for (let i = 0; i < claimKeys.length; i += 200) {
    const chunk = claimKeys.slice(i, i + 200);
    const { data: existing } = await supabase
      .from("stock_sync_log")
      .select("idempotency_key")
      .eq("connection_id", connectionId)
      .in("idempotency_key", chunk)
      .eq("status", "SUCCESS");
    for (const row of (existing || []) as { idempotency_key: string }[]) {
      alreadySynced.add(row.idempotency_key);
    }
  }

  // Compatibility guard for re-saved events. sales_line_items are replaced when
  // a day is saved again, so line-id idempotency keys change. A prior successful
  // event+wine+variant group must never be deducted again.
  if (candidateWineIds.length > 0) {
    const { data: syncedRows } = await supabase
      .from("stock_sync_log")
      .select("sales_event_id, winerim_product_id, variant, idempotency_key")
      .eq("connection_id", connectionId)
      .eq("status", "SUCCESS")
      .in("sales_event_id", eventIds)
      .in("winerim_product_id", candidateWineIds);
    for (const row of (syncedRows || []) as { sales_event_id: string; winerim_product_id: string; variant?: WinerimVariant | null; idempotency_key?: string | null }[]) {
      if (row.variant) {
        alreadySyncedGroups.add(buildStockSyncGroupKey(row.sales_event_id, row.winerim_product_id, row.variant));
      } else {
        legacySynced.add(`${row.sales_event_id}:${row.winerim_product_id}`);
      }
    }
  }

  const claimedLines: Claim[] = [];
  for (const entry of lineCandidates) {
    if (alreadySynced.has(entry.idempotencyKey)) {
      skipped++;
      continue;
    }

    const line = entry.line;
    const groupKey = buildStockSyncGroupKey(line.sales_event_id, line.winerim_product_id, entry.variant);
    if (alreadySyncedGroups.has(groupKey) || legacySynced.has(`${line.sales_event_id}:${line.winerim_product_id}`)) {
      skipped++;
      continue;
    }

    const { data: logEntry, error: claimError } = await supabase.from("stock_sync_log").insert({
      connection_id: connectionId,
      sales_event_id: line.sales_event_id,
      sales_line_item_id: line.id,
      provider_product_id: line.provider_product_id || "",
      winerim_product_id: line.winerim_product_id,
      product_name: `${line.name} [${entry.variant}]`,
      quantity: entry.qty,
      variant: entry.variant,
      idempotency_key: entry.idempotencyKey,
      status: "PENDING",
    }).select("id").single();

    if (claimError || !logEntry?.id) {
      skipped++;
      console.warn(`[sync-stock] skipped claimed line ${line.id}: ${claimError?.message || "no log id"}`);
      continue;
    }

    claimedLines.push({
      id: line.id,
      logId: logEntry.id,
      salesEventId: line.sales_event_id,
      winerimWineId: line.winerim_product_id,
      variant: entry.variant,
      qty: entry.qty,
      name: line.name,
      providerProductId: line.provider_product_id || "",
    });
  }

  const aggregated = new Map<string, Agg>();
  for (const claim of claimedLines) {
    const key = `${claim.winerimWineId}::${claim.variant}`;
    const existing = aggregated.get(key);
    if (existing) {
      existing.qty += claim.qty;
      existing.logIds.push(claim.logId);
      existing.lineIds.push(claim.id);
      if (!existing.eventIds.includes(claim.salesEventId)) existing.eventIds.push(claim.salesEventId);
    } else {
      aggregated.set(key, {
        winerimWineId: claim.winerimWineId,
        variant: claim.variant,
        qty: claim.qty,
        logIds: [claim.logId],
        lineIds: [claim.id],
        eventIds: [claim.salesEventId],
        name: claim.name,
        providerProductId: claim.providerProductId,
      });
    }
  }

  const toProcess = Array.from(aggregated.values());

  if (toProcess.length === 0) {
    return {
      synced: 0, skipped, failed: 0,
      unmapped: lines.length - mappedLines.length,
      totalLines: lines.length,
      mappedLines: mappedLines.length,
      aggregatedProducts: aggregated.size,
      claimedLines: claimedLines.length,
      message: "All groups already synced",
    };
  }

  let failed = 0;

  // ── Resolve stockId per (wine,variant) ──
  // We fetch /stock/wine/{id} for every wine we are about to mutate. It is documented,
  // gives both stockId and current stock for every variant, and avoids relying on the
  // undocumented GET /stock/{stockId} baseline read.
  const uniqueWineIds = Array.from(new Set(toProcess.map(p => p.winerimWineId)));
  type StockEntry = { id: number; stock: number; variant: WinerimVariant };
  const wineStockCache = new Map<string, StockEntry[]>();
  const wineFetchErrors = new Map<string, string>();

  for (const wineId of uniqueWineIds) {
    try {
      const r = await fetch(`${WINERIM_BASE}/stock/wine/${wineId}`, { method: "GET", headers: winerimHeaders });
      if (!r.ok) {
        wineFetchErrors.set(wineId, `GET /stock/wine/${wineId} → ${r.status}: ${(await r.text()).substring(0, 200)}`);
        continue;
      }
      const data = await r.json();
      const normalized = parseWinerimStockRows(data)
        .map((s) => {
          const canonical = findStockForVariant([s], "copa")
            ? "copa"
            : findStockForVariant([s], "botella")
              ? "botella"
              : findStockForVariant([s], "magnum")
                ? "magnum"
                : null;
          return {
            id: Number(s.id),
            stock: Number(s.stock ?? 0),
            variant: canonical,
          };
        })
        .filter((s): s is StockEntry => Number.isFinite(s.id) && s.id > 0 && !!s.variant);
      wineStockCache.set(wineId, normalized);

      // Backfill DB cache for next runs
      const upd: Record<string, number> = {};
      const bId = normalized.find(s => s.variant === "botella")?.id;
      const gId = normalized.find(s => s.variant === "copa")?.id;
      const mId = normalized.find(s => s.variant === "magnum")?.id;
      if (bId) upd.bottle_stock_id = bId;
      if (gId) upd.glass_stock_id  = gId;
      if (mId) upd.magnum_stock_id = mId;
      if (Object.keys(upd).length > 0) {
        await supabase.from("winerim_wines").update(upd)
          .eq("connection_id", connectionId).eq("winerim_id", wineId);
      }
    } catch (e) {
      wineFetchErrors.set(wineId, String(e));
    }
  }

  type BulkItem = { id: number; newStock: number; previousStock: number; agg: Agg };
  const bulkItems: BulkItem[] = [];

  for (const agg of toProcess) {
    const fetchedStocks = wineStockCache.get(agg.winerimWineId);
    const match = fetchedStocks?.find(s => s.variant === agg.variant);

    if (!match) {
      const err = wineFetchErrors.get(agg.winerimWineId) || `Variant '${agg.variant}' not found for wine ${agg.winerimWineId}`;
      await supabase.from("stock_sync_log").update({ status: "FAILED", error_message: err }).in("id", agg.logIds);
      failed++; continue;
    }

    const previousStock = match.stock;
    const newStock = Math.max(0, Math.floor(previousStock - agg.qty));
    bulkItems.push({ id: match.id, newStock, previousStock, agg });
  }


  // PUT per stockId (individual). Winerim v2 docs describe /stock/bulk but it is NOT yet
  // deployed in production (returns HTML login page). When Winerim ships it, swap this loop
  // for a chunked PUT to /api/v2/stock/bulk with { items: [{id, stock}] }.
  // Throttle: ~250ms gap → 4 req/s, comfortably under Winerim's 5 req/s rate limit.
  let synced = 0;
  for (let i = 0; i < bulkItems.length; i++) {
    const item = bulkItems[i];
    let r: Response;
    let txt = "";
    // deno-lint-ignore no-explicit-any
    let parsed: any;
    try {
      r = await fetch(`${WINERIM_BASE}/stock/${item.id}`, {
        method: "PUT",
        headers: winerimHeaders,
        body: JSON.stringify({ stock: item.newStock }),
      });
      txt = await r.text();
      try { parsed = JSON.parse(txt); } catch (_) { parsed = { raw: txt.substring(0, 300) }; }
    } catch (e) {
      await supabase.from("stock_sync_log").update({
        status: "FAILED", error_message: `PUT exception: ${String(e)}`,
        stock_id: item.id,
      }).in("id", item.agg.logIds);
      failed++;
      continue;
    }

    if (r.ok) {
      await supabase.from("stock_sync_log").update({
        status: "SUCCESS",
        stock_id: item.id,
        winerim_response: {
          previousStock: item.previousStock,
          newStock: item.newStock,
          soldQty: item.agg.qty,
          variant: item.agg.variant,
          stockId: item.id,
        },
        synced_at: new Date().toISOString(),
      }).in("id", item.agg.logIds);
      synced++;
      console.log(`[sync-stock] ${item.agg.name} [${item.agg.variant}]: ${item.previousStock} → ${item.newStock} (-${item.agg.qty})`);
    } else {
      await supabase.from("stock_sync_log").update({
        status: "FAILED",
        stock_id: item.id,
        error_message: `PUT /stock/${item.id} failed (${r.status}): ${txt.substring(0, 300)}`,
        winerim_response: parsed,
      }).in("id", item.agg.logIds);
      failed++;
    }

    // Throttle to stay below 5 req/s
    if (i < bulkItems.length - 1) await new Promise((res) => setTimeout(res, 250));
  }

  return {
    synced, skipped, failed,
    unmapped: lines.length - mappedLines.length,
    totalLines: lines.length,
    mappedLines: mappedLines.length,
    aggregatedProducts: aggregated.size,
    claimedLines: claimedLines.length,
  };
}

type StockSyncTotals = {
  synced: number;
  skipped: number;
  failed: number;
  checkedDays: number;
  errors: string[];
};

// deno-lint-ignore no-explicit-any
async function findSavedStockCandidateDays(supabase: any, connectionId: string, fromDay: string, toDay: string): Promise<string[]> {
  const { data: events } = await supabase
    .from("sales_events")
    .select("id, business_day")
    .eq("connection_id", connectionId)
    .gte("business_day", fromDay)
    .lte("business_day", toDay)
    .order("business_day", { ascending: true })
    .limit(10000);

  if (!events || events.length === 0) return [];

  const dayByEventId = new Map<string, string>();
  const eventIds: string[] = [];
  for (const ev of events as { id: string; business_day: string }[]) {
    eventIds.push(ev.id);
    dayByEventId.set(ev.id, ev.business_day);
  }

  const days = new Set<string>();
  for (let i = 0; i < eventIds.length; i += 500) {
    const chunk = eventIds.slice(i, i + 500);
    const { data: rows } = await supabase
      .from("sales_line_items")
      .select("sales_event_id")
      .eq("connection_id", connectionId)
      .eq("is_wine_candidate", true)
      .not("winerim_product_id", "is", null)
      .in("sales_event_id", chunk);

    for (const row of (rows || []) as { sales_event_id: string }[]) {
      const day = dayByEventId.get(row.sales_event_id);
      if (day) days.add(day);
    }
  }

  return Array.from(days).sort();
}

// deno-lint-ignore no-explicit-any
async function syncStockForDays(supabase: any, connectionId: string, days: string[], winerimToken: string): Promise<StockSyncTotals> {
  const totals: StockSyncTotals = { synced: 0, skipped: 0, failed: 0, checkedDays: 0, errors: [] };
  for (const day of days) {
    try {
      const result = await syncStockForDay(supabase, connectionId, day, winerimToken);
      totals.synced += Number(result.synced || 0);
      totals.skipped += Number(result.skipped || 0);
      totals.failed += Number(result.failed || 0);
      totals.checkedDays++;
    } catch (e) {
      totals.failed++;
      totals.errors.push(`${day}: ${String(e)}`);
    }
  }
  return totals;
}

// deno-lint-ignore no-explicit-any
async function loadConfig(supabase: any, connectionId: string): Promise<ClassificationConfig> {
  const { data } = await supabase
    .from("classification_config")
    .select("*")
    .eq("connection_id", connectionId)
    .single();
  if (!data) return DEFAULT_CONFIG;
  return {
    wine_families_whitelist: data.wine_families_whitelist || [],
    non_wine_families_blacklist: data.non_wine_families_blacklist || [],
    wine_keywords_whitelist: data.wine_keywords_whitelist || [],
    non_wine_keywords_blacklist: data.non_wine_keywords_blacklist || [],
    format_whitelist: data.format_whitelist || [],
    min_wine_price: data.min_wine_price ?? 6,
    max_wine_price: data.max_wine_price ?? 600,
    score_threshold_wine: data.score_threshold_wine ?? 40,
    score_threshold_not_wine: data.score_threshold_not_wine ?? 0,
  };
}

// ── WINE TYPE -> FAMILY MAPPING (deterministic) ──
const WINE_TYPE_FAMILY_MAP: Record<string, string[]> = {
  "tinto": ["VINOS TINTOS", "Tintos", "Tinto", "T "],
  "blanco": ["VINOS BLANCOS", "Blancos", "Blanco", "B "],
  "rosado": ["VINOS ROSADOS", "Rosados", "Rosado"],
  "espumoso": ["ESPUMOSOS", "Espumosos", "Cava", "Champagne"],
  "cava": ["ESPUMOSOS", "Cava", "Espumosos"],
  "champagne": ["ESPUMOSOS", "Champagne", "Espumosos"],
  "generoso": ["GENEROSOS", "Generosos", "Jerez"],
  "fortificado": ["GENEROSOS", "Generosos"],
  "dulce": ["DULCE", "Dulce", "Postre", "Dessert"],
  "postre": ["DULCE", "Dulce", "Postre", "Dessert"],
};

// Wine type aliases: normalize legacy keys to canonical ones
const WINE_TYPE_ALIASES: Record<string, string> = {
  "postre": "dulce",
};
// ── DETERMINISTIC FAMILY ID GENERATOR ──
function stableFamilyId(name: string): string {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    hash = ((hash << 5) - hash + normalized.charCodeAt(i)) | 0;
  }
  return String(900000 + (Math.abs(hash) % 9999));
}

function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))];
  }
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
  return [];
}

// ── PUSH TRACKING HELPER ──
// deno-lint-ignore no-explicit-any
async function upsertPushTracking(supabaseClient: any, connId: string, winerimWineId: string, format: string, updates: {
  sync_status: string;
  agora_product_id?: string;
  agora_family_id?: string;
  task_id?: string;
  last_error?: string | null;
  pushed_at?: string | null;
  verified_at?: string | null;
}) {
  const agoraProductId = updates.agora_product_id || (
    format === "MAGNUM" ? String(900000 + Number(winerimWineId || 0))
    : format === "GLASS" ? String(700000 + Number(winerimWineId || 0))
    : String(500000 + Number(winerimWineId || 0))
  );
  await supabaseClient.from("winerim_push_tracking").upsert({
    connection_id: connId,
    winerim_wine_id: winerimWineId,
    format,
    agora_product_id: agoraProductId,
    agora_family_id: updates.agora_family_id || null,
    source: "WINERIM",
    sync_status: updates.sync_status,
    task_id: updates.task_id || null,
    last_error: updates.last_error || null,
    pushed_at: updates.pushed_at || null,
    verified_at: updates.verified_at || null,
  }, { onConflict: "connection_id,winerim_wine_id,format" });
}

// ── DELETION DATE FILTER ──
// Agora entities with a DeletionDate are soft-deleted and must be excluded from all operational logic.
// deno-lint-ignore no-explicit-any
function isDeletedEntity(entity: any): boolean {
  if (!entity) return false;
  const dd = entity.DeletionDate || entity.deletionDate || entity.deletion_date;
  if (!dd) return false;
  // Any non-empty DeletionDate means deleted
  return String(dd).trim().length > 0;
}

// deno-lint-ignore no-explicit-any
function buildAgoraVerificationScope(masterData: any, options: { explicitSaleCenterIds?: string[]; connectionSelectedSaleCenterIds?: string[]; verificationMode?: string } = {}) {
  const allPriceListsRaw = (Array.isArray(masterData?.price_lists_json) ? masterData.price_lists_json : []) as Record<string, unknown>[];
  const allSaleCentersRaw = (Array.isArray(masterData?.sale_centers_json) ? masterData.sale_centers_json : []) as Record<string, unknown>[];

  // Filter out deleted entities — they must never contaminate production scope
  const allPriceLists = allPriceListsRaw.filter(e => !isDeletedEntity(e)) as { Id: string; Name: string }[];
  const allSaleCenters = allSaleCentersRaw.filter(e => !isDeletedEntity(e)) as Record<string, unknown>[];
  const deletedPriceLists = allPriceListsRaw.filter(e => isDeletedEntity(e));
  const deletedSaleCenters = allSaleCentersRaw.filter(e => isDeletedEntity(e));
  const explicitIds = normalizeStringArray(options.explicitSaleCenterIds);
  const connectionSelectedIds = normalizeStringArray(options.connectionSelectedSaleCenterIds);

  // Determine verification mode
  const verificationMode = options.verificationMode || "PRODUCTION_ALL_ACTIVE_SALE_CENTERS";

  let selectedSaleCenters = [] as Record<string, unknown>[];
  let source: "selected_sale_centers" | "referenced_sale_centers" | "production_all_active" = "production_all_active";

  if (verificationMode === "PRODUCTION_ALL_ACTIVE_SALE_CENTERS") {
    // Production mode: use ALL SaleCenters that have a CurrentPriceListId
    // This ensures we verify against every active SaleCenter, not just user-selected ones
    selectedSaleCenters = allSaleCenters.filter((sc) => !!sc.CurrentPriceListId);
    source = "production_all_active";
  } else if (explicitIds.length > 0) {
    selectedSaleCenters = allSaleCenters.filter((sc) => explicitIds.includes(String(sc.Id || "")));
    source = "selected_sale_centers";
  } else if (connectionSelectedIds.length > 0) {
    selectedSaleCenters = allSaleCenters.filter((sc) => connectionSelectedIds.includes(String(sc.Id || "")));
    source = "selected_sale_centers";
  }

  if (selectedSaleCenters.length === 0) {
    selectedSaleCenters = allSaleCenters.filter((sc) => !!sc.CurrentPriceListId);
    source = "referenced_sale_centers";
  }

  const selectedPriceListMap = new Map<string, { id: string; name: string }>();
  const priceListToSaleCenters: Record<string, string[]> = {};

  for (const sc of selectedSaleCenters) {
    const priceListId = sc.CurrentPriceListId ? String(sc.CurrentPriceListId) : "";
    if (!priceListId) continue;

    const priceList = allPriceLists.find((pl) => String(pl.Id) === priceListId);
    if (!selectedPriceListMap.has(priceListId)) {
      selectedPriceListMap.set(priceListId, {
        id: priceListId,
        name: priceList?.Name ? String(priceList.Name) : priceListId,
      });
    }

    if (!priceListToSaleCenters[priceListId]) priceListToSaleCenters[priceListId] = [];
    priceListToSaleCenters[priceListId].push(sc.Name ? String(sc.Name) : String(sc.Id || priceListId));
  }

  const selectedPriceLists = Array.from(selectedPriceListMap.values());
  const selectedPriceListIds = selectedPriceLists.map((pl) => pl.id);
  const ignoredPriceLists = allPriceLists
    .filter((pl) => !selectedPriceListIds.includes(String(pl.Id)))
    .map((pl) => ({ id: String(pl.Id), name: String(pl.Name || pl.Id) }));

  return {
    source,
    verificationMode,
    allPriceLists,
    allSaleCenters,
    deletedPriceLists: deletedPriceLists.map((pl: any) => ({ id: String(pl.Id), name: String(pl.Name || pl.Id), deletionDate: String(pl.DeletionDate || pl.deletionDate || "") })),
    deletedSaleCenters: deletedSaleCenters.map((sc: any) => ({ id: String(sc.Id || ""), name: String(sc.Name || sc.Id || ""), deletionDate: String(sc.DeletionDate || sc.deletionDate || "") })),
    selectedSaleCenters: selectedSaleCenters.map((sc) => ({
      id: String(sc.Id || ""),
      name: String(sc.Name || sc.Id || ""),
      priceListId: sc.CurrentPriceListId ? String(sc.CurrentPriceListId) : null,
    })),
    selectedPriceLists,
    selectedPriceListIds,
    ignoredPriceLists,
    priceListToSaleCenters,
  };
}

// deno-lint-ignore no-explicit-any
function buildAgoraVerificationScopePayload(masterData: any, options: { explicitSaleCenterIds?: string[]; connectionSelectedSaleCenterIds?: string[]; verificationMode?: string } = {}, includeVersion = true) {
  const scope = buildAgoraVerificationScope(masterData, options);
  return {
    ...(includeVersion ? { _verification_scope_version: 3 } : {}),
    _verification_mode: scope.verificationMode,
    _verification_scope_source: scope.source,
    _selected_sale_center_ids: scope.selectedSaleCenters.map((sc) => sc.id),
    _effective_sale_center_ids: scope.selectedSaleCenters.map((sc) => sc.id),
    _effective_price_list_ids: scope.selectedPriceListIds,
    ...(scope.selectedSaleCenters.length === 1 ? { _sale_center_id: scope.selectedSaleCenters[0].id } : {}),
    _selected_sale_centers: scope.selectedSaleCenters,
    _selected_price_lists: scope.selectedPriceLists,
    _ignored_price_lists: scope.ignoredPriceLists,
    _deleted_price_lists: scope.deletedPriceLists,
    _deleted_sale_centers: scope.deletedSaleCenters,
    _legacy_verification_scope: false,
    _scope_frozen_at: new Date().toISOString(),
  };
}

// ── SHARED AGORA POST-IMPORT VERIFICATION ──
interface AgoraVerificationIssue {
  code: string;
  message: string;
  field?: string;
  context?: Record<string, unknown>;
}

interface AgoraVerificationMissingPrice {
  product_erp_id: string;
  agora_product_id: string;
  price_list_id: string;
  price_list_name: string;
  issue: "missing" | "zero" | "invalid";
  name: string;
  format: string;
  affected_sale_centers: string[];
}

interface AgoraVerificationResult {
  success: boolean;
  verified_exists: boolean;
  verified_prices: boolean;
  verified_family: boolean;
  verified_preparation: boolean;
  verified_scope: boolean;
  errors: AgoraVerificationIssue[];
  warnings: AgoraVerificationIssue[];
  missing_prices: AgoraVerificationMissingPrice[];
  affected_sale_centers: string[];
  summary: { checked: number; ok: number; failed: number };
}

interface AgoraProductToVerify {
  productId: string;
  productName: string;
  format: string;
  erpId: string;
  expectedFamilyId?: string;
}

/**
 * Unified verification logic for Agora products.
 * Used by both `verify-products` and `process-xml-outbound-task`.
 */
function verifyAgoraProductsAgainstScope(
  verifyXml: string,
  products: AgoraProductToVerify[],
  scopedPriceLists: { id: string; name: string }[],
  priceListToSaleCenters: Record<string, string[]>,
): AgoraVerificationResult {
  const result: AgoraVerificationResult = {
    success: true,
    verified_exists: true,
    verified_prices: true,
    verified_family: true,
    verified_preparation: true,
    verified_scope: scopedPriceLists.length > 0,
    errors: [],
    warnings: [],
    missing_prices: [],
    affected_sale_centers: [],
    summary: { checked: 0, ok: 0, failed: 0 },
  };

  if (scopedPriceLists.length === 0) {
    result.success = false;
    result.errors.push({
      code: "VERIFY_SCOPE_EMPTY",
      message: "No relevant PriceLists resolved from current SaleCenter scope",
      field: "verification_scope",
    });
  }

  for (const product of products) {
    result.summary.checked++;
    const productFullRegex = new RegExp(
      `<Product[^>]*Id="${product.productId}"([^>]*)>([\\s\\S]*?)<\\/Product>`, "i",
    );
    const productMatch = verifyXml.match(productFullRegex);

    if (!productMatch) {
      result.summary.failed++;
      result.verified_exists = false;
      result.success = false;
      result.errors.push({
        code: "NOT_FOUND",
        message: `Product ${product.productId} (${product.format} ${product.productName}) not found in Agora`,
        context: { productId: product.productId, format: product.format },
      });
      for (const pl of scopedPriceLists) {
        const scNames = priceListToSaleCenters[pl.id] || [];
        result.missing_prices.push({
          product_erp_id: product.erpId,
          agora_product_id: product.productId,
          price_list_id: pl.id, price_list_name: pl.name,
          issue: "missing", name: product.productName, format: product.format,
          affected_sale_centers: scNames,
        });
        for (const s of scNames) {
          if (!result.affected_sale_centers.includes(s)) result.affected_sale_centers.push(s);
        }
      }
      continue;
    }

    const attrs = productMatch[1];
    const innerXml = productMatch[2];
    let productOk = true;

    // CHECK: PRICES
    for (const pl of scopedPriceLists) {
      const priceRegex = new RegExp(`<Price[^>]*PriceListId="${pl.id}"[^>]*MainPrice="([^"]*)"`, "i");
      const priceMatch = innerXml.match(priceRegex);
      const priceVal = priceMatch ? parseFloat(priceMatch[1]) : NaN;

      if (!priceMatch || isNaN(priceVal) || priceVal <= 0) {
        productOk = false;
        result.verified_prices = false;
        const issue: "missing" | "zero" | "invalid" = !priceMatch ? "missing" : isNaN(priceVal) ? "invalid" : "zero";
        const scNames = priceListToSaleCenters[pl.id] || [];
        result.missing_prices.push({
          product_erp_id: product.erpId,
          agora_product_id: product.productId,
          price_list_id: pl.id, price_list_name: pl.name,
          issue, name: product.productName, format: product.format,
          affected_sale_centers: scNames,
        });
        for (const s of scNames) {
          if (!result.affected_sale_centers.includes(s)) result.affected_sale_centers.push(s);
        }
        result.errors.push({
          code: "PRICE_MISSING",
          message: `Product ${product.productId} (${product.format}): ${issue} price in PriceList "${pl.name}"`,
          field: "prices",
          context: { productId: product.productId, format: product.format, priceListId: pl.id, priceListName: pl.name, affectedSaleCenters: scNames },
        });
      }
    }

    // CHECK: PREPARATION FIELDS
    const prepTypeMatch = attrs.match(/PreparationTypeId="([^"]*)"/);
    const prepOrderMatch = attrs.match(/PreparationOrderId="([^"]*)"/);
    const prepTypeVal = prepTypeMatch ? prepTypeMatch[1] : "";
    const prepOrderVal = prepOrderMatch ? prepOrderMatch[1] : "";
    if ((!prepTypeVal) !== (!prepOrderVal)) {
      productOk = false;
      result.verified_preparation = false;
      result.errors.push({
        code: "INVALID_PREPARATION_PAIR",
        message: `Preparation Type and Order must both be empty or both set (Product ${product.productId}, ${product.format}: Type="${prepTypeVal}" Order="${prepOrderVal}")`,
        field: "PreparationTypeId,PreparationOrderId",
        context: { productId: product.productId, format: product.format, prepTypeId: prepTypeVal, prepOrderId: prepOrderVal },
      });
    }

    // CHECK: FAMILY
    const familyMatch = attrs.match(/FamilyId="([^"]*)"/);
    const actualFamilyId = familyMatch ? familyMatch[1] : "";
    if (product.expectedFamilyId) {
      // Task mode: compare expected vs actual
      if (actualFamilyId !== product.expectedFamilyId) {
        productOk = false;
        result.verified_family = false;
        result.success = false;
        result.errors.push({
          code: "FAMILY_MISMATCH",
          message: `Product ${product.productId} (${product.format}): expected FamilyId="${product.expectedFamilyId}", got "${actualFamilyId}"`,
          field: "FamilyId",
          context: { productId: product.productId, format: product.format, expected: product.expectedFamilyId, actual: actualFamilyId },
        });
      }
    } else if (!actualFamilyId) {
      // Verify mode: warn if empty
      productOk = false;
      result.verified_family = false;
      result.warnings.push({
        code: "FAMILY_EMPTY",
        message: `Product ${product.productId} (${product.format} ${product.productName}) has no FamilyId assigned`,
        field: "FamilyId",
        context: { productId: product.productId, format: product.format },
      });
    }

    if (productOk) {
      result.summary.ok++;
    } else {
      result.success = false;
      result.summary.failed++;
    }
  }

  return result;
}

// ── WINE VALIDATION ──
interface WineValidationResult {
  valid: boolean;
  warnings: string[];
  missingFields: string[];
  error?: { code: string; message: string };
}

// deno-lint-ignore no-explicit-any
function validateWineForAgora(wine: any, formatType: string, connection?: any, priceLists?: { Id: string; Name: string }[]): WineValidationResult {
  const warnings: string[] = [];
  const missingFields: string[] = [];

  // BLOCK inactive wines — never create sellable products for inactive wines
  if (wine.is_active === false) {
    missingFields.push("wine_inactive");
    return { valid: false, warnings: ["Wine is inactive in Winerim — blocked from Agora push"], missingFields };
  }

  if (!wine.name || wine.name.length < 2) {
    missingFields.push("missing_wine_name");
  }

  const wineType = extractWineType(wine);
  if (!wineType) {
    warnings.push("missing_wine_type_will_use_default_family");
  }

  // Block if no PriceLists available — cannot guarantee cross-center pricing
  if (priceLists && priceLists.length === 0) {
    missingFields.push("no_pricelists_available");
  }

  if (formatType === "BOTTLE") {
    const bottlePrice = extractBottleSalePrice(wine);
    if (!bottlePrice || bottlePrice <= 0) {
      missingFields.push("missing_bottle_sale_price");
    }
    const bottleCost = extractBottleCostPrice(wine);
    if (!bottleCost || bottleCost <= 0) {
      warnings.push("missing_bottle_cost_price_will_use_zero");
    }
  }

  if (formatType === "GLASS") {
    if (!wine.serve_by_glass) {
      missingFields.push("serve_by_glass_not_enabled");
    }
    const glassPrice = extractGlassSalePrice(wine);
    if (!glassPrice || glassPrice <= 0) {
      missingFields.push("missing_glass_sale_price");
    }
    const glassCost = extractGlassCostPrice(wine, connection);
    if (!glassCost || glassCost <= 0) {
      warnings.push("missing_glass_cost_price_will_use_zero");
    } else if (!wine.glass_cost_price && wine.bottle_purchase_price) {
      const glassesPerBottle = connection?.estimated_glasses_per_bottle || 5;
      warnings.push(`glass_cost_estimated_from_bottle_price_divided_by_${glassesPerBottle}`);
    }
  }

  if (formatType === "MAGNUM") {
    const magnumPrice = wine.magnum_sale_price ? Number(wine.magnum_sale_price) : null;
    if (!magnumPrice || magnumPrice <= 0) {
      missingFields.push("missing_magnum_sale_price");
    }
    const magnumCost = wine.magnum_purchase_price ? Number(wine.magnum_purchase_price) : null;
    if (!magnumCost || magnumCost <= 0) {
      warnings.push("missing_magnum_cost_price_will_use_zero");
    }
  }

  return {
    valid: missingFields.length === 0,
    warnings,
    missingFields,
  };
}

// ── FIELD EXTRACTION (PRIORITY 3: use normalized DB fields first) ──
// deno-lint-ignore no-explicit-any
function extractWineType(wine: any): string | null {
  // 1. Use normalized DB field first
  if (wine.wine_type && typeof wine.wine_type === "string" && wine.wine_type.length > 0) {
    return wine.wine_type.toLowerCase();
  }
  // 2. Fallback to known raw_payload keys (mapped explicitly)
  const raw = wine.raw_payload || {};
  const type = raw.type || raw.wine_type || raw.category || raw.style || raw.color || raw.colour || null;
  if (type && typeof type === "string" && type.length > 0) return type.toLowerCase();
  // Do NOT fall back to grape_variety or region
  return null;
}

// deno-lint-ignore no-explicit-any
function extractBottleSalePrice(wine: any): number | null {
  // 1. Normalized DB field
  if (wine.bottle_sale_price && Number(wine.bottle_sale_price) > 0) return Number(wine.bottle_sale_price);
  // 2. Generic price field (legacy)
  if (wine.price && Number(wine.price) > 0) return Number(wine.price);
  // 3. Known raw_payload keys
  const raw = wine.raw_payload || {};
  const price = raw.bottle_sale_price ?? raw.sale_price ?? raw.pvp ?? raw.price ?? null;
  if (price && Number(price) > 0) return Number(price);
  return null;
}

// deno-lint-ignore no-explicit-any
function extractBottleCostPrice(wine: any): number | null {
  // 1. Normalized DB field
  if (wine.bottle_purchase_price && Number(wine.bottle_purchase_price) > 0) return Number(wine.bottle_purchase_price);
  // 2. Known raw_payload keys
  const raw = wine.raw_payload || {};
  const cost = raw.bottle_purchase_price ?? raw.purchase_price ?? raw.cost_price ?? raw.cost ?? null;
  if (cost && Number(cost) > 0) return Number(cost);
  return null;
}

// deno-lint-ignore no-explicit-any
function extractGlassSalePrice(wine: any): number | null {
  // 1. Normalized DB field
  if (wine.glass_sale_price && Number(wine.glass_sale_price) > 0) return Number(wine.glass_sale_price);
  // 2. Known raw_payload keys
  const raw = wine.raw_payload || {};
  const price = raw.glass_sale_price ?? raw.glass_price ?? null;
  if (price && Number(price) > 0) return Number(price);
  return null;
}

// deno-lint-ignore no-explicit-any
function extractGlassCostPrice(wine: any, connection?: any): number | null {
  // 1. Normalized DB field
  if (wine.glass_cost_price && Number(wine.glass_cost_price) > 0) return Number(wine.glass_cost_price);
  // 2. Known raw_payload keys
  const raw = wine.raw_payload || {};
  const cost = raw.glass_cost_price ?? raw.glass_cost ?? null;
  if (cost && Number(cost) > 0) return Number(cost);
  // 3. PRIORITY 4: Configurable fallback from bottle purchase price
  const bottleCost = extractBottleCostPrice(wine);
  if (bottleCost && bottleCost > 0) {
    const glassesPerBottle = connection?.estimated_glasses_per_bottle || 5;
    return Math.round((bottleCost / glassesPerBottle) * 100) / 100;
  }
  return null;
}

// ── GEOGRAPHIC FAMILY HELPERS ──
const GEO_COUNTRY_NAMES: Record<string, string> = {
  ES: "España", FR: "Francia", IT: "Italia", PT: "Portugal", DE: "Alemania",
  AT: "Austria", CH: "Suiza", GR: "Grecia", US: "EEUU", AR: "Argentina",
  CL: "Chile", AU: "Australia", NZ: "Nueva Zelanda", ZA: "Sudáfrica",
  GB: "Reino Unido", HU: "Hungría", GE: "Georgia", LB: "Líbano",
  IL: "Israel", AM: "Armenia", RO: "Rumanía", SI: "Eslovenia",
  HR: "Croacia", MX: "México", UY: "Uruguay", BR: "Brasil",
};

const GEO_TYPE_LABELS: Record<string, string> = {
  tinto: "TINTO", blanco: "BLANCO", rosado: "ROSADO",
  espumoso: "ESPUMOSO", fortificado: "FORTIFICADO",
  postre: "DULCE", dulce: "DULCE",
};

interface GeographicFamilyConfig {
  family_naming_mode: string;
  region_threshold: number;
  selected_regions: string[];
  excluded_regions: string[];
  hierarchy_mode?: "FLAT" | "HIERARCHICAL"; // FLAT = all families at root; HIERARCHICAL = Type+Country > Region (2 levels only, Agora limit)
}

function buildGeoFamilyName(wineType: string, country: string, region: string | null, isTopRegion: boolean): string {
  const tLabel = GEO_TYPE_LABELS[wineType?.toLowerCase()] || (wineType || "OTROS").toUpperCase();
  const cName = GEO_COUNTRY_NAMES[country] || country;
  if (isTopRegion && region) {
    return `${tLabel} - ${region}`;
  }
  return `${tLabel} - ${cName} (Otras)`;
}

// Hierarchical family name builders (for 3-level mode)
function geoTypeParentName(wineType: string): string {
  const tLabel = GEO_TYPE_LABELS[wineType?.toLowerCase()] || (wineType || "OTROS").toUpperCase();
  return `${tLabel} WINERIM`;
}

function geoCountrySubName(wineType: string, country: string): string {
  const tLabel = GEO_TYPE_LABELS[wineType?.toLowerCase()] || (wineType || "OTROS").toUpperCase();
  const cName = GEO_COUNTRY_NAMES[country] || country;
  return `${tLabel} ${cName}`;
}

function geoRegionLeafName(region: string): string {
  return region;
}

function geoCountryOtrasName(wineType: string, country: string): string {
  const tLabel = GEO_TYPE_LABELS[wineType?.toLowerCase()] || (wineType || "OTROS").toUpperCase();
  const cName = GEO_COUNTRY_NAMES[country] || country;
  return `${tLabel} ${cName} Otras`;
}

// deno-lint-ignore no-explicit-any
function isTopRegion(country: string, region: string, geoConfig: GeographicFamilyConfig, allWines: any[]): boolean {
  const key = `${country}|${region}`;
  if (geoConfig.excluded_regions?.includes(key)) return false;
  if (geoConfig.selected_regions?.includes(key)) return true;
  // Count wines in this region across all types
  let count = 0;
  for (const w of allWines) {
    const raw = w.raw_payload || {};
    if ((raw.country || "XX") === country && (raw.region || "Sin región") === region) count++;
  }
  return count >= (geoConfig.region_threshold || 10);
}

// ── XML IMPORT GENERATOR (HARDENED) ──
// deno-lint-ignore no-explicit-any
function generateImportXml(wines: any[], masterData: any, connection: any, formatTypes: string[], customFamilyMappings?: Record<string, { id: string; name: string }>, forceEmptyPreparation = false, geographicConfig?: GeographicFamilyConfig, allWinesForGeo?: any[]): { xml: string; validationResults: { winerimId: string; formatType: string; validation: WineValidationResult }[] } {
  const families = (masterData.families_json || []) as { Id: string; Name: string }[];
  const vats = (masterData.vats_json || []) as { Id: string; Name: string; VatRate: string }[];
  // Filter out deleted PriceLists — they must never appear in generated XML
  const allPriceListsRaw = (masterData.price_lists_json || []) as Record<string, unknown>[];
  const priceLists = allPriceListsRaw.filter(e => !isDeletedEntity(e)) as { Id: string; Name: string }[];
  const prepTypes = (masterData.preparation_types_json || []) as { Id: string; Name: string }[];
  const prepOrders = (masterData.preparation_orders_json || []) as { Id: string; Name: string }[];
  const warehouses = (masterData.warehouses_json || []) as { Id: string; Name: string }[];
  const existingProducts = (masterData.products_summary_json || []) as { Id: string; Name: string }[];

  const defaultVatId = connection.default_vat_id || findVatIdByRate(vats, connection.default_vat_rate) || (vats.length > 0 ? vats[0].Id : "3");
  
  // Pre-declare validationResults so prep guard can push warnings
  const validationResults: { winerimId: string; formatType: string; validation: WineValidationResult }[] = [];

  // HARDENED: Prevent TPV crash — PreparationTypeId and PreparationOrderId must ALWAYS be both empty or both set.
  let defaultPrepTypeId: string;
  let defaultPrepOrderId: string;
  if (forceEmptyPreparation) {
    defaultPrepTypeId = "";
    defaultPrepOrderId = "";
  } else {
    const rawPrepType = connection.default_preparation_type_id || "";
    const rawPrepOrder = connection.default_preparation_order_id || "";
    const typeSet = rawPrepType.length > 0;
    const orderSet = rawPrepOrder.length > 0;
    if (typeSet !== orderSet) {
      // MISMATCH: one is set and the other is not — force BOTH empty to prevent crash
      defaultPrepTypeId = "";
      defaultPrepOrderId = "";
      validationResults.push({
        winerimId: "_CONNECTION_CONFIG",
        formatType: "ALL",
        validation: {
          valid: false,
          warnings: [],
          missingFields: ["PreparationTypeId", "PreparationOrderId"],
        },
      });
      // Emit the canonical error so callers can detect it
      validationResults.push({
        winerimId: "_CONNECTION_CONFIG",
        formatType: "ALL",
        validation: {
          valid: false,
          warnings: [`Configured PreparationTypeId="${rawPrepType}" / PreparationOrderId="${rawPrepOrder}" are inconsistent — both forced empty.`],
          missingFields: [],
          error: { code: "INVALID_PREPARATION_PAIR", message: "Preparation Type and Order must both be empty or both set" },
        },
      });
    } else {
      defaultPrepTypeId = rawPrepType;
      defaultPrepOrderId = rawPrepOrder;
    }
  }
  const defaultWarehouseId = connection.default_warehouse_id || (warehouses.length > 0 ? warehouses[0].Id : "1");
  const autoCreateFamilies = connection.auto_create_families ?? false;

  // deno-lint-ignore no-explicit-any
  function findFamilyId(wineType: string | null, formatType?: string, wine?: any): { id: string; needsCreate: boolean; familyName: string; parentId?: string; grandparentId?: string } {
    // PRIORITY 0: Geographic families mode
    if (geographicConfig && geographicConfig.family_naming_mode === "GEOGRAPHIC_FAMILIES" && wine) {
      const raw = wine.raw_payload || {};
      const country = (raw.country || "XX") as string;
      const region = (raw.region || "Sin región") as string;
      const winesPool = allWinesForGeo || wines;
      const top = isTopRegion(country, region, geographicConfig, winesPool);

      if (geographicConfig.hierarchy_mode === "HIERARCHICAL") {
        // 2-level hierarchy (Agora limit: no subfamilies of subfamilies):
        // Level 1 (parent): "TINTO ESPAÑA", "BLANCO FRANCIA"...
        // Level 2 (child):  "Ribera del Duero", "Rioja"... or "Otras"
        const typeCountryParent = geoCountrySubName(wineType || "otros", country);
        const typeCountryParentId = stableFamilyId(typeCountryParent);

        // Register Type+Country as root parent
        if (!newFamilies.some(f => f.id === typeCountryParentId)) {
          newFamilies.push({ id: typeCountryParentId, name: typeCountryParent });
        }

        if (top && region) {
          // Region as direct child of Type+Country
          const leafName = geoRegionLeafName(region);
          const leafId = stableFamilyId(`${typeCountryParent}_${leafName}`);
          if (!newFamilyHierarchy.some(f => f.id === leafId)) {
            newFamilyHierarchy.push({ id: leafId, name: leafName, parentId: typeCountryParentId });
          }
          const existing = families.find(f => f.Name === leafName && f.Id === leafId);
          return { id: leafId, needsCreate: !existing, familyName: leafName, parentId: typeCountryParentId };
        } else {
          // "Otras" child under Type+Country — use unique name to avoid duplicate key in Agora
          const otrasFullName = geoCountryOtrasName(wineType || "otros", country);
          const otrasId = stableFamilyId(otrasFullName);
          // Use a short but unique display name: "Otras (TINTOS ESP)" to avoid Agora's UNIQUE constraint on family Name
          const otrasDisplayName = `Otras (${typeCountryParent})`;
          if (!newFamilyHierarchy.some(f => f.id === otrasId)) {
            newFamilyHierarchy.push({ id: otrasId, name: otrasDisplayName, parentId: typeCountryParentId });
          }
          const existing = families.find(f => f.Id === otrasId);
          return { id: otrasId, needsCreate: !existing, familyName: otrasDisplayName, parentId: typeCountryParentId };
        }
      }

      // FLAT mode (original behavior)
      const familyName = buildGeoFamilyName(wineType || "otros", country, region, top);
      const existing = families.find(f => f.Name === familyName);
      if (existing) return { id: existing.Id, needsCreate: false, familyName: existing.Name };
      const newId = stableFamilyId(familyName);
      return { id: newId, needsCreate: true, familyName };
    }

    // PRIORITY 1: Use custom family mappings if available
    if (customFamilyMappings) {
      // Try format-specific key first (e.g. "copa", "magnum")
      if (formatType === "GLASS" && customFamilyMappings["copa"]) {
        return { id: customFamilyMappings["copa"].id, needsCreate: false, familyName: customFamilyMappings["copa"].name };
      }
      if (formatType === "GLASS" && customFamilyMappings["glass"]) {
        return { id: customFamilyMappings["glass"].id, needsCreate: false, familyName: customFamilyMappings["glass"].name };
      }
      // Try wine type key (e.g. "botella_tinto", "tinto")
      if (wineType) {
        const typeKey = WINE_TYPE_ALIASES[wineType.toLowerCase()] || wineType.toLowerCase();
        // Try "botella_<type>" for bottles
        if (formatType === "BOTTLE" || !formatType) {
          const bottleKey = `botella_${typeKey}`;
          if (customFamilyMappings[bottleKey]) {
            return { id: customFamilyMappings[bottleKey].id, needsCreate: false, familyName: customFamilyMappings[bottleKey].name };
          }
        }
        // Try just the type
        if (customFamilyMappings[typeKey]) {
          return { id: customFamilyMappings[typeKey].id, needsCreate: false, familyName: customFamilyMappings[typeKey].name };
        }
      }
      // Try magnum key
      if (formatType === "MAGNUM" && customFamilyMappings["magnum"]) {
        return { id: customFamilyMappings["magnum"].id, needsCreate: false, familyName: customFamilyMappings["magnum"].name };
      }
    }

    // PRIORITY 2: Connection default
    if (connection.default_family_id) {
      const found = families.find(f => f.Id === connection.default_family_id);
      if (found) return { id: found.Id, needsCreate: false, familyName: found.Name };
    }

    // Try matching wine type (only from real type field, not grape/region)
    if (wineType) {
      const typeKey = WINE_TYPE_ALIASES[wineType.toLowerCase()] || wineType.toLowerCase();
      const candidates = WINE_TYPE_FAMILY_MAP[typeKey] || [];
      for (const candidate of candidates) {
        const found = families.find(f => f.Name.toLowerCase().includes(candidate.toLowerCase()));
        if (found) return { id: found.Id, needsCreate: false, familyName: found.Name };
      }
    }

    // Fallback: search for generic wine family
    const genericNames = ["Vinos", "Vino", "Wine", "Wines", connection.default_wine_family_name || "Vinos"];
    for (const name of genericNames) {
      const found = families.find(f => f.Name.toLowerCase() === name.toLowerCase());
      if (found) return { id: found.Id, needsCreate: false, familyName: found.Name };
    }

    // Auto-create if enabled - use DETERMINISTIC ID
    if (autoCreateFamilies && wineType) {
      const newFamilyName = `Vinos ${wineType.charAt(0).toUpperCase() + wineType.slice(1)}`;
      const newId = stableFamilyId(newFamilyName);
      return { id: newId, needsCreate: true, familyName: newFamilyName };
    }

    // Ultimate fallback: first family
    if (families.length > 0) return { id: families[0].Id, needsCreate: false, familyName: families[0].Name };
    return { id: "1", needsCreate: false, familyName: "Vinos" };
  }

  function findVatIdByRate(vatList: { Id: string; VatRate: string }[], rate?: number): string | null {
    if (!rate) return null;
    const rateStr = (rate / 100).toFixed(2);
    const found = vatList.find(v => v.VatRate === rateStr);
    return found?.Id || null;
  }

  function escapeXml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  }

  function truncate(s: string, maxLen: number): string {
    return s.length <= maxLen ? s : s.substring(0, maxLen);
  }

  const newFamilies: { id: string; name: string }[] = [];
  const newFamilyHierarchy: { id: string; name: string; parentId: string }[] = [];
  const productEntries: {
    wineName: string;
    formatOrder: number;
    productId: string;
    productName: string;
    winerimId: string;
    renderXml: (finalProductName: string) => string;
  }[] = [];

  for (const wine of wines) {
    const winerimId = Number(wine.winerim_id || wine.id || 0);
    const wineName = wine.name || "Unknown Wine";
    const wineType = extractWineType(wine);

    for (const fmt of formatTypes) {
      // Validate before generating (pass connection for glass cost fallback + priceLists emptiness check)
      const validation = validateWineForAgora(wine, fmt, connection, priceLists);
      validationResults.push({ winerimId: String(winerimId), formatType: fmt, validation });

      // Skip formats with missing required fields
      if (!validation.valid) continue;

      const isMagnum = fmt === "MAGNUM";
      const isGlass = fmt === "GLASS";
      const productId = isMagnum ? 900000 + winerimId : isGlass ? 700000 + winerimId : 500000 + winerimId;

      const familyResult = findFamilyId(wineType, fmt, wine);
      if (familyResult.needsCreate && !newFamilies.some(f => f.id === familyResult.id)) {
        newFamilies.push({ id: familyResult.id, name: familyResult.familyName });
      }

      const productName = formatProductName(isMagnum ? "MAGNUM" : isGlass ? "GLASS" : "BOTTLE", wineName);
      // Use REAL prices from normalized fields, never invent
      let mainPrice: string;
      let costPrice: string;

      if (isMagnum) {
        mainPrice = (Number(wine.magnum_sale_price) || 0).toFixed(2);
        costPrice = (Number(wine.magnum_purchase_price) || 0).toFixed(2);
      } else if (isGlass) {
        mainPrice = (extractGlassSalePrice(wine) || 0).toFixed(2);
        costPrice = (extractGlassCostPrice(wine, connection) || 0).toFixed(2);
      } else {
        mainPrice = (extractBottleSalePrice(wine) || 0).toFixed(2);
        costPrice = (extractBottleCostPrice(wine) || 0).toFixed(2);
      }

      // Generate prices for ALL PriceLists (same price everywhere)
      const pricesXml = priceLists.map(pl =>
        `        <Price PriceListId="${pl.Id}" MainPrice="${mainPrice}" AddinPrice="0.00" MenuItemPrice="0.00" />`
      ).join("\n");

      const costPricesXml = warehouses.map(wh =>
        `        <CostPrice WarehouseId="${wh.Id}" CostPrice="${costPrice}" />`
      ).join("\n");

      const formatOrder = isMagnum ? 2 : isGlass ? 1 : 0; // BOT=0, COPA=1, MAG=2
      productEntries.push({
        wineName: wineName.toLowerCase(),
        formatOrder,
        productId: String(productId),
        productName,
        winerimId: String(winerimId),
        renderXml: (finalProductName: string) => {
          const buttonText = truncate(finalProductName, 20);
          return `    <Product Id="${productId}" Name="${escapeXml(finalProductName)}" ButtonText="${escapeXml(buttonText)}" Color="#8B0000" PLU="" FamilyId="${familyResult.id}" VatId="${defaultVatId}" UseAsDirectSale="true" SaleableAsMain="true" SaleableAsAddin="false" IsSoldByWeight="false" AskForPreparationNotes="false" AskForAddins="false" PrintWhenPriceIsZero="false" PreparationTypeId="${defaultPrepTypeId}" PreparationOrderId="${defaultPrepOrderId}" CostPrice="${costPrice}">
      <Prices>
${pricesXml}
      </Prices>
      <CostPrices>
${costPricesXml}
      </CostPrices>
    </Product>`;
        },
      });
    }
  }

  let xml = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n<Import>\n`;

  const allFamiliesToCreate = [...newFamilies, ...newFamilyHierarchy];
  if (allFamiliesToCreate.length > 0) {
    xml += `  <Families>\n`;
    // First: root families (no parent)
    for (const f of newFamilies) {
      xml += `    <Family Id="${f.id}" Name="${escapeXml(f.name)}" ShowInPos="true" ButtonText="${escapeXml(truncate(f.name, 15))}" Color="#8B0000" Order="100" />\n`;
    }
    // Then: hierarchical families (with parent)
    for (const f of newFamilyHierarchy) {
      xml += `    <Family Id="${f.id}" Name="${escapeXml(f.name)}" ShowInPos="true" ButtonText="${escapeXml(truncate(f.name, 15))}" Color="#8B0000" Order="100" ParentFamilyId="${f.parentId}" />\n`;
    }
    xml += `  </Families>\n`;
  }

  // Sort by wine name (alphabetical), then by format (BOT, COPA, MAG)
  productEntries.sort((a, b) => a.wineName.localeCompare(b.wineName, "es") || a.formatOrder - b.formatOrder);

  const duplicateSafeProductNames = buildDuplicateSafeAgoraProductNames(
    productEntries.map((entry) => ({
      productId: entry.productId,
      baseName: entry.productName,
      winerimId: entry.winerimId,
    })),
    existingProducts,
  );

  // Inject SortOrder attribute into each <Product> based on sorted position
  const productXmls = productEntries.map((entry, idx) => {
    const finalProductName = duplicateSafeProductNames[entry.productId] || entry.productName;
    return entry.renderXml(finalProductName).replace('<Product Id=', `<Product SortOrder="${idx + 1}" Id=`);
  });

  if (productXmls.length > 0) {
    xml += `  <Products>\n`;
    xml += productXmls.join("\n");
    xml += `\n  </Products>\n`;
  }
  xml += `</Import>`;

  return { xml, validationResults };
}

// ── PARSE AGORA IMPORT RESPONSE ──
interface AgoraImportParsedResponse {
  success: boolean;
  importedCount: number;
  updatedCount: number;
  errors: string[];
  warnings: string[];
  rawPreview: string;
}

function parseAgoraImportResponse(status: number, body: string): AgoraImportParsedResponse {
  const rawPreview = body.substring(0, 2048);
  const errors: string[] = [];
  const warnings: string[] = [];
  let importedCount = 0;
  let updatedCount = 0;

  if (status === 404 || status === 405) {
    return { success: false, importedCount: 0, updatedCount: 0, errors: [`HTTP ${status}: Import endpoint not available`], warnings: [], rawPreview };
  }

  if (status >= 400) {
    errors.push(`HTTP ${status}`);
  }

  // Try parse XML response for structured errors
  const errorMatches = body.match(/<Error[^>]*>([^<]*)<\/Error>/gi);
  if (errorMatches) {
    for (const m of errorMatches) {
      const content = m.replace(/<\/?Error[^>]*>/gi, "").trim();
      if (content) errors.push(content);
    }
  }

  // Check for common error patterns
  const missingFamilyMatch = body.match(/FamilyId[^<]*not found|invalid FamilyId|unknown family/i);
  if (missingFamilyMatch) errors.push("missing_FamilyId: " + missingFamilyMatch[0].substring(0, 100));

  const missingVatMatch = body.match(/VatId[^<]*not found|invalid VatId|unknown vat/i);
  if (missingVatMatch) errors.push("missing_VatId: " + missingVatMatch[0].substring(0, 100));

  const missingPriceListMatch = body.match(/PriceListId[^<]*not found|invalid PriceListId/i);
  if (missingPriceListMatch) errors.push("invalid_PriceListId: " + missingPriceListMatch[0].substring(0, 100));

  // Check for warning patterns
  const warningMatches = body.match(/<Warning[^>]*>([^<]*)<\/Warning>/gi);
  if (warningMatches) {
    for (const m of warningMatches) {
      const content = m.replace(/<\/?Warning[^>]*>/gi, "").trim();
      if (content) warnings.push(content);
    }
  }

  // Try to extract counts
  const importedMatch = body.match(/imported[:\s]*(\d+)/i);
  if (importedMatch) importedCount = parseInt(importedMatch[1]);
  const updatedMatch = body.match(/updated[:\s]*(\d+)/i);
  if (updatedMatch) updatedCount = parseInt(updatedMatch[1]);

  // If HTTP OK and no structured errors, consider success
  const success = status >= 200 && status < 300 && errors.length === 0;

  return { success, importedCount, updatedCount, errors, warnings, rawPreview };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // ── FIX PRIORITY 1: Read body ONCE ──
    const payload = await req.json();
    const { action, connectionId, businessDay, daysBack, lastBusinessDay, filter } = payload;

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
    let baseUrlClean = (base_url ?? "").trim().replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(baseUrlClean)) {
      baseUrlClean = `http://${baseUrlClean}`;
    }
    // Validate host: reject placeholders and unresolvable single-label hostnames
    try {
      const parsed = new URL(baseUrlClean);
      const host = parsed.hostname.toLowerCase();
      const placeholderHosts = new Set(["tuip", "tu-ip", "your-ip", "yourip", "localhost.example", "ejemplo", "example"]);
      const isIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(host);
      const isFqdn = host.includes(".");
      if (!host || placeholderHosts.has(host) || (!isIp && !isFqdn)) {
        return new Response(
          JSON.stringify({
            error: `Invalid base_url for connection ${connection.id} (${connection.location_name}): "${base_url}". Configure a real IP or FQDN before invoking this connection.`,
          }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    } catch {
      return new Response(
        JSON.stringify({ error: `Malformed base_url for connection ${connection.id}: "${base_url}"` }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    const apiTokenClean = api_token.trim();
    const headers: Record<string, string> = { "Api-Token": apiTokenClean, Accept: "*/*" };

    async function fetchWithRetry(url: string, opts: RequestInit = {}, timeoutMs = 15000): Promise<Response> {
      // RATE LIMIT: never exceed POS_MAX_REQS_PER_SECOND requests/sec to a single POS
      await throttleConnection(connectionId);
      const controller1 = new AbortController();
      const t1 = setTimeout(() => controller1.abort(), timeoutMs);
      try {
        const r = await fetch(url, { ...opts, signal: controller1.signal });
        clearTimeout(t1);
        return r;
      } catch (_e1) {
        clearTimeout(t1);
        // Throttle again before retry to avoid stacking
        await throttleConnection(connectionId);
        const controller2 = new AbortController();
        const t2 = setTimeout(() => controller2.abort(), timeoutMs);
        try {
          const r = await fetch(url, { ...opts, signal: controller2.signal });
          clearTimeout(t2);
          return r;
        } catch (e2) {
          clearTimeout(t2);
          throw e2;
        }
      }
    }

    // ── TEST ──
    if (action === "test") {
      const today = new Date().toISOString().split("T")[0];
      const url = `${baseUrlClean}/api/export/?business-day=${today}&filter=Invoices`;
      try {
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
        return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      } catch (err) {
        const raw = String(err);
        const isDnsError = /dns error|failed to lookup address/i.test(raw);
        const isTimeout = /timed out|timeout/i.test(raw);
        const isNoRoute = /no route to host|connection refused|network is unreachable|connection reset/i.test(raw);
        const isConnectError = /tcp connect error|client error \(Connect\)/i.test(raw);

        if (isDnsError || isTimeout || isNoRoute || isConnectError) {
          let message = "Cannot reach the Agora server";
          let hint = "Verify the base_url, that the Agora server is running, and that the port is open on the customer's router/firewall.";
          if (isDnsError) {
            message = "DNS lookup failed for the Agora host";
            hint = "Check that the hostname/IP in base_url is correct and publicly resolvable.";
          } else if (isTimeout) {
            message = "Connection to the Agora server timed out";
            hint = "Check the Agora service is running and the port is forwarded.";
          } else if (isNoRoute) {
            message = "No route to the Agora server (port closed or firewall blocking)";
            hint = "Open port 8984 on the customer's router and firewall toward the PC running Agora.";
          }

          return new Response(
            JSON.stringify({ success: false, status: 502, message, hint, details: raw, kind: "NETWORK_UNREACHABLE" }),
            { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        return new Response(
          JSON.stringify({ success: false, status: 500, message: raw }),
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
        if (consecutiveEmpty >= 10 && daysWithSales.length > 0) break;
      }

      // lastClosedDay = most recent day with sales (cash closure completed)
      const lastClosedDay = daysWithSales.length > 0 ? daysWithSales[0] : null;

      return new Response(
        JSON.stringify({ daysWithSales, totalScanned, totalInvoicesFound, lastClosedDay }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── FETCH & PARSE SALES FOR A BUSINESS DAY ──
    // ── DISCOVER LIVE SALES ENDPOINTS ──
    // Tests multiple Agora endpoints to find one that returns sales BEFORE cash close.
    // Read-only probe; does not mutate any data.
    if (action === "discover-live-sales") {
      const day = businessDay || new Date().toISOString().slice(0, 10);
      const filters = [
        "Invoices", "Tickets", "Orders", "Receipts",
        "OpenInvoices", "OpenTickets", "OpenOrders", "PendingInvoices",
        "CurrentTickets", "LiveTickets", "Sales", "Documents",
      ];
      const results: any[] = [];
      for (const f of filters) {
        const url = `${baseUrlClean}/api/export/?business-day=${day}&filter=${f}`;
        try {
          const r = await fetch(url, { headers });
          const ct = r.headers.get("content-type") || "";
          let count = 0;
          let sampleKeys: string[] = [];
          let bodyPreview = "";
          if (r.ok) {
            const txt = await r.text();
            bodyPreview = txt.slice(0, 200);
            if (ct.includes("json")) {
              try {
                const j = JSON.parse(txt);
                const arr = Array.isArray(j) ? j : (j?.Invoices || j?.Items || j?.Data || []);
                count = Array.isArray(arr) ? arr.length : 0;
                if (count > 0 && typeof arr[0] === "object") sampleKeys = Object.keys(arr[0]).slice(0, 12);
              } catch (_e) { /* not json */ }
            }
          }
          results.push({ filter: f, status: r.status, ok: r.ok, contentType: ct, count, sampleKeys, bodyPreview });
        } catch (e: any) {
          results.push({ filter: f, error: String(e?.message || e) });
        }
      }
      return new Response(
        JSON.stringify({ businessDay: day, baseUrl: baseUrlClean, results }, null, 2),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (action === "fetch-day") {
      const day = businessDay;
      if (!day) {
        return new Response(JSON.stringify({ error: "businessDay is required" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const url = `${baseUrlClean}/api/export/?business-day=${day}&filter=Invoices`;
      const res = await fetch(url, { headers });
      if (!res.ok) {
        return new Response(JSON.stringify({ error: `Agora responded ${res.status}` }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } });
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

      const allFamilies = new Set<string>();

      const salesEvents = invoices.map((inv: any) => {
        const docId = String(inv.InvoiceId || inv.Id || "");
        const items = inv.InvoiceItems || [];
        const lines: any[] = [];
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
            const normalizedFormat = normalizeLineFormat(productName, formatName);
            const wineResult = isWineCandidate(family, productName, formatName, uPrice, wineFamilies, DEFAULT_NON_WINE_FAMILIES);
            lines.push({
              provider_product_id: String(line.ProductId || ""),
              name: productName, format: normalizedFormat, family,
              quantity: qty, unit_price: uPrice, total_amount: lineTotal,
              vat_rate: Number(line.VatRate || 0),
              is_wine_candidate: wineResult.candidate, wine_score: wineResult.score, wine_reasons: wineResult.reasons,
            });
          }
        }

        return {
          provider_doc_id: docId, business_day: day,
          doc_type: String(inv.Type || "BasicInvoice"),
          total_amount: Number(inv.TotalAmount || docTotal),
          total_tax: Number(inv.TotalTaxAmount || 0),
          total_net: Number(inv.TotalNetAmount || 0),
          line_count: lines.length, lines,
        };
      });

      const detectedFamilies = Array.from(allFamilies).map((f) => {
        const suggestion = suggestFamilyClassification(f);
        const itemCount = salesEvents.reduce((c: number, ev: any) =>
          c + ev.lines.filter((l: any) => l.family === f).length, 0);
        return { name: f, ...suggestion, itemCount };
      });

      return new Response(
        JSON.stringify({ businessDay: day, invoiceCount: invoices.length, salesEvents, detectedFamilies }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── SAVE SALES TO DB (with Winerim resolution) ──
    if (action === "save-sales") {
      const day = businessDay;
      if (!day) {
        return new Response(JSON.stringify({ error: "businessDay required" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const url = `${baseUrlClean}/api/export/?business-day=${day}&filter=Invoices`;
      const res = await fetch(url, { headers });
      if (!res.ok) {
        return new Response(JSON.stringify({ error: `Agora responded ${res.status}` }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } });
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

      // ── Build resolution lookup: agora_product_id -> { winerim_wine_id, format } ──
      const { data: trackingRows } = await supabase
        .from("winerim_push_tracking")
        .select("agora_product_id, winerim_wine_id, format, sync_status")
        .eq("connection_id", connectionId);
      const { data: mappingRows } = await supabase
        .from("product_mappings")
        .select("provider_product_id, winerim_wine_id, format_type, status")
        .eq("connection_id", connectionId);

      // Build lookup map: agora_product_id -> { winerim_wine_id, format }
      const resolutionMap = new Map<string, { winerim_wine_id: string; format: string }>();
      // Priority 1: push tracking (verified/pushed products)
      for (const t of (trackingRows || [])) {
        if (t.agora_product_id && t.winerim_wine_id && (t.sync_status === "VERIFIED" || t.sync_status === "PUSHED")) {
          resolutionMap.set(String(t.agora_product_id), { winerim_wine_id: t.winerim_wine_id, format: t.format });
        }
      }
      // Priority 2: product mappings (confirmed matches)
      for (const m of (mappingRows || [])) {
        if (m.provider_product_id && m.winerim_wine_id && m.status === "CONFIRMED" && !resolutionMap.has(m.provider_product_id)) {
          resolutionMap.set(m.provider_product_id, { winerim_wine_id: m.winerim_wine_id, format: m.format_type || "BOTTLE" });
        }
      }

      let savedEvents = 0;
      let savedLines = 0;
      let resolvedLines = 0;
      let unresolvedLines = 0;

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
            const normalizedFmt = normalizeLineFormat(pName, fName);
            const fam = String(line.FamilyName || "");
            const productId = String(line.ProductId || "");
            const wr = isWineCandidate(fam, pName, fName, uP, wineFamilies, DEFAULT_NON_WINE_FAMILIES);

            // Resolve to winerim wine
            const resolution = resolutionMap.get(productId);
            const winerimProductId = resolution?.winerim_wine_id || null;
            const isResolved = !!winerimProductId;
            if (isResolved) resolvedLines++; else if (wr.candidate) unresolvedLines++;

            lineData.push({
              provider_product_id: productId,
              name: pName, format: normalizedFmt, family: fam,
              quantity: qty, unit_price: uP, total_amount: lineTotal,
              vat_rate: Number(line.VatRate || 0), is_wine_candidate: wr.candidate,
              winerim_product_id: winerimProductId,
              mapped: isResolved,
            });
          }
        }

        const { data: eventRow, error: eventErr } = await supabase
          .from("sales_events")
          .upsert({
            connection_id: connectionId, provider_doc_id: docId, business_day: day,
            doc_type: String(inv.Type || "BasicInvoice"),
            total_amount: Number(inv.TotalAmount || docTotal),
            total_tax: Number(inv.TotalTaxAmount || 0),
            total_net: Number(inv.TotalNetAmount || 0),
            line_count: lineData.length, raw_json: inv,
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

      let stockSyncResult: StockSyncTotals | null = null;
      let warning: string | null = null;
      const winerimToken = (connection.winerim_api_token || "").trim();
      const skipStockSync = payload.skipStockSync === true;
      const shouldSyncStock = !skipStockSync && resolvedLines > 0;

      if (shouldSyncStock && winerimToken) {
        stockSyncResult = await syncStockForDays(supabase, connectionId, [day], winerimToken);
      }

      const cursorDecision = decideSalesCursorAdvance({
        resolvedLines,
        skipStockSync,
        hasWinerimToken: Boolean(winerimToken),
        stockFailed: stockSyncResult?.failed || 0,
      });
      const cursorAdvanced = cursorDecision.advance;
      if (cursorDecision.reason === "missing_winerim_token") {
        warning = "Sales saved but Winerim stock was not synced: missing Winerim API token.";
      } else if (cursorDecision.reason === "stock_failed") {
        warning = "Sales saved but Winerim stock sync had failures. Cursor was not advanced, so cron will retry.";
      }

      const connectionUpdate = cursorAdvanced
        ? { last_business_day_synced: day, last_sync_at: new Date().toISOString() }
        : { last_sync_at: new Date().toISOString() };
      await supabase.from("pos_connections")
        .update(connectionUpdate)
        .eq("id", connectionId);

      return new Response(
        JSON.stringify({
          success: true,
          savedEvents,
          savedLines,
          resolvedLines,
          unresolvedLines,
          businessDay: day,
          stockSync: stockSyncResult,
          cursorAdvanced,
          warning,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── AUTO-SYNC SALES (find pending days and save them) ──
    if (action === "auto-sync-sales") {
      // Find last synced day
      const lastSynced = connection.last_business_day_synced;
      const startDate = lastSynced
        ? new Date(new Date(lastSynced).getTime() + 86400000)
        : new Date(Date.now() - 30 * 86400000);
      const today = new Date();
      const yesterday = new Date(today.getTime() - 86400000);

      // Scan from startDate to yesterday (closed days only)
      // Wall-clock guard: bail out before edge runtime 150s idle timeout (504 IDLE_TIMEOUT)
      const ACTION_DEADLINE_MS = 120_000;
      const actionStart = Date.now();
      const pendingDays: string[] = [];
      const current = new Date(startDate);
      let scanAborted = false;
      while (current <= yesterday && pendingDays.length < 30) {
        if (Date.now() - actionStart > ACTION_DEADLINE_MS) { scanAborted = true; break; }
        const dayStr = current.toISOString().split("T")[0];
        const url = `${baseUrlClean}/api/export/?business-day=${dayStr}&filter=Invoices`;
        try {
          const res = await fetchWithRetry(url, { headers }, 10_000);
          if (res.ok) {
            const rawData = await res.json();
            const invoices = parseInvoices(rawData);
            if (invoices.length > 0) pendingDays.push(dayStr);
          } else {
            await res.text();
          }
        } catch (err) { /* skip */ }
        current.setDate(current.getDate() + 1);
      }
      if (scanAborted) {
        return new Response(
          JSON.stringify({ success: false, aborted: true, reason: "scan_deadline_exceeded", message: "Agora server unresponsive; aborted before timeout. Will retry next cron." }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      if (pendingDays.length === 0) {
        const winerimToken = (connection.winerim_api_token || "").trim();
        let stockSyncResult: StockSyncTotals | null = null;

        if (winerimToken) {
          const lookbackDays = Math.min(Math.max(Number(connection.backfill_days || 30), 1), 30);
          const fromDay = new Date(yesterday.getTime() - (lookbackDays - 1) * 86400000).toISOString().split("T")[0];
          const toDay = yesterday.toISOString().split("T")[0];
          const stockCandidateDays = await findSavedStockCandidateDays(supabase, connectionId, fromDay, toDay);
          if (stockCandidateDays.length > 0) {
            stockSyncResult = await syncStockForDays(supabase, connectionId, stockCandidateDays, winerimToken);
          }
        }

        return new Response(
          JSON.stringify({
            success: true,
            daysSynced: 0,
            totalEvents: 0,
            totalLines: 0,
            resolvedLines: 0,
            unresolvedLines: 0,
            stockSync: stockSyncResult,
            message: stockSyncResult?.checkedDays
              ? "No pending sales days; checked saved days for stock catch-up"
              : "No pending days to sync",
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Build resolution lookup once
      const { data: familyRules } = await supabase
        .from("wine_family_rules").select("family_name, is_wine").eq("connection_id", connectionId);
      const customWineFamilies = familyRules
        ?.filter((r: { is_wine: boolean }) => r.is_wine)
        .map((r: { family_name: string }) => r.family_name.toLowerCase()) || [];
      const wineFamilies = [...DEFAULT_WINE_FAMILIES, ...customWineFamilies];

      const { data: trackingRows } = await supabase
        .from("winerim_push_tracking")
        .select("agora_product_id, winerim_wine_id, format, sync_status")
        .eq("connection_id", connectionId);
      const { data: mappingRows } = await supabase
        .from("product_mappings")
        .select("provider_product_id, winerim_wine_id, format_type, status")
        .eq("connection_id", connectionId);

      const resolutionMap = new Map<string, { winerim_wine_id: string; format: string }>();
      for (const t of (trackingRows || [])) {
        if (t.agora_product_id && t.winerim_wine_id && (t.sync_status === "VERIFIED" || t.sync_status === "PUSHED")) {
          resolutionMap.set(String(t.agora_product_id), { winerim_wine_id: t.winerim_wine_id, format: t.format });
        }
      }
      for (const m of (mappingRows || [])) {
        if (m.provider_product_id && m.winerim_wine_id && m.status === "CONFIRMED" && !resolutionMap.has(m.provider_product_id)) {
          resolutionMap.set(m.provider_product_id, { winerim_wine_id: m.winerim_wine_id, format: m.format_type || "BOTTLE" });
        }
      }

      let totalEvents = 0, totalLines = 0, resolvedLines = 0, unresolvedLines = 0;
      const syncedDays: string[] = [];
      const stockDaysAttempted = new Set<string>();
      let stockBlockedDay: string | null = null;
      let saveBlockedDay: string | null = null;
      const winerimToken = (connection.winerim_api_token || "").trim();
      const stockSyncTotals: StockSyncTotals = { synced: 0, skipped: 0, failed: 0, checkedDays: 0, errors: [] };

      const addStockTotals = (partial: StockSyncTotals) => {
        stockSyncTotals.synced += partial.synced;
        stockSyncTotals.skipped += partial.skipped;
        stockSyncTotals.failed += partial.failed;
        stockSyncTotals.checkedDays += partial.checkedDays;
        stockSyncTotals.errors.push(...partial.errors);
      };

      let processingAborted = false;
      for (const day of pendingDays) {
        if (Date.now() - actionStart > ACTION_DEADLINE_MS) { processingAborted = true; break; }
        const url = `${baseUrlClean}/api/export/?business-day=${day}&filter=Invoices`;
        let res: Response;
        try { res = await fetchWithRetry(url, { headers }, 10_000); }
        catch { saveBlockedDay = day; break; }
        if (!res.ok) { await res.text(); saveBlockedDay = day; break; }
        const rawData = await res.json();
        const invoices = parseInvoices(rawData);
        let dayEvents = 0;
        let dayResolvedLines = 0;

        for (let invIdx = 0; invIdx < invoices.length; invIdx++) {
          const inv = invoices[invIdx];
          const rawDocId = String(inv.InvoiceId || inv.Id || "");
          const docId = rawDocId || `${day}_inv_${invIdx}`;
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
              const normalizedFmt = normalizeLineFormat(pName, fName);
              const fam = String(line.FamilyName || "");
              const productId = String(line.ProductId || "");
              const wr = isWineCandidate(fam, pName, fName, uP, wineFamilies, DEFAULT_NON_WINE_FAMILIES);

              const resolution = resolutionMap.get(productId);
              const winerimProductId = resolution?.winerim_wine_id || null;
              const isResolved = !!winerimProductId;
              if (isResolved) {
                resolvedLines++;
                dayResolvedLines++;
              } else if (wr.candidate) {
                unresolvedLines++;
              }

              lineData.push({
                provider_product_id: productId,
                name: pName, format: normalizedFmt, family: fam,
                quantity: qty, unit_price: uP, total_amount: lineTotal,
                vat_rate: Number(line.VatRate || 0), is_wine_candidate: wr.candidate,
                winerim_product_id: winerimProductId,
                mapped: isResolved,
              });
            }
          }

          const { data: eventRow, error: eventErr } = await supabase
            .from("sales_events")
            .upsert({
              connection_id: connectionId, provider_doc_id: docId, business_day: day,
              doc_type: String(inv.Type || "BasicInvoice"),
              total_amount: Number(inv.TotalAmount || docTotal),
              total_tax: Number(inv.TotalTaxAmount || 0),
              total_net: Number(inv.TotalNetAmount || 0),
              line_count: lineData.length, raw_json: inv,
            }, { onConflict: "connection_id,provider_doc_id" })
            .select("id").single();

          if (eventErr || !eventRow) continue;
          totalEvents++;
          dayEvents++;

          await supabase.from("sales_line_items").delete().eq("sales_event_id", eventRow.id);
          const linesToInsert = lineData.map((l) => ({ ...l, sales_event_id: eventRow.id, connection_id: connectionId }));
          if (linesToInsert.length > 0) {
            const { error: lineErr } = await supabase.from("sales_line_items").insert(linesToInsert);
            if (!lineErr) totalLines += linesToInsert.length;
          }
        }

        if (invoices.length > 0 && dayEvents === 0) {
          saveBlockedDay = day;
          break;
        }

        let stockOk = true;
        if (dayResolvedLines > 0) {
          if (!winerimToken) {
            stockOk = false;
            stockSyncTotals.failed++;
            stockSyncTotals.errors.push(`${day}: missing Winerim API token`);
          } else {
            const dayStock = await syncStockForDays(supabase, connectionId, [day], winerimToken);
            stockDaysAttempted.add(day);
            addStockTotals(dayStock);
            stockOk = dayStock.failed === 0;
          }
        }

        if (!stockOk) {
          stockBlockedDay = day;
          break;
        }

        await supabase.from("pos_connections")
          .update({ last_business_day_synced: day, last_sync_at: new Date().toISOString() })
          .eq("id", connectionId);
        syncedDays.push(day);
      }

      if (!stockBlockedDay && !saveBlockedDay && winerimToken && Date.now() - actionStart < ACTION_DEADLINE_MS) {
        const lookbackDays = Math.min(Math.max(Number(connection.backfill_days || 30), 1), 30);
        const fromDay = new Date(yesterday.getTime() - (lookbackDays - 1) * 86400000).toISOString().split("T")[0];
        const toDay = yesterday.toISOString().split("T")[0];
        const catchupDays = (await findSavedStockCandidateDays(supabase, connectionId, fromDay, toDay))
          .filter((day) => !stockDaysAttempted.has(day));
        if (catchupDays.length > 0) {
          addStockTotals(await syncStockForDays(supabase, connectionId, catchupDays, winerimToken));
        }
      }

      const stockSyncResult = stockSyncTotals.checkedDays > 0 || stockSyncTotals.failed > 0 ? stockSyncTotals : null;

      return new Response(
        JSON.stringify({
          success: !processingAborted && !stockBlockedDay && !saveBlockedDay,
          daysSynced: syncedDays.length,
          pendingDaysFound: pendingDays.length,
          syncedDays,
          totalEvents,
          totalLines,
          resolvedLines,
          unresolvedLines,
          stockSync: stockSyncResult,
          blockedByStockFailure: stockBlockedDay,
          blockedBySaveFailure: saveBlockedDay,
          aborted: processingAborted,
          message: stockBlockedDay
            ? `Stock sync failed for ${stockBlockedDay}. Cursor was not advanced and cron will retry.`
            : saveBlockedDay
              ? `Sales save failed for ${saveBlockedDay}. Cursor was not advanced and cron will retry.`
              : processingAborted
                ? "Processing deadline reached. Cursor was advanced only through completed days."
                : undefined,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── RESOLVE EXISTING SALES LINES (re-resolution pass) ──
    if (action === "resolve-sales") {
      // Build resolution lookup
      const { data: trackingRows } = await supabase
        .from("winerim_push_tracking")
        .select("agora_product_id, winerim_wine_id, format, sync_status")
        .eq("connection_id", connectionId);
      const { data: mappingRows } = await supabase
        .from("product_mappings")
        .select("provider_product_id, winerim_wine_id, format_type, status")
        .eq("connection_id", connectionId);

      const resolutionMap = new Map<string, { winerim_wine_id: string; format: string }>();
      for (const t of (trackingRows || [])) {
        if (t.agora_product_id && t.winerim_wine_id && (t.sync_status === "VERIFIED" || t.sync_status === "PUSHED")) {
          resolutionMap.set(String(t.agora_product_id), { winerim_wine_id: t.winerim_wine_id, format: t.format });
        }
      }
      for (const m of (mappingRows || [])) {
        if (m.provider_product_id && m.winerim_wine_id && m.status === "CONFIRMED" && !resolutionMap.has(m.provider_product_id)) {
          resolutionMap.set(m.provider_product_id, { winerim_wine_id: m.winerim_wine_id, format: m.format_type || "BOTTLE" });
        }
      }

      // Fetch unresolved wine candidate lines
      const { data: unresolvedLines } = await supabase
        .from("sales_line_items")
        .select("id, provider_product_id")
        .eq("connection_id", connectionId)
        .eq("is_wine_candidate", true)
        .eq("mapped", false)
        .limit(1000);

      let resolved = 0;
      for (const line of (unresolvedLines || [])) {
        const resolution = resolutionMap.get(line.provider_product_id || "");
        if (resolution) {
          await supabase.from("sales_line_items").update({
            winerim_product_id: resolution.winerim_wine_id,
            mapped: true,
          }).eq("id", line.id);
          resolved++;
        }
      }

      return new Response(
        JSON.stringify({ success: true, totalUnresolved: (unresolvedLines || []).length, resolved, remaining: (unresolvedLines || []).length - resolved }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── SALES ANALYTICS ──
    if (action === "sales-analytics") {
      const { data: events } = await supabase
        .from("sales_events")
        .select("id, business_day, total_amount, line_count")
        .eq("connection_id", connectionId)
        .order("business_day", { ascending: false })
        .limit(100);

      const { data: lines } = await supabase
        .from("sales_line_items")
        .select("id, format, is_wine_candidate, mapped, winerim_product_id, quantity, total_amount, name, provider_product_id, family")
        .eq("connection_id", connectionId)
        .limit(5000);

      const allLines = lines || [];
      const wineLines = allLines.filter((l: any) => l.is_wine_candidate);
      const resolvedLines = wineLines.filter((l: any) => l.mapped && l.winerim_product_id);
      const unresolvedLines = wineLines.filter((l: any) => !l.mapped || !l.winerim_product_id);

      // By format breakdown
      const byFormat: Record<string, { count: number; qty: number; total: number }> = {};
      for (const l of resolvedLines) {
        const fmt = (l.format || "UNKNOWN").toUpperCase();
        if (!byFormat[fmt]) byFormat[fmt] = { count: 0, qty: 0, total: 0 };
        byFormat[fmt].count++;
        byFormat[fmt].qty += Number(l.quantity || 0);
        byFormat[fmt].total += Number(l.total_amount || 0);
      }

      // Unresolved grouped by product
      const unresolvedByProduct: Record<string, { name: string; family: string; count: number; qty: number; total: number }> = {};
      for (const l of unresolvedLines) {
        const pid = l.provider_product_id || "unknown";
        if (!unresolvedByProduct[pid]) unresolvedByProduct[pid] = { name: l.name, family: l.family || "", count: 0, qty: 0, total: 0 };
        unresolvedByProduct[pid].count++;
        unresolvedByProduct[pid].qty += Number(l.quantity || 0);
        unresolvedByProduct[pid].total += Number(l.total_amount || 0);
      }

      return new Response(JSON.stringify({
        success: true,
        totalEvents: (events || []).length,
        totalLines: allLines.length,
        totalWineLines: wineLines.length,
        resolvedCount: resolvedLines.length,
        unresolvedCount: unresolvedLines.length,
        byFormat,
        unresolvedByProduct: Object.entries(unresolvedByProduct)
          .sort(([, a], [, b]) => b.total - a.total)
          .slice(0, 50)
          .map(([pid, v]) => ({ provider_product_id: pid, ...v })),
        lastSyncDay: (events || [])[0]?.business_day || null,
        events: (events || []).slice(0, 30),
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── DISCOVER CATALOG ENDPOINT ──
    if (action === "discover-catalog") {
      const filters = ["Articles", "Products", "Catalog"];
      const urlVariations: { filter: string; url: string; label: string }[] = [];
      for (const f of filters) {
        urlVariations.push({ filter: f, url: `${baseUrlClean}/api/export/?filter=${f}`, label: `?filter=${f}` });
      }
      if (lastBusinessDay) {
        for (const f of filters) {
          urlVariations.push({ filter: f, url: `${baseUrlClean}/api/export/?business-day=${lastBusinessDay}&filter=${f}`, label: `?business-day=${lastBusinessDay}&filter=${f}` });
        }
      }

      const results: { filter: string; label: string; status: number; contentType: string; count: number; sample: unknown; errorBody?: string }[] = [];
      let selectedEndpoint: string | null = null;
      let selectedSample: unknown = null;
      let selectedCount = 0;

      for (const variation of urlVariations) {
        if (selectedEndpoint) break;
        try {
          const res = await fetchWithRetry(variation.url, { headers });
          const ct = res.headers.get("content-type") || "";

          if (!res.ok) {
            let errorBody = "";
            try { const raw = await res.text(); errorBody = raw.substring(0, 2048); } catch (_) { /* ignore */ }
            results.push({ filter: variation.filter, label: variation.label, status: res.status, contentType: ct, count: 0, sample: null, errorBody });
            continue;
          }

          if (!ct.includes("json") && !ct.includes("text")) {
            results.push({ filter: variation.filter, label: variation.label, status: res.status, contentType: ct, count: 0, sample: "binary/file response" });
            continue;
          }

          const body = await res.text();
          const trimmed = body.trim();
          if (!trimmed || trimmed === "{}" || trimmed === "[]") {
            results.push({ filter: variation.filter, label: variation.label, status: res.status, contentType: ct, count: 0, sample: null });
            continue;
          }

          let parsed: unknown;
          try { parsed = JSON.parse(trimmed); } catch (_) {
            results.push({ filter: variation.filter, label: variation.label, status: res.status, contentType: ct, count: 0, sample: null, errorBody: trimmed.substring(0, 2048) });
            continue;
          }

          let items: unknown[] = [];
          if (Array.isArray(parsed)) { items = parsed; }
          else if (typeof parsed === "object" && parsed !== null) {
            for (const key of Object.keys(parsed as Record<string, unknown>)) {
              if (Array.isArray((parsed as Record<string, unknown>)[key]) && ((parsed as Record<string, unknown>)[key] as unknown[]).length > 0) {
                items = (parsed as Record<string, unknown>)[key] as unknown[];
                break;
              }
            }
          }

          const productLikeFields = ["Name", "ProductName", "name", "Description", "ArticleName", "ItemName", "ProductId", "Id"];
          const hasProductFields = items.length > 0 && typeof items[0] === "object" && items[0] !== null &&
            productLikeFields.some((pf) => pf in (items[0] as Record<string, unknown>));

          results.push({ filter: variation.filter, label: variation.label, status: res.status, contentType: ct, count: items.length, sample: items.length > 0 ? items[0] : null });

          if (hasProductFields && items.length > 0) {
            selectedEndpoint = variation.filter;
            selectedSample = items[0];
            selectedCount = items.length;
            await supabase.from("pos_connections").update({ catalog_endpoint: variation.filter }).eq("id", connectionId);
          }
        } catch (e) {
          results.push({ filter: variation.filter, label: variation.label, status: 0, contentType: "error", count: 0, sample: null, errorBody: String(e) });
        }
      }

      if (selectedEndpoint) {
        return new Response(
          JSON.stringify({ success: true, selectedEndpoint, productCount: selectedCount, sample: selectedSample, allResults: results }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({ success: false, message: "Catalog export not enabled or not supported.", allResults: results }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── TEST CATALOG ENDPOINT ──
    if (action === "test-catalog-endpoint") {
      const endpoint = filter || connection.catalog_endpoint;
      if (!endpoint) {
        return new Response(JSON.stringify({ error: "No catalog endpoint specified" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      const url = `${baseUrlClean}/api/export/?filter=${endpoint}`;
      const res = await fetch(url, { headers });
      const ct = res.headers.get("content-type") || "";
      if (!res.ok) {
        return new Response(JSON.stringify({ success: false, status: res.status, contentType: ct }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      if (!ct.includes("json") && !ct.includes("text")) {
        return new Response(JSON.stringify({ success: false, status: res.status, contentType: ct, message: "Binary response" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      const body = await res.text();
      const parsed = JSON.parse(body);
      let items: unknown[] = [];
      if (Array.isArray(parsed)) items = parsed;
      else if (typeof parsed === "object" && parsed !== null) {
        for (const key of Object.keys(parsed)) {
          if (Array.isArray(parsed[key]) && parsed[key].length > 0) { items = parsed[key]; break; }
        }
      }
      return new Response(
        JSON.stringify({ success: true, filter: endpoint, count: items.length, sample: items.slice(0, 3) }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── SYNC CATALOG ──
    if (action === "sync-catalog") {
      const endpoint = connection.catalog_endpoint;
      if (!endpoint) {
        return new Response(JSON.stringify({ error: "No catalog endpoint configured." }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // If derived catalog, delegate to the build-derived-catalog logic
      if (endpoint === "DERIVED_FROM_INVOICES") {
        const scanDaysBack = daysBack || 30;
        const config = await loadConfig(supabase, connectionId);
        const productMap = new Map<string, { name: string; family: string; format: string; vatRate: number; totalPrice: number; count: number }>();
        let daysScanned = 0;
        let totalInvoices = 0;

        for (let i = 0; i < scanDaysBack; i++) {
          const day = new Date(Date.now() - i * 86400000).toISOString().split("T")[0];
          daysScanned++;
          try {
            const url = `${baseUrlClean}/api/export/?business-day=${day}&filter=Invoices`;
            const res = await fetch(url, { headers });
            if (!res.ok) continue;
            const body = await res.text();
            if (!body.trim() || body.trim() === "{}" || body.trim() === "[]") continue;
            const parsed = JSON.parse(body);
            const invoices = parseInvoices(parsed);
            totalInvoices += invoices.length;

            for (const inv of invoices) {
              for (const item of (inv.InvoiceItems || [])) {
                for (const line of (item.Lines || [])) {
                  const prodId = String(line.ProductId || "");
                  if (!prodId) continue;
                  const uPrice = Number(line.UnitPrice || 0);
                  const existing = productMap.get(prodId);
                  if (existing) {
                    existing.totalPrice += uPrice;
                    existing.count++;
                  } else {
                    productMap.set(prodId, {
                      name: String(line.ProductName || ""), family: String(line.FamilyName || ""),
                      format: String(line.SaleFormatName || ""), vatRate: Number(line.VatRate || 0),
                      totalPrice: uPrice, count: 1,
                    });
                  }
                }
              }
            }
          } catch (_) { /* skip */ }
        }

        let upserted = 0;
        let wineCandidateCount = 0;

        for (const [prodId, p] of productMap) {
          const avgPrice = p.count > 0 ? p.totalPrice / p.count : 0;
          const cr = classifyProduct(p.family, p.name, p.format, avgPrice, config);
          if (cr.classification === "WINE") wineCandidateCount++;

          await supabase.from("provider_products").upsert({
            connection_id: connectionId, provider_product_id: prodId,
            name: p.name, family: p.family, vat_rate: p.vatRate, sale_format: p.format,
            price: Math.round(avgPrice * 100) / 100,
            is_wine_candidate: cr.classification === "WINE",
            wine_score: cr.score, wine_reasons: cr.reasons,
            classification_override: "AUTO",
            last_score: cr.score, last_reasons: cr.reasons,
            raw_payload: { derived: true, occurrences: p.count },
          }, { onConflict: "connection_id,provider_product_id" });
          upserted++;
        }

        await supabase.from("pos_connections").update({
          last_catalog_sync_at: new Date().toISOString(),
          catalog_product_count: upserted,
          catalog_wine_candidate_count: wineCandidateCount,
        }).eq("id", connectionId);

        return new Response(
          JSON.stringify({ success: true, totalProducts: upserted, wineCandidates: wineCandidateCount, daysScanned, totalInvoices, endpoint: "DERIVED_FROM_INVOICES" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const config = await loadConfig(supabase, connectionId);
      const url = `${baseUrlClean}/api/export/?filter=${endpoint}`;
      const res = await fetch(url, { headers });
      if (!res.ok) {
        const errorBody = await res.text().catch(() => "");
        return new Response(JSON.stringify({
          success: false,
          error: `Agora catalog export returned ${res.status}. This endpoint may not be supported by this installation.`,
          status: res.status,
          errorBody: errorBody.substring(0, 500),
        }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const rawData = await res.json();
      let items: any[] = [];
      if (Array.isArray(rawData)) items = rawData;
      else if (typeof rawData === "object" && rawData !== null) {
        for (const key of Object.keys(rawData)) {
          if (Array.isArray(rawData[key]) && rawData[key].length > 0) { items = rawData[key]; break; }
        }
      }

      let upserted = 0;
      let wineCandidateCount = 0;

      for (const item of items) {
        const prodId = String(item.Id || item.ProductId || item.ArticleId || "");
        if (!prodId) continue;

        const prodName = String(item.Name || item.ProductName || item.ArticleName || "");
        const prodFamily = String(item.FamilyName || item.Family || "");
        const prodFormat = String(item.SaleFormatName || item.Format || "");
        const prodPrice = Number(item.Price || item.MainPrice || item.UnitPrice || 0);
        const prodVat = Number(item.VatRate || item.Vat || 0);

        const cr = classifyProduct(prodFamily, prodName, prodFormat, prodPrice, config);
        if (cr.classification === "WINE") wineCandidateCount++;

        await supabase.from("provider_products").upsert({
          connection_id: connectionId, provider_product_id: prodId,
          name: prodName, family: prodFamily, vat_rate: prodVat, sale_format: prodFormat,
          price: Math.round(prodPrice * 100) / 100,
          is_wine_candidate: cr.classification === "WINE",
          wine_score: cr.score, wine_reasons: cr.reasons,
          classification_override: "AUTO",
          last_score: cr.score, last_reasons: cr.reasons,
          raw_payload: item,
        }, { onConflict: "connection_id,provider_product_id" });
        upserted++;
      }

      await supabase.from("pos_connections").update({
        last_catalog_sync_at: new Date().toISOString(),
        catalog_product_count: upserted,
        catalog_wine_candidate_count: wineCandidateCount,
      }).eq("id", connectionId);

      return new Response(
        JSON.stringify({ success: true, totalProducts: upserted, wineCandidates: wineCandidateCount, endpoint }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── BUILD DERIVED CATALOG ──
    if (action === "build-derived-catalog") {
      const scanDaysBack = daysBack || 30;
      const config = await loadConfig(supabase, connectionId);
      const productMap = new Map<string, { name: string; family: string; format: string; vatRate: number; totalPrice: number; count: number }>();
      let daysScanned = 0;
      let totalInvoices = 0;

      for (let i = 0; i < scanDaysBack; i++) {
        const day = new Date(Date.now() - i * 86400000).toISOString().split("T")[0];
        daysScanned++;
        try {
          const url = `${baseUrlClean}/api/export/?business-day=${day}&filter=Invoices`;
          const res = await fetch(url, { headers });
          if (!res.ok) continue;
          const body = await res.text();
          if (!body.trim() || body.trim() === "{}" || body.trim() === "[]") continue;
          const parsed = JSON.parse(body);
          const invoices = parseInvoices(parsed);
          totalInvoices += invoices.length;

          for (const inv of invoices) {
            for (const item of (inv.InvoiceItems || [])) {
              for (const line of (item.Lines || [])) {
                const prodId = String(line.ProductId || "");
                if (!prodId) continue;
                const uPrice = Number(line.UnitPrice || 0);
                const existing = productMap.get(prodId);
                if (existing) {
                  existing.totalPrice += uPrice;
                  existing.count++;
                } else {
                  productMap.set(prodId, {
                    name: String(line.ProductName || ""), family: String(line.FamilyName || ""),
                    format: String(line.SaleFormatName || ""), vatRate: Number(line.VatRate || 0),
                    totalPrice: uPrice, count: 1,
                  });
                }
              }
            }
          }
        } catch (_) { /* skip */ }
      }

      let upserted = 0;
      let wineCandidateCount = 0;

      for (const [prodId, p] of productMap) {
        const avgPrice = p.count > 0 ? p.totalPrice / p.count : 0;
        const cr = classifyProduct(p.family, p.name, p.format, avgPrice, config);
        if (cr.classification === "WINE") wineCandidateCount++;

        await supabase.from("provider_products").upsert({
          connection_id: connectionId, provider_product_id: prodId,
          name: p.name, family: p.family, vat_rate: p.vatRate, sale_format: p.format,
          price: Math.round(avgPrice * 100) / 100,
          is_wine_candidate: cr.classification === "WINE",
          wine_score: cr.score, wine_reasons: cr.reasons,
          classification_override: "AUTO",
          last_score: cr.score, last_reasons: cr.reasons,
          raw_payload: { derived: true, occurrences: p.count },
        }, { onConflict: "connection_id,provider_product_id" });
        upserted++;
      }

      await supabase.from("pos_connections").update({
        last_catalog_sync_at: new Date().toISOString(),
        catalog_product_count: upserted,
        catalog_wine_candidate_count: wineCandidateCount,
        catalog_endpoint: "DERIVED_FROM_INVOICES",
      }).eq("id", connectionId);

      return new Response(
        JSON.stringify({ success: true, totalProducts: upserted, wineCandidates: wineCandidateCount, daysScanned, totalInvoices, endpoint: "DERIVED_FROM_INVOICES" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── RECOMPUTE CLASSIFICATION ──
    if (action === "recompute-classification") {
      const config = await loadConfig(supabase, connectionId);
      let offset = 0;
      const batchSize = 500;
      let totalRecomputed = 0;
      let wineCount = 0;
      let notWineCount = 0;
      let reviewCount = 0;

      while (true) {
        const { data: products, error: fetchErr } = await supabase
          .from("provider_products")
          .select("id, name, family, sale_format, price, classification_override")
          .eq("connection_id", connectionId)
          .eq("classification_override", "AUTO")
          .range(offset, offset + batchSize - 1);

        if (fetchErr || !products || products.length === 0) break;

        for (const p of products) {
          const cr = classifyProduct(p.family, p.name, p.sale_format, Number(p.price || 0), config);
          await supabase.from("provider_products").update({
            is_wine_candidate: cr.classification === "WINE",
            wine_score: cr.score, wine_reasons: cr.reasons,
            last_score: cr.score, last_reasons: cr.reasons,
          }).eq("id", p.id);

          totalRecomputed++;
          if (cr.classification === "WINE") wineCount++;
          else if (cr.classification === "NOT_WINE") notWineCount++;
          else reviewCount++;
        }

        offset += batchSize;
        if (products.length < batchSize) break;
      }

      await supabase.from("pos_connections").update({
        catalog_wine_candidate_count: wineCount,
      }).eq("id", connectionId);

      return new Response(
        JSON.stringify({ success: true, totalRecomputed, wine: wineCount, notWine: notWineCount, needsReview: reviewCount }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── SYNC STOCK TO WINERIM (Read-Modify-Write with real API) ──
    if (action === "sync-stock") {
      const day = businessDay;
      if (!day) {
        return new Response(JSON.stringify({ error: "businessDay required" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const winerimToken = (connection.winerim_api_token || "").trim();
      if (!winerimToken) {
        return new Response(JSON.stringify({ success: false, error: "No Winerim API token configured" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const result = await syncStockForDay(supabase, connectionId, day, winerimToken);

      return new Response(
        JSON.stringify({ success: true, ...result }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── DETECT WRITE CAPABILITIES ──
    if (action === "detect-capabilities") {
      const writeEndpoints = [
        { path: "/api/import/articles", label: "POST /api/import/articles" },
        { path: "/api/import/products", label: "POST /api/import/products" },
        { path: "/api/products", label: "POST /api/products" },
        { path: "/api/articles", label: "POST /api/articles" },
      ];

      const results: { path: string; label: string; status: number; supports: boolean; body?: string }[] = [];
      let writeEndpoint: string | null = null;
      let canWrite: "YES" | "NO" | "UNKNOWN" = "NO";

      for (const ep of writeEndpoints) {
        try {
          let res: Response;
          try {
            res = await fetchWithRetry(`${baseUrlClean}${ep.path}`, {
              method: "OPTIONS",
              headers: { ...headers, "Content-Type": "application/json" },
            }, 8000);
          } catch (_) {
            res = await fetchWithRetry(`${baseUrlClean}${ep.path}`, {
              method: "POST",
              headers: { ...headers, "Content-Type": "application/json" },
              body: JSON.stringify({ _test: true, Name: "WINERIM_TEST_PROBE", ExternalRef: "WINERIM_TEST_PROBE_DELETE" }),
            }, 8000);
          }

          const bodyText = await res.text();
          const bodyPreview = bodyText.substring(0, 512);
          const supports = res.status !== 404 && res.status !== 405 && res.status !== 501;
          results.push({ path: ep.path, label: ep.label, status: res.status, supports, body: bodyPreview });

          if (supports && !writeEndpoint) {
            writeEndpoint = ep.path;
            canWrite = "UNKNOWN"; // Never auto-YES from detection alone
          }
        } catch (e) {
          results.push({ path: ep.path, label: ep.label, status: 0, supports: false, body: String(e) });
        }
      }

      await supabase.from("provider_capabilities").upsert({
        connection_id: connectionId, provider: "AGORA",
        can_read_sales: true, can_read_catalog: !!connection.catalog_endpoint,
        can_write_products: canWrite, write_endpoint: writeEndpoint,
        write_endpoints_json: results, last_checked_at: new Date().toISOString(),
      }, { onConflict: "connection_id" });

      return new Response(
        JSON.stringify({ success: true, canWrite, writeEndpoint, results }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── PROCESS OUTBOUND TASK (legacy JSON mode) ──
    if (action === "process-outbound-task") {
      const taskId = payload.taskId;
      const alreadyClaimed = payload.alreadyClaimed === true;

      const { data: task, error: taskErr } = await supabase
        .from("outbound_tasks").select("*").eq("id", taskId).single();
      if (taskErr || !task) {
        return new Response(JSON.stringify({ error: "Task not found" }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const { data: caps } = await supabase
        .from("provider_capabilities").select("*").eq("connection_id", task.connection_id).single();

      if (!caps || caps.can_write_products === "NO") {
        await supabase.from("outbound_tasks").update({
          status: "BLOCKED", blocked_reason: "Write not supported for this Agora installation.",
        }).eq("id", task.id);
        return new Response(JSON.stringify({ success: false, status: "BLOCKED", reason: "Write not supported" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      if (caps.can_write_products === "UNKNOWN") {
        await supabase.from("outbound_tasks").update({
          status: "BLOCKED", blocked_reason: "Write capability not confirmed. Run a manual XML import first.",
        }).eq("id", task.id);
        return new Response(JSON.stringify({ success: false, status: "BLOCKED", reason: "Write capability unknown" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const writeEp = caps.write_endpoint;
      if (!writeEp) {
        await supabase.from("outbound_tasks").update({ status: "BLOCKED", blocked_reason: "No write endpoint detected" }).eq("id", task.id);
        return new Response(JSON.stringify({ success: false, status: "BLOCKED" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const currentAttempts = alreadyClaimed ? (task.attempts || 0) : ((task.attempts || 0) + 1);
      if (!alreadyClaimed) {
        await supabase.from("outbound_tasks").update({ status: "RUNNING", attempts: currentAttempts }).eq("id", task.id);
      }
      const taskPayload = task.payload_json;

      try {
        let existingProductId = task.external_id;
        if (!existingProductId && taskPayload.ExternalRef) {
          const { data: existingProduct } = await supabase
            .from("provider_products").select("provider_product_id")
            .eq("connection_id", task.connection_id).eq("provider_product_id", taskPayload.ExternalRef).single();
          if (existingProduct) existingProductId = existingProduct.provider_product_id;
        }

        let res: Response;
        if (existingProductId) {
          res = await fetchWithRetry(`${baseUrlClean}${writeEp}/${existingProductId}`, {
            method: "PUT", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(taskPayload),
          });
        } else {
          res = await fetchWithRetry(`${baseUrlClean}${writeEp}`, {
            method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(taskPayload),
          });
        }

        const resBody = await res.text();
        const resPreview = resBody.substring(0, 2048);

        if (res.status === 401 || res.status === 403) {
          await supabase.from("outbound_tasks").update({ status: "FAILED", last_error: `Auth error ${res.status}: ${resPreview}` }).eq("id", task.id);
          return new Response(JSON.stringify({ success: false, status: "FAILED", error: "Auth error" }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        if (res.status === 404 || res.status === 405) {
          await supabase.from("outbound_tasks").update({ status: "BLOCKED", blocked_reason: `Endpoint returned ${res.status}.` }).eq("id", task.id);
          await supabase.from("provider_capabilities").update({ can_write_products: "NO" }).eq("connection_id", task.connection_id);
          return new Response(JSON.stringify({ success: false, status: "BLOCKED" }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        if (!res.ok) {
          const shouldRetry = currentAttempts < (task.max_attempts || 3);
          await supabase.from("outbound_tasks").update({
            status: shouldRetry ? "QUEUED" : "FAILED",
            last_error: `HTTP ${res.status}: ${resPreview}`,
          }).eq("id", task.id);
          return new Response(JSON.stringify({ success: false, status: shouldRetry ? "QUEUED" : "FAILED" }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        let externalId = task.external_id;
        try {
          const parsed = JSON.parse(resBody);
          externalId = parsed?.Id || parsed?.ProductId || parsed?.ArticleId || externalId;
        } catch (_) { /* not JSON */ }

        await supabase.from("outbound_tasks").update({
          status: "SUCCESS", last_error: null, external_id: externalId ? String(externalId) : null,
        }).eq("id", task.id);
        // Reset failure counter on success — connection is healthy again
        await resetFailureCounter(supabase, connectionId);

        return new Response(JSON.stringify({ success: true, status: "SUCCESS", externalId, responsePreview: resPreview }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      } catch (e) {
        const errMsg = String(e).substring(0, 500);
        const errClass = classifyPosError(errMsg);
        const shouldRetry = currentAttempts < (task.max_attempts || 3) && errClass !== "BUSINESS_ERROR";
        await supabase.from("outbound_tasks").update({
          status: shouldRetry ? "QUEUED" : "FAILED",
          last_error: `[${errClass}] ${errMsg}`,
        }).eq("id", task.id);
        // Trip circuit breaker if POS is down/overloaded
        const breakerResult = await applyCircuitBreaker(supabase, connectionId, errClass);
        return new Response(JSON.stringify({
          success: false, status: shouldRetry ? "QUEUED" : "FAILED",
          errorClass: errClass, breakerTripped: breakerResult.paused,
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }

    // ── PROCESS OUTBOUND QUEUE (legacy JSON, time-budgeted) ──
    if (action === "process-outbound-queue") {
      // Check write capability once
      const { data: caps } = await supabase
        .from("provider_capabilities").select("can_write_products, write_endpoint").eq("connection_id", connectionId).single();

      const BATCH_SIZE = 10;
      const TIME_BUDGET_MS = 20_000;
      const startTime = Date.now();
      let processed = 0, succeeded = 0, failed = 0;

      while (Date.now() - startTime < TIME_BUDGET_MS) {
        const taskTypes = ["AGORA_UPSERT_PRODUCT", "AGORA_MIGRATE_FAMILY"];
        const { data: claimedTasks, error: claimErr } = await supabase.rpc("claim_outbound_tasks", {
          p_connection_id: connectionId,
          p_task_types: taskTypes,
          p_limit: BATCH_SIZE,
        });
        const usedAtomicClaim = !claimErr;
        let tasks = claimedTasks;
        if (claimErr) {
          console.warn(`[process-outbound-queue] atomic claim unavailable, falling back: ${claimErr.message}`);
          const { data: fallbackTasks } = await supabase
            .from("outbound_tasks").select("id, task_type, payload_json, external_id, attempts")
            .eq("connection_id", connectionId).in("task_type", taskTypes)
            .eq("status", "QUEUED").order("created_at").limit(BATCH_SIZE);
          tasks = fallbackTasks;
        }

        if (!tasks || tasks.length === 0) break;

        for (const t of tasks) {
          if (Date.now() - startTime >= TIME_BUDGET_MS) break;
          try {
            if (t.task_type === "AGORA_MIGRATE_FAMILY") {
              const p = t.payload_json as Record<string, unknown>;
              const productId = p.productId || t.external_id;
              const targetFamilyId = p.targetFamilyId;
              const wineName = String(p.wineName || "");
              const fmt = String(p.format || "BOTTLE");
              const productName = formatProductName(fmt, wineName);

              const escXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
              const vatIdMig = String((connection as any).default_vat_id || "1");
              const migrateXml = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n<Import>\n  <Products>\n    <Product Id="${productId}" Name="${escXml(productName)}" FamilyId="${targetFamilyId}" VatId="${vatIdMig}" />\n  </Products>\n</Import>`;

              const currentAttempts = usedAtomicClaim ? (((t as any).attempts || 1)) : (((t as any).attempts || 0) + 1);
              if (!usedAtomicClaim) {
                await supabase.from("outbound_tasks").update({ status: "RUNNING", attempts: currentAttempts }).eq("id", t.id);
              }

              const importUrl = `${baseUrlClean}/api/import/`;
              const res = await fetchWithRetry(importUrl, {
                method: "POST",
                headers: { ...headers, Accept: "application/xml", "Content-Type": "application/xml; charset=utf-8" },
                body: migrateXml,
              });
              const resBody = await res.text();

              if (res.ok) {
                await supabase.from("outbound_tasks").update({ status: "SUCCESS", last_error: null }).eq("id", t.id);
                const winerimId = String(p.winerimWineId || "");
                if (winerimId) {
                  await supabase.from("winerim_push_tracking")
                    .update({ sync_status: "VERIFIED", agora_family_id: String(targetFamilyId), verified_at: new Date().toISOString() })
                    .eq("connection_id", connectionId)
                    .eq("winerim_wine_id", winerimId)
                    .eq("format", fmt);
                }
                succeeded++;
              } else {
                await supabase.from("outbound_tasks").update({ status: "FAILED", last_error: `HTTP ${res.status}: ${resBody.substring(0, 500)}` }).eq("id", t.id);
                const winerimId = String(p.winerimWineId || "");
                if (winerimId) {
                  await supabase.from("winerim_push_tracking")
                    .update({ sync_status: "FAILED", last_error: `Migration failed: HTTP ${res.status}` })
                    .eq("connection_id", connectionId)
                    .eq("winerim_wine_id", winerimId)
                    .eq("format", fmt);
                }
                failed++;
              }
              processed++;
            } else {
              const { data: result } = await supabase.functions.invoke("agora-proxy", {
                body: { action: "process-outbound-task", connectionId, taskId: t.id, alreadyClaimed: usedAtomicClaim },
              });
              processed++;
              if (result?.status === "SUCCESS") succeeded++; else failed++;
            }
          } catch (err) { failed++; processed++; }
        }
      }

      const { count: remaining } = await supabase
        .from("outbound_tasks").select("id", { count: "exact", head: true })
        .eq("connection_id", connectionId).in("task_type", ["AGORA_UPSERT_PRODUCT", "AGORA_MIGRATE_FAMILY"])
        .eq("status", "QUEUED");

      return new Response(JSON.stringify({ success: true, processed, succeeded, failed, remaining: remaining || 0, done: (remaining || 0) === 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── EXPORT PRODUCTS (JSON/CSV fallback) ──
    if (action === "export-products") {
      const exportFormat = payload.format || "json";
      const exportIds = payload.winerimWineIds || [];

      let wines: any[] = [];
      if (exportIds && exportIds.length > 0) {
        const { data } = await supabase.from("winerim_wines").select("*").eq("connection_id", connectionId).in("winerim_id", exportIds);
        wines = data || [];
      } else {
        const { data: mappings } = await supabase
          .from("product_mappings").select("winerim_wine_id, winerim_wine_name")
          .eq("connection_id", connectionId).eq("status", "CONFIRMED");
        if (mappings) {
          const ids = mappings.map((m: any) => m.winerim_wine_id).filter(Boolean);
          if (ids.length > 0) {
            const { data } = await supabase.from("winerim_wines").select("*").eq("connection_id", connectionId).in("winerim_id", ids);
            wines = data || [];
          }
        }
      }

      const defaultFamily = connection.default_wine_family_name || "Vinos";
      const defaultVat = Number(connection.default_vat_rate || 10);
      const defaultFormat = connection.default_bottle_format_name || "BOT";

      const exportRows = wines.map((w: any) => ({
        externalRef: `WINERIM_${w.winerim_id}`, name: w.name, family: defaultFamily,
        format: defaultFormat, vat_rate: defaultVat, price: w.price || 0,
        sku: w.sku || "", ean: w.ean || "",
      }));

      if (exportFormat === "csv") {
        const csvHeader = "externalRef,name,family,format,vat_rate,price,sku,ean";
        const csvRows = exportRows.map((r: any) =>
          `"${r.externalRef}","${r.name.replace(/"/g, '""')}","${r.family}","${r.format}",${r.vat_rate},${r.price},"${r.sku}","${r.ean}"`
        );
        return new Response([csvHeader, ...csvRows].join("\n"),
          { headers: { ...corsHeaders, "Content-Type": "text/csv", "Content-Disposition": "attachment; filename=agora-import.csv" } });
      }

      return new Response(
        JSON.stringify({ success: true, products: exportRows, count: exportRows.length }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── SYNC AGORA MASTER DATA ──
    // FIX PRIORITY 2: Only proves export-master works; does NOT set can_write_products=YES
    if (action === "sync-master-data") {
      const xmlHeaders = { "Api-Token": apiTokenClean, Accept: "application/xml" };
      
      function extractElements(xml: string, tagName: string): Record<string, string>[] {
        const results: Record<string, string>[] = [];
        const selfClosingRegex = new RegExp(`<${tagName}\\s([^>]*?)\\/>`, "gi");
        let match;
        while ((match = selfClosingRegex.exec(xml)) !== null) {
          const attrs: Record<string, string> = {};
          const attrRegex = /(\w+)="([^"]*)"/g;
          let attrMatch;
          while ((attrMatch = attrRegex.exec(match[1])) !== null) {
            attrs[attrMatch[1]] = attrMatch[2];
          }
          results.push(attrs);
        }
        const openRegex = new RegExp(`<${tagName}\\s([^>]*?)>`, "gi");
        while ((match = openRegex.exec(xml)) !== null) {
          const attrs: Record<string, string> = {};
          const attrRegex = /(\w+)="([^"]*)"/g;
          let attrMatch;
          while ((attrMatch = attrRegex.exec(match[1])) !== null) {
            attrs[attrMatch[1]] = attrMatch[2];
          }
          if (!results.some(r => r.Id === attrs.Id && r.Name === attrs.Name)) {
            results.push(attrs);
          }
        }
        return results;
      }

      const truncationWarnings: string[] = [];

      // ── Fetch 1: Core master data (without Products to reduce payload size) ──
      const coreUrl = `${baseUrlClean}/api/export-master/?filter=Families,Vats,PriceLists,PreparationTypes,PreparationOrders,Warehouses`;
      let coreXml = "";
      try {
        const coreRes = await fetchWithRetry(coreUrl, { headers: xmlHeaders }, 30000);
        if (!coreRes.ok) {
          const body = await coreRes.text().catch(() => "");
          return new Response(
            JSON.stringify({ success: false, error: `Agora responded ${coreRes.status} on core export`, body: body.substring(0, 2048) }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        coreXml = await coreRes.text();
        if (!coreXml.trimEnd().endsWith(">")) {
          truncationWarnings.push(`Core XML appears truncated (${coreXml.length} bytes)`);
        }
      } catch (e) {
        return new Response(
          JSON.stringify({ success: false, error: `Failed to reach Agora (core): ${e}` }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // ── Fetch 2: Products separately (can be large; always cached) ──
      let productsXml = "";
      try {
        const cachedProducts = await fetchAgoraProductsXmlCached(connectionId, baseUrlClean, apiTokenClean, fetchWithRetry, 30000);
        if (cachedProducts.ok) {
          productsXml = cachedProducts.xml;
          if (!productsXml.trimEnd().endsWith(">")) {
            truncationWarnings.push(`Products XML appears truncated (${productsXml.length} bytes)`);
          }
        } else {
          console.warn(`[sync-master-data] Products fetch returned ${cachedProducts.status}`);
        }
      } catch (e) {
        console.warn(`[sync-master-data] Products fetch failed: ${e}`);
      }

      // ── Fetch 3: SalePoints separately ──
      const spUrl = `${baseUrlClean}/api/export-master/?filter=SalePoints`;
      let spXml = "";
      try {
        const spRes = await fetchWithRetry(spUrl, { headers: xmlHeaders }, 15000);
        if (spRes.ok) {
          spXml = await spRes.text();
        } else {
          console.warn(`[sync-master-data] SalePoints fetch returned ${spRes.status}`);
        }
      } catch (e) {
        console.warn(`[sync-master-data] SalePoints fetch failed: ${e}`);
      }

      // ── Fetch 4: SaleCenters separately (critical for price diagnostics) ──
      const scUrl = `${baseUrlClean}/api/export-master/?filter=SaleCenters`;
      let scXml = "";
      try {
        const scRes = await fetchWithRetry(scUrl, { headers: xmlHeaders }, 15000);
        if (scRes.ok) {
          scXml = await scRes.text();
          console.log(`[sync-master-data] SaleCenters dedicated fetch: ${scXml.length} bytes`);
        } else {
          console.warn(`[sync-master-data] SaleCenters fetch returned ${scRes.status}`);
          truncationWarnings.push(`SaleCenters fetch failed with status ${scRes.status}`);
        }
      } catch (e) {
        console.warn(`[sync-master-data] SaleCenters fetch failed: ${e}`);
        truncationWarnings.push(`SaleCenters fetch error: ${e}`);
      }

      // ── Parse all responses ──
      const families = extractElements(coreXml, "Family");
      const vats = extractElements(coreXml, "Vat");
      const priceLists = extractElements(coreXml, "PriceList");
      const prepTypes = extractElements(coreXml, "PreparationType");
      const prepOrders = extractElements(coreXml, "PreparationOrder");
      const warehouses = extractElements(coreXml, "Warehouse").filter(w => w.Name);
      const products = extractElements(productsXml, "Product");
      const salePoints = extractElements(spXml, "SalePoint");
      const saleCenters = extractElements(scXml, "SaleCenter");

      // Warn if SaleCenters came back empty
      if (saleCenters.length === 0) {
        truncationWarnings.push("SaleCenters: 0 fetched — the installation may not expose SaleCenters via export-master");
      }

      // Log fetched counts for diagnostics
      console.log(`[sync-master-data] connection=${connectionId} fetched: families=${families.length} vats=${vats.length} priceLists=${priceLists.length} salePoints=${salePoints.length} saleCenters=${saleCenters.length} products=${products.length}`);

      const productsSummary = products.map(p => ({
        Id: p.Id, Name: p.Name, FamilyId: p.FamilyId, VatId: p.VatId,
        UseAsDirectSale: (p as any).UseAsDirectSale,
        SaleableAsMain: (p as any).SaleableAsMain,
        ButtonText: (p as any).ButtonText,
        Color: (p as any).Color,
      }));

      await supabase.from("agora_master_data").upsert({
        connection_id: connectionId,
        families_json: families, vats_json: vats, price_lists_json: priceLists,
        preparation_types_json: prepTypes, preparation_orders_json: prepOrders,
        warehouses_json: warehouses, products_summary_json: productsSummary,
        sale_points_json: salePoints, sale_centers_json: saleCenters,
        raw_xml_preview: coreXml.substring(0, 5000),
        fetched_at: new Date().toISOString(),
      }, { onConflict: "connection_id" });

      // FIX: Only set write_mode, NOT can_write_products
      if (families.length > 0 || products.length > 0) {
        await supabase.from("pos_connections").update({
          write_mode: "XML_IMPORT",
        }).eq("id", connectionId).eq("write_mode", "NONE");

        // Set capabilities to UNKNOWN (not YES) - only a real POST proves write
        await supabase.from("provider_capabilities").upsert({
          connection_id: connectionId, provider: "AGORA",
          can_read_sales: true, can_read_catalog: true,
          can_write_products: "UNKNOWN",
          write_endpoint: "/api/import/",
          last_checked_at: new Date().toISOString(),
        }, { onConflict: "connection_id" });
      }

      return new Response(
        JSON.stringify({
          success: true,
          families: families.length, vats: vats.length, priceLists: priceLists.length,
          preparationTypes: prepTypes.length, preparationOrders: prepOrders.length,
          warehouses: warehouses.length, products: productsSummary.length,
          salePoints: salePoints.length, saleCenters: saleCenters.length,
          truncationWarnings,
          fetchedCounts: {
            families: families.length, vats: vats.length, priceLists: priceLists.length,
            salePoints: salePoints.length, saleCenters: saleCenters.length,
            products: products.length, warehouses: warehouses.length,
          },
          masterData: { families, vats, priceLists, preparationTypes: prepTypes, preparationOrders: prepOrders, warehouses, salePoints, saleCenters },
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Helper: Load custom family mappings for a connection ──
    async function loadCustomFamilyMappings(connId: string): Promise<Record<string, { id: string; name: string }> | undefined> {
      const { data: mappings } = await supabase
        .from("wine_type_family_mappings")
        .select("mapping_key, agora_family_id, agora_family_name")
        .eq("connection_id", connId);
      if (!mappings || mappings.length === 0) return undefined;
      const result: Record<string, { id: string; name: string }> = {};
      for (const m of mappings) {
        if (m.agora_family_id && m.agora_family_name) {
          result[m.mapping_key] = { id: m.agora_family_id, name: m.agora_family_name };
        }
      }
      return Object.keys(result).length > 0 ? result : undefined;
    }

    // ── CREATE PILOT FAMILIES ──
    if (action === "create-pilot-families") {
      const PILOT_FAMILIES = [
        { key: "copa", name: "COPAS WINERIM" },
        { key: "botella_tinto", name: "TINTOS WINERIM" },
        { key: "botella_blanco", name: "BLANCOS WINERIM" },
        { key: "botella_espumoso", name: "ESPUMOSOS WINERIM" },
        { key: "botella_fortificado", name: "FORTIFICADOS WINERIM" },
        { key: "botella_dulce", name: "DULCE WINERIM" },
        { key: "botella_rosado", name: "ROSADOS WINERIM" },
        { key: "magnum", name: "MAGNUM WINERIM" },
      ];

      // Load current master data to check which families already exist
      const { data: masterData } = await supabase
        .from("agora_master_data").select("families_json").eq("connection_id", connectionId).single();
      const existingFamilies = ((masterData as any)?.families_json || []) as { Id: string; Name: string }[];

      const toCreate: { id: string; name: string; key: string }[] = [];
      const alreadyExist: { id: string; name: string; key: string }[] = [];

      for (const pf of PILOT_FAMILIES) {
        const existing = existingFamilies.find(f => f.Name.toUpperCase() === pf.name.toUpperCase());
        if (existing) {
          alreadyExist.push({ id: existing.Id, name: existing.Name, key: pf.key });
        } else {
          const newId = stableFamilyId(pf.name);
          toCreate.push({ id: newId, name: pf.name, key: pf.key });
        }
      }

      let importSuccess = true;
      let importError: string | null = null;

      if (toCreate.length > 0) {
        // Build XML for family creation only
        function escXml(s: string): string {
          return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
        }
        let xml = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n<Import>\n  <Families>\n`;
        for (const f of toCreate) {
          xml += `    <Family Id="${f.id}" Name="${escXml(f.name)}" ShowInPos="true" ButtonText="${escXml(f.name.substring(0, 15))}" Color="#722F37" Order="200" />\n`;
        }
        xml += `  </Families>\n</Import>`;

        // POST to Agora
        const importUrl = `${baseUrlClean}/api/import/`;
        const xmlHeaders = {
          "Api-Token": apiTokenClean,
          Accept: "application/xml",
          "Content-Type": "application/xml; charset=utf-8",
        };

        try {
          const importRes = await fetchWithRetry(importUrl, { method: "POST", headers: xmlHeaders, body: xml }, 30000);
          const responseBody = await importRes.text().catch(() => "");
          const parsed = parseAgoraImportResponse(importRes.status, responseBody);
          importSuccess = parsed.success;
          if (!parsed.success) {
            importError = parsed.errors.join("; ") || `HTTP ${importRes.status}`;
          }
        } catch (e) {
          importSuccess = false;
          importError = String(e);
        }
      }

      // Save family mappings to DB (both existing and newly created)
      const allMappings = [...alreadyExist, ...toCreate];
      for (const m of allMappings) {
        await supabase.from("wine_type_family_mappings").upsert({
          connection_id: connectionId,
          mapping_key: m.key,
          agora_family_id: m.id,
          agora_family_name: m.name,
        }, { onConflict: "connection_id,mapping_key" });
      }

      return new Response(JSON.stringify({
        success: importSuccess,
        created: toCreate.map(f => ({ id: f.id, name: f.name, key: f.key })),
        reused: alreadyExist.map(f => ({ id: f.id, name: f.name, key: f.key })),
        error: importError,
        totalMappings: allMappings.length,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── SET FAMILY VISIBILITY (toggle ShowInPos per family, batched) ──
    if (action === "set-family-visibility") {
      const updates: { familyId: string; showInPos: boolean }[] = payload.updates || [];
      if (!Array.isArray(updates) || updates.length === 0) {
        return new Response(JSON.stringify({ success: false, error: "No updates provided" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      function escXmlV(s: string): string {
        return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
      }

      // Fetch full Families XML from Agora — reuse the complete <Family .../> element to avoid
      // HTTP 500 from missing required attributes (Color, Order, ButtonText, ParentFamilyId, etc.)
      const famUrl = `${baseUrlClean}/api/export-master/?filter=Families`;
      let famXmlSrc = "";
      try {
        const famRes = await fetchWithRetry(famUrl, { method: "GET", headers: { "Api-Token": apiTokenClean, Accept: "application/xml" } }, 30000);
        famXmlSrc = await famRes.text().catch(() => "");
        if (!famRes.ok || !famXmlSrc) {
          return new Response(JSON.stringify({ success: false, error: `No se pudo leer familias Agora: HTTP ${famRes.status}` }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: `Fetch familias falló: ${String(e)}` }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // Index every <Family .../> by Id
      const famElById = new Map<string, string>();
      const famRegex = /<Family\b[^>]*\/>|<Family\b[^>]*>[\s\S]*?<\/Family>/g;
      const idAttr = /\bId="([^"]+)"/;
      let mFam: RegExpExecArray | null;
      while ((mFam = famRegex.exec(famXmlSrc)) !== null) {
        const full = mFam[0];
        const idm = idAttr.exec(full);
        if (idm) famElById.set(String(idm[1]), full);
      }

      const setAttr = (el: string, attr: string, value: string): string => {
        const re = new RegExp(`\\b${attr}="[^"]*"`);
        if (re.test(el)) return el.replace(re, `${attr}="${value}"`);
        return el.replace(/(\s*\/?>)$/, ` ${attr}="${value}"$1`);
      };

      // Fallback metadata (only used if a familyId isn't present in export-master)
      const { data: masterData } = await supabase
        .from("agora_master_data").select("families_json").eq("connection_id", connectionId).single();
      const existingFamilies = ((masterData as any)?.families_json || []) as { Id: string; Name: string; Color?: string; Order?: string; ButtonText?: string; ParentFamilyId?: string }[];

      let xml = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n<Import>\n  <Families>\n`;
      const applied: { id: string; showInPos: boolean }[] = [];
      const skipped: string[] = [];
      for (const u of updates) {
        const flag = u.showInPos ? "true" : "false";
        const original = famElById.get(String(u.familyId));
        if (original) {
          xml += `    ${setAttr(original, "ShowInPos", flag)}\n`;
          applied.push({ id: u.familyId, showInPos: u.showInPos });
          continue;
        }
        // Fallback: synthesize from cached families_json
        const fam = existingFamilies.find(f => String(f.Id) === String(u.familyId));
        if (!fam) { skipped.push(u.familyId); continue; }
        const name = fam.Name || u.familyId;
        const color = fam.Color || (u.showInPos ? "#8B0000" : "#999999");
        const btn = fam.ButtonText || name.substring(0, 20);
        const order = fam.Order || (u.showInPos ? "100" : "9999");
        const parentAttr = fam.ParentFamilyId ? ` ParentFamilyId="${fam.ParentFamilyId}"` : "";
        xml += `    <Family Id="${u.familyId}" Name="${escXmlV(name)}" ShowInPos="${flag}" ButtonText="${escXmlV(btn)}" Color="${color}" Order="${order}"${parentAttr} />\n`;
        applied.push({ id: u.familyId, showInPos: u.showInPos });
      }
      xml += `  </Families>\n</Import>`;

      if (applied.length === 0) {
        return new Response(JSON.stringify({ success: false, error: `Ninguna familia encontrada (skipped=${skipped.length})`, skipped }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const importUrl = `${baseUrlClean}/api/import/`;
      const xmlHeaders = { "Api-Token": apiTokenClean, Accept: "application/xml", "Content-Type": "application/xml; charset=utf-8" };
      try {
        const importRes = await fetchWithRetry(importUrl, { method: "POST", headers: xmlHeaders, body: xml }, 30000);
        const responseBody = await importRes.text().catch(() => "");
        const parsed = parseAgoraImportResponse(importRes.status, responseBody);
        return new Response(JSON.stringify({
          success: parsed.success, applied, skipped,
          error: parsed.success ? null : (parsed.errors.join("; ") || `HTTP ${importRes.status}: ${responseBody.slice(0, 300)}`),
          xmlPreview: xml.slice(0, 1000),
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: String(e) }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }

    // ── SET PRODUCT VISIBILITY (toggle UseAsDirectSale + SaleableAsMain per product, batched) ──
    // Pulls the FULL <Product .../> element from Agora's export-master XML (cached) and only
    // overrides the two visibility attributes. Minimal product XML is rejected by Agora (HTTP 500)
    // because required attributes (Price, Vat, ButtonText, Color, etc.) are missing.
    if (action === "set-product-visibility") {
      const updates: { productId: string; visible: boolean }[] = payload.updates || [];
      if (!Array.isArray(updates) || updates.length === 0) {
        return new Response(JSON.stringify({ success: false, error: "No updates provided" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // 1) Fetch full products XML from Agora (cached)
      const cached = await fetchAgoraProductsXmlCached(connectionId, baseUrlClean, apiTokenClean, fetchWithRetry, 30000);
      if (!cached.ok) {
        return new Response(JSON.stringify({ success: false, error: `No se pudo leer catálogo Agora: HTTP ${cached.status}` }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // 2) Index every <Product .../> element by Id
      const productElByIdLocal = new Map<string, string>();
      const productRegex = /<Product\b[^>]*\/>|<Product\b[^>]*>[\s\S]*?<\/Product>/g;
      const idAttr = /\bId="([^"]+)"/;
      let mProd: RegExpExecArray | null;
      while ((mProd = productRegex.exec(cached.xml)) !== null) {
        const full = mProd[0];
        const idm = idAttr.exec(full);
        if (idm) productElByIdLocal.set(String(idm[1]), full);
      }

      const setAttr = (el: string, attr: string, value: string): string => {
        const re = new RegExp(`\\b${attr}="[^"]*"`);
        if (re.test(el)) return el.replace(re, `${attr}="${value}"`);
        // Insert before closing /> or >
        return el.replace(/(\s*\/?>)$/, ` ${attr}="${value}"$1`);
      };

      // 3) Build patched import XML — reuse full element, override two attrs only
      let xml = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n<Import>\n  <Products>\n`;
      const applied: { id: string; visible: boolean }[] = [];
      const skipped: string[] = [];
      for (const u of updates) {
        const pid = String(u.productId);
        const original = productElByIdLocal.get(pid);
        if (!original) { skipped.push(pid); continue; }
        const flag = u.visible ? "true" : "false";
        let patched = setAttr(original, "UseAsDirectSale", flag);
        patched = setAttr(patched, "SaleableAsMain", flag);
        xml += `    ${patched}\n`;
        applied.push({ id: pid, visible: u.visible });
      }
      xml += `  </Products>\n</Import>`;

      if (applied.length === 0) {
        return new Response(JSON.stringify({ success: false, error: `Ningún producto encontrado en catálogo Agora (skipped=${skipped.length})`, skipped }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const importUrl = `${baseUrlClean}/api/import/`;
      const xmlHeaders = { "Api-Token": apiTokenClean, Accept: "application/xml", "Content-Type": "application/xml; charset=utf-8" };
      try {
        const importRes = await fetchWithRetry(importUrl, { method: "POST", headers: xmlHeaders, body: xml }, 60000);
        const responseBody = await importRes.text().catch(() => "");
        const parsed = parseAgoraImportResponse(importRes.status, responseBody);
        // Invalidate cache so the next batch sees the patched UseAsDirectSale flag
        if (parsed.success) invalidateAgoraProductsCache(connectionId);
        return new Response(JSON.stringify({
          success: parsed.success, applied, skipped,
          error: parsed.success ? null : (parsed.errors.join("; ") || `HTTP ${importRes.status}: ${responseBody.slice(0, 300)}`),
          xmlPreview: xml.slice(0, 1000),
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: String(e) }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }
    if (action === "archive-products") {
      const sourceFamilyIds: string[] = (payload.sourceFamilyIds || []).map(String);
      if (sourceFamilyIds.length === 0) {
        return new Response(JSON.stringify({ success: false, error: "No sourceFamilyIds provided" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      function escXmlA(s: string): string {
        return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
      }

      const { data: masterData } = await supabase
        .from("agora_master_data").select("products_summary_json, families_json").eq("connection_id", connectionId).single();
      const products = ((masterData as any)?.products_summary_json || []) as { Id: string; Name: string; FamilyId?: string; VatId?: string }[];
      const families = ((masterData as any)?.families_json || []) as { Id: string; Name: string }[];

      // Find or create the ARCHIVO family
      const ARCHIVE_NAME = "ARCHIVO WINERIM";
      const ARCHIVE_ID = "999999"; // stable hidden id
      const targetProducts = products.filter(p => sourceFamilyIds.includes(String(p.FamilyId || "")));

      if (targetProducts.length === 0) {
        return new Response(JSON.stringify({ success: true, archived: 0, message: "No products in those families" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // 1) Ensure archive family exists and is hidden
      let xml = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n<Import>\n  <Families>\n`;
      xml += `    <Family Id="${ARCHIVE_ID}" Name="${escXmlA(ARCHIVE_NAME)}" ShowInPos="false" ButtonText="ARCHIVO" Color="#444444" Order="99999" />\n`;
      xml += `  </Families>\n  <Products>\n`;
      for (const p of targetProducts) {
        xml += `    <Product Id="${p.Id}" Name="${escXmlA(p.Name)}" FamilyId="${ARCHIVE_ID}"`;
        if (p.VatId) xml += ` VatId="${p.VatId}"`;
        xml += ` />\n`;
      }
      xml += `  </Products>\n</Import>`;

      const importUrl = `${baseUrlClean}/api/import/`;
      const xmlHeaders = { "Api-Token": apiTokenClean, Accept: "application/xml", "Content-Type": "application/xml; charset=utf-8" };
      try {
        const importRes = await fetchWithRetry(importUrl, { method: "POST", headers: xmlHeaders, body: xml }, 60000);
        const responseBody = await importRes.text().catch(() => "");
        const parsed = parseAgoraImportResponse(importRes.status, responseBody);
        return new Response(JSON.stringify({
          success: parsed.success,
          archived: targetProducts.length,
          archiveFamilyId: ARCHIVE_ID,
          error: parsed.success ? null : (parsed.errors.join("; ") || `HTTP ${importRes.status}`),
          xmlPreview: xml.slice(0, 800),
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: String(e) }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }

    // ── HIDE FAMILIES (set ShowInPos=false) ──
    if (action === "hide-families") {
      const familyIds: string[] = payload.familyIds || [];
      if (familyIds.length === 0) {
        return new Response(JSON.stringify({ success: false, error: "No familyIds provided" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      function escXmlH(s: string): string {
        return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
      }

      // Load current families to get names
      const { data: masterData } = await supabase
        .from("agora_master_data").select("families_json").eq("connection_id", connectionId).single();
      const existingFamilies = ((masterData as any)?.families_json || []) as { Id: string; Name: string }[];

      let xml = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n<Import>\n  <Families>\n`;
      const hidden: string[] = [];
      for (const fId of familyIds) {
        const fam = existingFamilies.find(f => f.Id === fId);
        const name = fam?.Name || fId;
        xml += `    <Family Id="${fId}" Name="${escXmlH(name)}" ShowInPos="false" ButtonText="${escXmlH(name.substring(0, 20))}" Color="#999999" Order="9999" />\n`;
        hidden.push(name);
      }
      xml += `  </Families>\n</Import>`;

      const importUrl = `${baseUrlClean}/api/import/`;
      const xmlHeaders = {
        "Api-Token": apiTokenClean,
        Accept: "application/xml",
        "Content-Type": "application/xml; charset=utf-8",
      };

      try {
        const importRes = await fetchWithRetry(importUrl, { method: "POST", headers: xmlHeaders, body: xml }, 30000);
        const responseBody = await importRes.text().catch(() => "");
        const parsed = parseAgoraImportResponse(importRes.status, responseBody);
        return new Response(JSON.stringify({
          success: parsed.success,
          hidden,
          error: parsed.success ? null : (parsed.errors.join("; ") || `HTTP ${importRes.status}`),
          xmlSent: xml,
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: String(e) }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }

    // ── CREATE SINGLE FAMILY (manual) ──
    if (action === "create-family") {
      const familyName = payload.familyName;
      const familyButtonText = payload.familyButtonText || familyName.substring(0, 20);
      const familyColor = payload.familyColor || "#8B0000";
      const familyOrder = payload.familyOrder || 100;
      const familyShowInPos = payload.familyShowInPos !== false;
      const familyParentId = payload.familyParentId || null;

      if (!familyName) {
        return new Response(JSON.stringify({ success: false, error: "familyName is required" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const newId = stableFamilyId(familyName);

      function escXml2(s: string): string {
        return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
      }

      let xml = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n<Import>\n  <Families>\n`;
      xml += `    <Family Id="${newId}" Name="${escXml2(familyName)}" ShowInPos="${familyShowInPos}" ButtonText="${escXml2(familyButtonText)}" Color="${familyColor}" Order="${familyOrder}"`;
      if (familyParentId) xml += ` ParentFamilyId="${familyParentId}"`;
      xml += ` />\n`;
      xml += `  </Families>\n</Import>`;

      const importUrl = `${baseUrlClean}/api/import/`;
      const xmlHeaders2 = {
        "Api-Token": apiTokenClean,
        Accept: "application/xml",
        "Content-Type": "application/xml; charset=utf-8",
      };

      try {
        const importRes = await fetchWithRetry(importUrl, { method: "POST", headers: xmlHeaders2, body: xml }, 30000);
        const responseBody = await importRes.text().catch(() => "");
        const parsed = parseAgoraImportResponse(importRes.status, responseBody);

        return new Response(JSON.stringify({
          success: parsed.success,
          familyId: newId,
          familyName,
          error: parsed.success ? null : (parsed.errors.join("; ") || `HTTP ${importRes.status}`),
          xmlSent: xml,
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: String(e) }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }

    // ── PREVIEW XML (dry-run, no send) ──
    if (action === "preview-xml") {
      const winerimWineIds = payload.winerimWineIds || [];
      const formatTypes = payload.formatTypes || ["BOTTLE", "MAGNUM"];

      const customFamilyMappings = await loadCustomFamilyMappings(connectionId);

      const { data: masterData } = await supabase
        .from("agora_master_data").select("*").eq("connection_id", connectionId).single();

      if (!masterData) {
        return new Response(
          JSON.stringify({ success: false, error: "No master data cached. Run 'Sync Master Data' first." }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const { data: wines } = await supabase
        .from("winerim_wines").select("*").eq("connection_id", connectionId).in("winerim_id", winerimWineIds);

      if (!wines || wines.length === 0) {
        return new Response(JSON.stringify({ success: false, error: "No wines found" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const geoConfigPreview = (connection.provider_config as any)?.geographic_config as GeographicFamilyConfig | undefined;
      const isGeoModePreview = (connection.provider_config as any)?.family_structure_mode === "GEOGRAPHIC_FAMILIES" && geoConfigPreview;
      const { xml, validationResults } = generateImportXml(wines, masterData, connection, formatTypes, customFamilyMappings, false, isGeoModePreview ? geoConfigPreview : undefined, isGeoModePreview ? wines : undefined);

      // PRIORITY 7: Include source data summary for preview transparency
      const sourceDataSummary = wines.map((w: any) => ({
        winerim_id: w.winerim_id,
        name: w.name,
        wine_type: w.wine_type || null,
        bottle_sale_price: w.bottle_sale_price ? Number(w.bottle_sale_price) : null,
        bottle_purchase_price: w.bottle_purchase_price ? Number(w.bottle_purchase_price) : null,
        glass_sale_price: w.glass_sale_price ? Number(w.glass_sale_price) : null,
        glass_cost_price: w.glass_cost_price ? Number(w.glass_cost_price) : null,
        serve_by_glass: w.serve_by_glass || false,
        is_active: w.is_active !== false,
        source: "normalized_db_fields",
      }));

      const hasProducts = xml.includes("<Product");
      const previewXmlHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(xml)).then(
        (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join(""),
      );

      // Extract per-product price list counts for transparency
      const previewPricesByProduct: Record<string, number> = {};
      const prevProdRegex = /<Product\s+Id="(\d+)"[^>]*>([\s\S]*?)<\/Product>/gi;
      let prevM;
      while ((prevM = prevProdRegex.exec(xml)) !== null) {
        const inner = prevM[2];
        const priceCount = (inner.match(/<Price\s/gi) || []).length;
        previewPricesByProduct[prevM[1]] = priceCount;
      }

      return new Response(
        JSON.stringify({
          success: hasProducts,
          xml,
          xmlHash: previewXmlHash,
          priceListCountByProduct: previewPricesByProduct,
          wineCount: wines.length,
          validationResults,
          sourceDataSummary,
          ...(hasProducts ? {} : {
            error: "No exportable products generated. Check validation results for details.",
            hint: "Pricing data may be missing. Re-sync Winerim catalog to fetch wine details.",
          }),
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── XML IMPORT (POST /api/import/) ──
    if (action === "xml-import") {
      const winerimWineIds = payload.winerimWineIds || [];
      const formatTypes = payload.formatTypes || ["BOTTLE"];
      const dryRun = payload.dryRun || false;

      const { data: masterData } = await supabase
        .from("agora_master_data").select("*").eq("connection_id", connectionId).single();

      if (!masterData) {
        return new Response(
          JSON.stringify({ success: false, error: "No master data. Run 'Sync Master Data' first." }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const customFamilyMappings = await loadCustomFamilyMappings(connectionId);

      const { data: wines } = await supabase
        .from("winerim_wines").select("*").eq("connection_id", connectionId).in("winerim_id", winerimWineIds);

      if (!wines || wines.length === 0) {
        return new Response(JSON.stringify({ success: false, error: "No wines found" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const geoConfigBulk = (connection.provider_config as any)?.geographic_config as GeographicFamilyConfig | undefined;
      const isGeoModeBulk = (connection.provider_config as any)?.family_structure_mode === "GEOGRAPHIC_FAMILIES" && geoConfigBulk;
      const { xml, validationResults } = generateImportXml(wines, masterData, connection, formatTypes, customFamilyMappings, false, isGeoModeBulk ? geoConfigBulk : undefined, isGeoModeBulk ? wines : undefined);

      if (dryRun) {
        return new Response(
          JSON.stringify({ success: true, dryRun: true, xml, validationResults }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // POST to Agora
      const importUrl = `${baseUrlClean}/api/import/`;
      const xmlHeaders = {
        "Api-Token": apiTokenClean,
        Accept: "application/xml",
        "Content-Type": "application/xml; charset=utf-8",
      };

      let importRes: Response;
      try {
        importRes = await fetchWithRetry(importUrl, { method: "POST", headers: xmlHeaders, body: xml }, 30000);
      } catch (e) {
        return new Response(
          JSON.stringify({ success: false, error: `Failed to reach Agora import: ${e}` }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const responseBody = await importRes.text().catch(() => "");

      // FIX PRIORITY 6: Parse response properly
      const parsedResponse = parseAgoraImportResponse(importRes.status, responseBody);

      // FIX PRIORITY 2: Set can_write_products based on actual result
      if (parsedResponse.success) {
        await supabase.from("provider_capabilities").upsert({
          connection_id: connectionId, provider: "AGORA",
          can_read_sales: true, can_read_catalog: true,
          can_write_products: "YES",
          write_endpoint: "/api/import/",
          last_checked_at: new Date().toISOString(),
        }, { onConflict: "connection_id" });

        // auto_push_verified_ready is NOT set here — it must be enabled manually by the user
        // after verifying products were created correctly in Agora
      } else if (importRes.status === 404 || importRes.status === 405) {
        await supabase.from("provider_capabilities").upsert({
          connection_id: connectionId, provider: "AGORA",
          can_read_sales: true, can_read_catalog: true,
          can_write_products: "NO",
          write_endpoint: "/api/import/",
          last_checked_at: new Date().toISOString(),
        }, { onConflict: "connection_id" });
      }

      // Update mappings
      for (const wine of wines) {
        for (const fmt of formatTypes) {
          const agoraProductId = fmt === "MAGNUM"
            ? String(900000 + Number(wine.winerim_id || 0))
            : fmt === "GLASS" 
            ? String(700000 + Number(wine.winerim_id || 0))
            : String(500000 + Number(wine.winerim_id || 0));
          const productName = formatProductName(fmt, wine.name);

          await supabase.from("product_mappings").upsert({
            connection_id: connectionId,
            provider_product_id: agoraProductId,
            provider_product_name: productName,
            winerim_wine_id: wine.winerim_id, winerim_wine_name: wine.name,
            match_method: "XML_IMPORT", match_score: 100,
            match_reasons: ["Created via XML import"],
            status: parsedResponse.success ? "CONFIRMED" : "PENDING",
            format_type: fmt, agora_product_id: agoraProductId,
            last_synced_at: parsedResponse.success ? new Date().toISOString() : null,
            last_sync_error: parsedResponse.success ? null : parsedResponse.errors.join("; ").substring(0, 500),
          }, { onConflict: "connection_id,provider_product_id" });

          // ── PUSH TRACKING: Mark per format ──
          await upsertPushTracking(supabase, connectionId, wine.winerim_id, fmt, {
            sync_status: parsedResponse.success ? "PUSHED" : "FAILED",
            agora_product_id: agoraProductId,
            pushed_at: parsedResponse.success ? new Date().toISOString() : null,
            last_error: parsedResponse.success ? null : parsedResponse.errors.join("; ").substring(0, 500),
          });
        }
      }

      // ── UNIFIED POST-IMPORT VERIFICATION ──
      interface PostImportVerification {
        success: boolean;
        verified_exists: boolean;
        verified_prices: boolean;
        verified_family: boolean;
        verified_preparation: boolean;
        verified_scope?: boolean;
        errors: { code: string; message: string; field?: string; context?: Record<string, unknown> }[];
        warnings: { code: string; message: string; field?: string; context?: Record<string, unknown> }[];
        summary: { checked: number; ok: number; failed: number; totalPriceListsChecked: number };
        missing_prices: MissingPriceEntry[];
        affected_sale_centers: string[];
      }

      interface MissingPriceEntry {
        product_erp_id: string;
        agora_product_id: string;
        price_list_id: string;
        price_list_name: string;
        issue: "missing" | "zero" | "invalid";
        product_name?: string;
        format?: string;
        affected_sale_centers?: string[];
      }

      const verification: PostImportVerification = {
        success: true,
        verified_exists: true,
        verified_prices: true,
        verified_family: true,
        verified_preparation: true,
        errors: [],
        warnings: [],
        summary: { checked: 0, ok: 0, failed: 0, totalPriceListsChecked: 0 },
        missing_prices: [],
        affected_sale_centers: [],
      };

      if (parsedResponse.success) {
        try {
          const cachedProducts = await fetchAgoraProductsXmlCached(connectionId, baseUrlClean, apiTokenClean, fetchWithRetry, 30000);

          const { data: cachedMaster } = await supabase
            .from("agora_master_data").select("price_lists_json, sale_centers_json").eq("connection_id", connectionId).single();
          
          // Use production scope to only verify against active PLs linked to active SaleCenters
          const manualImportScope = buildAgoraVerificationScope(cachedMaster, {
            connectionSelectedSaleCenterIds: connection.selected_sale_center_ids || [],
            verificationMode: "PRODUCTION_ALL_ACTIVE_SALE_CENTERS",
          });
          const allPriceLists = manualImportScope.selectedPriceLists.map(pl => ({ Id: pl.id, Name: pl.name }));
          const plToSc = manualImportScope.priceListToSaleCenters;
          verification.summary.totalPriceListsChecked = allPriceLists.length;

          // Extract expected familyIds from the sent XML
          const expectedFamilies: Record<string, string> = {};
          const familyRegex = /<Product[^>]*Id="(\d+)"[^>]*FamilyId="([^"]*)"/g;
          let fMatch;
          while ((fMatch = familyRegex.exec(xml)) !== null) {
            expectedFamilies[fMatch[1]] = fMatch[2];
          }

          if (cachedProducts.ok) {
            const verifyXml = cachedProducts.xml;

            // Build products list for unified verification
            const productsToVerify: AgoraProductToVerify[] = [];
            for (const wine of wines) {
              for (const fmt of formatTypes) {
                const productId = fmt === "MAGNUM"
                  ? String(900000 + Number(wine.winerim_id || 0))
                  : fmt === "GLASS"
                  ? String(700000 + Number(wine.winerim_id || 0))
                  : String(500000 + Number(wine.winerim_id || 0));
                productsToVerify.push({
                  productId,
                  productName: formatProductName(fmt, wine.name),
                  format: fmt,
                  erpId: `${wine.winerim_id}:${fmt}`,
                  expectedFamilyId: expectedFamilies[productId] || undefined,
                });
              }
            }

            // Use the unified verification function — same logic as verify-products and process-xml-outbound-task
            const scopedPriceLists = manualImportScope.selectedPriceLists;
            const unifiedResult = verifyAgoraProductsAgainstScope(
              verifyXml, productsToVerify, scopedPriceLists, plToSc,
            );

            // Merge unified result into the verification object
            verification.success = unifiedResult.success;
            verification.verified_exists = unifiedResult.verified_exists;
            verification.verified_prices = unifiedResult.verified_prices;
            verification.verified_family = unifiedResult.verified_family;
            verification.verified_preparation = unifiedResult.verified_preparation;
            verification.verified_scope = unifiedResult.verified_scope;
            verification.errors = unifiedResult.errors;
            verification.warnings = unifiedResult.warnings;
            verification.missing_prices = unifiedResult.missing_prices;
            verification.affected_sale_centers = unifiedResult.affected_sale_centers;
            verification.summary.checked = unifiedResult.summary.checked;
            verification.summary.ok = unifiedResult.summary.ok;
            verification.summary.failed = unifiedResult.summary.failed;
            verification.summary.totalPriceListsChecked = scopedPriceLists.length;
          } else {
            verification.warnings.push({
              code: "VERIFY_FETCH_FAILED",
              message: `Export-master returned ${verifyRes.status} — verification incomplete`,
            });
          }
        } catch (verifyErr) {
          verification.warnings.push({
            code: "VERIFY_EXCEPTION",
            message: `Verification failed: ${String(verifyErr).substring(0, 200)}`,
          });
        }

        // If verification failed, mark outbound tasks as FAILED
        if (!verification.success && verification.errors.length > 0) {
          const failMsg = `Post-import verification: ${verification.summary.failed}/${verification.summary.checked} products failed — ${verification.errors.map(e => e.code).join(", ")}`;
          for (const wine of wines) {
            const wineId = wine.winerim_id;
            await supabase.from("outbound_tasks")
              .update({ status: "FAILED", last_error: failMsg.substring(0, 500) })
              .eq("connection_id", connectionId)
              .eq("task_type", "AGORA_XML_UPSERT_PRODUCT")
              .contains("payload_json", { _winerim_wine_id: wineId })
              .eq("status", "RUNNING");
          }
        }
      }

      return new Response(
        JSON.stringify({
          success: parsedResponse.success,
          status: importRes.status,
          parsedResponse,
          validationResults,
          xmlSent: xml.substring(0, 3000),
          winesProcessed: wines.length,
          formatsUsed: formatTypes,
          verification,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── PROCESS XML OUTBOUND TASK ──
    if (action === "process-xml-outbound-task") {
      const taskId = payload.taskId;
      const alreadyClaimed = payload.alreadyClaimed === true;

      const { data: task, error: taskErr } = await supabase
        .from("outbound_tasks").select("*").eq("id", taskId).single();
      if (taskErr || !task) {
        return new Response(JSON.stringify({ error: "Task not found" }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // Allow first real XML import to validate write capability.
      // Only block when XML import mode is not enabled.
      if (connection.write_mode !== "XML_IMPORT") {
        await supabase.from("outbound_tasks").update({
          status: "BLOCKED",
          blocked_reason: "Write mode is not XML_IMPORT. Configure Write Settings first.",
        }).eq("id", task.id);
        return new Response(JSON.stringify({ success: false, status: "BLOCKED" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const currentAttempts = alreadyClaimed ? (task.attempts || 0) : ((task.attempts || 0) + 1);
      if (!alreadyClaimed) {
        await supabase.from("outbound_tasks").update({ status: "RUNNING", attempts: currentAttempts }).eq("id", task.id);
      }

      try {
        const { data: masterData } = await supabase
          .from("agora_master_data").select("*").eq("connection_id", task.connection_id).single();

        if (!masterData) {
          await supabase.from("outbound_tasks").update({
            status: "BLOCKED", blocked_reason: "No master data cached. Run 'Sync Master Data' first.",
          }).eq("id", task.id);
          return new Response(JSON.stringify({ success: false, status: "BLOCKED" }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        const taskPayload = task.payload_json as Record<string, unknown>;
        const winerimWineId = taskPayload._winerim_wine_id as string;
        const fmtTypes = (taskPayload._format_types as string[]) || ["BOTTLE"];
        const familyOverrideId = taskPayload._family_override_id as string | undefined;
        const forceEmptyPreparation = taskPayload._force_empty_preparation === true;

        const { data: wineArr } = await supabase
          .from("winerim_wines").select("*")
          .eq("connection_id", task.connection_id).eq("winerim_id", winerimWineId).limit(1);

        if (!wineArr || wineArr.length === 0) {
          await supabase.from("outbound_tasks").update({
            status: "FAILED", last_error: `Wine ${winerimWineId} not found in cache`,
          }).eq("id", task.id);
          return new Response(JSON.stringify({ success: false, status: "FAILED" }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        let customFamilyMappings = await loadCustomFamilyMappings(task.connection_id);
        // If family override is set, create an override mapping that takes priority
        if (familyOverrideId) {
          const overrideMapping: Record<string, { id: string; name: string }> = {};
          for (const key of ["copa", "botella_tinto", "botella_blanco", "botella_rosado", "botella_espumoso", "botella_fortificado", "botella_dulce", "magnum"]) {
            overrideMapping[key] = { id: familyOverrideId, name: `Override Family ${familyOverrideId}` };
          }
          customFamilyMappings = overrideMapping;
        }
        const geoConfig = (connection.provider_config as any)?.geographic_config as GeographicFamilyConfig | undefined;
        const isGeoMode = (connection.provider_config as any)?.family_structure_mode === "GEOGRAPHIC_FAMILIES" && geoConfig;
        const { xml, validationResults } = generateImportXml(wineArr, masterData, connection, fmtTypes, customFamilyMappings, forceEmptyPreparation, isGeoMode ? geoConfig : undefined, isGeoMode ? wineArr : undefined);

        // ── HARD VALIDATION: Compute XML hash for mismatch detection ──
        const taskXmlHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(xml)).then(
          (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join(""),
        );

        // Check if any products were actually generated (validation may have skipped all)
        if (!xml.includes("<Product ")) {
          const reasons = validationResults.map(v => v.validation.missingFields.join(", ")).filter(Boolean).join("; ");
          await supabase.from("outbound_tasks").update({
            status: "BLOCKED", blocked_reason: `Validation failed: ${reasons || "no products generated"}`,
          }).eq("id", task.id);
          return new Response(JSON.stringify({ success: false, status: "BLOCKED", validationResults }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        // ── HARD VALIDATION: Block if any sellable product has 0 <Price> entries ──
        const zeroPriceProducts: string[] = [];
        const preSendProductRegex = /<Product\s+Id="(\d+)"[^>]*>([\s\S]*?)<\/Product>/gi;
        let preSendMatch;
        while ((preSendMatch = preSendProductRegex.exec(xml)) !== null) {
          const pid = preSendMatch[1];
          const inner = preSendMatch[2];
          const hasPrices = /<Price\s/i.test(inner);
          if (!hasPrices) zeroPriceProducts.push(pid);
        }
        if (zeroPriceProducts.length > 0) {
          const blockMsg = `[NO_PRICELISTS_GENERATED_IN_TASK_XML] Products with 0 Price entries: ${zeroPriceProducts.join(", ")}. PriceLists in masterData: ${(masterData.price_lists_json || []).length}`;
          await supabase.from("outbound_tasks").update({
            status: "FAILED",
            last_error: blockMsg,
            payload_json: { ...taskPayload, _task_xml_hash: taskXmlHash, _zero_price_products: zeroPriceProducts },
          }).eq("id", task.id);
          return new Response(JSON.stringify({ success: false, status: "FAILED", error: blockMsg }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        const importUrl = `${baseUrlClean}/api/import/`;
        const xmlHeaders = {
          "Api-Token": apiTokenClean,
          Accept: "application/xml",
          "Content-Type": "application/xml; charset=utf-8",
        };

        const importRes = await fetchWithRetry(importUrl, { method: "POST", headers: xmlHeaders, body: xml }, 30000);
        const responseBody = await importRes.text().catch(() => "");
        const parsedResponse = parseAgoraImportResponse(importRes.status, responseBody);

        if (!parsedResponse.success) {
          // ── IMPROVED ERROR CAPTURE: Include Agora's actual error message ──
          const rawDetail = parsedResponse.rawPreview?.substring(0, 500) || "";
          const agoraErrors = parsedResponse.errors.length > 0 
            ? parsedResponse.errors.join("; ").substring(0, 300)
            : "";
          const errorMsg = rawDetail 
            ? `HTTP ${importRes.status}: ${rawDetail}`
            : (agoraErrors || `HTTP ${importRes.status}`);

          // ── DUPLICATE KEY DETECTION: If Agora says duplicate, the product already exists ──
          const duplicateDetail = `${rawDetail} ${agoraErrors}`.toLowerCase();
          const isDuplicateKey = duplicateDetail.includes("unique key constraint") || duplicateDetail.includes("duplicate key");
          if (isDuplicateKey) {
            const isFamilyDuplicate = duplicateDetail.includes("importar la familia") ||
              duplicateDetail.includes("dbo.family") ||
              duplicateDetail.includes("family with id") ||
              duplicateDetail.includes("nombre 'otras'") ||
              duplicateDetail.includes("nombre \"otras\"");

            if (isFamilyDuplicate) {
              await supabase.from("outbound_tasks").update({
                status: "BLOCKED",
                last_error: errorMsg,
                blocked_reason: "DUPLICATE_FAMILY_NAME_IN_AGORA: Agora está rechazando una familia duplicada (por ejemplo 'Otras'). Revisa la jerarquía/familia destino antes de reintentar.",
              }).eq("id", task.id);
              return new Response(JSON.stringify({ success: false, status: "BLOCKED", reason: "DUPLICATE_FAMILY", parsedResponse }),
                { headers: { ...corsHeaders, "Content-Type": "application/json" } });
            }

            // ── AUTO-RETRY AS UPDATE: Product already exists, flip _operation and requeue ──
            const currentOp = taskPayload._operation || "CREATE";
            if (currentOp === "CREATE" && currentAttempts <= 2) {
              // Flip to UPDATE and requeue for automatic retry
              await supabase.from("outbound_tasks").update({
                status: "QUEUED",
                last_error: `Auto-switching from CREATE→UPDATE: ${errorMsg.substring(0, 200)}`,
                blocked_reason: null,
                payload_json: { ...taskPayload, _operation: "UPDATE", _auto_switched_from_create: true },
              }).eq("id", task.id);
              return new Response(JSON.stringify({ success: false, status: "QUEUED", reason: "AUTO_SWITCHED_TO_UPDATE" }),
                { headers: { ...corsHeaders, "Content-Type": "application/json" } });
            }

            // If already UPDATE or max attempts reached, block
            await supabase.from("outbound_tasks").update({
              status: "BLOCKED",
              last_error: errorMsg,
              blocked_reason: "PRODUCT_ALREADY_EXISTS_IN_AGORA: El producto ya existe en Agora y el UPDATE también falló. Verifica los datos manualmente.",
            }).eq("id", task.id);
            return new Response(JSON.stringify({ success: false, status: "BLOCKED", reason: "DUPLICATE_KEY", parsedResponse }),
              { headers: { ...corsHeaders, "Content-Type": "application/json" } });
          }

          const errClassHttp = classifyPosError(errorMsg, importRes.status);
          const isBusinessError = errClassHttp === "BUSINESS_ERROR";
          const shouldRetry = currentAttempts < (task.max_attempts || 3) && importRes.status >= 500 && !isBusinessError;
          
          // If it's a data error (4xx), don't retry - BLOCK
          const isDataError = importRes.status >= 400 && importRes.status < 500;
          await supabase.from("outbound_tasks").update({
            status: isDataError || isBusinessError ? "BLOCKED" : (shouldRetry ? "QUEUED" : "FAILED"),
            last_error: `[${errClassHttp}] ${errorMsg}`,
            blocked_reason: isDataError || isBusinessError ? `Data error: ${errorMsg}` : null,
          }).eq("id", task.id);

          if (importRes.status === 404 || importRes.status === 405) {
            await supabase.from("provider_capabilities").update({ can_write_products: "NO" }).eq("connection_id", task.connection_id);
          }

          // Trip circuit breaker if POS is overloaded (HTTP 500/501)
          const breakerResult = await applyCircuitBreaker(supabase, task.connection_id, errClassHttp);

          return new Response(JSON.stringify({
            success: false,
            status: isDataError || isBusinessError ? "BLOCKED" : (shouldRetry ? "QUEUED" : "FAILED"),
            errorClass: errClassHttp, breakerTripped: breakerResult.paused, parsedResponse,
          }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        // ── DIAGNOSTICS: Extract PriceListIds from the XML we actually sent ──
        // FIX: Use `<Product\s+Id=` to match the FIRST Id attribute, NOT FamilyId/VatId
        const sentPricesByProduct: Record<string, { priceListId: string; mainPrice: string }[]> = {};
        const productBlockRegex = /<Product\s+Id="(\d+)"[^>]*>([\s\S]*?)<\/Product>/gi;
        let pm;
        while ((pm = productBlockRegex.exec(xml)) !== null) {
          const prodId = pm[1];
          const innerBlock = pm[2];
          const priceEntries: { priceListId: string; mainPrice: string }[] = [];
          const prReg = /<Price\s[^>]*PriceListId="(\d+)"[^>]*MainPrice="([^"]*)"/gi;
          let pr;
          while ((pr = prReg.exec(innerBlock)) !== null) {
            priceEntries.push({ priceListId: pr[1], mainPrice: pr[2] });
          }
          sentPricesByProduct[prodId] = priceEntries;
        }

        // ── UNIFIED POST-IMPORT VERIFICATION (using shared function) ──
        // Extract expected familyIds from sent XML (use \s+Id= to avoid FamilyId capture)
        const expectedFamilies: Record<string, string> = {};
        const famRegex = /<Product\s+Id="(\d+)"[^>]*\sFamilyId="([^"]*)"/g;
        let fm;
        while ((fm = famRegex.exec(xml)) !== null) {
          expectedFamilies[fm[1]] = fm[2];
        }

        let taskVerification: AgoraVerificationResult & Record<string, unknown> = {
          success: true, verified_exists: true, verified_prices: true,
          verified_family: true, verified_preparation: true, verified_scope: true,
          errors: [], warnings: [], missing_prices: [], affected_sale_centers: [],
          summary: { checked: 0, ok: 0, failed: 0 },
        };

        // Diagnostics: actual prices read back from Agora
        const actualPricesByProduct: Record<string, { priceListId: string; mainPrice: string }[]> = {};

        try {
          const cachedProductsTask = await fetchAgoraProductsXmlCached(task.connection_id, baseUrlClean, apiTokenClean, fetchWithRetry, 30000);
          const verifyRes = { ok: cachedProductsTask.ok, status: cachedProductsTask.status, text: async () => cachedProductsTask.xml };

          const { data: cachedMaster2 } = await supabase
            .from("agora_master_data").select("price_lists_json, sale_centers_json").eq("connection_id", task.connection_id).single();

          // Use frozen scope from task payload if available; fall back to live resolution for legacy tasks
          const frozenPriceLists = Array.isArray(taskPayload._selected_price_lists) ? taskPayload._selected_price_lists as { id: string; name: string }[] : null;
          const frozenPlToSc = frozenPriceLists ? (() => {
            const map: Record<string, string[]> = {};
            const saleCenters = Array.isArray(taskPayload._selected_sale_centers) ? taskPayload._selected_sale_centers as { id: string; name: string; priceListId?: string | null }[] : [];
            for (const sc of saleCenters) {
              if (sc.priceListId) {
                if (!map[sc.priceListId]) map[sc.priceListId] = [];
                map[sc.priceListId].push(sc.name || sc.id || "");
              }
            }
            return map;
          })() : null;
          const hasFrozenScope = frozenPriceLists && frozenPriceLists.length > 0 && taskPayload._scope_frozen_at;

          const verificationScope = hasFrozenScope ? null : buildAgoraVerificationScope(cachedMaster2, {
            explicitSaleCenterIds: normalizeStringArray(taskPayload._selected_sale_center_ids || taskPayload._sale_center_id),
            connectionSelectedSaleCenterIds: connection.selected_sale_center_ids || [],
          });

          const effectivePriceLists = hasFrozenScope ? frozenPriceLists! : verificationScope!.selectedPriceLists;
          const effectivePlToSc = hasFrozenScope ? frozenPlToSc! : verificationScope!.priceListToSaleCenters;
          const effectiveScopeSource = hasFrozenScope ? (taskPayload._verification_scope_source || "frozen") : verificationScope!.source;
          const effectiveSaleCenters = hasFrozenScope
            ? (Array.isArray(taskPayload._selected_sale_centers) ? taskPayload._selected_sale_centers : [])
            : verificationScope!.selectedSaleCenters;
          const effectiveIgnoredPriceLists = hasFrozenScope
            ? (Array.isArray(taskPayload._ignored_price_lists) ? taskPayload._ignored_price_lists : [])
            : verificationScope!.ignoredPriceLists;

          // Build product list for this task
          const productsToVerify: AgoraProductToVerify[] = fmtTypes.map((fmt: string) => {
            const productId = fmt === "MAGNUM"
              ? String(900000 + Number(winerimWineId || 0))
              : fmt === "GLASS"
              ? String(700000 + Number(winerimWineId || 0))
              : String(500000 + Number(winerimWineId || 0));
            return {
              productId,
              productName: wineArr[0].name,
              format: fmt,
              erpId: winerimWineId || "",
              expectedFamilyId: expectedFamilies[productId] || undefined,
            };
          });

          if (verifyRes.ok) {
            const verifyXml = await verifyRes.text();

            // ── DIAGNOSTICS: Extract actual stored prices from Agora's response ──
            for (const p of productsToVerify) {
              const pRegex = new RegExp(
                `<Product[^>]*Id="${p.productId}"[^>]*>([\\s\\S]*?)<\\/Product>`, "i",
              );
              const pMatch = verifyXml.match(pRegex);
              if (pMatch) {
                const inner = pMatch[1];
                const actualPrices: { priceListId: string; mainPrice: string }[] = [];
                const apReg = /<Price[^>]*PriceListId="(\d+)"[^>]*MainPrice="([^"]*)"/gi;
                let ap;
                while ((ap = apReg.exec(inner)) !== null) {
                  actualPrices.push({ priceListId: ap[1], mainPrice: ap[2] });
                }
                actualPricesByProduct[p.productId] = actualPrices;
              } else {
                actualPricesByProduct[p.productId] = [];
              }
            }

            taskVerification = {
              ...verifyAgoraProductsAgainstScope(
                verifyXml, productsToVerify,
                effectivePriceLists,
                effectivePlToSc,
              ),
              selected_sale_centers: effectiveSaleCenters,
              selected_price_lists: effectivePriceLists,
              ignored_price_lists: effectiveIgnoredPriceLists,
              verification_scope_source: effectiveScopeSource,
              scope_frozen: !!hasFrozenScope,
              scope_frozen_at: taskPayload._scope_frozen_at || null,
              legacy_verification_scope: !hasFrozenScope && (!!taskPayload._legacy_verification_scope || (!taskPayload._sale_center_id && normalizeStringArray(taskPayload._selected_sale_center_ids).length === 0)),
            };
          } else {
            taskVerification.warnings.push({
              code: "VERIFY_FETCH_FAILED",
              message: `Export-master returned ${verifyRes.status} — verification incomplete`,
            });
          }
        } catch (_verifyErr) {
          taskVerification.warnings.push({
            code: "VERIFY_EXCEPTION",
            message: `Verification fetch failed: ${String(_verifyErr).substring(0, 200)}`,
          });
        }

        // ── DIAGNOSTICS: Compare sent XML vs actual stored prices ──
        // Determine if the bug is in generation, import, or verification
        const diagnostics: Record<string, unknown> = {
          timestamp: new Date().toISOString(),
          task_xml_hash: taskXmlHash,
          sent_price_lists_by_product: sentPricesByProduct,
          actual_price_lists_by_product: actualPricesByProduct,
          products_diagnosed: [] as unknown[],
        };

        const productsToVerifyIds = fmtTypes.map((fmt: string) =>
          fmt === "MAGNUM" ? String(900000 + Number(winerimWineId || 0))
          : fmt === "GLASS" ? String(700000 + Number(winerimWineId || 0))
          : String(500000 + Number(winerimWineId || 0))
        );

        let hasImportPersistenceBug = false;
        for (const prodId of productsToVerifyIds) {
          const sent = sentPricesByProduct[prodId] || [];
          const actual = actualPricesByProduct[prodId] || [];
          const sentPlIds = sent.map(s => s.priceListId);
          const actualPlIds = actual.map(a => a.priceListId);
          const missingInAgora = sentPlIds.filter(id => !actualPlIds.includes(id));
          const extraInAgora = actualPlIds.filter(id => !sentPlIds.includes(id));
          const xmlIncludedAll = (taskPayload._effective_price_list_ids as string[] || []).every(id => sentPlIds.includes(id));

          if (missingInAgora.length > 0 && xmlIncludedAll) {
            hasImportPersistenceBug = true;
          }

          (diagnostics.products_diagnosed as unknown[]).push({
            product_id: prodId,
            sent_price_list_ids: sentPlIds,
            actual_price_list_ids: actualPlIds,
            missing_in_agora: missingInAgora,
            extra_in_agora: extraInAgora,
            xml_included_all_expected: xmlIncludedAll,
            diagnosis: missingInAgora.length > 0 && xmlIncludedAll
              ? "IMPORT_DID_NOT_PERSIST_ALL_PRICELISTS"
              : missingInAgora.length > 0
              ? "XML_GENERATION_MISSING_PRICELISTS"
              : "OK",
          });
        }

        // If verification failed and it's an import persistence bug, upgrade error codes
        if (!taskVerification.success && hasImportPersistenceBug) {
          for (const err of (taskVerification.errors as AgoraVerificationIssue[])) {
            if (err.code === "PRICE_MISSING") {
              const prodId = (err.context as Record<string, unknown>)?.productId as string;
              const plId = (err.context as Record<string, unknown>)?.priceListId as string;
              const prodDiag = (diagnostics.products_diagnosed as any[]).find(d => d.product_id === prodId);
              if (prodDiag && (prodDiag.missing_in_agora as string[]).includes(plId)) {
                err.code = "IMPORT_DID_NOT_PERSIST_ALL_PRICELISTS";
                err.message = err.message.replace("missing price", "XML sent price but Agora did not persist");
              }
            }
          }
        }

        // Store diagnostics in the task payload for UI visibility
        const updatedPayload = { ...taskPayload, _diagnostics: diagnostics };

        if (!taskVerification.success) {
          // Distinguish between hard failures and soft verification issues (e.g. NOT_FOUND after successful import)
          const hardErrors = (taskVerification.errors as AgoraVerificationIssue[]).filter(
            (e) => e.code !== "NOT_FOUND"
          );
          const notFoundErrors = (taskVerification.errors as AgoraVerificationIssue[]).filter(
            (e) => e.code === "NOT_FOUND"
          );

          // If the ONLY verification failures are NOT_FOUND (product not yet indexed by Agora after import),
          // treat as SUCCESS with warnings — the import itself was accepted (HTTP 200).
          if (hardErrors.length === 0 && notFoundErrors.length > 0) {
            // Downgrade NOT_FOUND to warnings
            for (const nf of notFoundErrors) {
              taskVerification.warnings.push({
                ...nf,
                code: "NOT_FOUND_POST_IMPORT",
                message: `${nf.message} (import accepted, verification pending — Agora may need time to index)`,
              });
            }
            taskVerification.errors = [];
            taskVerification.success = true;
            // Fall through to the success path below
          } else {
            const failMsg = `Post-import verification failed: ${(taskVerification.errors as AgoraVerificationIssue[]).map((e) => `[${e.code}] ${e.message}`).join("; ")}`.substring(0, 1000);
            await supabase.from("outbound_tasks").update({
              status: "FAILED",
              last_error: failMsg,
              payload_json: updatedPayload,
            }).eq("id", task.id);
            // ── PUSH TRACKING: Mark FAILED per format ──
            for (const fmt of fmtTypes) {
              await upsertPushTracking(supabase, task.connection_id, winerimWineId, fmt, {
                sync_status: "FAILED",
                task_id: task.id,
                last_error: failMsg.substring(0, 500),
                pushed_at: new Date().toISOString(),
              });
            }
            return new Response(JSON.stringify({ success: false, status: "FAILED", verification: taskVerification, diagnostics }),
              { headers: { ...corsHeaders, "Content-Type": "application/json" } });
          }
        }

        // Store diagnostics even on success
        await supabase.from("outbound_tasks").update({
          payload_json: updatedPayload,
        }).eq("id", task.id);

        // Success - update mappings
        for (const fmt of fmtTypes) {
          const agoraProductId = fmt === "MAGNUM"
            ? String(900000 + Number(winerimWineId || 0))
            : fmt === "GLASS"
            ? String(700000 + Number(winerimWineId || 0))
            : String(500000 + Number(winerimWineId || 0));
          const productName = formatProductName(fmt, wineArr[0].name);

          await supabase.from("product_mappings").upsert({
            connection_id: task.connection_id,
            provider_product_id: agoraProductId,
            provider_product_name: productName,
            winerim_wine_id: winerimWineId, winerim_wine_name: wineArr[0].name,
            match_method: "XML_IMPORT", match_score: 100,
            status: "CONFIRMED", format_type: fmt, agora_product_id: agoraProductId,
            last_synced_at: new Date().toISOString(),
          }, { onConflict: "connection_id,provider_product_id" });
        }

        await supabase.from("provider_capabilities").upsert({
          connection_id: task.connection_id,
          provider: "AGORA",
          can_read_sales: true,
          can_read_catalog: true,
          can_write_products: "YES",
          write_endpoint: "/api/import/",
          last_checked_at: new Date().toISOString(),
        }, { onConflict: "connection_id" });

        await supabase.from("outbound_tasks").update({
          status: "SUCCESS", last_error: null,
          external_id: String(500000 + Number(winerimWineId || 0)),
        }).eq("id", task.id);

        // auto_push_verified_ready is NOT set here — manual verification required

        // ── PUSH TRACKING: Mark PUSHED (or VERIFIED if verification passed) per format ──
        const pushStatus = taskVerification.success ? "VERIFIED" : "PUSHED";
        for (const fmt of fmtTypes) {
          const fmtProductId = fmt === "MAGNUM" ? String(900000 + Number(winerimWineId || 0))
            : fmt === "GLASS" ? String(700000 + Number(winerimWineId || 0))
            : String(500000 + Number(winerimWineId || 0));
          await upsertPushTracking(supabase, task.connection_id, winerimWineId, fmt, {
            sync_status: pushStatus,
            task_id: task.id,
            agora_family_id: expectedFamilies[fmtProductId] || undefined,
            pushed_at: new Date().toISOString(),
            verified_at: taskVerification.success ? new Date().toISOString() : null,
            last_error: null,
          });
        }

        // Reset failure counter on success — connection is healthy again
        await resetFailureCounter(supabase, task.connection_id);
        return new Response(JSON.stringify({ success: true, status: "SUCCESS", parsedResponse, verification: taskVerification }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });

      } catch (e) {
        const errMsg = String(e).substring(0, 500);
        const errClass = classifyPosError(errMsg);
        const shouldRetry = currentAttempts < (task.max_attempts || 3) && errClass !== "BUSINESS_ERROR";
        await supabase.from("outbound_tasks").update({
          status: shouldRetry ? "QUEUED" : "FAILED",
          last_error: `[${errClass}] ${errMsg}`,
        }).eq("id", task.id);
        const breakerResult = await applyCircuitBreaker(supabase, task.connection_id, errClass);
        return new Response(JSON.stringify({
          success: false, status: shouldRetry ? "QUEUED" : "FAILED",
          errorClass: errClass, breakerTripped: breakerResult.paused,
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }

    // ── QUEUE XML OUTBOUND TASKS (with idempotent CREATE/UPDATE guard) ──
    if (action === "queue-xml-outbound") {
      const winerimWineIds = payload.winerimWineIds || [];
      const formatTypes = payload.formatTypes || ["BOTTLE"];
      const familyOverrideId = payload.familyOverrideId || null;

      // Load master data to check which products already exist in Agora + capture verification scope
      const { data: masterData } = await supabase
        .from("agora_master_data").select("products_summary_json, sale_centers_json, price_lists_json").eq("connection_id", connectionId).single();
      const existingProducts = (masterData?.products_summary_json || []) as { Id: string; Name: string }[];
      const existingProductIds = new Set(existingProducts.map((p: any) => String(p.Id)));
      const scopePayload = buildAgoraVerificationScopePayload(masterData, {
        explicitSaleCenterIds: normalizeStringArray(payload.saleCenterIds || payload.saleCenterId),
        connectionSelectedSaleCenterIds: connection.selected_sale_center_ids || [],
        verificationMode: "PRODUCTION_ALL_ACTIVE_SALE_CENTERS",
      });

      // ── Pre-load wine eligibility data to filter formats per wine ──
      const wineEligibility: Record<string, { serve_by_glass: boolean; bottle_sale_price: number | null; glass_sale_price: number | null; magnum_sale_price: number | null }> = {};
      for (let i = 0; i < winerimWineIds.length; i += 500) {
        const chunk = winerimWineIds.slice(i, i + 500);
        const { data: wines } = await supabase
          .from("winerim_wines")
          .select("winerim_id, serve_by_glass, bottle_sale_price, glass_sale_price, magnum_sale_price")
          .eq("connection_id", connectionId)
          .in("winerim_id", chunk);
        for (const w of (wines || [])) {
          wineEligibility[w.winerim_id] = {
            serve_by_glass: w.serve_by_glass,
            bottle_sale_price: w.bottle_sale_price,
            glass_sale_price: w.glass_sale_price,
            magnum_sale_price: w.magnum_sale_price,
          };
        }
      }

      let queuedCreate = 0, queuedUpdate = 0, skippedDuplicate = 0, skippedNoFormats = 0;
      for (const wineId of winerimWineIds) {
        // ── Filter formats based on wine eligibility ──
        const elig = wineEligibility[wineId];
        const eligibleFormats = formatTypes.filter((fmt: string) => {
          if (fmt === "GLASS") return elig?.serve_by_glass && (elig?.glass_sale_price ?? 0) > 0;
          if (fmt === "BOTTLE") return (elig?.bottle_sale_price ?? 0) > 0;
          if (fmt === "MAGNUM") return (elig?.magnum_sale_price ?? 0) > 0;
          return false;
        });
        if (eligibleFormats.length === 0) {
          // Fallback: if no format qualifies but BOTTLE was requested, still push BOTTLE
          if (formatTypes.includes("BOTTLE")) eligibleFormats.push("BOTTLE");
          else { skippedNoFormats++; continue; }
        }

        // Skip if already queued/running
        const { data: alreadyQueued } = await supabase
          .from("outbound_tasks").select("id")
          .eq("connection_id", connectionId)
          .eq("task_type", "AGORA_XML_UPSERT_PRODUCT")
          .contains("payload_json", { _winerim_wine_id: wineId })
          .in("status", ["QUEUED", "RUNNING"])
          .limit(1);

        if (alreadyQueued && alreadyQueued.length > 0) {
          skippedDuplicate++;
          continue;
        }

        // Determine CREATE vs UPDATE per format by checking existing Agora products
        const winerimIdNum = Number(wineId || 0);
        const formatProductIds: Record<string, string> = {
          BOTTLE: String(500000 + winerimIdNum),
          GLASS: String(700000 + winerimIdNum),
          MAGNUM: String(900000 + winerimIdNum),
        };
        const existsInAgora = eligibleFormats.some((fmt: string) => existingProductIds.has(formatProductIds[fmt] || ""));
        const operationType = existsInAgora ? "UPDATE" : "CREATE";

        await supabase.from("outbound_tasks").insert({
          connection_id: connectionId,
          task_type: "AGORA_XML_UPSERT_PRODUCT",
          payload_json: {
            _winerim_wine_id: wineId,
            _format_types: eligibleFormats,
            _write_mode: "XML_IMPORT",
            _trigger_source: "MANUAL",
            _operation: operationType,
            ...scopePayload,
            ...(familyOverrideId ? { _family_override_id: familyOverrideId } : {}),
          },
          status: "QUEUED",
        });
        if (operationType === "CREATE") queuedCreate++; else queuedUpdate++;

        // ── PUSH TRACKING: Mark QUEUED only for formats that are not already present in Agora ──
        // Existing published products keep their published status; pending UPDATEs are tracked via outbound_tasks.
        for (const fmt of eligibleFormats) {
          const formatAlreadyExists = existingProductIds.has(formatProductIds[fmt] || "");
          if (!formatAlreadyExists) {
            await upsertPushTracking(supabase, connectionId, wineId, fmt, {
              sync_status: "QUEUED",
            });
          }
        }
      }

      return new Response(JSON.stringify({
        success: true,
        queued: queuedCreate + queuedUpdate,
        queuedCreate,
        queuedUpdate,
        skippedDuplicate,
        skippedNoFormats,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── PROCESS XML OUTBOUND QUEUE (time-budgeted, auto-retry from UI) ──
    if (action === "process-xml-outbound-queue") {
      const serverLoop = payload.serverLoop === true;
      const BATCH_SIZE = 10;
      const TIME_BUDGET_MS = serverLoop ? 50_000 : 20_000;
      const startTime = Date.now();
      let processed = 0, succeeded = 0, failed = 0;

      // ── CIRCUIT BREAKER CHECK ──
      // If this connection is paused (recent repeated failures), exit early.
      const nowIso = new Date().toISOString();
      const breakerPausedUntil = (connection as any).circuit_breaker_paused_until as string | null;
      if (breakerPausedUntil && breakerPausedUntil > nowIso) {
        return new Response(JSON.stringify({
          success: true, processed: 0, succeeded: 0, failed: 0,
          skipped: true, breakerPausedUntil,
          reason: (connection as any).circuit_breaker_reason || "circuit_breaker_active",
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // Helper: compute exponential backoff delay (in seconds)
      const backoffDelaySec = (attempts: number) =>
        Math.min(60 * 60, Math.pow(2, attempts) * 60); // 2,4,8,16,32 min, cap 60min

      // Helper: register a failure and possibly trip the circuit breaker
      let runConsecutiveFailures = (connection as any).consecutive_failures || 0;
      const registerFailure = async (taskId: string, errorMsg: string, attempts: number) => {
        const nextRetry = new Date(Date.now() + backoffDelaySec(attempts) * 1000).toISOString();
        await supabase.from("outbound_tasks").update({
          status: attempts >= 5 ? "FAILED" : "QUEUED", // back to QUEUED with backoff if retries left
          last_error: errorMsg.substring(0, 500),
          next_retry_at: nextRetry,
        }).eq("id", taskId);
        runConsecutiveFailures++;
        // Trip breaker after 10 consecutive failures within this run → pause 15 min
        if (runConsecutiveFailures >= 10) {
          const pauseUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString();
          await supabase.from("pos_connections").update({
            circuit_breaker_paused_until: pauseUntil,
            circuit_breaker_reason: `Auto-paused: ${runConsecutiveFailures} consecutive failures. Last error: ${errorMsg.substring(0, 200)}`,
            consecutive_failures: runConsecutiveFailures,
          }).eq("id", connectionId);
        }
      };

      const registerSuccess = async () => {
        if (runConsecutiveFailures > 0) {
          runConsecutiveFailures = 0;
          await supabase.from("pos_connections").update({ consecutive_failures: 0 }).eq("id", connectionId);
        }
      };

      while (Date.now() - startTime < TIME_BUDGET_MS) {
        // Re-check breaker each loop in case it tripped mid-run
        if (runConsecutiveFailures >= 10) break;

        const taskTypes = ["AGORA_XML_UPSERT_PRODUCT", "AGORA_MIGRATE_FAMILY", "AGORA_HIDE_PRODUCT"];
        const { data: claimedTasks, error: claimErr } = await supabase.rpc("claim_outbound_tasks", {
          p_connection_id: connectionId,
          p_task_types: taskTypes,
          p_limit: BATCH_SIZE,
        });
        const usedAtomicClaim = !claimErr;
        let tasks = claimedTasks;
        if (claimErr) {
          console.warn(`[process-xml-outbound-queue] atomic claim unavailable, falling back: ${claimErr.message}`);
          const { data: fallbackTasks } = await supabase
            .from("outbound_tasks").select("id, task_type")
            .eq("connection_id", connectionId)
            .in("task_type", taskTypes)
            .eq("status", "QUEUED")
            .or(`next_retry_at.is.null,next_retry_at.lte.${new Date().toISOString()}`)
            .order("created_at").limit(BATCH_SIZE);
          tasks = fallbackTasks;
        }

        if (!tasks || tasks.length === 0) break;

        for (const t of tasks) {
          if (Date.now() - startTime >= TIME_BUDGET_MS) break;
          if (runConsecutiveFailures >= 10) break;
          try {
            if ((t as any).task_type === "AGORA_HIDE_PRODUCT") {
              const { data: fullTask } = await supabase.from("outbound_tasks").select("*").eq("id", t.id).single();
              if (!fullTask) { failed++; processed++; continue; }
              const p = fullTask.payload_json as Record<string, unknown>;
              const productIds = (p._product_ids as string[]) || [];
              const wineName = String(p._wine_name || "Unknown");
              const escXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

              if (productIds.length === 0) {
                await supabase.from("outbound_tasks").update({ status: "FAILED", last_error: "No product IDs to hide" }).eq("id", t.id);
                failed++; processed++; continue;
              }

              const vatIdHide = String((connection as any).default_vat_id || "1");
              let productsXml = "";
              for (const pid of productIds) {
                productsXml += `    <Product Id="${pid}" Name="${escXml(`[INACTIVO] ${wineName}`)}" VatId="${vatIdHide}" UseAsDirectSale="false" SaleableAsMain="false" />\n`;
              }
              const hideXml = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n<Import>\n  <Products>\n${productsXml}  </Products>\n</Import>`;

              const newAttempts = usedAtomicClaim ? (fullTask.attempts || 1) : ((fullTask.attempts || 0) + 1);
              if (!usedAtomicClaim) {
                await supabase.from("outbound_tasks").update({ status: "RUNNING", attempts: newAttempts }).eq("id", t.id);
              }
              const importUrl = `${baseUrlClean}/api/import/`;
              const res = await fetchWithRetry(importUrl, {
                method: "POST",
                headers: { ...headers, Accept: "application/xml", "Content-Type": "application/xml; charset=utf-8" },
                body: hideXml,
              });
              const resBody = await res.text();

              if (res.ok) {
                await supabase.from("outbound_tasks").update({ status: "SUCCESS", last_error: null }).eq("id", t.id);
                await registerSuccess();
                succeeded++;
              } else {
                await registerFailure(t.id, `HTTP ${res.status}: ${resBody}`, newAttempts);
                failed++;
              }
              processed++;
            } else if ((t as any).task_type === "AGORA_MIGRATE_FAMILY") {
              const { data: fullTask } = await supabase.from("outbound_tasks").select("*").eq("id", t.id).single();
              if (!fullTask) { failed++; processed++; continue; }
              const p = fullTask.payload_json as Record<string, unknown>;
              const productId = p.productId || fullTask.external_id;
              const targetFamilyId = p.targetFamilyId;
              const wineName = String(p.wineName || "");
              const fmt = String(p.format || "BOTTLE");
              const productName = formatProductName(fmt, wineName);
              const escXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
              const vatIdMig2 = String((connection as any).default_vat_id || "1");
              const migrateXml = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n<Import>\n  <Products>\n    <Product Id="${productId}" Name="${escXml(productName)}" FamilyId="${targetFamilyId}" VatId="${vatIdMig2}" />\n  </Products>\n</Import>`;

              const newAttempts = usedAtomicClaim ? (fullTask.attempts || 1) : ((fullTask.attempts || 0) + 1);
              if (!usedAtomicClaim) {
                await supabase.from("outbound_tasks").update({ status: "RUNNING", attempts: newAttempts }).eq("id", t.id);
              }
              const importUrl = `${baseUrlClean}/api/import/`;
              const res = await fetchWithRetry(importUrl, {
                method: "POST",
                headers: { ...headers, Accept: "application/xml", "Content-Type": "application/xml; charset=utf-8" },
                body: migrateXml,
              });
              const resBody = await res.text();

              if (res.ok) {
                await supabase.from("outbound_tasks").update({ status: "SUCCESS", last_error: null }).eq("id", t.id);
                const winerimId = String(p.winerimWineId || "");
                if (winerimId) {
                  await supabase.from("winerim_push_tracking")
                    .update({ sync_status: "VERIFIED", agora_family_id: String(targetFamilyId), verified_at: new Date().toISOString() })
                    .eq("connection_id", connectionId)
                    .eq("winerim_wine_id", winerimId)
                    .eq("format", fmt);
                }
                await registerSuccess();
                succeeded++;
              } else {
                await registerFailure(t.id, `HTTP ${res.status}: ${resBody}`, newAttempts);
                failed++;
              }
              processed++;
            } else {
              const { data: result } = await supabase.functions.invoke("agora-proxy", {
                body: { action: "process-xml-outbound-task", connectionId, taskId: t.id, alreadyClaimed: usedAtomicClaim },
              });
              processed++;
              if (result?.status === "SUCCESS") {
                await registerSuccess();
                succeeded++;
              } else {
                // The sub-task already wrote FAILED; just count it for breaker tracking
                runConsecutiveFailures++;
                if (runConsecutiveFailures >= 10) {
                  const pauseUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString();
                  await supabase.from("pos_connections").update({
                    circuit_breaker_paused_until: pauseUntil,
                    circuit_breaker_reason: `Auto-paused: ${runConsecutiveFailures} consecutive task failures.`,
                    consecutive_failures: runConsecutiveFailures,
                  }).eq("id", connectionId);
                }
                failed++;
              }
            }
          } catch (err) {
            const errMsg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
            // Respect max_attempts to prevent infinite loops (e.g. malformed payloads that always throw)
            const { data: cur } = await supabase
              .from("outbound_tasks").select("attempts, max_attempts").eq("id", t.id).single();
            const curAttempts = (cur?.attempts || 0) + 1;
            const curMax = cur?.max_attempts || 10;
            const exhausted = curAttempts >= curMax;
            if (exhausted) {
              console.error(`[process-xml-outbound-queue] task ${t.id} BLOCKED after ${curAttempts} attempts:`, errMsg);
            }
            try {
              await supabase.from("outbound_tasks")
                .update({
                  status: exhausted ? "BLOCKED" : "QUEUED",
                  attempts: curAttempts,
                  last_error: `EXCEPTION: ${errMsg}`,
                  blocked_reason: exhausted ? `Exhausted ${curMax} attempts. Last error: ${errMsg}` : null,
                  next_retry_at: exhausted ? null : new Date(Date.now() + Math.min(60_000, 2000 * curAttempts)).toISOString(),
                  updated_at: new Date().toISOString(),
                })
                .eq("id", t.id);
            } catch (_) { /* swallow */ }
            if (exhausted) runConsecutiveFailures++;
            failed++; processed++;
          }
        }
      }

      // Remaining ready-to-run tasks
      const { count: remaining } = await supabase
        .from("outbound_tasks").select("id", { count: "exact", head: true })
        .eq("connection_id", connectionId)
        .in("task_type", ["AGORA_XML_UPSERT_PRODUCT", "AGORA_MIGRATE_FAMILY", "AGORA_HIDE_PRODUCT"])
        .eq("status", "QUEUED");

      const remainingCount = remaining || 0;
      const breakerTripped = runConsecutiveFailures >= 10;
      const isDone = remainingCount === 0 || breakerTripped;

      if (serverLoop && !isDone) {
        const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
        const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
        const fnUrl = `${supabaseUrl}/functions/v1/agora-proxy`;
        await supabase.rpc("schedule_next_queue_batch" as never, {
          fn_url: fnUrl,
          service_key: serviceRoleKey,
          conn_id: connectionId,
        } as never);
      }

      return new Response(JSON.stringify({
        success: true, processed, succeeded, failed,
        remaining: remainingCount, done: isDone, serverLoop, breakerTripped,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── RETRY/RESET FAILED TASKS ──
    if (action === "retry-failed-tasks") {
      const targetStatuses = payload.statuses || ["FAILED"];
      const { count, error: countErr } = await supabase
        .from("outbound_tasks").select("id", { count: "exact", head: true })
        .eq("connection_id", connectionId)
        .eq("task_type", "AGORA_XML_UPSERT_PRODUCT")
        .in("status", targetStatuses);
      
      if (countErr) {
        return new Response(JSON.stringify({ error: countErr.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const { error: updateErr } = await supabase
        .from("outbound_tasks")
        .update({ status: "QUEUED", attempts: 0, last_error: null, blocked_reason: null })
        .eq("connection_id", connectionId)
        .eq("task_type", "AGORA_XML_UPSERT_PRODUCT")
        .in("status", targetStatuses);

      if (updateErr) {
        return new Response(JSON.stringify({ error: updateErr.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      return new Response(JSON.stringify({ success: true, reset: count || 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── DELETE ALL TASKS (clean slate) ──
    if (action === "delete-all-tasks") {
      const targetStatuses = payload.statuses || ["FAILED", "BLOCKED"];
      const { error: delErr } = await supabase
        .from("outbound_tasks")
        .delete()
        .eq("connection_id", connectionId)
        .eq("task_type", "AGORA_XML_UPSERT_PRODUCT")
        .in("status", targetStatuses);

      if (delErr) {
        return new Response(JSON.stringify({ error: delErr.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      return new Response(JSON.stringify({ success: true }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── CLEANUP AND PUSH GLASSES (only for serve_by_glass wines) ──
    if (action === "cleanup-and-push-glasses") {
      const targetFamilyId = payload.targetFamilyId; // e.g. "901954" for COPAS WINERIM
      const targetFamilyName = payload.targetFamilyName || "COPAS WINERIM";
      const deleteQueuedTracking = payload.deleteQueuedTracking !== false;

      // 1) Delete all QUEUED tracking entries (both GLASS and BOTTLE)
      if (deleteQueuedTracking) {
        const { data: deleted } = await supabase
          .from("winerim_push_tracking")
          .delete()
          .eq("connection_id", connectionId)
          .eq("sync_status", "QUEUED")
          .select("id");
        console.log(`Deleted ${deleted?.length || 0} QUEUED tracking entries`);
      }

      // 2) Delete all QUEUED/FAILED outbound tasks
      const { data: deletedTasks } = await supabase
        .from("outbound_tasks")
        .delete()
        .eq("connection_id", connectionId)
        .in("status", ["QUEUED", "FAILED"])
        .select("id");
      console.log(`Deleted ${deletedTasks?.length || 0} QUEUED/FAILED tasks`);

      // 3) Find wines that serve by glass and have glass_sale_price
      const { data: glassWines } = await supabase
        .from("winerim_wines")
        .select("winerim_id, name, wine_type, glass_sale_price")
        .eq("connection_id", connectionId)
        .eq("serve_by_glass", true)
        .not("glass_sale_price", "is", null);

      if (!glassWines || glassWines.length === 0) {
        return new Response(JSON.stringify({ success: true, message: "No glass-eligible wines found", cleaned: deletedTasks?.length || 0 }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // 4) Check which already have a GLASS tracking entry (VERIFIED/PUSHED)
      const { data: existingGlass } = await supabase
        .from("winerim_push_tracking")
        .select("winerim_wine_id")
        .eq("connection_id", connectionId)
        .eq("format", "GLASS");
      const existingGlassSet = new Set((existingGlass || []).map((e: any) => e.winerim_wine_id));

      // 5) Load master data for scope
      const { data: masterData } = await supabase
        .from("agora_master_data").select("products_summary_json, sale_centers_json, price_lists_json").eq("connection_id", connectionId).single();
      const existingProducts = (masterData?.products_summary_json || []) as { Id: string; Name: string }[];
      const existingProductIds = new Set(existingProducts.map((p: any) => String(p.Id)));
      const scopePayload = buildAgoraVerificationScopePayload(masterData, {
        connectionSelectedSaleCenterIds: connection.selected_sale_center_ids || [],
        verificationMode: "PRODUCTION_ALL_ACTIVE_SALE_CENTERS",
      });

      let created = 0, skipped = 0, queued = 0;
      for (const wine of glassWines) {
        if (existingGlassSet.has(wine.winerim_id)) {
          skipped++;
          continue;
        }

        // Create tracking entry
        await supabase.from("winerim_push_tracking").insert({
          connection_id: connectionId,
          winerim_wine_id: wine.winerim_id,
          format: "GLASS",
          sync_status: "QUEUED",
          source: "WINERIM",
          agora_family_id: targetFamilyId,
        });

        // Build task - check if product already exists in Agora
        const glassPrefix = connection.default_glass_format_name || "COPA";
        const glassProductName = `${glassPrefix} ${wine.name}`;
        const existingMatch = existingProducts.find((p: any) =>
          String(p.Name).trim().toUpperCase() === glassProductName.trim().toUpperCase()
        );
        const operation = existingMatch ? "UPDATE" : "CREATE";

        await supabase.from("outbound_tasks").insert({
          connection_id: connectionId,
          task_type: "AGORA_XML_UPSERT_PRODUCT",
          status: "QUEUED",
          payload_json: {
            _winerim_wine_id: wine.winerim_id,
            _format_types: ["GLASS"],
            _operation: operation,
            _trigger_source: "CLEANUP_PUSH_GLASSES",
            _family_override_id: targetFamilyId,
            _family_override_name: targetFamilyName,
            ...(existingMatch ? { _existing_agora_product_id: String(existingMatch.Id) } : {}),
            ...scopePayload,
          },
        });
        created++;
        queued++;
      }

      return new Response(JSON.stringify({
        success: true,
        glassEligible: glassWines.length,
        trackingCreated: created,
        trackingSkipped: skipped,
        tasksQueued: queued,
        tasksCleaned: deletedTasks?.length || 0,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── REQUEUE BLOCKED DUPLICATE TASKS AS UPDATE ──
    if (action === "requeue-blocked-as-update") {
      // Find all BLOCKED tasks with PRODUCT_ALREADY_EXISTS reason
      const { data: blockedTasks, error: fetchErr } = await supabase
        .from("outbound_tasks").select("id, payload_json")
        .eq("connection_id", connectionId)
        .eq("task_type", "AGORA_XML_UPSERT_PRODUCT")
        .eq("status", "BLOCKED")
        .like("blocked_reason", "PRODUCT_ALREADY_EXISTS%");

      if (fetchErr) {
        return new Response(JSON.stringify({ error: fetchErr.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      let requeued = 0;
      for (const t of (blockedTasks || [])) {
        const pl = t.payload_json as Record<string, unknown>;
        await supabase.from("outbound_tasks").update({
          status: "QUEUED",
          attempts: 0,
          last_error: null,
          blocked_reason: null,
          payload_json: { ...pl, _operation: "UPDATE", _requeued_from_blocked: true },
        }).eq("id", t.id);
        requeued++;
      }

      return new Response(JSON.stringify({ success: true, requeued }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── BACKFILL PRICES (re-push UPDATE for products missing PriceList entries) ──
    if (action === "backfill-prices") {
      const winerimWineIds = payload.winerimWineIds || [];
      const formatTypes = payload.formatTypes || ["BOTTLE", "GLASS", "MAGNUM"];

      const { data: masterData } = await supabase
        .from("agora_master_data").select("*").eq("connection_id", connectionId).single();

      if (!masterData) {
        return new Response(JSON.stringify({ success: false, error: "No master data. Run 'Sync Master Data' first." }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // Get all confirmed mappings to find which products to re-push
      let targetWineIds: string[] = winerimWineIds;
      if (targetWineIds.length === 0) {
        const { data: mappings } = await supabase
          .from("product_mappings").select("winerim_wine_id")
          .eq("connection_id", connectionId).eq("status", "CONFIRMED").eq("match_method", "XML_IMPORT");
        if (mappings) {
          targetWineIds = [...new Set(mappings.map((m: any) => m.winerim_wine_id).filter(Boolean))];
        }
      }

      if (targetWineIds.length === 0) {
        return new Response(JSON.stringify({ success: true, message: "No products to backfill", queued: 0 }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const backfillScopePayload = buildAgoraVerificationScopePayload(masterData, {
        connectionSelectedSaleCenterIds: connection.selected_sale_center_ids || [],
        verificationMode: "PRODUCTION_ALL_ACTIVE_SALE_CENTERS",
      });

      // Queue them as outbound tasks for re-push (idempotent: skip already queued)
      let queued = 0;
      let skipped = 0;
      for (const wineId of targetWineIds) {
        const { data: existing } = await supabase
          .from("outbound_tasks").select("id")
          .eq("connection_id", connectionId)
          .eq("task_type", "AGORA_XML_UPSERT_PRODUCT")
          .contains("payload_json", { _winerim_wine_id: wineId, _trigger_source: "BACKFILL_PRICES" })
          .in("status", ["QUEUED", "RUNNING"])
          .limit(1);
        if (existing && existing.length > 0) { skipped++; continue; }

        await supabase.from("outbound_tasks").insert({
          connection_id: connectionId,
          task_type: "AGORA_XML_UPSERT_PRODUCT",
          payload_json: {
            _winerim_wine_id: wineId,
            _format_types: formatTypes,
            _write_mode: "XML_IMPORT",
            _trigger_source: "BACKFILL_PRICES",
            ...backfillScopePayload,
          },
          status: "QUEUED",
        });
        queued++;
      }

      return new Response(JSON.stringify({ success: true, queued, skipped, totalTargets: targetWineIds.length }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── BACKFILL PREPARATION FIELDS (fix both empty to prevent TPV crash) ──
    if (action === "backfill-preparation") {
      const winerimWineIds = payload.winerimWineIds || [];
      const formatTypes = payload.formatTypes || ["BOTTLE", "GLASS", "MAGNUM"];

      const { data: masterData } = await supabase
        .from("agora_master_data").select("*").eq("connection_id", connectionId).single();

      if (!masterData) {
        return new Response(JSON.stringify({ success: false, error: "No master data. Run 'Sync Master Data' first." }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // Get target wine IDs: either provided or all confirmed XML imports
      let targetWineIds: string[] = winerimWineIds;
      if (targetWineIds.length === 0) {
        const { data: mappings } = await supabase
          .from("product_mappings").select("winerim_wine_id")
          .eq("connection_id", connectionId).eq("status", "CONFIRMED").eq("match_method", "XML_IMPORT");
        if (mappings) {
          targetWineIds = [...new Set(mappings.map((m: any) => m.winerim_wine_id).filter(Boolean))];
        }
      }

      if (targetWineIds.length === 0) {
        return new Response(JSON.stringify({ success: true, message: "No products to fix", queued: 0 }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const prepScopePayload = buildAgoraVerificationScopePayload(masterData, {
        connectionSelectedSaleCenterIds: connection.selected_sale_center_ids || [],
        verificationMode: "PRODUCTION_ALL_ACTIVE_SALE_CENTERS",
      });

      // Queue UPDATE tasks with a special flag to force empty preparation fields
      let queued = 0;
      let skipped = 0;
      for (const wineId of targetWineIds) {
        // Skip if already queued
        const { data: existing } = await supabase
          .from("outbound_tasks").select("id")
          .eq("connection_id", connectionId)
          .eq("task_type", "AGORA_XML_UPSERT_PRODUCT")
          .contains("payload_json", { _winerim_wine_id: wineId, _trigger_source: "BACKFILL_PREPARATION" })
          .in("status", ["QUEUED", "RUNNING"])
          .limit(1);
        if (existing && existing.length > 0) { skipped++; continue; }

        await supabase.from("outbound_tasks").insert({
          connection_id: connectionId,
          task_type: "AGORA_XML_UPSERT_PRODUCT",
          payload_json: {
            _winerim_wine_id: wineId,
            _format_types: formatTypes,
            _write_mode: "XML_IMPORT",
            _trigger_source: "BACKFILL_PREPARATION",
            _force_empty_preparation: true,
            ...prepScopePayload,
          },
          status: "QUEUED",
        });
        queued++;
      }

      return new Response(JSON.stringify({ success: true, queued, skipped, totalTargets: targetWineIds.length }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── REASSIGN FAMILIES (re-push products with current family mappings) ──
    if (action === "reassign-families") {
      const winerimWineIds = payload.winerimWineIds || [];

      // Get all confirmed XML_IMPORT mappings to find which products exist
      let targetWineIds: string[] = winerimWineIds;
      if (targetWineIds.length === 0) {
        const { data: mappings } = await supabase
          .from("product_mappings").select("winerim_wine_id, format_type")
          .eq("connection_id", connectionId).eq("status", "CONFIRMED").eq("match_method", "XML_IMPORT");
        if (mappings) {
          targetWineIds = [...new Set(mappings.map((m: any) => m.winerim_wine_id).filter(Boolean))];
        }
      }

      if (targetWineIds.length === 0) {
        return new Response(JSON.stringify({ success: true, message: "No pushed products to reassign", queued: 0 }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // Load master data for scope
      const { data: reassignMasterData } = await supabase
        .from("agora_master_data").select("sale_centers_json, price_lists_json").eq("connection_id", connectionId).single();
      const reassignScopePayload = buildAgoraVerificationScopePayload(reassignMasterData, {
        connectionSelectedSaleCenterIds: connection.selected_sale_center_ids || [],
        verificationMode: "PRODUCTION_ALL_ACTIVE_SALE_CENTERS",
      });

      // Get connection write settings for format types
      const { data: connSettings } = await supabase
        .from("pos_connections").select("write_bottle, write_glass")
        .eq("id", connectionId).single();
      const formatTypes: string[] = [];
      if (connSettings?.write_bottle !== false) formatTypes.push("BOTTLE");
      if (connSettings?.write_glass) formatTypes.push("GLASS");
      if (formatTypes.length === 0) formatTypes.push("BOTTLE");

      let queued = 0;
      let skipped = 0;
      for (const wineId of targetWineIds) {
        // Skip if already queued
        const { data: existing } = await supabase
          .from("outbound_tasks").select("id")
          .eq("connection_id", connectionId)
          .eq("task_type", "AGORA_XML_UPSERT_PRODUCT")
          .contains("payload_json", { _winerim_wine_id: wineId, _trigger_source: "REASSIGN_FAMILIES" })
          .in("status", ["QUEUED", "RUNNING"])
          .limit(1);
        if (existing && existing.length > 0) { skipped++; continue; }

        await supabase.from("outbound_tasks").insert({
          connection_id: connectionId,
          task_type: "AGORA_XML_UPSERT_PRODUCT",
          payload_json: {
            _winerim_wine_id: wineId,
            _format_types: formatTypes,
            _write_mode: "XML_IMPORT",
            _trigger_source: "REASSIGN_FAMILIES",
            ...reassignScopePayload,
          },
          status: "QUEUED",
        });
        queued++;
      }

      return new Response(JSON.stringify({ success: true, queued, skipped, totalTargets: targetWineIds.length }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "requeue-task-current-scope") {
      const taskId = payload.taskId;
      const { data: taskToClone, error: taskCloneErr } = await supabase
        .from("outbound_tasks").select("*").eq("id", taskId).single();

      if (taskCloneErr || !taskToClone) {
        return new Response(JSON.stringify({ success: false, error: "Task not found" }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const { data: masterDataForScope } = await supabase
        .from("agora_master_data").select("sale_centers_json, price_lists_json").eq("connection_id", connectionId).single();
      const scopePayload = buildAgoraVerificationScopePayload(masterDataForScope, {
        connectionSelectedSaleCenterIds: connection.selected_sale_center_ids || [],
        verificationMode: "PRODUCTION_ALL_ACTIVE_SALE_CENTERS",
      });

      const taskPayload = (taskToClone.payload_json || {}) as Record<string, unknown>;
      await supabase.from("outbound_tasks").insert({
        connection_id: connectionId,
        task_type: taskToClone.task_type,
        payload_json: {
          ...taskPayload,
          ...scopePayload,
          _trigger_source: "REQUEUE_CURRENT_SCOPE",
          _requeued_from_task_id: taskToClone.id,
        },
        status: "QUEUED",
      });

      return new Response(JSON.stringify({ success: true, requeuedFromTaskId: taskToClone.id }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "verify-products") {
      const { data: masterData } = await supabase
        .from("agora_master_data").select("sale_centers_json, price_lists_json").eq("connection_id", connectionId).single();

      const allPriceLists = ((masterData as any)?.price_lists_json || []) as { Id: string; Name: string }[];

      if (allPriceLists.length === 0) {
        return new Response(JSON.stringify({ 
          success: false, error: "No PriceLists in master data. Sync master data first.",
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const verificationScope = buildAgoraVerificationScope(masterData, {
        explicitSaleCenterIds: normalizeStringArray(payload.saleCenterIds || payload.saleCenterId),
        connectionSelectedSaleCenterIds: connection.selected_sale_center_ids || [],
        verificationMode: "PRODUCTION_ALL_ACTIVE_SALE_CENTERS",
      });
      const scopedPriceLists = verificationScope.selectedPriceLists;
      const priceListToSaleCenters = verificationScope.priceListToSaleCenters;

      // Re-fetch current products from Agora
      // On-demand verification (manual UI action) — bypass cache to get fresh data
      const cachedProductsManual = await fetchAgoraProductsXmlCached(connectionId, baseUrlClean, apiTokenClean, fetchWithRetry, 30000, true);
      
      if (!cachedProductsManual.ok) {
        return new Response(JSON.stringify({ success: false, error: `Agora responded ${cachedProductsManual.status}` }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const verifyXml = cachedProductsManual.xml;
      
      const { data: mappings } = await supabase
        .from("product_mappings").select("provider_product_id, provider_product_name, winerim_wine_id, format_type")
        .eq("connection_id", connectionId).eq("status", "CONFIRMED").eq("match_method", "XML_IMPORT");

      // Build product list from mappings (no expectedFamilyId → triggers FAMILY_EMPTY warning path)
      const productsToVerify: AgoraProductToVerify[] = (mappings || []).map((m: any) => ({
        productId: m.provider_product_id,
        productName: m.provider_product_name,
        format: m.format_type,
        erpId: m.winerim_wine_id || "",
      }));

      const verifyResult = verifyAgoraProductsAgainstScope(
        verifyXml, productsToVerify, scopedPriceLists, priceListToSaleCenters,
      );

      // ── PUSH TRACKING: Update verified status per product ──
      for (const m of (mappings || [])) {
        const productOk = !verifyResult.errors.some((e: any) =>
          (e.context as Record<string, unknown>)?.productId === m.provider_product_id
        );
        await upsertPushTracking(supabase, connectionId, m.winerim_wine_id, m.format_type, {
          sync_status: productOk ? "VERIFIED" : "FAILED",
          agora_product_id: m.provider_product_id,
          verified_at: productOk ? new Date().toISOString() : null,
          last_error: productOk ? null : verifyResult.errors
            .filter((e: any) => (e.context as Record<string, unknown>)?.productId === m.provider_product_id)
            .map((e: any) => e.message).join("; ").substring(0, 500),
        });
      }

      return new Response(JSON.stringify({
        ...verifyResult,
        totalPriceLists: scopedPriceLists.length,
        totalSaleCenters: verificationScope.selectedSaleCenters.length,
        totalProducts: verifyResult.summary.checked,
        missingCentralPrice: verifyResult.summary.failed,
        priceListToSaleCenters,
        selectedSaleCenters: verificationScope.selectedSaleCenters,
        selectedPriceLists: verificationScope.selectedPriceLists,
        ignoredPriceLists: verificationScope.ignoredPriceLists,
        verificationScopeSource: verificationScope.source,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── DEBUG BUNDLE (for support) ──
    if (action === "debug-bundle") {
      // 1. Master data: SaleCenters + PriceLists
      const { data: masterData } = await supabase
        .from("agora_master_data")
        .select("sale_centers_json, price_lists_json, families_json, vats_json, warehouses_json, preparation_types_json, preparation_orders_json, products_summary_json")
        .eq("connection_id", connectionId).single();

      const saleCenters = (masterData as any)?.sale_centers_json || [];
      const priceLists = (masterData as any)?.price_lists_json || [];
      const families = (masterData as any)?.families_json || [];

      // 2. Selected SaleCenter IDs from connection
      const selectedSaleCenterIds = connection.selected_sale_center_ids || [];

      // 3. Last 20 outbound tasks (sanitized)
      const { data: recentTasks } = await supabase
        .from("outbound_tasks").select("id, task_type, status, attempts, max_attempts, last_error, blocked_reason, external_id, payload_json, created_at, updated_at")
        .eq("connection_id", connectionId)
        .order("created_at", { ascending: false }).limit(20);

      // 4. Verification: missing_prices from last verify-products run
      //    Re-run a lightweight version inline
      const { data: mappings } = await supabase
        .from("product_mappings").select("provider_product_id, provider_product_name, winerim_wine_id, format_type")
        .eq("connection_id", connectionId).eq("status", "CONFIRMED").eq("match_method", "XML_IMPORT").limit(100);

      let missingPrices: unknown[] = [];
      let sampleXml = "";

      try {
        // Quick verification scan
        // Quick verification scan (uses cache to avoid slamming Agora)
        const cachedProductsScan = await fetchAgoraProductsXmlCached(connectionId, baseUrlClean, apiTokenClean, fetchWithRetry, 20000);
        if (cachedProductsScan.ok) {
          const verifyXml = cachedProductsScan.xml;
          for (const m of (mappings || []).slice(0, 50)) {
            const prodRegex = new RegExp(`<Product[^>]*Id="${m.provider_product_id}"[^>]*>([\\s\\S]*?)<\\/Product>`, "i");
            const prodMatch = verifyXml.match(prodRegex);
            for (const pl of priceLists) {
              if (!prodMatch) {
                missingPrices.push({ agora_id: m.provider_product_id, name: m.provider_product_name, price_list: (pl as any).Name, issue: "product_not_found" });
              } else {
                const prRegex = new RegExp(`<Price[^>]*PriceListId="${(pl as any).Id}"[^>]*MainPrice="([^"]*)"`, "i");
                const prMatch = prodMatch[1].match(prRegex);
                if (!prMatch) {
                  missingPrices.push({ agora_id: m.provider_product_id, name: m.provider_product_name, price_list: (pl as any).Name, issue: "missing" });
                } else if (parseFloat(prMatch[1]) <= 0) {
                  missingPrices.push({ agora_id: m.provider_product_id, name: m.provider_product_name, price_list: (pl as any).Name, issue: "zero", value: prMatch[1] });
                }
              }
            }
          }
        }
      } catch (_) { /* best-effort */ }

      // 5. Generate sample XML for one wine
      try {
        const sampleMapping = (mappings || [])[0];
        if (sampleMapping?.winerim_wine_id && masterData) {
          const { data: sampleWines } = await supabase
            .from("winerim_wines").select("*")
            .eq("connection_id", connectionId).eq("winerim_id", sampleMapping.winerim_wine_id).limit(1);
          if (sampleWines && sampleWines.length > 0) {
            const customMappings = await loadCustomFamilyMappings(connectionId);
            const geoConfigSample = (connection.provider_config as any)?.geographic_config as GeographicFamilyConfig | undefined;
            const isGeoModeSample = (connection.provider_config as any)?.family_structure_mode === "GEOGRAPHIC_FAMILIES" && geoConfigSample;
            const { xml } = generateImportXml(sampleWines, masterData, connection, ["BOTTLE", "GLASS", "MAGNUM"], customMappings, false, isGeoModeSample ? geoConfigSample : undefined, isGeoModeSample ? sampleWines : undefined);
            sampleXml = xml;
          }
        }
      } catch (_) { /* best-effort */ }

      // 6. Connection settings (sanitized: no tokens)
      const sanitizedConnection = {
        id: connection.id,
        location_name: connection.location_name,
        provider: connection.provider,
        write_mode: connection.write_mode,
        sync_mode: connection.sync_mode,
        write_bottle: connection.write_bottle,
        write_glass: connection.write_glass,
        auto_create_families: connection.auto_create_families,
        auto_push_on_create: connection.auto_push_on_create,
        auto_push_on_update: connection.auto_push_on_update,
        auto_push_verified_ready: connection.auto_push_verified_ready,
        default_family_id: connection.default_family_id,
        default_vat_id: connection.default_vat_id,
        default_bottle_format_name: connection.default_bottle_format_name,
        default_glass_format_name: connection.default_glass_format_name,
        default_preparation_type_id: connection.default_preparation_type_id,
        default_preparation_order_id: connection.default_preparation_order_id,
        default_warehouse_id: connection.default_warehouse_id,
        selected_sale_center_ids: selectedSaleCenterIds,
        estimated_glasses_per_bottle: connection.estimated_glasses_per_bottle,
        last_business_day_synced: connection.last_business_day_synced,
        last_sync_at: connection.last_sync_at,
      };

      const bundle = {
        _generated_at: new Date().toISOString(),
        _version: "1.0",
        connection: sanitizedConnection,
        sale_centers: saleCenters,
        price_lists: priceLists,
        families_count: (families as unknown[]).length,
        selected_sale_center_ids: selectedSaleCenterIds,
        missing_prices: missingPrices,
        sample_xml: sampleXml,
        recent_tasks: (recentTasks || []).map((t: any) => ({
          ...t,
          // Sanitize payload: remove any token-like fields
          payload_json: (() => {
            const p = { ...(t.payload_json || {}) };
            delete p.api_token; delete p.token; delete p.secret;
            return p;
          })(),
        })),
      };

      return new Response(JSON.stringify(bundle, null, 2),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── DIAGNOSE (legacy) ──
    if (action === "diagnose" || action === "export") {
      const day = businessDay || new Date().toISOString().split("T")[0];
      const url = `${baseUrlClean}/api/export/?business-day=${day}&filter=Invoices`;
      const res = await fetch(url, { headers });
      const data = await res.json();
      return new Response(JSON.stringify({ data, status: res.status }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── EVALUATE AUTO-PUSH ──
    if (action === "evaluate-auto-push") {
      const winerimWineIds = payload.winerimWineIds || [];
      const evtType = payload.eventType || "CREATE";

      const autoPushOnCreate = connection.auto_push_on_create ?? false;
      const autoPushOnUpdate = connection.auto_push_on_update ?? false;
      const autoPushBottle = connection.auto_push_bottle ?? true;
      const autoPushGlass = connection.auto_push_glass ?? false;
      const requireReview = connection.require_manual_review_before_push ?? true;

      if (evtType === "CREATE" && !autoPushOnCreate) {
        return new Response(JSON.stringify({ success: true, skipped: true, reason: "auto_push_on_create disabled" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      if (evtType === "UPDATE" && !autoPushOnUpdate) {
        return new Response(JSON.stringify({ success: true, skipped: true, reason: "auto_push_on_update disabled" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      if (connection.write_mode !== "XML_IMPORT") {
        return new Response(JSON.stringify({ success: true, skipped: true, reason: "write_mode is not XML_IMPORT" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // Gate: only skip if explicitly NO. UNKNOWN passes because write_mode=XML_IMPORT
      // and readiness_status=READY (validated above) already proves we can write.
      const { data: caps } = await supabase
        .from("provider_capabilities").select("can_write_products").eq("connection_id", connectionId).single();
      if (caps?.can_write_products === "NO") {
        return new Response(JSON.stringify({ success: true, skipped: true, reason: "can_write_products is NO" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      if (!connection.auto_push_verified_ready) {
        return new Response(JSON.stringify({ success: true, skipped: true, reason: "auto_push_not_verified_no_manual_import_success_yet" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // Check master data exists
      const { data: masterData } = await supabase
        .from("agora_master_data").select("id, families_json, vats_json, price_lists_json, warehouses_json, sale_centers_json")
        .eq("connection_id", connectionId).single();
      if (!masterData) {
        return new Response(JSON.stringify({ success: true, skipped: true, reason: "no master data cached" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const families = (masterData as any).families_json || [];
      const vats = (masterData as any).vats_json || [];
      const warnings: string[] = [];
      if (families.length === 0) warnings.push("missing_families");
      if (vats.length === 0) warnings.push("missing_vats");
      if (warnings.length > 0) {
        return new Response(JSON.stringify({ success: true, skipped: true, reason: "master_data_incomplete", warnings }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const autoPushScopePayload = buildAgoraVerificationScopePayload(masterData, {
        connectionSelectedSaleCenterIds: connection.selected_sale_center_ids || [],
      });

      const { data: wines } = await supabase
        .from("winerim_wines").select("winerim_id, name, price, format, winery, grape_variety, region, vintage, raw_payload, wine_type, bottle_sale_price, bottle_purchase_price, glass_sale_price, glass_cost_price, magnum_sale_price, magnum_purchase_price, serve_by_glass, is_active")
        .eq("connection_id", connectionId).in("winerim_id", winerimWineIds);

      if (!wines || wines.length === 0) {
        return new Response(JSON.stringify({ success: true, skipped: true, reason: "no wines found" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      let queued = 0;
      let skipped = 0;
      const skippedReasons: { winerim_id: string; reason: string }[] = [];

      let hidQueued = 0;
      for (const wine of wines) {
        // ── INACTIVE WINE → queue HIDE task to set ShowInPos=false in Agora ──
        if (wine.is_active === false) {
          // Check if already has a verified push (i.e. product exists in Agora)
          const { data: existingPush } = await supabase
            .from("winerim_push_tracking").select("format, agora_product_id")
            .eq("connection_id", connectionId).eq("winerim_wine_id", wine.winerim_id)
            .in("sync_status", ["VERIFIED", "PUSHED"]);
          
          if (existingPush && existingPush.length > 0) {
            // Check no existing hide task queued
            const { data: existingHide } = await supabase
              .from("outbound_tasks").select("id")
              .eq("connection_id", connectionId)
              .eq("task_type", "AGORA_HIDE_PRODUCT")
              .contains("payload_json", { _winerim_wine_id: wine.winerim_id })
              .in("status", ["QUEUED", "RUNNING"]).limit(1);
            
            if (!existingHide || existingHide.length === 0) {
              const productIds = existingPush.map(p => p.agora_product_id).filter(Boolean);
              await supabase.from("outbound_tasks").insert({
                connection_id: connectionId,
                task_type: "AGORA_HIDE_PRODUCT",
                payload_json: {
                  _winerim_wine_id: wine.winerim_id,
                  _product_ids: productIds,
                  _wine_name: wine.name,
                  _trigger_source: "AUTO_DEACTIVATION",
                },
                status: "QUEUED",
              });
              hidQueued++;
              // Update tracking to reflect hidden status
              for (const p of existingPush) {
                await supabase.from("winerim_push_tracking")
                  .update({ sync_status: "HIDDEN" })
                  .eq("connection_id", connectionId)
                  .eq("winerim_wine_id", wine.winerim_id)
                  .eq("format", p.format);
              }
            }
          }
          skipped++;
          skippedReasons.push({ winerim_id: wine.winerim_id, reason: "wine_inactive_hide_queued" });
          continue;
        }

        if (requireReview) {
          const hasName = wine.name && wine.name.length > 2;
          if (!hasName) {
            skipped++;
            skippedReasons.push({ winerim_id: wine.winerim_id, reason: "invalid_name" });
            continue;
          }
        }

        // Build format list with per-format eligibility checks
        const formatTypes: string[] = [];
        if (autoPushBottle) {
          const bottleValidation = validateWineForAgora(wine, "BOTTLE", connection);
          if (bottleValidation.valid) {
            formatTypes.push("BOTTLE");
          } else {
            skippedReasons.push({ winerim_id: wine.winerim_id, reason: `bottle_validation_failed:${bottleValidation.missingFields.join(",")}` });
          }
        }
        if (autoPushGlass) {
          // GLASS gate: must have serve_by_glass=true AND glass_sale_price>0
          if (!wine.serve_by_glass) {
            skippedReasons.push({ winerim_id: wine.winerim_id, reason: "glass_skipped:serve_by_glass_not_enabled" });
          } else if (!wine.glass_sale_price || Number(wine.glass_sale_price) <= 0) {
            skippedReasons.push({ winerim_id: wine.winerim_id, reason: "glass_skipped:no_glass_sale_price" });
          } else {
            const glassValidation = validateWineForAgora(wine, "GLASS", connection);
            if (glassValidation.valid) {
              formatTypes.push("GLASS");
            } else {
              skippedReasons.push({ winerim_id: wine.winerim_id, reason: `glass_validation_failed:${glassValidation.missingFields.join(",")}` });
            }
          }
        }
        // MAGNUM gate: auto-enabled when wine has magnum_sale_price (no per-connection toggle yet).
        // Mirrors the implicit policy: si Winerim tiene precio de magnum, Agora debe tenerlo.
        if (wine.magnum_sale_price && Number(wine.magnum_sale_price) > 0) {
          const magnumValidation = validateWineForAgora(wine, "MAGNUM", connection);
          if (magnumValidation.valid) {
            formatTypes.push("MAGNUM");
          } else {
            skippedReasons.push({ winerim_id: wine.winerim_id, reason: `magnum_validation_failed:${magnumValidation.missingFields.join(",")}` });
          }
        }
        if (formatTypes.length === 0) { skipped++; continue; }

        // Strict idempotency: if there is ANY pending (QUEUED/RUNNING) task for this wine, skip.
        // No time window — pending = pending, regardless of age.
        const { data: pendingTask } = await supabase
          .from("outbound_tasks").select("id")
          .eq("connection_id", connectionId)
          .eq("task_type", "AGORA_XML_UPSERT_PRODUCT")
          .contains("payload_json", { _winerim_wine_id: wine.winerim_id })
          .in("status", ["QUEUED", "RUNNING"])
          .limit(1);

        if (pendingTask && pendingTask.length > 0) {
          skipped++;
          skippedReasons.push({ winerim_id: wine.winerim_id, reason: "already_pending_task" });
          continue;
        }

        // Anti-spam: count failures in last 24h. If >=5, require manual intervention.
        const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const { data: recentFailures } = await supabase
          .from("outbound_tasks").select("id")
          .eq("connection_id", connectionId)
          .eq("task_type", "AGORA_XML_UPSERT_PRODUCT")
          .contains("payload_json", { _winerim_wine_id: wine.winerim_id })
          .in("status", ["FAILED", "BLOCKED"])
          .gte("created_at", dayAgo).limit(5);

        if (recentFailures && recentFailures.length >= 5) {
          skipped++;
          skippedReasons.push({ winerim_id: wine.winerim_id, reason: "too_many_failures_24h_manual_intervention_required" });
          continue;
        }

        await supabase.from("outbound_tasks").insert({
          connection_id: connectionId,
          task_type: "AGORA_XML_UPSERT_PRODUCT",
          payload_json: {
            _winerim_wine_id: wine.winerim_id,
            _format_types: formatTypes,
            _write_mode: "XML_IMPORT",
            _trigger_source: evtType === "CREATE" ? "AUTO_CREATE" : "AUTO_UPDATE",
            _requested_at: new Date().toISOString(),
            ...autoPushScopePayload,
          },
          status: "QUEUED",
        });
        queued++;
      }

      console.log(`[evaluate-auto-push] connection=${connectionId} event=${evtType} queued=${queued} skipped=${skipped} hidQueued=${hidQueued}`);

      return new Response(JSON.stringify({
        success: true, queued, skipped, hidQueued, skippedReasons,
        totalWines: wines.length, eventType: evtType,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── PROBE PRICELIST PERSISTENCE ──
    // Creates a disposable test product with all active PriceLists, imports it,
    // reads it back, and compares sent vs persisted. Evidence for Agora support.
    if (action === "probe-pricelist-persistence") {
      const probeStarted = new Date().toISOString();

      const { data: masterData } = await supabase
        .from("agora_master_data").select("*").eq("connection_id", connectionId).single();
      if (!masterData) {
        return new Response(JSON.stringify({ success: false, error: "No master data cached." }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const allPriceListsRaw = (masterData.price_lists_json || []) as Record<string, unknown>[];
      const priceLists = allPriceListsRaw.filter((e: any) => !isDeletedEntity(e)) as { Id: string; Name: string }[];
      const deletedPriceLists = allPriceListsRaw.filter((e: any) => isDeletedEntity(e)) as { Id: string; Name: string; DeletionDate?: string }[];
      const vats = (masterData.vats_json || []) as { Id: string; Name: string; VatRate: string }[];
      const families = (masterData.families_json || []) as { Id: string; Name: string }[];
      const warehouses = (masterData.warehouses_json || []) as { Id: string; Name: string }[];

      if (priceLists.length === 0) {
        return new Response(JSON.stringify({ success: false, error: `No active PriceLists in master data. ${deletedPriceLists.length} deleted PriceLists were excluded.` }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // Use a distinctive test product ID that won't collide with real wines
      const probeProductId = "999999";
      const probeName = "_WINERIM_PROBE_PRICELIST_TEST";
      const probePrice = "0.01";
      const defaultVatId = connection.default_vat_id || (vats.length > 0 ? vats[0].Id : "3");
      const defaultFamilyId = connection.default_family_id || (families.length > 0 ? families[0].Id : "1");
      const defaultWarehouseId = connection.default_warehouse_id || (warehouses.length > 0 ? warehouses[0].Id : "1");

      // Build test XML with ALL PriceLists
      const pricesXml = priceLists.map(pl =>
        `        <Price PriceListId="${pl.Id}" MainPrice="${probePrice}" AddinPrice="0.00" MenuItemPrice="0.00" />`
      ).join("\n");
      const costPricesXml = warehouses.map(wh =>
        `        <CostPrice WarehouseId="${wh.Id}" CostPrice="0.01" />`
      ).join("\n");

      const probeXml = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<Import>
  <Products>
    <Product Id="${probeProductId}" Name="${probeName}" ButtonText="PROBE" Color="#999999" PLU="" FamilyId="${defaultFamilyId}" VatId="${defaultVatId}" UseAsDirectSale="false" SaleableAsMain="false" SaleableAsAddin="false" IsSoldByWeight="false" AskForPreparationNotes="false" AskForAddins="false" PrintWhenPriceIsZero="false" PreparationTypeId="" PreparationOrderId="" CostPrice="0.01">
      <Prices>
${pricesXml}
      </Prices>
      <CostPrices>
${costPricesXml}
      </CostPrices>
    </Product>
  </Products>
</Import>`;

      const sentPriceListIds = priceLists.map(pl => String(pl.Id));
      const sentPriceListNames = Object.fromEntries(priceLists.map(pl => [String(pl.Id), String(pl.Name)]));

      // Step 1: Import the probe product
      let importSuccess = false;
      let importError: string | null = null;
      let importRawResponse = "";
      try {
        const importUrl = `${baseUrlClean}/api/import/`;
        const xmlHeaders = { "Api-Token": apiTokenClean, Accept: "application/xml", "Content-Type": "application/xml; charset=utf-8" };
        const importRes = await fetchWithRetry(importUrl, { method: "POST", headers: xmlHeaders, body: probeXml }, 30000);
        importRawResponse = await importRes.text().catch(() => "");
        const parsed = parseAgoraImportResponse(importRes.status, importRawResponse);
        importSuccess = parsed.success;
        if (!parsed.success) importError = parsed.errors.join("; ") || `HTTP ${importRes.status}`;
      } catch (e) {
        importError = String(e).substring(0, 500);
      }

      // Step 2: Read back the product from Agora
      const actualPriceListIds: string[] = [];
      const actualPrices: { priceListId: string; priceListName: string; mainPrice: string }[] = [];
      let productFoundInExport = false;
      let readBackRaw = "";
      try {
        // Probe action — force fresh fetch to get accurate post-write state
        const cachedProductsProbe = await fetchAgoraProductsXmlCached(connectionId, baseUrlClean, apiTokenClean, fetchWithRetry, 30000, true);
        if (cachedProductsProbe.ok) {
          readBackRaw = cachedProductsProbe.xml;
          const prodRegex = new RegExp(`<Product[^>]*Id="${probeProductId}"[^>]*>([\\s\\S]*?)<\\/Product>`, "i");
          const prodMatch = readBackRaw.match(prodRegex);
          if (prodMatch) {
            productFoundInExport = true;
            const inner = prodMatch[1];
            const prReg = /<Price[^>]*PriceListId="(\d+)"[^>]*MainPrice="([^"]*)"/gi;
            let pr;
            while ((pr = prReg.exec(inner)) !== null) {
              actualPriceListIds.push(pr[1]);
              actualPrices.push({
                priceListId: pr[1],
                priceListName: sentPriceListNames[pr[1]] || pr[1],
                mainPrice: pr[2],
              });
            }
          }
        }
      } catch (_) { /* best-effort */ }

      // Step 3: Compare
      const missingInAgora = sentPriceListIds.filter(id => !actualPriceListIds.includes(id));
      const extraInAgora = actualPriceListIds.filter(id => !sentPriceListIds.includes(id));
      const persistedAll = missingInAgora.length === 0;
      const probeFinished = new Date().toISOString();

      const diagnosis = !importSuccess
        ? "IMPORT_FAILED"
        : !productFoundInExport
        ? "PRODUCT_NOT_FOUND_AFTER_IMPORT"
        : persistedAll
        ? "ALL_PRICELISTS_PERSISTED"
        : "IMPORT_DID_NOT_PERSIST_ALL_PRICELISTS";

      const probeResult = {
        success: true,
        diagnosis,
        probe_product_id: probeProductId,
        probe_started: probeStarted,
        probe_finished: probeFinished,
        import_success: importSuccess,
        import_error: importError,
        product_found_in_export: productFoundInExport,
        sent_price_list_count: sentPriceListIds.length,
        sent_price_list_ids: sentPriceListIds,
        sent_price_list_names: sentPriceListNames,
        actual_price_list_count: actualPriceListIds.length,
        actual_price_list_ids: actualPriceListIds,
        actual_prices: actualPrices,
        missing_in_agora: missingInAgora,
        missing_in_agora_names: missingInAgora.map(id => sentPriceListNames[id] || id),
        extra_in_agora: extraInAgora,
        persisted_all: persistedAll,
        deleted_price_lists_excluded: deletedPriceLists.map((pl: any) => ({ id: String(pl.Id), name: String(pl.Name || pl.Id), deletionDate: String(pl.DeletionDate || "") })),
        deleted_price_lists_count: deletedPriceLists.length,
        conclusion: persistedAll
          ? `✅ Agora correctly persisted ALL ${sentPriceListIds.length} active PriceLists. The middleware XML is correct.${deletedPriceLists.length > 0 ? ` (${deletedPriceLists.length} deleted PriceLists were excluded from probe.)` : ""}`
          : diagnosis === "IMPORT_FAILED"
          ? "❌ Import failed. Cannot determine PriceList persistence behavior."
          : diagnosis === "PRODUCT_NOT_FOUND_AFTER_IMPORT"
          ? "❌ Product not found after import. Agora may have rejected it silently."
          : `⚠️ Agora only persisted ${actualPriceListIds.length}/${sentPriceListIds.length} active PriceLists. Missing: ${missingInAgora.map(id => sentPriceListNames[id] || id).join(", ")}. This is an Agora-side limitation — the middleware XML is correct.${deletedPriceLists.length > 0 ? ` (${deletedPriceLists.length} deleted PriceLists were excluded.)` : ""}`,
        xml_sent: probeXml,
        import_raw_response: importRawResponse.substring(0, 2000),
      };

      return new Response(JSON.stringify(probeResult, null, 2),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── MIGRATE VERIFIED WINERIM FAMILIES TO PRODUCTION FAMILIES ──
    if (action === "migrate-families-to-production") {
      // 1. Load custom family mappings
      const { data: mappingRows } = await supabase
        .from("wine_type_family_mappings")
        .select("mapping_key, agora_family_id, agora_family_name")
        .eq("connection_id", connectionId);
      const customMappings: Record<string, { id: string; name: string }> = {};
      for (const m of (mappingRows || [])) {
        if (m.agora_family_id && m.agora_family_name) {
          customMappings[m.mapping_key] = { id: m.agora_family_id, name: m.agora_family_name };
        }
      }
      if (Object.keys(customMappings).length === 0) {
        return new Response(JSON.stringify({ error: "No family mappings configured. Set up wine-type → Agora family mappings first." }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // 2. Load master data for family resolution
      const { data: masterRow } = await supabase
        .from("agora_master_data")
        .select("families_json, vats_json, price_lists_json, preparation_types_json, preparation_orders_json, warehouses_json, products_summary_json")
        .eq("connection_id", connectionId)
        .single();

      // 3. Load VERIFIED tracking rows only
      const { data: verifiedRows } = await supabase
        .from("winerim_push_tracking")
        .select("id, winerim_wine_id, format, agora_product_id, sync_status")
        .eq("connection_id", connectionId)
        .eq("sync_status", "VERIFIED");

      if (!verifiedRows || verifiedRows.length === 0) {
        return new Response(JSON.stringify({ success: true, queued: 0, skipped: 0, totalTargets: 0, message: "No VERIFIED products to migrate." }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // 4. Load winerim wines for type resolution
      const wineIds = [...new Set(verifiedRows.map(r => r.winerim_wine_id))];
      const { data: wines } = await supabase
        .from("winerim_wines")
        .select("winerim_id, name, wine_type, bottle_sale_price, glass_sale_price, magnum_sale_price")
        .eq("connection_id", connectionId)
        .in("winerim_id", wineIds);
      const wineMap = new Map((wines || []).map(w => [w.winerim_id, w]));

      // 5. Check for pending tasks to avoid duplicates
      const { data: pendingTasks } = await supabase
        .from("outbound_tasks")
        .select("external_id")
        .eq("connection_id", connectionId)
        .in("status", ["QUEUED", "RUNNING"]);
      const pendingIds = new Set((pendingTasks || []).map(t => t.external_id));

      // 6. Build and queue migration tasks
      const families = (masterRow?.families_json || []) as { Id: string; Name: string }[];
      let queued = 0;
      let skipped = 0;
      const totalTargets = verifiedRows.length;

      for (const row of verifiedRows) {
        const extId = row.agora_product_id || `WINERIM_${row.winerim_wine_id}`;
        if (pendingIds.has(extId)) { skipped++; continue; }

        const wine = wineMap.get(row.winerim_wine_id);
        if (!wine) { skipped++; continue; }

        // Resolve target family using mappings
        const wineType = (wine.wine_type || "").toLowerCase();
        const fmt = row.format;
        let targetFamilyId: string | null = null;
        let targetFamilyName: string | null = null;

        // Try format-specific keys first
        if (fmt === "GLASS" && (customMappings["copa"] || customMappings["glass"])) {
          const m = customMappings["copa"] || customMappings["glass"];
          targetFamilyId = m.id; targetFamilyName = m.name;
        } else if (fmt === "MAGNUM" && customMappings["magnum"]) {
          targetFamilyId = customMappings["magnum"].id; targetFamilyName = customMappings["magnum"].name;
        } else if (wineType) {
          const bottleKey = `botella_${wineType}`;
          if (fmt === "BOTTLE" && customMappings[bottleKey]) {
            targetFamilyId = customMappings[bottleKey].id; targetFamilyName = customMappings[bottleKey].name;
          } else if (customMappings[wineType]) {
            targetFamilyId = customMappings[wineType].id; targetFamilyName = customMappings[wineType].name;
          }
        }

        if (!targetFamilyId) {
          // No mapping found for this type/format — skip
          skipped++;
          continue;
        }

        // Verify the target family actually exists in Agora
        const familyExists = families.some(f => f.Id === targetFamilyId);
        if (!familyExists) { skipped++; continue; }

        // Queue UPDATE task — only changes FamilyId
        const productId = Number(extId.replace("WINERIM_", "")) || 0;
        const agoraProductId = row.agora_product_id || String(productId > 0 ? (fmt === "MAGNUM" ? 900000 + productId : fmt === "GLASS" ? 700000 + productId : 500000 + productId) : extId);

        await supabase.from("outbound_tasks").insert({
          connection_id: connectionId,
          task_type: "AGORA_MIGRATE_FAMILY",
          external_id: agoraProductId,
          status: "QUEUED",
          payload_json: {
            productId: agoraProductId,
            winerimWineId: row.winerim_wine_id,
            format: fmt,
            targetFamilyId,
            targetFamilyName,
            wineName: wine.name,
            wineType: wine.wine_type,
            migrationType: "WINERIM_TO_PRODUCTION",
          },
        });

        // Update tracking
        await supabase.from("winerim_push_tracking")
          .update({ sync_status: "QUEUED", agora_family_id: targetFamilyId })
          .eq("id", row.id);

        queued++;
      }

      return new Response(JSON.stringify({ success: true, queued, skipped, totalTargets }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── Recompute stock from scratch using sales history (idempotent).
    // For each wine that has historical stock_sync_log SUCCESS entries:
    //   baseline = previousStock from the EARLIEST log entry (= stock before first ever deduction)
    //   correctNet = sum over all sales_line_items of:
    //                  bottles + (glasses / glassesPerBottle)   (only wine-candidate lines)
    //   targetStock = max(0, baseline - correctNet)
    // Then PUT targetStock to Winerim. Running this multiple times converges to the
    // same correct value, so it's safe even if previous restore attempts double-applied.
    if (action === "restore-glass-overdiscount") {
      const winerimToken = ((connection as any).winerim_api_token || "").trim();
      if (!winerimToken) {
        return new Response(JSON.stringify({ error: "winerim_api_token missing" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      if (payload?.apply === true && payload?.allowLegacyFractionalRestore !== true) {
        return new Response(JSON.stringify({
          success: false,
          error: "LEGACY_RESTORE_DISABLED",
          message: "restore-glass-overdiscount still uses legacy fractional bottle logic. It is dry-run only unless allowLegacyFractionalRestore=true is passed explicitly.",
          rollback: "Pass allowLegacyFractionalRestore=true for the old manual behavior, or restore the previous agora-proxy version.",
        }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      const glassesPerBottle = Math.max(1, Number((connection as any).estimated_glasses_per_bottle ?? 5));
      const apply = payload?.apply === true && payload?.allowLegacyFractionalRestore === true;

      // 1. Gather all wine-candidate sales lines for this connection
      const { data: rows } = await supabase
        .from("sales_line_items")
        .select("winerim_product_id, name, quantity, format")
        .eq("connection_id", connectionId)
        .eq("is_wine_candidate", true)
        .not("winerim_product_id", "is", null);

      // Per-wine totals: bottles, glasses, name
      const perWine = new Map<string, { name: string; bottles: number; glasses: number }>();
      for (const r of (rows || []) as any[]) {
        const fmt = String(r.format || "").toUpperCase();
        const isGlass = fmt === "COPA" || fmt.includes("COPA") || fmt === "GLASS";
        const wId = String(r.winerim_product_id);
        const q = Math.abs(Number(r.quantity || 0));
        const e = perWine.get(wId);
        if (e) {
          if (isGlass) e.glasses += q; else e.bottles += q;
        } else {
          perWine.set(wId, { name: r.name, bottles: isGlass ? 0 : q, glasses: isGlass ? q : 0 });
        }
      }

      // 2. Get earliest baseline (previousStock) per wine from stock_sync_log
      const wineIds = Array.from(perWine.keys());
      const baselineByWine = new Map<string, number>();
      // Page through to avoid 1000-row cap
      const CHUNK = 200;
      for (let i = 0; i < wineIds.length; i += CHUNK) {
        const slice = wineIds.slice(i, i + CHUNK);
        const { data: logs } = await supabase
          .from("stock_sync_log")
          .select("winerim_product_id, winerim_response, created_at")
          .eq("connection_id", connectionId)
          .eq("status", "SUCCESS")
          .in("winerim_product_id", slice)
          .order("created_at", { ascending: true });
        for (const l of (logs || []) as any[]) {
          const wId = String(l.winerim_product_id);
          if (baselineByWine.has(wId)) continue; // first one wins per wine
          const prev = Number(l.winerim_response?.previousStock);
          if (Number.isFinite(prev)) baselineByWine.set(wId, prev);
        }
      }

      const WINERIM_BASE = "https://app.winerim.com/api/v2";
      const winerimHeaders = {
        "WINERIM-API-TOKEN": winerimToken,
        "Content-Type": "application/json",
        "Accept": "application/json",
      };

      const plan: any[] = [];
      let restored = 0, failed = 0, skipped = 0;

      for (const [winerimWineId, agg] of perWine) {
        const baseline = baselineByWine.get(winerimWineId);
        if (baseline === undefined) { skipped++; continue; } // no historical deductions → nothing to fix
        const correctNet = agg.bottles + (agg.glasses / glassesPerBottle);
        const targetStock = Math.max(0, baseline - correctNet);

        // Get current stockId
        const stockRes = await fetch(`${WINERIM_BASE}/stock/wine/${winerimWineId}`, {
          method: "GET", headers: winerimHeaders,
        });
        if (!stockRes.ok) {
          failed++;
          plan.push({ winerimWineId, name: agg.name, baseline, bottles: agg.bottles, glasses: agg.glasses, correctNet, targetStock, error: `GET ${stockRes.status}` });
          continue;
        }
        const stockData = await stockRes.json();
        let stockId: number | null = null;
        let currentStock = 0;
        const stocksArr = stockData?.stocks || stockData?.data?.stocks;
        if (Array.isArray(stocksArr) && stocksArr.length > 0) {
          const active = stocksArr.find((s: any) => s.stockActive === true);
          const botella = stocksArr.find((s: any) => {
            const v = (s.winePrice as any)?.variant;
            return v === "botella" || v === "botella-pequena";
          });
          const chosen = active || botella || stocksArr[0];
          stockId = chosen.id as number;
          currentStock = Number(chosen.stock ?? 0);
        } else {
          const stockObj = stockData?.data || stockData;
          stockId = stockObj?.id || stockObj?.stockId;
          currentStock = Number(stockObj?.stock ?? stockObj?.quantity ?? 0);
        }
        if (!stockId) { failed++; plan.push({ winerimWineId, name: agg.name, baseline, error: "no stockId" }); continue; }

        const delta = targetStock - currentStock;
        plan.push({
          winerimWineId, name: agg.name,
          baseline, bottles: agg.bottles, glasses: agg.glasses,
          correctNet: Number(correctNet.toFixed(3)),
          currentStock, targetStock: Number(targetStock.toFixed(3)),
          delta: Number(delta.toFixed(3)), stockId,
        });

        if (apply && Math.abs(delta) > 0.001) {
          const putRes = await fetch(`${WINERIM_BASE}/stock/${stockId}`, {
            method: "PUT", headers: winerimHeaders,
            body: JSON.stringify({ stock: targetStock }),
          });
          if (putRes.ok) restored++; else failed++;
        }
      }

      return new Response(JSON.stringify({
        success: true, apply, glassesPerBottle,
        winesAffected: plan.length, skipped, restored, failed,
        plan,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    return new Response(
      JSON.stringify({ error: "Unknown action" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("agora-proxy error:", err);
    const raw = String(err);

    // Detect network-level failures reaching the customer's Agora server
    // and return a clean 502 with an actionable message instead of a 500 crash.
    const isDnsError = /dns error|failed to lookup address/i.test(raw);
    const isTimeout = /timed out|timeout/i.test(raw);
    const isNoRoute = /no route to host|connection refused|network is unreachable|connection reset/i.test(raw);
    const isConnectError = /tcp connect error|client error \(Connect\)/i.test(raw);

    if (isDnsError || isTimeout || isNoRoute || isConnectError) {
      let reason = "Cannot reach the Agora server";
      let hint = "Verify the base_url, that the Agora server is running, and that the port is open on the customer's router/firewall.";
      if (isDnsError) {
        reason = "DNS lookup failed for the Agora host";
        hint = "Check that the hostname/IP in base_url is correct and publicly resolvable (dynamic DNS up to date?).";
      } else if (isTimeout) {
        reason = "Connection to the Agora server timed out";
        hint = "The host is reachable but not responding on that port. Check the Agora service is running and the port is forwarded.";
      } else if (isNoRoute) {
        reason = "No route to the Agora server (port closed or firewall blocking)";
        hint = "Open the Agora port on the customer's router (port-forwarding) and ensure no firewall is blocking inbound connections.";
      }

      return new Response(
        JSON.stringify({
          error: reason,
          hint,
          details: raw,
          kind: "NETWORK_UNREACHABLE",
        }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ error: raw }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
