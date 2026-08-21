import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { buildDuplicateSafeAgoraProductLabels, buildDuplicateSafeAgoraProductNames } from "../_shared/agoraProductNaming.ts";
import { agoraSalesPairKey, canonicalAgoraSalesLineFormat, isAgoraSaleFormatFirstConnection, resolveAgoraSalesLineIdentityForConnection } from "../_shared/agoraSalesLineIdentity.ts";
import { decideAgoraStockFence } from "../_shared/agoraStockFence.ts";

import {
  buildVinotecaReferencePlan,
  isVinotecaNativeFormatsConnection,
  VINOTECA_PREPARATION_ORDER_ID,
  VINOTECA_PREPARATION_TYPE_ID,
  VINOTECA_REGION_REFERENCE_NATIVE_FORMATS,
  VINOTECA_ROOT_FAMILY_NAME,
  trackingAgoraProductIdForFormat,
  vinotecaFormatId,
  vinotecaRegionKey,
  findAdoptableVinotecaRegionFamily,
  type VinotecaCatalogRoute,
  type VinotecaFormat,
  type VinotecaReferencePlan,
  type VinotecaSkippedReference,
} from "../_shared/agoraVinotecaNativeFormats.ts";
import {
  baseProductPriceMap,
  saleFormatDifferenceReasons,
} from "../_shared/agoraVinotecaProductDiff.ts";
import { verifyVinotecaNativeFormatsImport } from "../_shared/agoraVinotecaPostImportVerify.ts";

import {
  AGORA_BUTTON_TEXT_WINE_NAME_WITH_FORMAT_SUFFIX,
  AGORA_BUTTON_TEXT_WINE_NAME_ONLY,
  AGORA_SORT_ALPHABETICAL_WINE_NAME,
  agoraProductButtonText,
  agoraProductButtonTextMode,
  agoraProductColor,
  agoraProductSortMode,
  buildUniqueAgoraButtonTexts,
  canonicalAgoraWineType,
  compareAgoraWineNames,
  shouldSortAgoraProductsAlphabetically,
} from "../_shared/agoraProductPresentation.ts";
import { isAgoraTimestampOldEnough } from "../_shared/agoraLocalTime.ts";
import {
  agoraDocumentType,
  buildAgoraInvoiceDocId,
  completeAgoraSalesEventDocIds,
  normalizeAgoraLineFormat,
  shouldPauseAgoraInvoiceProcessing,
  withAgoraOperationalMetadata,
} from "../_shared/agoraSales.ts";
import {
  countXmlOpenTickets,
  parseOpenTickets,
} from "../_shared/agoraOpenTickets.ts";
import {
  assessWinerimSalesImportResponse,
  buildStockSyncGroupKey,
  buildStockSyncIdempotencyKey,
  findStockForVariant,
  isTerminalStockSyncError,
  normalizeWinerimVariant,
  parseWinerimStockRows,
  retryableWinerimSalesImportSales,
  signedWholeSaleQuantity,
  salesImportQtyWhenStockDidNotMove,
  variantForAgoraFormat,
  WINERIM_SALES_IMPORT_MAX_ATTEMPTS,
  type WinerimSalesImportMode,
  type WinerimSalesImportSale,
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

async function readResponseTextBestEffort(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch (err) {
    return `[response body unreadable: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}]`;
  }
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
  await supabase.from("pos_connections").update({
    consecutive_failures: 0,
    circuit_breaker_paused_until: null,
    circuit_breaker_reason: null,
  }).eq("id", connectionId);
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

type AgoraProviderSoldAt = { value: string | null; source: string | null };

function normalizeProviderSoldAt(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  const isoLocal = raw.match(/^(\d{4}-\d{2}-\d{2})[T\s](\d{2}:\d{2}:\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/);
  if (isoLocal) return `${isoLocal[1]}T${isoLocal[2]}`;

  const isoDate = raw.match(/^(\d{4}-\d{2}-\d{2})$/);
  if (isoDate) return `${isoDate[1]}T00:00:00`;

  const spanishDate = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}:\d{2}(?::\d{2})?))?$/);
  if (spanishDate) {
    const time = spanishDate[4] ? (spanishDate[4].length === 5 ? `${spanishDate[4]}:00` : spanishDate[4]) : "00:00:00";
    return `${spanishDate[3]}-${spanishDate[2]}-${spanishDate[1]}T${time}`;
  }

  const parsed = Date.parse(raw);
  if (!Number.isNaN(parsed)) return new Date(parsed).toISOString().slice(0, 19);
  return null;
}

function extractAgoraProviderSoldAt(
  line: Record<string, unknown> | null | undefined,
  item: Record<string, unknown> | null | undefined,
  document: Record<string, unknown> | null | undefined,
  fallbackDay?: string | null,
): AgoraProviderSoldAt {
  const candidates: Array<[unknown, string]> = [
    [line?.CreationDate, "line.CreationDate"],
    [line?.CreatedAt, "line.CreatedAt"],
    [line?.CreatedDate, "line.CreatedDate"],
    [line?.Date, "line.Date"],
    [item?.CreationDate, "item.CreationDate"],
    [item?.CreatedAt, "item.CreatedAt"],
    [item?.Date, "item.Date"],
    [document?.CreationDate, "document.CreationDate"],
    [document?.CreatedAt, "document.CreatedAt"],
    [document?.Date, "document.Date"],
    [document?.BusinessDay, "document.BusinessDay"],
    [fallbackDay, "fallback.businessDay"],
  ];

  for (const [candidate, source] of candidates) {
    const normalized = normalizeProviderSoldAt(candidate);
    if (normalized) return { value: normalized, source };
  }

  return { value: null, source: null };
}

function earlierProviderSoldAt(current: unknown, next: unknown): string | null {
  const currentNormalized = normalizeProviderSoldAt(current);
  const nextNormalized = normalizeProviderSoldAt(next);
  if (!currentNormalized) return nextNormalized;
  if (!nextNormalized) return currentNormalized;

  const currentMs = Date.parse(currentNormalized);
  const nextMs = Date.parse(nextNormalized);
  if (Number.isFinite(currentMs) && Number.isFinite(nextMs)) {
    return nextMs < currentMs ? nextNormalized : currentNormalized;
  }
  return nextNormalized < currentNormalized ? nextNormalized : currentNormalized;
}

// ── PRODUCT NAME BUILDER: prefix B (botella) / C (copa) / M (magnum) ──
function formatProductName(fmt: string, wineName: string): string {
  const f = String(fmt || "").toUpperCase();
  const normalizedWineName = String(wineName || "").replace(/\s+/g, " ").trim();
  if (f === "MAGNUM") return `M ${normalizedWineName}`;
  if (f === "GLASS" || f === "COPA") return `C ${normalizedWineName}`;
  return `B ${normalizedWineName}`;
}

function decodeXmlAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function commercialDCode(wineName: string | null | undefined): string | null {
  const match = String(wineName || "").toUpperCase().match(/\bD\s*[-_ ]?(\d{3})\b/);
  return match ? `D${match[1]}` : null;
}

function commercialGenericCode(wineName: string | null | undefined): { prefix: string; number: number } | null {
  const text = String(wineName || "").toUpperCase();
  const magnum = text.match(/\bMAGNUM\s*[-_ ]?(\d{1,3})\b/);
  if (magnum) return { prefix: "MAGNUM", number: Number(magnum[1]) };
  const match = text.match(/\b([BRTEDG])\s*[-_ ]?(\d{1,3})([A-Z])?\b/);
  return match ? { prefix: match[1], number: Number(match[2]), suffix: match[3] || "" } : null;
}

type CommercialCode = { prefix: string; number: number; suffix?: string };

const DEFAULT_COMMERCIAL_CODE_PREFIX_ORDER = ["T", "B", "R", "E", "D", "G", "MAGNUM"];

function shouldSortAgoraProductsByCommercialCode(connection: any): boolean {
  return agoraProductSortMode(connection) === "COMMERCIAL_CODE_NUMERIC";
}

function commercialCodePrefixOrder(connection: any): string[] {
  const config = (connection?.provider_config || {}) as Record<string, unknown>;
  const raw = Array.isArray(config.agora_product_sort_prefix_order)
    ? config.agora_product_sort_prefix_order
    : DEFAULT_COMMERCIAL_CODE_PREFIX_ORDER;
  const normalized = raw
    .map((v) => String(v || "").trim().toUpperCase())
    .filter(Boolean);
  return normalized.length > 0 ? normalized : DEFAULT_COMMERCIAL_CODE_PREFIX_ORDER;
}

function commercialCodePrefixOrderForFamily(
  connection: any,
  familyId: string,
  familyName: string,
  fallbackOrder: string[],
): string[] {
  const config = (connection?.provider_config || {}) as Record<string, unknown>;
  const byFamily = (config.agora_product_sort_prefix_order_by_family || {}) as Record<string, unknown>;
  const explicit = byFamily[String(familyId)] || byFamily[String(familyName || "").toUpperCase()];
  if (Array.isArray(explicit)) {
    const normalized = explicit.map((v) => String(v || "").trim().toUpperCase()).filter(Boolean);
    if (normalized.length > 0) return normalized;
  }
  if (/magnums?\s+winerim/i.test(String(familyName || ""))) {
    return ["MAGNUM", ...fallbackOrder.filter((prefix) => prefix !== "MAGNUM")];
  }
  return fallbackOrder;
}

function commercialCodeRank(code: CommercialCode | null | undefined, prefixOrder: string[]): number {
  if (!code) return Number.MAX_SAFE_INTEGER;
  const idx = prefixOrder.indexOf(String(code.prefix || "").toUpperCase());
  return idx >= 0 ? idx : prefixOrder.length + 1;
}

function compareCommercialCodes(
  a: CommercialCode | null | undefined,
  b: CommercialCode | null | undefined,
  prefixOrder: string[],
): number {
  const rankDiff = commercialCodeRank(a, prefixOrder) - commercialCodeRank(b, prefixOrder);
  if (rankDiff !== 0) return rankDiff;
  if (a && b) {
    const numberDiff = a.number - b.number;
    if (numberDiff !== 0) return numberDiff;
    const suffixDiff = String(a.suffix || "").localeCompare(String(b.suffix || ""), "es");
    if (suffixDiff !== 0) return suffixDiff;
  }
  if (a && !b) return -1;
  if (!a && b) return 1;
  return 0;
}

function inferAgoraFormatOrderFromName(name: string | null | undefined): number {
  const text = String(name || "").toUpperCase().trim();
  if (text.startsWith("C ") || text.startsWith("COPA ") || text.startsWith("COPA.")) return 1;
  if (text.startsWith("M ") || text.startsWith("MAG ") || text.startsWith("MAG.") || text.startsWith("MAGNUM")) return 2;
  return 0;
}

function escapeXmlAttribute(value: string): string {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function extractXmlAttrValue(xml: string, attr: string): string | null {
  const re = new RegExp(`\\b${attr}="([^"]*)"`);
  return re.exec(xml)?.[1] || null;
}

function setXmlAttrValue(el: string, attr: string, value: string): string {
  const escaped = escapeXmlAttribute(value);
  const re = new RegExp(`\\b${attr}="[^"]*"`);
  if (re.test(el)) return el.replace(re, `${attr}="${escaped}"`);
  return el.replace(/(<[\w:-]+\b[^>]*)(\/?>)/, `$1 ${attr}="${escaped}"$2`);
}

function extractXmlElementsWithAttrs(xml: string, tagName: string): { xml: string; attrs: Record<string, string> }[] {
  const results: { xml: string; attrs: Record<string, string> }[] = [];
  const elementRegex = new RegExp(`<${tagName}\\b[^>]*\\/>|<${tagName}\\b[^>]*>[\\s\\S]*?<\\/${tagName}>`, "g");
  let match: RegExpExecArray | null;
  while ((match = elementRegex.exec(xml)) !== null) {
    const full = match[0];
    const attrs: Record<string, string> = {};
    const attrRegex = /\b([\w:-]+)="([^"]*)"/g;
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = attrRegex.exec(full)) !== null) {
      attrs[attrMatch[1]] = attrMatch[2];
    }
    results.push({ xml: full, attrs });
  }
  return results;
}

function findXmlElementByAttr(xml: string, tagName: string, attr: string, value: string): { xml: string; attrs: Record<string, string> } | null {
  return extractXmlElementsWithAttrs(xml, tagName).find((el) => String(el.attrs[attr] || "") === String(value)) || null;
}

function normalizeAgoraMoney(value: unknown): string {
  const raw = String(value ?? "").trim().replace(",", ".");
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? numeric.toFixed(2) : raw;
}

function productPriceMap(productXml: string): Record<string, string> {
  // Base Product prices only. <Price> nodes nested inside
  // <AdditionalSaleFormats><SaleFormat> must never overwrite the bottle price
  // (that collapse produced the false "no_agora_changes" skip).
  return baseProductPriceMap(productXml);
}


function normalizeAgoraTextAttribute(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function applyUniqueExpectedAgoraButtonTexts(
  connection: unknown,
  expectedProducts: Array<{ xml: string; attrs: Record<string, string> }>,
  actualProducts: Array<{ xml: string; attrs: Record<string, string> }>,
): void {
  const buttonTextMode = agoraProductButtonTextMode(connection);
  if (![AGORA_BUTTON_TEXT_WINE_NAME_ONLY, AGORA_BUTTON_TEXT_WINE_NAME_WITH_FORMAT_SUFFIX].includes(buttonTextMode)) {
    return;
  }

  const actualById = new Map(
    actualProducts.map((product) => [String(product.attrs.Id || ""), product]),
  );
  const expectedByFamily = new Map<string, Array<{ xml: string; attrs: Record<string, string> }>>();
  for (const product of expectedProducts) {
    const familyId = String(product.attrs.FamilyId || "");
    const familyProducts = expectedByFamily.get(familyId) || [];
    familyProducts.push(product);
    expectedByFamily.set(familyId, familyProducts);
  }

  for (const familyProducts of expectedByFamily.values()) {
    familyProducts.sort((left, right) =>
      compareAgoraWineNames(
        decodeXmlAttribute(left.attrs.Name || ""),
        decodeXmlAttribute(right.attrs.Name || ""),
      ) || Number(left.attrs.Id || 0) - Number(right.attrs.Id || 0)
    );
    const uniqueButtonTexts = buildUniqueAgoraButtonTexts(
      connection,
      familyProducts.map((product) => {
        const productId = String(product.attrs.Id || "");
        return {
          key: productId,
          technicalName: normalizeAgoraTextAttribute(decodeXmlAttribute(product.attrs.Name || "")),
          existingButtonText: normalizeAgoraTextAttribute(
            decodeXmlAttribute(actualById.get(productId)?.attrs.ButtonText || product.attrs.ButtonText || ""),
          ),
        };
      }),
      20,
    );
    for (const product of familyProducts) {
      const expectedButtonText = uniqueButtonTexts[String(product.attrs.Id || "")];
      if (expectedButtonText) product.attrs.ButtonText = escapeXmlAttribute(expectedButtonText);
    }
  }
}

function agoraProductDifferenceReasons(
  expected: { xml: string; attrs: Record<string, string> },
  actual: { xml: string; attrs: Record<string, string> },
  scopedPriceListIds: string[],
): string[] {
  const differences: string[] = [];
  const attrsToCompare = [
    "Name",
    "ButtonText",
    "FamilyId",
    "VatId",
    "UseAsDirectSale",
    "SaleableAsMain",
    "SaleableAsAddin",
    "IsSoldByWeight",
    "AskForPreparationNotes",
    "AskForAddins",
    "PrintWhenPriceIsZero",
    "PreparationTypeId",
    "PreparationOrderId",
  ];

  for (const attr of attrsToCompare) {
    const expectedValue = attr === "Name" || attr === "ButtonText"
      ? normalizeAgoraTextAttribute(decodeXmlAttribute(expected.attrs[attr] || ""))
      : String(expected.attrs[attr] || "");
    const actualValue = attr === "Name" || attr === "ButtonText"
      ? normalizeAgoraTextAttribute(decodeXmlAttribute(actual.attrs[attr] || ""))
      : String(actual.attrs[attr] || "");
    if (expectedValue !== actualValue) differences.push(`${attr.toUpperCase()}_MISMATCH`);
  }

  if (normalizeAgoraMoney(expected.attrs.CostPrice) !== normalizeAgoraMoney(actual.attrs.CostPrice)) {
    differences.push("COST_PRICE_MISMATCH");
  }

  const expectedPrices = productPriceMap(expected.xml);
  const actualPrices = productPriceMap(actual.xml);
  const priceListIds = scopedPriceListIds.length > 0
    ? scopedPriceListIds.filter((id) => Object.prototype.hasOwnProperty.call(expectedPrices, id))
    : Object.keys(expectedPrices);

  const hasSaleFormats = /<AdditionalSaleFormats\b/i.test(expected.xml);
  const basePriceLabel = hasSaleFormats ? "BOTTLE_PRICE_LIST" : "PRICE_LIST";

  for (const priceListId of priceListIds) {
    if (!Object.prototype.hasOwnProperty.call(actualPrices, priceListId)) {
      differences.push(`${basePriceLabel}_${priceListId}_MISSING`);
    } else if (expectedPrices[priceListId] !== actualPrices[priceListId]) {
      differences.push(`${basePriceLabel}_${priceListId}_MISMATCH`);
    }
  }

  // GLASS/MAGNUM live inside AdditionalSaleFormats and are compared by
  // SaleFormatId, never as independent Products.
  differences.push(...saleFormatDifferenceReasons(expected.xml, actual.xml, scopedPriceListIds));

  if (priceListIds.length === 0) differences.push("NO_SCOPED_PRICE_LIST");
  return differences;
}


function agoraProductMatchesExpectedXml(
  expected: { xml: string; attrs: Record<string, string> },
  actual: { xml: string; attrs: Record<string, string> },
  scopedPriceListIds: string[],
): boolean {
  return agoraProductDifferenceReasons(expected, actual, scopedPriceListIds).length === 0;
}

// Sa Pedrera validated that this specific DULCES WINERIM screen is ordered
// by Agora Product.Id. Keep D-code products on deterministic 903xxx IDs.
function saPedreraDulceCode(connection: any, wine: any): string | null {
  const locationName = String(connection?.location_name || connection?.name || "");
  if (!/sa\s*pedrera/i.test(locationName)) return null;
  const wineType = String(wine?.wine_type || wine?.raw_payload?.type || "").toLowerCase();
  if (wineType !== "postre" && wineType !== "dulce") return null;
  return commercialDCode(wine?.name);
}

function saPedreraDedicatedFamily(
  connection: any,
  wine: any,
  formatType: string,
): { id: string; needsCreate: false; familyName: string } | null {
  const locationName = String(connection?.location_name || connection?.name || "");
  if (!/sa\s*pedrera/i.test(locationName)) return null;

  const fmt = String(formatType || "BOTTLE").toUpperCase();
  const wineType = String(wine?.wine_type || wine?.raw_payload?.type || "").toLowerCase();
  const code = commercialGenericCode(wine?.name);

  // The D### postre/dulce controlled screen intentionally keeps copa and bottle
  // together in DULCES WINERIM until Sa Pedrera approves moving them elsewhere.
  if ((wineType === "postre" || wineType === "dulce") && code?.prefix === "D") {
    return { id: "903925", needsCreate: false, familyName: "DULCES WINERIM" };
  }

  if (fmt === "GLASS") {
    return { id: "901954", needsCreate: false, familyName: "COPAS WINERIM" };
  }

  if (fmt === "MAGNUM" || code?.prefix === "MAGNUM") {
    return { id: "904289", needsCreate: false, familyName: "MAGNUM WINERIM" };
  }

  if (fmt !== "BOTTLE") return null;

  if (wineType === "tinto") return { id: "900157", needsCreate: false, familyName: "TINTOS WINERIM" };
  if (wineType === "blanco") return { id: "904241", needsCreate: false, familyName: "BLANCOS WINERIM" };
  if (wineType === "rosado") return { id: "903516", needsCreate: false, familyName: "ROSADOS WINERIM" };
  if (wineType === "espumoso") return { id: "908875", needsCreate: false, familyName: "ESPUMOSOS WINERIM" };
  if (wineType === "fortificado") return { id: "908182", needsCreate: false, familyName: "FORTIFICADOS WINERIM" };

  return null;
}

function deterministicAgoraProductId(connection: any, wine: any, formatType: string): string {
  const winerimId = Number(wine?.winerim_id || wine?.id || 0);
  const orderedDulceCode = saPedreraDulceCode(connection, wine);
  if (orderedDulceCode) return String(903000 + Number(orderedDulceCode.replace("D", "")));
  if (formatType === "MAGNUM") return String(900000 + winerimId);
  if (formatType === "GLASS") return String(700000 + winerimId);
  return String(500000 + winerimId);
}

function preferredSingleFormatForDulce(wine: any): "BOTTLE" | "GLASS" {
  const glassPrice = extractGlassSalePrice(wine) || 0;
  return glassPrice > 0 ? "GLASS" : "BOTTLE";
}

// deno-lint-ignore no-explicit-any
function buildSalesResolutionMap(trackingRows: any[] | null | undefined, mappingRows: any[] | null | undefined): Map<string, { winerim_wine_id: string; format: string }> {
  const resolutionMap = new Map<string, { winerim_wine_id: string; format: string }>();
  const rejectedProductIds = new Set<string>();
  const trackedProductIds = new Set<string>();

  for (const m of (mappingRows || [])) {
    if (m.provider_product_id && m.status === "REJECTED") {
      rejectedProductIds.add(String(m.provider_product_id));
    }
  }

  for (const t of (trackingRows || [])) {
    const productId = String(t.agora_product_id || "");
    if (!productId || rejectedProductIds.has(productId)) continue;
    trackedProductIds.add(productId);
    if (t.winerim_wine_id && (t.sync_status === "VERIFIED" || t.sync_status === "PUSHED")) {
      resolutionMap.set(productId, { winerim_wine_id: t.winerim_wine_id, format: t.format });
    }
  }

  for (const m of (mappingRows || [])) {
    const productId = String(m.provider_product_id || "");
    if (!productId || rejectedProductIds.has(productId)) continue;
    if (trackedProductIds.has(productId) && !resolutionMap.has(productId)) continue;
    if (m.winerim_wine_id && m.status === "CONFIRMED" && !resolutionMap.has(productId)) {
      resolutionMap.set(productId, { winerim_wine_id: m.winerim_wine_id, format: m.format_type || "BOTTLE" });
    }
  }

  return resolutionMap;
}

const SALES_RESOLUTION_PAGE_SIZE = 1000;
const SALES_RESOLUTION_MAX_ROWS_PER_TABLE = 25000;

// Sales resolution must never rely on an unpaginated read: Supabase caps rows
// per request, so a partial page silently drops existing mappings.
// deno-lint-ignore no-explicit-any
async function selectAllConnectionRows(
  supabaseClient: any,
  tableName: string,
  columns: string,
  connectionId: string,
): Promise<any[]> {
  const rows: any[] = [];
  let from = 0;
  while (true) {
    const to = from + SALES_RESOLUTION_PAGE_SIZE - 1;
    const { data, error } = await supabaseClient
      .from(tableName)
      .select(columns)
      .eq("connection_id", connectionId)
      .order("id", { ascending: true })
      .range(from, to);
    if (error) throw new Error(`Could not page ${tableName} for sales resolution: ${error.message}`);
    const page = data || [];
    rows.push(...page);
    if (rows.length > SALES_RESOLUTION_MAX_ROWS_PER_TABLE) {
      throw new Error(
        `${tableName} exceeded ${SALES_RESOLUTION_MAX_ROWS_PER_TABLE} rows for connection ${connectionId}; refusing partial sales resolution`,
      );
    }
    if (page.length < SALES_RESOLUTION_PAGE_SIZE) break;
    from += SALES_RESOLUTION_PAGE_SIZE;
  }
  return rows;
}

// Fully persisted sales events are durable checkpoints for large business
// days. Paginating the read lets later cron invocations resume safely.
// deno-lint-ignore no-explicit-any
async function loadCompleteSalesEventDocIdsForDay(
  supabaseClient: any,
  connectionId: string,
  businessDay: string,
): Promise<Set<string>> {
  const rows: any[] = [];

  for (let from = 0; from < SALES_RESOLUTION_MAX_ROWS_PER_TABLE; from += SALES_RESOLUTION_PAGE_SIZE) {
    const to = from + SALES_RESOLUTION_PAGE_SIZE - 1;
    const { data, error } = await supabaseClient
      .from("sales_events")
      .select("id,provider_doc_id,line_count,sales_line_items(count)")
      .eq("connection_id", connectionId)
      .eq("business_day", businessDay)
      .order("id", { ascending: true })
      .range(from, to);

    if (error) {
      throw new Error(`Failed to load sales resume checkpoint for ${businessDay}: ${error.message || String(error)}`);
    }

    const page = data || [];
    rows.push(...page);
    if (page.length < SALES_RESOLUTION_PAGE_SIZE) {
      return completeAgoraSalesEventDocIds(rows);
    }
  }

  throw new Error(`Sales resume checkpoint exceeded ${SALES_RESOLUTION_MAX_ROWS_PER_TABLE} events for ${connectionId}/${businessDay}`);
}

// Active winerim wine ids, only needed for VINOTECA native-namespace connections
// (fail-closed sales resolution). Other connections get undefined = unchanged.
// deno-lint-ignore no-explicit-any
async function loadSalesActiveWineFormats(
  supabaseClient: any,
  connectionId: string,
): Promise<Map<string, Set<string>> | undefined> {
  if (!isAgoraSaleFormatFirstConnection(connectionId)) return undefined;
  const rows = await selectAllConnectionRows(
    supabaseClient,
    "winerim_wines",
    "id, winerim_id, is_active, bottle_sale_price, glass_sale_price, magnum_sale_price",
    connectionId,
  );
  const active = new Map<string, Set<string>>();
  for (const row of (rows || []) as Record<string, unknown>[]) {
    if (row.is_active === false) continue;
    const id = String(row.winerim_id ?? "").trim();
    if (!id) continue;
    const formats = new Set<string>();
    const positive = (value: unknown) => Number(value) > 0;
    if (positive(row.bottle_sale_price)) formats.add("BOTTLE");
    if (positive(row.glass_sale_price)) formats.add("GLASS");
    if (positive(row.magnum_sale_price)) formats.add("MAGNUM");
    if (formats.size > 0) active.set(id, formats);
  }
  return active;
}

// Exact compound sales identities (connection_id, ProductId, SaleFormatId).
// Only allowlisted VINOTECA connections use them; others get undefined.
// deno-lint-ignore no-explicit-any
async function loadSalesPairMappings(
  supabaseClient: any,
  connectionId: string,
): Promise<Map<string, { winerim_wine_id: string; format: string }> | undefined> {
  if (!isAgoraSaleFormatFirstConnection(connectionId)) return undefined;
  const rows = await selectAllConnectionRows(
    supabaseClient,
    "agora_sales_variant_mappings",
    "id, provider_product_id, sale_format_id, winerim_wine_id, format_type, status",
    connectionId,
  );
  const pairs = new Map<string, { winerim_wine_id: string; format: string }>();
  for (const row of (rows || []) as Record<string, unknown>[]) {
    const status = String(row.status ?? "").trim().toUpperCase();
    if (status && status !== "CONFIRMED" && status !== "ACTIVE") continue;
    const wineId = String(row.winerim_wine_id ?? "").trim();
    if (!wineId) continue;
    pairs.set(
      agoraSalesPairKey(row.provider_product_id, row.sale_format_id),
      { winerim_wine_id: wineId, format: String(row.format_type ?? "").trim().toUpperCase() },
    );
  }
  return pairs;
}

// Exact catalog identities for wines adopted from an existing Agora catalog.
// A route is valid only when every row agrees on the parent ProductId and one
// format uses that ProductId as its SaleFormatId (Agora's base format).
// Partial or conflicting routes are retained as an invalid sentinel so the
// builder fails closed instead of creating a deterministic duplicate.
// deno-lint-ignore no-explicit-any
async function loadVinotecaCatalogRoutes(
  supabaseClient: any,
  connectionId: string,
): Promise<Map<string, VinotecaCatalogRoute | null> | undefined> {
  if (!isAgoraSaleFormatFirstConnection(connectionId)) return undefined;
  const rows = await selectAllConnectionRows(
    supabaseClient,
    "agora_sales_variant_mappings",
    "provider_product_id, sale_format_id, winerim_wine_id, format_type, status, evidence",
    connectionId,
  );
  const grouped = new Map<string, Record<string, unknown>[]>();
  for (const row of (rows || []) as Record<string, unknown>[]) {
    const status = String(row.status ?? "").trim().toUpperCase();
    if (status && status !== "CONFIRMED" && status !== "ACTIVE") continue;
    const wineId = String(row.winerim_wine_id ?? "").trim();
    if (!wineId) continue;
    const group = grouped.get(wineId) || [];
    group.push(row);
    grouped.set(wineId, group);
  }

  const routes = new Map<string, VinotecaCatalogRoute | null>();
  for (const [wineId, group] of grouped) {
    const productIds = new Set(group.map((row) => String(row.provider_product_id ?? "").trim()).filter(Boolean));
    const formatIds: Partial<Record<VinotecaFormat, string>> = {};
    let invalid = productIds.size !== 1;
    let baseFormat: VinotecaFormat | null = null;
    const productId = [...productIds][0] || "";
    for (const row of group) {
      const format = String(row.format_type ?? "").trim().toUpperCase() as VinotecaFormat;
      const saleFormatId = String(row.sale_format_id ?? "").trim();
      if (!(["BOTTLE", "GLASS", "MAGNUM"] as string[]).includes(format) || !saleFormatId || formatIds[format]) {
        invalid = true;
        continue;
      }
      formatIds[format] = saleFormatId;
      const metadata = row.evidence && typeof row.evidence === "object"
        ? row.evidence as Record<string, unknown>
        : {};
      const explicitlyBase = String(metadata.formatSource ?? "").trim().toUpperCase() === "BASE";
      if (explicitlyBase || saleFormatId === productId) {
        if (baseFormat && baseFormat !== format) invalid = true;
        baseFormat = format;
      }
    }
    routes.set(wineId, !invalid && productId && baseFormat
      ? { productId, baseFormat, formatIds }
      : null);
  }
  return routes;
}


// deno-lint-ignore no-explicit-any
async function buildSalesResolutionMapFromDb(
  supabaseClient: any,
  connectionId: string,
): Promise<Map<string, { winerim_wine_id: string; format: string }>> {
  const [trackingRows, mappingRows] = await Promise.all([
    selectAllConnectionRows(
      supabaseClient,
      "winerim_push_tracking",
      "id, agora_product_id, winerim_wine_id, format, sync_status",
      connectionId,
    ),
    selectAllConnectionRows(
      supabaseClient,
      "product_mappings",
      "id, provider_product_id, winerim_wine_id, format_type, status",
      connectionId,
    ),
  ]);
  return buildSalesResolutionMap(trackingRows, mappingRows);
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

function agoraNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isResolvedWineCandidate(winerimProductId: unknown, heuristicCandidate: boolean): boolean {
  return Boolean(String(winerimProductId || "").trim()) || heuristicCandidate;
}

function buildAgoraOpenTicketDocId(ticket: Record<string, unknown>, day: string, ticketIndex: number): string {
  const candidates = [
    ticket.GlobalId,
    ticket.TicketGlobalId,
    ticket.TicketId,
    ticket.Id,
    ticket.DocumentId,
    ticket.DocId,
    ticket.Number,
    ticket.Code,
  ];
  for (const candidate of candidates) {
    const value = String(candidate || "").trim();
    if (value) return `open_ticket:${value}`;
  }
  return `open_ticket:${day}:${ticketIndex}`;
}

function isOpenTicketsSyncEnabled(connection: { provider_config?: unknown }): boolean {
  const config = (connection?.provider_config && typeof connection.provider_config === "object")
    ? connection.provider_config as Record<string, unknown>
    : {};
  return config.open_tickets_sync_enabled === true;
}

function isOpenTicketsStockSyncEnabled(connection: { provider_config?: unknown }): boolean {
  const config = (connection?.provider_config && typeof connection.provider_config === "object")
    ? connection.provider_config as Record<string, unknown>
    : {};
  return config.open_tickets_stock_sync_enabled === true;
}

function openTicketsStockCurrentDayOnly(providerConfig: Record<string, unknown>): boolean {
  return providerConfig.open_tickets_stock_current_day_only !== false;
}

function isStockSyncDayAllowed(day: string, providerConfig: Record<string, unknown>): boolean {
  const notBefore = String(providerConfig.stock_sync_not_before || "").trim();
  return !isBusinessDay(notBefore) || day >= notBefore;
}

function isOpenTicketStockDayAllowed(day: string, defaultDay: string, providerConfig: Record<string, unknown>): boolean {
  if (!isStockSyncDayAllowed(day, providerConfig)) return false;
  if (!openTicketsStockCurrentDayOnly(providerConfig)) return true;
  return day >= defaultDay;
}

function isStaleOpenTicketRestoreEnabled(providerConfig: Record<string, unknown>): boolean {
  return providerConfig.open_tickets_restore_stale_previous_days_enabled !== false;
}

function staleOpenTicketRestoreLookbackHours(providerConfig: Record<string, unknown>): number {
  const parsed = Number(providerConfig.open_tickets_restore_lookback_hours ?? 96);
  if (!Number.isFinite(parsed)) return 96;
  return Math.min(168, Math.max(1, parsed));
}

function todayInTimeZone(timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  return `${byType.get("year")}-${byType.get("month")}-${byType.get("day")}`;
}

function isIntradaySalesSyncEnabled(connection: { provider_config?: unknown }): boolean {
  const config = (connection?.provider_config && typeof connection.provider_config === "object")
    ? connection.provider_config as Record<string, unknown>
    : {};
  return config.intraday_sales_sync_enabled === true;
}

function isBusinessDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

async function updateSalesCursorMonotonically(
  supabase: any,
  connectionId: string,
  candidateDay: string | null,
  syncedAt = new Date().toISOString(),
): Promise<{ advanced: boolean; cursor: string | null; error: string | null }> {
  if (!candidateDay) {
    const { error } = await supabase
      .from("pos_connections")
      .update({ last_sync_at: syncedAt })
      .eq("id", connectionId);
    return { advanced: false, cursor: null, error: error?.message || null };
  }
  if (!isBusinessDay(candidateDay)) {
    return { advanced: false, cursor: null, error: `Invalid cursor day: ${candidateDay}` };
  }

  // Postgres evaluates the predicate and UPDATE atomically. A concurrent run
  // can advance the cursor, but an older run can never overwrite it.
  const { data: advancedRow, error: advanceError } = await supabase
    .from("pos_connections")
    .update({ last_business_day_synced: candidateDay, last_sync_at: syncedAt })
    .eq("id", connectionId)
    .or(`last_business_day_synced.is.null,last_business_day_synced.lt.${candidateDay}`)
    .select("last_business_day_synced")
    .maybeSingle();
  if (advanceError) {
    return { advanced: false, cursor: null, error: advanceError.message };
  }
  if (advancedRow) {
    return {
      advanced: true,
      cursor: String(advancedRow.last_business_day_synced || candidateDay),
      error: null,
    };
  }

  const { data: freshRow, error: freshError } = await supabase
    .from("pos_connections")
    .select("last_business_day_synced")
    .eq("id", connectionId)
    .single();
  if (freshError) {
    return { advanced: false, cursor: null, error: freshError.message };
  }
  const { error: touchError } = await supabase
    .from("pos_connections")
    .update({ last_sync_at: syncedAt })
    .eq("id", connectionId);
  return {
    advanced: false,
    cursor: String(freshRow?.last_business_day_synced || "") || null,
    error: touchError?.message || null,
  };
}

function formatBusinessDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addUtcDays(day: string, delta: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return formatBusinessDay(date);
}

function recentOpenTicketBusinessDays(providerConfig: unknown): string[] {
  const config = (providerConfig && typeof providerConfig === "object" ? providerConfig : {}) as Record<string, unknown>;
  const lastSync = (config.last_open_tickets_sync && typeof config.last_open_tickets_sync === "object"
    ? config.last_open_tickets_sync
    : {}) as Record<string, unknown>;
  const maxAgeMinutes = Math.max(10, Number(config.open_tickets_active_cursor_guard_minutes ?? 30));
  const syncedAt = String(lastSync.at || "").trim();
  const syncAgeMs = syncedAt && Number.isFinite(Date.parse(syncedAt))
    ? Date.now() - Date.parse(syncedAt)
    : Number.POSITIVE_INFINITY;
  if (lastSync.success !== true || Number(lastSync.ticketCount || 0) <= 0 || syncAgeMs > maxAgeMinutes * 60_000) {
    return [];
  }
  return Array.from(new Set(
    (Array.isArray(lastSync.businessDays) ? lastSync.businessDays : [])
      .map((day) => String(day || ""))
      .filter(isBusinessDay),
  )).sort();
}

function buildBusinessDayRange(fromDay: string, toDay: string, maxDays: number): string[] {
  if (!isBusinessDay(fromDay) || !isBusinessDay(toDay)) {
    throw new Error("fromBusinessDay/toBusinessDay must use YYYY-MM-DD");
  }
  if (fromDay > toDay) {
    throw new Error("fromBusinessDay cannot be after toBusinessDay");
  }
  const days: string[] = [];
  let cursor = fromDay;
  while (cursor <= toDay) {
    days.push(cursor);
    if (days.length > maxDays) {
      throw new Error(`Date range too large (${days.length} days). Max allowed: ${maxDays}`);
    }
    cursor = addUtcDays(cursor, 1);
  }
  return days;
}

function configuredStockSyncStartDate(providerConfig: unknown): string | null {
  const cfg = (providerConfig && typeof providerConfig === "object" ? providerConfig : {}) as Record<string, unknown>;
  const candidates = [
    cfg.stock_sync_not_before,
    cfg.stock_sync_start_date,
    cfg.sales_stock_sync_start_date,
    cfg.operational_stock_start_date,
  ];
  for (const candidate of candidates) {
    if (isBusinessDay(candidate)) return candidate;
  }
  return null;
}

function configuredStockSyncStartAt(providerConfig: unknown): string | null {
  const cfg = (providerConfig && typeof providerConfig === "object" ? providerConfig : {}) as Record<string, unknown>;
  const raw = String(cfg.stock_sync_not_before_at || cfg.operational_stock_start_at || "").trim();
  if (!raw || !Number.isFinite(Date.parse(raw))) return null;
  return new Date(raw).toISOString();
}

function providerSaleIsAfterStockStart(providerSoldAt: unknown, stockSyncStartAt: string | null): boolean {
  if (!stockSyncStartAt) return true;
  const soldAt = String(providerSoldAt || "").trim();
  if (!soldAt || !Number.isFinite(Date.parse(soldAt))) return false;
  return Date.parse(soldAt) >= Date.parse(stockSyncStartAt);
}

function rawJsonDisablesStockSync(rawJson: unknown): boolean {
  const raw = (rawJson && typeof rawJson === "object" ? rawJson : {}) as Record<string, unknown>;
  return raw._winerim_import_mode === "historical_analytics" || raw._stock_sync_eligible === false;
}

function withHistoricalAnalyticsMetadata(rawJson: unknown, importedAt: string): Record<string, unknown> {
  const raw = (rawJson && typeof rawJson === "object" && !Array.isArray(rawJson) ? rawJson : { value: rawJson }) as Record<string, unknown>;
  return {
    ...raw,
    _winerim_import_mode: "historical_analytics",
    _stock_sync_eligible: false,
    _winerim_imported_at: importedAt,
  };
}

type SalesLineReplacementResult = {
  ok: boolean;
  inserted: number;
  error?: string;
};

// Agora open tickets are snapshots and their lines are replaced on every poll.
// Detach durable stock claims first so deleting an old snapshot cannot erase the
// idempotency evidence that prevents the next poll from recording the sale again.
async function replaceSalesEventLinesPreservingStockClaims(
  supabase: any,
  connectionId: string,
  salesEventId: string,
  lines: Record<string, unknown>[],
): Promise<SalesLineReplacementResult> {
  const { error: detachError } = await supabase
    .from("stock_sync_log")
    .update({ sales_line_item_id: null })
    .eq("connection_id", connectionId)
    .eq("sales_event_id", salesEventId)
    .not("sales_line_item_id", "is", null);
  if (detachError) {
    return { ok: false, inserted: 0, error: `stock claim detach failed: ${detachError.message}` };
  }

  const { error: deleteError } = await supabase
    .from("sales_line_items")
    .delete()
    .eq("sales_event_id", salesEventId);
  if (deleteError) {
    return { ok: false, inserted: 0, error: `sales line delete failed: ${deleteError.message}` };
  }

  if (lines.length === 0) return { ok: true, inserted: 0 };

  const rows = lines.map((line) => ({
    ...line,
    sales_event_id: salesEventId,
    connection_id: connectionId,
  }));
  const { error: insertError } = await supabase.from("sales_line_items").insert(rows);
  if (insertError) {
    return { ok: false, inserted: 0, error: `sales line insert failed: ${insertError.message}` };
  }

  return { ok: true, inserted: rows.length };
}

type WinerimSalesImportOutcome = {
  attempted: boolean;
  ok: boolean;
  qty: number;
  live?: boolean;
  orderId?: string;
  status?: number;
  imported?: number;
  skipped?: number;
  failed?: number;
  stockApplied?: boolean;
  retryable?: boolean;
  attempts?: number;
  response?: unknown;
  error?: string;
};

function stableShortHash(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function shortExternalId(value: unknown, maxLength = 10): string {
  const cleaned = String(value ?? "").replace(/[^a-zA-Z0-9]/g, "");
  return (cleaned || "x").slice(0, maxLength);
}

function buildWinerimSalesImportOrderId(input: {
  connectionId: string;
  day: string;
  wineId: string;
  variant: WinerimVariant;
  scope: string;
}): string {
  const variantShort = input.variant === "botella" ? "bot" : input.variant === "copa" ? "cop" : "mag";
  return [
    "agora",
    shortExternalId(input.connectionId, 8),
    input.day,
    input.wineId,
    variantShort,
    shortExternalId(stableShortHash(input.scope), 10),
  ].join(":");
}

async function waitForWinerimRetry(attempt: number): Promise<void> {
  if (attempt <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

function readWinerimStockActive(stock: Record<string, unknown>): boolean {
  const value = stock.stockActive ?? stock.stock_active ?? stock.active;
  if (value === undefined || value === null || value === "") return true;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "y", "si", "sí"].includes(normalized)) return true;
  if (["false", "0", "no", "n"].includes(normalized)) return false;
  return true;
}

async function postWinerimSalesImportWithRetry(input: {
  winerimBase: string;
  winerimHeaders: Record<string, string>;
  sales: WinerimSalesImportSale[];
  variant: WinerimVariant;
  live: boolean;
  mode: WinerimSalesImportMode;
}): Promise<Omit<WinerimSalesImportOutcome, "attempted" | "qty" | "orderId" | "live">> {
  let pendingSales = input.sales;
  let attempts = 0;
  let lastStatus: number | undefined;
  let lastParsed: unknown;
  let lastText = "";

  while (attempts < WINERIM_SALES_IMPORT_MAX_ATTEMPTS && pendingSales.length > 0) {
    attempts++;
    if (attempts > 1) await waitForWinerimRetry(attempts - 1);

    try {
      const response = await fetch(`${input.winerimBase}/sales/import`, {
        method: "POST",
        headers: input.winerimHeaders,
        body: JSON.stringify({
          ...(input.live ? { live: true } : {}),
          sales: pendingSales,
        }),
      });
      lastStatus = response.status;
      lastText = await response.text();
      try {
        lastParsed = JSON.parse(lastText);
      } catch (_) {
        lastParsed = { raw: lastText.substring(0, 300) };
      }

      if (response.status === 409 && attempts < WINERIM_SALES_IMPORT_MAX_ATTEMPTS) {
        continue;
      }

      const retryableSales = response.ok
        ? retryableWinerimSalesImportSales(pendingSales, lastParsed)
        : [];
      if (retryableSales.length > 0 && attempts < WINERIM_SALES_IMPORT_MAX_ATTEMPTS) {
        pendingSales = retryableSales;
        continue;
      }

      const assessed = assessWinerimSalesImportResponse({
        status: response.status,
        response: lastParsed,
        sales: pendingSales,
        variant: input.variant,
        live: input.live,
        mode: input.mode,
      });
      return {
        ok: assessed.ok,
        status: response.status,
        imported: assessed.imported,
        skipped: assessed.skipped,
        failed: assessed.failed,
        stockApplied: assessed.stockApplied,
        retryable: assessed.retryable,
        attempts,
        response: lastParsed,
        error: assessed.ok ? undefined : `${assessed.error}: ${lastText.substring(0, 300)}`,
      };
    } catch (e) {
      return {
        ok: false,
        retryable: true,
        attempts,
        error: `POST /sales/import exception: ${String(e)}`,
      };
    }
  }

  const assessed = assessWinerimSalesImportResponse({
    status: lastStatus || 0,
    response: lastParsed,
    sales: pendingSales,
    variant: input.variant,
    live: input.live,
    mode: input.mode,
  });
  return {
    ok: false,
    status: lastStatus,
    imported: assessed.imported,
    skipped: assessed.skipped,
    failed: assessed.failed,
    stockApplied: assessed.stockApplied,
    retryable: assessed.retryable,
    attempts,
    response: lastParsed,
    error: assessed.error || `POST /sales/import failed after ${attempts} attempts: ${lastText.substring(0, 300)}`,
  };
}

async function importWinerimSalesOnly(input: {
  winerimBase: string;
  winerimHeaders: Record<string, string>;
  connectionId: string;
  day: string;
  soldAt?: string | null;
  wineId: string;
  variant: WinerimVariant;
  stockId: number;
  soldQty: number;
  orderScope: string;
}): Promise<WinerimSalesImportOutcome> {
  const qty = Math.ceil(Math.abs(Number(input.soldQty || 0)));
  if (qty <= 0) return { attempted: false, ok: true, qty: 0 };

  const orderId = buildWinerimSalesImportOrderId({
    connectionId: input.connectionId,
    day: input.day,
    wineId: input.wineId,
    variant: input.variant,
    scope: input.orderScope,
  });

  const result = await postWinerimSalesImportWithRetry({
    winerimBase: input.winerimBase,
    winerimHeaders: input.winerimHeaders,
    variant: input.variant,
    live: false,
    mode: "historical",
    sales: [{
      stockId: input.stockId,
      qty,
      soldAt: normalizeProviderSoldAt(input.soldAt) || input.day,
      orderId,
    }],
  });
  return {
    attempted: true,
    ok: result.ok,
    qty,
    live: false,
    orderId,
    ...result,
  };
}

async function importWinerimSaleIfStockDidNotMove(input: {
  winerimBase: string;
  winerimHeaders: Record<string, string>;
  connectionId: string;
  day: string;
  soldAt?: string | null;
  wineId: string;
  variant: WinerimVariant;
  stockId: number;
  soldQty: number;
  previousStock: number;
  newStock: number;
  orderScope: string;
}): Promise<WinerimSalesImportOutcome> {
  const live = input.variant === "copa";
  const qty = live
    ? Math.ceil(Number(input.soldQty || 0))
    : salesImportQtyWhenStockDidNotMove({
      soldQty: input.soldQty,
      previousStock: input.previousStock,
      newStock: input.newStock,
    });
  if (qty <= 0) return { attempted: false, ok: true, qty: 0 };
  const orderId = buildWinerimSalesImportOrderId({
    connectionId: input.connectionId,
    day: input.day,
    wineId: input.wineId,
    variant: input.variant,
    scope: input.orderScope,
  });

  const result = await postWinerimSalesImportWithRetry({
    winerimBase: input.winerimBase,
    winerimHeaders: input.winerimHeaders,
    variant: input.variant,
    live,
    mode: "operational",
    sales: [{
      stockId: input.stockId,
      qty,
      soldAt: normalizeProviderSoldAt(input.soldAt) || input.day,
      orderId,
    }],
  });
  return {
    attempted: true,
    qty,
    live,
    orderId,
    ...result,
  };
}

// ── Winerim Stock Sync Helper (variant-aware, line-idempotent) ──
// Winerim API v2: each wine exposes prices[] with variants ("copa","botella","magnum") and
// each variant has its own erpStock.id. We must update the correct stockId per variant with
// INTEGER quantities (Winerim rejects decimals). No more fractional bottle conversion.
// deno-lint-ignore no-explicit-any
async function syncStockForDay(supabase: any, connectionId: string, day: string, winerimToken: string) {
  const { data: connection, error: connectionError } = await supabase
    .from("pos_connections")
    .select("provider_config")
    .eq("id", connectionId)
    .single();
  if (connectionError) {
    throw new Error(`Could not read stock sync configuration: ${connectionError.message}`);
  }
  const stockSyncStartDate = configuredStockSyncStartDate(connection?.provider_config);
  const stockSyncStartAt = configuredStockSyncStartAt(connection?.provider_config);
  if (stockSyncStartDate && day < stockSyncStartDate) {
    return {
      synced: 0,
      skipped: 0,
      failed: 0,
      message: `Stock sync skipped before configured stock_sync_start_date (${stockSyncStartDate})`,
      stockSyncStartDate,
    };
  }

  const WINERIM_BASE = "https://app.winerim.com/api/v2";
  const winerimHeaders = {
    "WINERIM-API-TOKEN": winerimToken,
    "Content-Type": "application/json",
    "Accept": "application/json",
  };

  const { data: events, error: eventsError } = await supabase
    .from("sales_events").select("id, raw_json, doc_type")
    .eq("connection_id", connectionId).eq("business_day", day);
  if (eventsError) throw new Error(`sales_events lookup failed: ${eventsError.message}`);

  const eligibleEvents = (events || []).filter((event: { raw_json?: unknown }) => !rawJsonDisablesStockSync(event.raw_json));

  if (eligibleEvents.length === 0) {
    return { synced: 0, skipped: 0, failed: 0, message: "No sales events for this day" };
  }

  const eventIds = eligibleEvents.map((e: { id: string }) => e.id);
  const openTicketEventIds = new Set(
    eligibleEvents
      .filter((event: { doc_type?: string | null }) => String(event.doc_type || "").toLowerCase() === "openticket")
      .map((event: { id: string }) => event.id),
  );
  const { data: lines, error: linesError } = await supabase
    .from("sales_line_items")
    .select("id, sales_event_id, name, quantity, winerim_product_id, provider_product_id, is_wine_candidate, format, provider_sold_at")
    .in("sales_event_id", eventIds);
  if (linesError) throw new Error(`sales_line_items lookup failed: ${linesError.message}`);

  if (!lines || lines.length === 0) {
    return { synced: 0, skipped: 0, failed: 0, message: "No line items found" };
  }

  // deno-lint-ignore no-explicit-any
  const mappedLines = (lines as any[]).filter((l: any) =>
    l.winerim_product_id &&
    (l.is_wine_candidate || !openTicketEventIds.has(l.sales_event_id)) &&
    providerSaleIsAfterStockStart(l.provider_sold_at, stockSyncStartAt)
  );

  type Claim = {
    id: string;
    logId: string;
    salesEventId: string;
    winerimWineId: string;
    variant: WinerimVariant;
    qty: number;
    name: string;
    providerProductId: string;
    providerSoldAt: string | null;
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
    providerSoldAt: string | null;
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
      const qty = signedWholeSaleQuantity(line.quantity);
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
  const terminalFailedGroups = new Set<string>();
  const terminalBlockedGroups = new Set<string>();
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

  if (candidateWineIds.length > 0) {
    const recentTerminalCutoff = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    const { data: failedRows } = await supabase
      .from("stock_sync_log")
      .select("sales_event_id, winerim_product_id, variant, error_message")
      .eq("connection_id", connectionId)
      .in("status", ["FAILED", "BLOCKED"])
      .gte("created_at", recentTerminalCutoff)
      .in("sales_event_id", eventIds)
      .in("winerim_product_id", candidateWineIds);
    for (const row of (failedRows || []) as { sales_event_id: string; winerim_product_id: string; variant?: string | null; error_message?: string | null }[]) {
      if (!isTerminalStockSyncError(row.error_message)) continue;
      const rowVariant = normalizeWinerimVariant(row.variant);
      if (!rowVariant) continue;
      terminalFailedGroups.add(buildStockSyncGroupKey(row.sales_event_id, row.winerim_product_id, rowVariant));
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
    if (terminalFailedGroups.has(groupKey)) {
      skipped++;
      terminalBlockedGroups.add(groupKey);
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
      providerSoldAt: normalizeProviderSoldAt(line.provider_sold_at),
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
      existing.providerSoldAt = earlierProviderSoldAt(existing.providerSoldAt, claim.providerSoldAt);
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
        providerSoldAt: claim.providerSoldAt,
      });
    }
  }

  const toProcess = Array.from(aggregated.values());
  let failed = terminalBlockedGroups.size;

  if (toProcess.length === 0) {
    return {
      synced: 0, skipped, failed,
      unmapped: lines.length - mappedLines.length,
      totalLines: lines.length,
      mappedLines: mappedLines.length,
      aggregatedProducts: aggregated.size,
      claimedLines: claimedLines.length,
      terminalBlocked: terminalBlockedGroups.size,
      message: failed > 0 ? "All processable groups already synced; terminal stock failures remain blocked" : "All groups already synced",
    };
  }

  // ── Resolve stockId per (wine,variant) ──
  // We fetch /stock/wine/{id} for every wine we are about to mutate. It is documented,
  // gives both stockId and current stock for every variant, and avoids relying on the
  // undocumented GET /stock/{stockId} baseline read.
  const uniqueWineIds = Array.from(new Set(toProcess.map(p => p.winerimWineId)));
  type StockEntry = { id: number; stock: number; stockActive: boolean; variant: WinerimVariant };
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
            stockActive: readWinerimStockActive(s),
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

  type BulkItem = { id: number; newStock: number; previousStock: number; stockActive: boolean; agg: Agg };
  const bulkItems: BulkItem[] = [];
  let synced = 0;

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
    if (agg.variant === "copa") {
      const salesImport = await importWinerimSaleIfStockDidNotMove({
        winerimBase: WINERIM_BASE,
        winerimHeaders,
        connectionId,
        day,
        wineId: agg.winerimWineId,
        variant: agg.variant,
        stockId: match.id,
        soldQty: agg.qty,
        previousStock,
        newStock,
        soldAt: agg.providerSoldAt,
        orderScope: [
          ...agg.eventIds.slice().sort(),
          ...agg.lineIds.slice().sort(),
          String(agg.qty),
        ].join("|"),
      });
      if (!salesImport.ok) {
        await supabase.from("stock_sync_log").update({
          status: "FAILED",
          stock_id: match.id,
          error_message: salesImport.error || "POST /sales/import live failed for glass sale",
          winerim_response: {
            mode: "glass_live_sales_import",
            previousStock,
            expectedStockWithoutLive: newStock,
            soldQty: agg.qty,
            variant: agg.variant,
            stockId: match.id,
            stockActive: match.stockActive,
            providerSoldAt: agg.providerSoldAt,
            salesImport,
          },
        }).in("id", agg.logIds);
        failed++;
        continue;
      }

      await supabase.from("stock_sync_log").update({
        status: "SUCCESS",
        stock_id: match.id,
        winerim_response: {
          mode: "glass_live_sales_import",
          previousStock,
          expectedStockWithoutLive: newStock,
          soldQty: agg.qty,
          variant: agg.variant,
          stockId: match.id,
          stockActive: match.stockActive,
          providerSoldAt: agg.providerSoldAt,
          salesImport,
        },
        synced_at: new Date().toISOString(),
      }).in("id", agg.logIds);
      synced++;
      continue;
    }

    if (!match.stockActive) {
      const salesImport = await importWinerimSalesOnly({
        winerimBase: WINERIM_BASE,
        winerimHeaders,
        connectionId,
        day,
        wineId: agg.winerimWineId,
        variant: agg.variant,
        stockId: match.id,
        soldQty: agg.qty,
        soldAt: agg.providerSoldAt,
        orderScope: [
          "stock_inactive",
          ...agg.eventIds.slice().sort(),
          ...agg.lineIds.slice().sort(),
          String(agg.qty),
        ].join("|"),
      });
      if (!salesImport.ok) {
        await supabase.from("stock_sync_log").update({
          status: "FAILED",
          stock_id: match.id,
          error_message: salesImport.error || "POST /sales/import failed for inactive stock",
          winerim_response: {
            mode: "sales_only_stock_inactive",
            previousStock,
            newStock: previousStock,
            soldQty: agg.qty,
            variant: agg.variant,
            stockId: match.id,
            stockActive: false,
            providerSoldAt: agg.providerSoldAt,
            salesImport,
          },
        }).in("id", agg.logIds);
        failed++;
        continue;
      }
      await supabase.from("stock_sync_log").update({
        status: "SUCCESS",
        stock_id: match.id,
        winerim_response: {
          mode: "sales_only_stock_inactive",
          previousStock,
          newStock: previousStock,
          soldQty: agg.qty,
          variant: agg.variant,
          stockId: match.id,
          stockActive: false,
          providerSoldAt: agg.providerSoldAt,
          salesImport,
        },
        synced_at: new Date().toISOString(),
      }).in("id", agg.logIds);
      synced++;
      continue;
    }
    bulkItems.push({ id: match.id, newStock, previousStock, stockActive: match.stockActive, agg });
  }


  // PUT per stockId (individual). Winerim v2 docs describe /stock/bulk but it is NOT yet
  // deployed in production (returns HTML login page). When Winerim ships it, swap this loop
  // for a chunked PUT to /api/v2/stock/bulk with { items: [{id, stock}] }.
  // Throttle: ~250ms gap → 4 req/s, comfortably under Winerim's 5 req/s rate limit.
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
      const salesImport = await importWinerimSaleIfStockDidNotMove({
        winerimBase: WINERIM_BASE,
        winerimHeaders,
        connectionId,
        day,
        wineId: item.agg.winerimWineId,
        variant: item.agg.variant,
        stockId: item.id,
        soldQty: item.agg.qty,
        previousStock: item.previousStock,
        newStock: item.newStock,
        soldAt: item.agg.providerSoldAt,
        orderScope: [
          ...item.agg.eventIds.slice().sort(),
          ...item.agg.lineIds.slice().sort(),
          String(item.agg.qty),
        ].join("|"),
      });
      if (salesImport.attempted && !salesImport.ok) {
        await supabase.from("stock_sync_log").update({
          status: "FAILED",
          stock_id: item.id,
          error_message: salesImport.error || "POST /sales/import failed after no stock movement",
          winerim_response: {
            previousStock: item.previousStock,
            newStock: item.newStock,
            soldQty: item.agg.qty,
            variant: item.agg.variant,
            stockId: item.id,
            providerSoldAt: item.agg.providerSoldAt,
            stockUpdateResponse: parsed,
            salesImport,
          },
        }).in("id", item.agg.logIds);
        failed++;
        continue;
      }

      await supabase.from("stock_sync_log").update({
        status: "SUCCESS",
        stock_id: item.id,
        winerim_response: {
          previousStock: item.previousStock,
          newStock: item.newStock,
          soldQty: item.agg.qty,
          variant: item.agg.variant,
          stockId: item.id,
          providerSoldAt: item.agg.providerSoldAt,
          salesImport: salesImport.attempted ? salesImport : undefined,
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

// Same stock semantics as syncStockForDay, but suitable for intraday polling.
// It compares the current saved invoice state against successful stock_sync_log
// quantities, then writes only the remaining delta. This lets us re-import an
// open business day safely while Agora invoices keep changing during service.
// deno-lint-ignore no-explicit-any
async function syncStockForDayIncremental(supabase: any, connectionId: string, day: string, winerimToken: string) {
  const { data: connection } = await supabase
    .from("pos_connections")
    .select("provider_config")
    .eq("id", connectionId)
    .single();
  const stockSyncStartDate = configuredStockSyncStartDate(connection?.provider_config);
  const stockSyncStartAt = configuredStockSyncStartAt(connection?.provider_config);
  if (stockSyncStartDate && day < stockSyncStartDate) {
    return {
      synced: 0,
      skipped: 0,
      failed: 0,
      message: `Stock sync skipped before configured stock_sync_start_date (${stockSyncStartDate})`,
      stockSyncStartDate,
    };
  }

  const WINERIM_BASE = "https://app.winerim.com/api/v2";
  const winerimHeaders = {
    "WINERIM-API-TOKEN": winerimToken,
    "Content-Type": "application/json",
    "Accept": "application/json",
  };

  const { data: events } = await supabase
    .from("sales_events")
    .select("id, raw_json, doc_type")
    .eq("connection_id", connectionId)
    .eq("business_day", day);

  const eligibleEvents = (events || []).filter((event: { raw_json?: unknown }) => !rawJsonDisablesStockSync(event.raw_json));
  if (eligibleEvents.length === 0) {
    return { synced: 0, skipped: 0, failed: 0, message: "No sales events for this day" };
  }

  const eventIds = eligibleEvents.map((event: { id: string }) => event.id);
  const openTicketEventIds = new Set(
    eligibleEvents
      .filter((event: { doc_type?: string | null }) => String(event.doc_type || "").toLowerCase() === "openticket")
      .map((event: { id: string }) => event.id),
  );
  const { data: lines } = await supabase
    .from("sales_line_items")
    .select("id, sales_event_id, name, quantity, winerim_product_id, provider_product_id, is_wine_candidate, format, provider_sold_at")
    .in("sales_event_id", eventIds);

  if (!lines || lines.length === 0) {
    return { synced: 0, skipped: 0, failed: 0, message: "No line items found" };
  }

  type DesiredGroup = {
    groupKey: string;
    salesEventId: string;
    winerimWineId: string;
    variant: WinerimVariant;
    desiredQty: number;
    lineIds: string[];
    firstLineId: string;
    name: string;
    providerProductId: string;
    providerSoldAt: string | null;
  };
  type DeltaClaim = DesiredGroup & {
    deltaQty: number;
    alreadyQty: number;
    idempotencyKey: string;
    logId: string;
  };
  type Agg = {
    winerimWineId: string;
    variant: WinerimVariant;
    qty: number;
    logIds: string[];
    groupKeys: string[];
    name: string;
    providerSoldAt: string | null;
  };

  const desiredGroups = new Map<string, DesiredGroup>();
  let mappedLineCount = 0;
  for (const line of lines as any[]) {
    if (!line.winerim_product_id) continue;
    if (openTicketEventIds.has(line.sales_event_id) && !line.is_wine_candidate) continue;
    if (!providerSaleIsAfterStockStart(line.provider_sold_at, stockSyncStartAt)) continue;
    const qty = signedWholeSaleQuantity(line.quantity);
    if (qty === 0) continue;
    mappedLineCount++;
    const variant = variantForAgoraFormat(line.format);
    const groupKey = buildStockSyncGroupKey(line.sales_event_id, line.winerim_product_id, variant);
    const existing = desiredGroups.get(groupKey);
    if (existing) {
      existing.desiredQty += qty;
      existing.lineIds.push(line.id);
      existing.providerSoldAt = earlierProviderSoldAt(existing.providerSoldAt, line.provider_sold_at);
    } else {
      desiredGroups.set(groupKey, {
        groupKey,
        salesEventId: line.sales_event_id,
        winerimWineId: String(line.winerim_product_id),
        variant,
        desiredQty: qty,
        lineIds: [line.id],
        firstLineId: line.id,
        name: String(line.name || ""),
        providerProductId: String(line.provider_product_id || ""),
        providerSoldAt: normalizeProviderSoldAt(line.provider_sold_at),
      });
    }
  }

  for (const [key, group] of desiredGroups.entries()) {
    if (group.desiredQty <= 0) desiredGroups.delete(key);
  }

  if (desiredGroups.size === 0) {
    return {
      synced: 0,
      skipped: 0,
      failed: 0,
      unmapped: (lines as any[]).length,
      totalLines: (lines as any[]).length,
      mappedLines: 0,
      message: "No mapped wine lines found",
    };
  }

  const candidateWineIds = Array.from(new Set(Array.from(desiredGroups.values()).map((group) => group.winerimWineId)));

  const alreadyQtyByGroup = new Map<string, number>();
  for (let i = 0; i < eventIds.length; i += 500) {
    const eventChunk = eventIds.slice(i, i + 500);
    const { data: syncedRows } = await supabase
      .from("stock_sync_log")
      .select("sales_event_id, winerim_product_id, variant, quantity")
      .eq("connection_id", connectionId)
      .eq("status", "SUCCESS")
      .in("sales_event_id", eventChunk)
      .in("winerim_product_id", candidateWineIds);
    for (const row of (syncedRows || []) as { sales_event_id: string; winerim_product_id: string; variant?: string | null; quantity?: number | string | null }[]) {
      const variant = normalizeWinerimVariant(row.variant);
      if (!variant) continue;
      const groupKey = buildStockSyncGroupKey(row.sales_event_id, row.winerim_product_id, variant);
      const qty = Number(row.quantity || 0);
      if (!Number.isFinite(qty)) continue;
      alreadyQtyByGroup.set(groupKey, (alreadyQtyByGroup.get(groupKey) || 0) + qty);
    }
  }
  for (const [key, quantity] of alreadyQtyByGroup.entries()) {
    alreadyQtyByGroup.set(key, Math.max(0, quantity));
  }

  const terminalGroups = new Set<string>();
  const recentTerminalCutoff = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  const { data: failedRows } = await supabase
    .from("stock_sync_log")
    .select("sales_event_id, winerim_product_id, variant, error_message")
    .eq("connection_id", connectionId)
    .in("status", ["FAILED", "BLOCKED"])
    .gte("created_at", recentTerminalCutoff)
    .in("sales_event_id", eventIds)
    .in("winerim_product_id", candidateWineIds);
  for (const row of (failedRows || []) as { sales_event_id: string; winerim_product_id: string; variant?: string | null; error_message?: string | null }[]) {
    if (!isTerminalStockSyncError(row.error_message)) continue;
    const variant = normalizeWinerimVariant(row.variant);
    if (!variant) continue;
    terminalGroups.add(buildStockSyncGroupKey(row.sales_event_id, row.winerim_product_id, variant));
  }

  const stalePendingBefore = new Date(Date.now() - 15 * 60_000).toISOString();
  await supabase
    .from("stock_sync_log")
    .update({ status: "FAILED", error_message: "Stale PENDING intraday claim rescued before retry" })
    .eq("connection_id", connectionId)
    .eq("status", "PENDING")
    .lt("created_at", stalePendingBefore);

  const deltaCandidates = Array.from(desiredGroups.values())
    .map((group) => {
      const alreadyQty = alreadyQtyByGroup.get(group.groupKey) || 0;
      const deltaQty = Math.max(0, group.desiredQty - alreadyQty);
      return {
        ...group,
        alreadyQty,
        deltaQty,
        idempotencyKey: `${connectionId}:${group.groupKey}:target:${group.desiredQty}`,
      };
    })
    .filter((group) => group.deltaQty > 0);

  const idempotencyKeys = deltaCandidates.map((group) => group.idempotencyKey);
  const existingTargetKeys = new Set<string>();
  for (let i = 0; i < idempotencyKeys.length; i += 200) {
    const chunk = idempotencyKeys.slice(i, i + 200);
    const { data: existingRows } = await supabase
      .from("stock_sync_log")
      .select("idempotency_key")
      .eq("connection_id", connectionId)
      .in("status", ["PENDING", "SUCCESS"])
      .in("idempotency_key", chunk);
    for (const row of (existingRows || []) as { idempotency_key: string }[]) {
      existingTargetKeys.add(row.idempotency_key);
    }
  }

  let skipped = desiredGroups.size - deltaCandidates.length;
  let failed = 0;
  const claimed: DeltaClaim[] = [];
  for (const group of deltaCandidates) {
    if (terminalGroups.has(group.groupKey)) {
      skipped++;
      failed++;
      continue;
    }
    if (existingTargetKeys.has(group.idempotencyKey)) {
      skipped++;
      continue;
    }

    const { data: logEntry, error: claimError } = await supabase.from("stock_sync_log").insert({
      connection_id: connectionId,
      sales_event_id: group.salesEventId,
      sales_line_item_id: group.firstLineId,
      provider_product_id: group.providerProductId,
      winerim_product_id: group.winerimWineId,
      product_name: `${group.name} [${group.variant}]`,
      quantity: group.deltaQty,
      variant: group.variant,
      idempotency_key: group.idempotencyKey,
      status: "PENDING",
    }).select("id").single();

    if (claimError || !logEntry?.id) {
      skipped++;
      console.warn(`[sync-stock-intraday] skipped delta group ${group.groupKey}: ${claimError?.message || "no log id"}`);
      continue;
    }

    claimed.push({ ...group, logId: logEntry.id });
  }

  const aggregated = new Map<string, Agg>();
  for (const claim of claimed) {
    const key = `${claim.winerimWineId}::${claim.variant}`;
    const existing = aggregated.get(key);
    if (existing) {
      existing.qty += claim.deltaQty;
      existing.logIds.push(claim.logId);
      existing.groupKeys.push(claim.groupKey);
      existing.providerSoldAt = earlierProviderSoldAt(existing.providerSoldAt, claim.providerSoldAt);
    } else {
      aggregated.set(key, {
        winerimWineId: claim.winerimWineId,
        variant: claim.variant,
        qty: claim.deltaQty,
        logIds: [claim.logId],
        groupKeys: [claim.groupKey],
        name: claim.name,
        providerSoldAt: claim.providerSoldAt,
      });
    }
  }

  const toProcess = Array.from(aggregated.values());
  if (toProcess.length === 0) {
    return {
      synced: 0,
      skipped,
      failed,
      unmapped: (lines as any[]).length - mappedLineCount,
      totalLines: (lines as any[]).length,
      mappedLines: mappedLineCount,
      desiredGroups: desiredGroups.size,
      deltaGroups: deltaCandidates.length,
      claimedGroups: claimed.length,
      message: "All intraday groups already synced",
    };
  }

  type StockEntry = { id: number; stock: number; stockActive: boolean; variant: WinerimVariant };
  const wineStockCache = new Map<string, StockEntry[]>();
  const wineFetchErrors = new Map<string, string>();
  const uniqueWineIds = Array.from(new Set(toProcess.map((item) => item.winerimWineId)));

  for (const wineId of uniqueWineIds) {
    try {
      const r = await fetch(`${WINERIM_BASE}/stock/wine/${wineId}`, { method: "GET", headers: winerimHeaders });
      if (!r.ok) {
        wineFetchErrors.set(wineId, `GET /stock/wine/${wineId} → ${r.status}: ${(await r.text()).substring(0, 200)}`);
        continue;
      }
      const data = await r.json();
      const normalized = parseWinerimStockRows(data)
        .map((stock) => {
          const canonical = findStockForVariant([stock], "copa")
            ? "copa"
            : findStockForVariant([stock], "botella")
              ? "botella"
              : findStockForVariant([stock], "magnum")
                ? "magnum"
                : null;
          return {
            id: Number(stock.id),
            stock: Number(stock.stock ?? 0),
            stockActive: readWinerimStockActive(stock),
            variant: canonical,
          };
        })
        .filter((stock): stock is StockEntry => Number.isFinite(stock.id) && stock.id > 0 && !!stock.variant);
      wineStockCache.set(wineId, normalized);

      const upd: Record<string, number> = {};
      const bId = normalized.find((stock) => stock.variant === "botella")?.id;
      const gId = normalized.find((stock) => stock.variant === "copa")?.id;
      const mId = normalized.find((stock) => stock.variant === "magnum")?.id;
      if (bId) upd.bottle_stock_id = bId;
      if (gId) upd.glass_stock_id = gId;
      if (mId) upd.magnum_stock_id = mId;
      if (Object.keys(upd).length > 0) {
        await supabase.from("winerim_wines").update(upd)
          .eq("connection_id", connectionId)
          .eq("winerim_id", wineId);
      }
    } catch (e) {
      wineFetchErrors.set(wineId, String(e));
    }
  }

  type BulkItem = { id: number; newStock: number; previousStock: number; stockActive: boolean; agg: Agg };
  const bulkItems: BulkItem[] = [];
  let synced = 0;
  for (const agg of toProcess) {
    const fetchedStocks = wineStockCache.get(agg.winerimWineId);
    const match = fetchedStocks?.find((stock) => stock.variant === agg.variant);
    if (!match) {
      const err = wineFetchErrors.get(agg.winerimWineId) || `Variant '${agg.variant}' not found for wine ${agg.winerimWineId}`;
      await supabase.from("stock_sync_log").update({ status: "FAILED", error_message: err }).in("id", agg.logIds);
      failed++;
      continue;
    }
    const previousStock = match.stock;
    const newStock = Math.max(0, Math.floor(previousStock - agg.qty));
    if (agg.variant === "copa") {
      const salesImport = await importWinerimSaleIfStockDidNotMove({
        winerimBase: WINERIM_BASE,
        winerimHeaders,
        connectionId,
        day,
        wineId: agg.winerimWineId,
        variant: agg.variant,
        stockId: match.id,
        soldQty: agg.qty,
        previousStock,
        newStock,
        soldAt: agg.providerSoldAt,
        orderScope: [
          ...agg.groupKeys.slice().sort(),
          String(agg.qty),
        ].join("|"),
      });
      if (!salesImport.ok) {
        await supabase.from("stock_sync_log").update({
          status: "FAILED",
          stock_id: match.id,
          error_message: salesImport.error || "POST /sales/import live failed for glass sale",
          winerim_response: {
            mode: "intraday_incremental_glass_live_sales_import",
            previousStock,
            expectedStockWithoutLive: newStock,
            soldQty: agg.qty,
            variant: agg.variant,
            stockId: match.id,
            stockActive: match.stockActive,
            groupKeys: agg.groupKeys,
            providerSoldAt: agg.providerSoldAt,
            salesImport,
          },
        }).in("id", agg.logIds);
        failed++;
        continue;
      }

      await supabase.from("stock_sync_log").update({
        status: "SUCCESS",
        stock_id: match.id,
        winerim_response: {
          mode: "intraday_incremental_glass_live_sales_import",
          previousStock,
          expectedStockWithoutLive: newStock,
          soldQty: agg.qty,
          variant: agg.variant,
          stockId: match.id,
          stockActive: match.stockActive,
          groupKeys: agg.groupKeys,
          providerSoldAt: agg.providerSoldAt,
          salesImport,
        },
        synced_at: new Date().toISOString(),
      }).in("id", agg.logIds);
      synced++;
      continue;
    }

    if (!match.stockActive) {
      const salesImport = await importWinerimSalesOnly({
        winerimBase: WINERIM_BASE,
        winerimHeaders,
        connectionId,
        day,
        wineId: agg.winerimWineId,
        variant: agg.variant,
        stockId: match.id,
        soldQty: agg.qty,
        soldAt: agg.providerSoldAt,
        orderScope: [
          "stock_inactive",
          ...agg.groupKeys.slice().sort(),
          String(agg.qty),
        ].join("|"),
      });
      if (!salesImport.ok) {
        await supabase.from("stock_sync_log").update({
          status: "FAILED",
          stock_id: match.id,
          error_message: salesImport.error || "POST /sales/import failed for inactive stock",
          winerim_response: {
            mode: "sales_only_stock_inactive",
            previousStock: match.stock,
            newStock: match.stock,
            soldQty: agg.qty,
            variant: agg.variant,
            stockId: match.id,
            stockActive: false,
            groupKeys: agg.groupKeys,
            providerSoldAt: agg.providerSoldAt,
            salesImport,
          },
        }).in("id", agg.logIds);
        failed++;
        continue;
      }
      await supabase.from("stock_sync_log").update({
        status: "SUCCESS",
        stock_id: match.id,
        winerim_response: {
          mode: "sales_only_stock_inactive",
          previousStock: match.stock,
          newStock: match.stock,
          soldQty: agg.qty,
          variant: agg.variant,
          stockId: match.id,
          stockActive: false,
          groupKeys: agg.groupKeys,
          providerSoldAt: agg.providerSoldAt,
          salesImport,
        },
        synced_at: new Date().toISOString(),
      }).in("id", agg.logIds);
      synced++;
      continue;
    }
    bulkItems.push({
      id: match.id,
      previousStock,
      newStock,
      stockActive: match.stockActive,
      agg,
    });
  }

  for (let i = 0; i < bulkItems.length; i++) {
    const item = bulkItems[i];
    let r: Response;
    let txt = "";
    let parsed: unknown;
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
        status: "FAILED",
        error_message: `PUT exception: ${String(e)}`,
        stock_id: item.id,
      }).in("id", item.agg.logIds);
      failed++;
      continue;
    }

    if (r.ok) {
      const salesImport = await importWinerimSaleIfStockDidNotMove({
        winerimBase: WINERIM_BASE,
        winerimHeaders,
        connectionId,
        day,
        wineId: item.agg.winerimWineId,
        variant: item.agg.variant,
        stockId: item.id,
        soldQty: item.agg.qty,
        previousStock: item.previousStock,
        newStock: item.newStock,
        soldAt: item.agg.providerSoldAt,
        orderScope: [
          ...item.agg.groupKeys.slice().sort(),
          String(item.agg.qty),
        ].join("|"),
      });
      if (salesImport.attempted && !salesImport.ok) {
        await supabase.from("stock_sync_log").update({
          status: "FAILED",
          stock_id: item.id,
          error_message: salesImport.error || "POST /sales/import failed after no stock movement",
          winerim_response: {
            mode: "intraday_incremental_delta",
            previousStock: item.previousStock,
            newStock: item.newStock,
            soldQty: item.agg.qty,
            variant: item.agg.variant,
            stockId: item.id,
            groupKeys: item.agg.groupKeys,
            providerSoldAt: item.agg.providerSoldAt,
            stockUpdateResponse: parsed,
            salesImport,
          },
        }).in("id", item.agg.logIds);
        failed++;
        continue;
      }

      await supabase.from("stock_sync_log").update({
        status: "SUCCESS",
        stock_id: item.id,
        winerim_response: {
          mode: "intraday_incremental_delta",
          previousStock: item.previousStock,
          newStock: item.newStock,
          soldQty: item.agg.qty,
          variant: item.agg.variant,
          stockId: item.id,
          groupKeys: item.agg.groupKeys,
          providerSoldAt: item.agg.providerSoldAt,
          salesImport: salesImport.attempted ? salesImport : undefined,
        },
        synced_at: new Date().toISOString(),
      }).in("id", item.agg.logIds);
      synced++;
      console.log(`[sync-stock-intraday] ${item.agg.name} [${item.agg.variant}]: ${item.previousStock} → ${item.newStock} (-${item.agg.qty})`);
    } else {
      await supabase.from("stock_sync_log").update({
        status: "FAILED",
        stock_id: item.id,
        error_message: `PUT /stock/${item.id} failed (${r.status}): ${txt.substring(0, 300)}`,
        winerim_response: parsed,
      }).in("id", item.agg.logIds);
      failed++;
    }

    if (i < bulkItems.length - 1) await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return {
    synced,
    skipped,
    failed,
    unmapped: (lines as any[]).length - mappedLineCount,
    totalLines: (lines as any[]).length,
    mappedLines: mappedLineCount,
    desiredGroups: desiredGroups.size,
    deltaGroups: deltaCandidates.length,
    claimedGroups: claimed.length,
    aggregatedProducts: aggregated.size,
  };
}

// Intraday-safe stock sync. Unlike the legacy incremental implementation, this
// compares totals for the whole business day per wine+variant. That makes it
// resilient to stale duplicate sales_events left by earlier doc-id strategies:
// current Agora state is the desired total, stock_sync_log.SUCCESS is what was
// already discounted, and only the positive delta is sent to Winerim.
// deno-lint-ignore no-explicit-any
async function syncStockForDayIncrementalByDayTotal(
  supabase: any,
  connectionId: string,
  day: string,
  winerimToken: string,
  desiredEventIdsOverride?: string[],
) {
  const { data: connection, error: connectionError } = await supabase
    .from("pos_connections")
    .select("provider_config")
    .eq("id", connectionId)
    .single();
  if (connectionError) {
    throw new Error(`Could not read stock sync configuration: ${connectionError.message}`);
  }
  const stockSyncStartDate = configuredStockSyncStartDate(connection?.provider_config);
  const stockSyncStartAt = configuredStockSyncStartAt(connection?.provider_config);
  if (stockSyncStartDate && day < stockSyncStartDate) {
    return {
      synced: 0,
      skipped: 0,
      failed: 0,
      message: `Stock sync skipped before configured stock_sync_start_date (${stockSyncStartDate})`,
      stockSyncStartDate,
    };
  }

  const { data: dayEvents, error: dayEventsError } = await supabase
    .from("sales_events")
    .select("id, raw_json, doc_type")
    .eq("connection_id", connectionId)
    .eq("business_day", day);
  if (dayEventsError) {
    throw new Error(`Could not read sales events for ${day}: ${dayEventsError.message}`);
  }

  const allDayEventIds = (dayEvents || []).map((event: { id: string }) => event.id);
  const eligibleEvents = (dayEvents || []).filter((event: { raw_json?: unknown }) => !rawJsonDisablesStockSync(event.raw_json));
  const eligibleEventIds = eligibleEvents.map((event: { id: string }) => event.id);
  if (eligibleEventIds.length === 0) {
    return { synced: 0, skipped: 0, failed: 0, message: "No sales events for this day" };
  }

  // When closed invoices exist, they are the definitive desired state for the day.
  // OpenTicket rows can still count as "already synced" below so an open-ticket
  // pre-discount is not applied a second time when the invoice closes.
  const definitiveEventIds = eligibleEvents
    .filter((event: { doc_type?: string | null }) => String(event.doc_type || "").toLowerCase() !== "openticket")
    .map((event: { id: string }) => event.id);
  const desiredEventIds = (desiredEventIdsOverride && desiredEventIdsOverride.length > 0)
    ? desiredEventIdsOverride.filter((id) => eligibleEventIds.includes(id))
    : (definitiveEventIds.length > 0 ? definitiveEventIds : eligibleEventIds);
  if (desiredEventIds.length === 0) {
    return { synced: 0, skipped: 0, failed: 0, message: "No current sales events selected for this day" };
  }
  const definitiveEventIdSet = new Set(definitiveEventIds);
  const desiredSource = desiredEventIds.some((id) => definitiveEventIdSet.has(id)) ? "definitive" : "open_ticket";

  const { data: lines, error: linesError } = await supabase
    .from("sales_line_items")
    .select("id, sales_event_id, name, quantity, winerim_product_id, provider_product_id, is_wine_candidate, format, provider_sold_at")
    .in("sales_event_id", desiredEventIds);
  if (linesError) {
    throw new Error(`Could not read sales lines for ${day}: ${linesError.message}`);
  }

  if (!lines || lines.length === 0) {
    return { synced: 0, skipped: 0, failed: 0, message: "No line items found" };
  }

  type DesiredTotal = {
    key: string;
    winerimWineId: string;
    variant: WinerimVariant;
    desiredQty: number;
    firstEventId: string;
    firstLineId: string;
    providerProductId: string;
    name: string;
    providerSoldAt: string | null;
  };

  const desiredTotals = new Map<string, DesiredTotal>();
  let mappedLineCount = 0;
  for (const line of lines as any[]) {
    if (!line.winerim_product_id) continue;
    if (desiredSource === "open_ticket" && !line.is_wine_candidate) continue;
    if (!providerSaleIsAfterStockStart(line.provider_sold_at, stockSyncStartAt)) continue;
    const qty = signedWholeSaleQuantity(line.quantity);
    if (qty === 0) continue;
    mappedLineCount++;
    const variant = variantForAgoraFormat(line.format);
    const wineId = String(line.winerim_product_id);
    const key = `${wineId}::${variant}`;
    const existing = desiredTotals.get(key);
    if (existing) {
      existing.desiredQty += qty;
      existing.providerSoldAt = earlierProviderSoldAt(existing.providerSoldAt, line.provider_sold_at);
    } else {
      desiredTotals.set(key, {
        key,
        winerimWineId: wineId,
        variant,
        desiredQty: qty,
        firstEventId: line.sales_event_id,
        firstLineId: line.id,
        providerProductId: String(line.provider_product_id || ""),
        name: String(line.name || ""),
        providerSoldAt: normalizeProviderSoldAt(line.provider_sold_at),
      });
    }
  }

  for (const [key, total] of desiredTotals.entries()) {
    if (total.desiredQty <= 0) desiredTotals.delete(key);
  }

  if (desiredTotals.size === 0) {
    return {
      synced: 0,
      skipped: 0,
      failed: 0,
      unmapped: (lines as any[]).length,
      totalLines: (lines as any[]).length,
      mappedLines: 0,
      message: "No mapped wine lines found",
    };
  }

  const candidateWineIds = Array.from(new Set(Array.from(desiredTotals.values()).map((total) => total.winerimWineId)));
  const alreadyQtyByTotal = new Map<string, number>();
  for (let i = 0; i < allDayEventIds.length; i += 500) {
    const eventChunk = allDayEventIds.slice(i, i + 500);
    const { data: syncedRows } = await supabase
      .from("stock_sync_log")
      .select("winerim_product_id, variant, quantity")
      .eq("connection_id", connectionId)
      .eq("status", "SUCCESS")
      .in("sales_event_id", eventChunk)
      .in("winerim_product_id", candidateWineIds);
    for (const row of (syncedRows || []) as { winerim_product_id: string; variant?: string | null; quantity?: number | string | null }[]) {
      const variant = normalizeWinerimVariant(row.variant);
      if (!variant) continue;
      const key = `${row.winerim_product_id}::${variant}`;
      const qty = Number(row.quantity || 0);
      if (!Number.isFinite(qty)) continue;
      alreadyQtyByTotal.set(key, (alreadyQtyByTotal.get(key) || 0) + qty);
    }
  }
  for (const [key, quantity] of alreadyQtyByTotal.entries()) {
    alreadyQtyByTotal.set(key, Math.max(0, quantity));
  }

  const terminalTotals = new Set<string>();
  const recentTerminalCutoff = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  const { data: failedRows } = await supabase
    .from("stock_sync_log")
    .select("winerim_product_id, variant, error_message")
    .eq("connection_id", connectionId)
    .in("status", ["FAILED", "BLOCKED"])
    .gte("created_at", recentTerminalCutoff)
    .in("sales_event_id", allDayEventIds)
    .in("winerim_product_id", candidateWineIds);
  for (const row of (failedRows || []) as { winerim_product_id: string; variant?: string | null; error_message?: string | null }[]) {
    if (!isTerminalStockSyncError(row.error_message)) continue;
    const variant = normalizeWinerimVariant(row.variant);
    if (!variant) continue;
    terminalTotals.add(`${row.winerim_product_id}::${variant}`);
  }

  const stalePendingBefore = new Date(Date.now() - 15 * 60_000).toISOString();
  await supabase
    .from("stock_sync_log")
    .update({ status: "FAILED", error_message: "Stale PENDING intraday total claim rescued before retry" })
    .eq("connection_id", connectionId)
    .eq("status", "PENDING")
    .lt("created_at", stalePendingBefore);

  type DeltaTotal = DesiredTotal & { alreadyQty: number; deltaQty: number; idempotencyKey: string; logId: string };
  const deltaCandidates = Array.from(desiredTotals.values())
    .map((total) => {
      const alreadyQty = alreadyQtyByTotal.get(total.key) || 0;
      const deltaQty = Math.max(0, total.desiredQty - alreadyQty);
      return {
        ...total,
        alreadyQty,
        deltaQty,
        idempotencyKey: `${connectionId}:${day}:${total.winerimWineId}:${total.variant}:target:${total.desiredQty}:source:${desiredSource}`,
      };
    })
    .filter((total) => total.deltaQty > 0);

  const existingTargetKeys = new Set<string>();
  const idempotencyKeys = deltaCandidates.map((total) => total.idempotencyKey);
  for (let i = 0; i < idempotencyKeys.length; i += 200) {
    const chunk = idempotencyKeys.slice(i, i + 200);
    const { data: existingRows } = await supabase
      .from("stock_sync_log")
      .select("idempotency_key")
      .eq("connection_id", connectionId)
      .in("status", ["PENDING", "SUCCESS", "SKIPPED"])
      .in("idempotency_key", chunk);
    for (const row of (existingRows || []) as { idempotency_key: string }[]) {
      existingTargetKeys.add(row.idempotency_key);
    }
  }

  let skipped = desiredTotals.size - deltaCandidates.length;
  let failed = 0;
  const claimed: DeltaTotal[] = [];
  for (const total of deltaCandidates) {
    if (terminalTotals.has(total.key)) {
      skipped++;
      failed++;
      continue;
    }
    if (existingTargetKeys.has(total.idempotencyKey)) {
      skipped++;
      continue;
    }
    const { data: logEntry, error: claimError } = await supabase.from("stock_sync_log").insert({
      connection_id: connectionId,
      sales_event_id: total.firstEventId,
      sales_line_item_id: total.firstLineId,
      provider_product_id: total.providerProductId,
      winerim_product_id: total.winerimWineId,
      product_name: `${total.name} [${total.variant}]`,
      quantity: total.deltaQty,
      variant: total.variant,
      idempotency_key: total.idempotencyKey,
      status: "PENDING",
    }).select("id").single();
    if (claimError || !logEntry?.id) {
      skipped++;
      console.warn(`[sync-stock-intraday-total] skipped ${total.key}: ${claimError?.message || "no log id"}`);
      continue;
    }
    claimed.push({ ...total, logId: logEntry.id });
  }

  if (claimed.length === 0) {
    return {
      synced: 0,
      skipped,
      failed,
      unmapped: (lines as any[]).length - mappedLineCount,
      totalLines: (lines as any[]).length,
      mappedLines: mappedLineCount,
      desiredTotals: desiredTotals.size,
      deltaTotals: deltaCandidates.length,
      claimedTotals: 0,
      message: "All intraday totals already synced",
    };
  }

  const WINERIM_BASE = "https://app.winerim.com/api/v2";
  const winerimHeaders = {
    "WINERIM-API-TOKEN": winerimToken,
    "Content-Type": "application/json",
    "Accept": "application/json",
  };
  type StockEntry = { id: number; stock: number; stockActive: boolean; variant: WinerimVariant };
  const wineStockCache = new Map<string, StockEntry[]>();
  const wineFetchErrors = new Map<string, string>();
  for (const wineId of Array.from(new Set(claimed.map((claim) => claim.winerimWineId)))) {
    try {
      const r = await fetch(`${WINERIM_BASE}/stock/wine/${wineId}`, { method: "GET", headers: winerimHeaders });
      if (!r.ok) {
        wineFetchErrors.set(wineId, `GET /stock/wine/${wineId} → ${r.status}: ${(await r.text()).substring(0, 200)}`);
        continue;
      }
      const data = await r.json();
      const normalized = parseWinerimStockRows(data)
        .map((stock) => {
          const canonical = findStockForVariant([stock], "copa")
            ? "copa"
            : findStockForVariant([stock], "botella")
              ? "botella"
              : findStockForVariant([stock], "magnum")
                ? "magnum"
                : null;
          return {
            id: Number(stock.id),
            stock: Number(stock.stock ?? 0),
            stockActive: readWinerimStockActive(stock),
            variant: canonical,
          };
        })
        .filter((stock): stock is StockEntry => Number.isFinite(stock.id) && stock.id > 0 && !!stock.variant);
      wineStockCache.set(wineId, normalized);
    } catch (e) {
      wineFetchErrors.set(wineId, String(e));
    }
  }

  let synced = 0;
  for (let i = 0; i < claimed.length; i++) {
    const claim = claimed[i];
    const match = wineStockCache.get(claim.winerimWineId)?.find((stock) => stock.variant === claim.variant);
    if (!match) {
      const err = wineFetchErrors.get(claim.winerimWineId) || `Variant '${claim.variant}' not found for wine ${claim.winerimWineId}`;
      await supabase.from("stock_sync_log").update({ status: "FAILED", error_message: err }).eq("id", claim.logId);
      failed++;
      continue;
    }

    const previousStock = match.stock;
    const newStock = Math.max(0, Math.floor(previousStock - claim.deltaQty));
    if (claim.variant === "copa") {
      const salesImport = await importWinerimSaleIfStockDidNotMove({
        winerimBase: WINERIM_BASE,
        winerimHeaders,
        connectionId,
        day,
        wineId: claim.winerimWineId,
        variant: claim.variant,
        stockId: match.id,
        soldQty: claim.deltaQty,
        previousStock,
        newStock,
        soldAt: claim.providerSoldAt,
        orderScope: claim.idempotencyKey,
      });
      if (!salesImport.ok) {
        await supabase.from("stock_sync_log").update({
          status: "FAILED",
          stock_id: match.id,
          error_message: salesImport.error || "POST /sales/import live failed for glass sale",
          winerim_response: {
            mode: "intraday_day_total_glass_live_sales_import",
            previousStock,
            expectedStockWithoutLive: newStock,
            soldQty: claim.deltaQty,
            desiredQty: claim.desiredQty,
            alreadySyncedQty: claim.alreadyQty,
            variant: claim.variant,
            stockId: match.id,
            stockActive: match.stockActive,
            businessDay: day,
            providerSoldAt: claim.providerSoldAt,
            salesImport,
          },
        }).eq("id", claim.logId);
        failed++;
        continue;
      }

      await supabase.from("stock_sync_log").update({
        status: "SUCCESS",
        stock_id: match.id,
        winerim_response: {
          mode: "intraday_day_total_glass_live_sales_import",
          previousStock,
          expectedStockWithoutLive: newStock,
          soldQty: claim.deltaQty,
          desiredQty: claim.desiredQty,
          alreadySyncedQty: claim.alreadyQty,
          variant: claim.variant,
          stockId: match.id,
          stockActive: match.stockActive,
          businessDay: day,
          providerSoldAt: claim.providerSoldAt,
          salesImport,
        },
        synced_at: new Date().toISOString(),
      }).eq("id", claim.logId);
      synced++;
      console.log(`[sync-stock-intraday-total] ${claim.name} [${claim.variant}]: live sales/import applied for ${claim.deltaQty}`);
      continue;
    }

    if (!match.stockActive) {
      if (desiredSource === "open_ticket") {
        await supabase.from("stock_sync_log").update({
          status: "SKIPPED",
          stock_id: match.id,
          error_message: null,
          winerim_response: {
            mode: "open_ticket_sales_only_deferred_to_invoice",
            previousStock,
            newStock: previousStock,
            soldQty: 0,
            desiredQty: claim.desiredQty,
            alreadySyncedQty: claim.alreadyQty,
            variant: claim.variant,
            stockId: match.id,
            stockActive: false,
            businessDay: day,
            providerSoldAt: claim.providerSoldAt,
            reason: "Inactive stock sales history cannot be reversed; wait for a definitive invoice",
          },
          synced_at: new Date().toISOString(),
        }).eq("id", claim.logId);
        skipped++;
        continue;
      }
      const salesImport = await importWinerimSalesOnly({
        winerimBase: WINERIM_BASE,
        winerimHeaders,
        connectionId,
        day,
        wineId: claim.winerimWineId,
        variant: claim.variant,
        stockId: match.id,
        soldQty: claim.deltaQty,
        soldAt: claim.providerSoldAt,
        orderScope: `stock_inactive:${claim.idempotencyKey}`,
      });
      if (!salesImport.ok) {
        await supabase.from("stock_sync_log").update({
          status: "FAILED",
          stock_id: match.id,
          error_message: salesImport.error || "POST /sales/import failed for inactive stock",
          winerim_response: {
            mode: "sales_only_stock_inactive",
            previousStock,
            newStock: previousStock,
            soldQty: claim.deltaQty,
            desiredQty: claim.desiredQty,
            alreadySyncedQty: claim.alreadyQty,
            variant: claim.variant,
            stockId: match.id,
            stockActive: false,
            businessDay: day,
            providerSoldAt: claim.providerSoldAt,
            salesImport,
          },
        }).eq("id", claim.logId);
        failed++;
        continue;
      }
      await supabase.from("stock_sync_log").update({
        status: "SUCCESS",
        stock_id: match.id,
        winerim_response: {
          mode: "sales_only_stock_inactive",
          previousStock,
          newStock: previousStock,
          soldQty: claim.deltaQty,
          desiredQty: claim.desiredQty,
          alreadySyncedQty: claim.alreadyQty,
          variant: claim.variant,
          stockId: match.id,
          stockActive: false,
          businessDay: day,
          providerSoldAt: claim.providerSoldAt,
          salesImport,
        },
        synced_at: new Date().toISOString(),
      }).eq("id", claim.logId);
      synced++;
      continue;
    }
    let r: Response;
    let txt = "";
    let parsed: unknown;
    try {
      r = await fetch(`${WINERIM_BASE}/stock/${match.id}`, {
        method: "PUT",
        headers: winerimHeaders,
        body: JSON.stringify({ stock: newStock }),
      });
      txt = await r.text();
      try { parsed = JSON.parse(txt); } catch (_) { parsed = { raw: txt.substring(0, 300) }; }
    } catch (e) {
      await supabase.from("stock_sync_log").update({
        status: "FAILED",
        stock_id: match.id,
        error_message: `PUT exception: ${String(e)}`,
      }).eq("id", claim.logId);
      failed++;
      continue;
    }

    if (r.ok) {
      const salesImport = await importWinerimSaleIfStockDidNotMove({
        winerimBase: WINERIM_BASE,
        winerimHeaders,
        connectionId,
        day,
        wineId: claim.winerimWineId,
        variant: claim.variant,
        stockId: match.id,
        soldQty: claim.deltaQty,
        previousStock,
        newStock,
        soldAt: claim.providerSoldAt,
        orderScope: claim.idempotencyKey,
      });
      if (salesImport.attempted && !salesImport.ok) {
        await supabase.from("stock_sync_log").update({
          status: "FAILED",
          stock_id: match.id,
          error_message: salesImport.error || "POST /sales/import failed after no stock movement",
          winerim_response: {
            mode: "intraday_day_total_delta",
            previousStock,
            newStock,
            soldQty: claim.deltaQty,
            desiredQty: claim.desiredQty,
            alreadySyncedQty: claim.alreadyQty,
            variant: claim.variant,
            stockId: match.id,
            businessDay: day,
            providerSoldAt: claim.providerSoldAt,
            stockUpdateResponse: parsed,
            salesImport,
          },
        }).eq("id", claim.logId);
        failed++;
        continue;
      }

      await supabase.from("stock_sync_log").update({
        status: "SUCCESS",
        stock_id: match.id,
        winerim_response: {
          mode: "intraday_day_total_delta",
          previousStock,
          newStock,
          soldQty: claim.deltaQty,
          desiredQty: claim.desiredQty,
          alreadySyncedQty: claim.alreadyQty,
          variant: claim.variant,
          stockId: match.id,
          businessDay: day,
          providerSoldAt: claim.providerSoldAt,
          salesImport: salesImport.attempted ? salesImport : undefined,
        },
        synced_at: new Date().toISOString(),
      }).eq("id", claim.logId);
      synced++;
      console.log(`[sync-stock-intraday-total] ${claim.name} [${claim.variant}]: ${previousStock} → ${newStock} (-${claim.deltaQty})`);
    } else {
      await supabase.from("stock_sync_log").update({
        status: "FAILED",
        stock_id: match.id,
        error_message: `PUT /stock/${match.id} failed (${r.status}): ${txt.substring(0, 300)}`,
        winerim_response: parsed,
      }).eq("id", claim.logId);
      failed++;
    }

    if (i < claimed.length - 1) await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return {
    synced,
    skipped,
    failed,
    unmapped: (lines as any[]).length - mappedLineCount,
    totalLines: (lines as any[]).length,
    mappedLines: mappedLineCount,
    desiredTotals: desiredTotals.size,
    deltaTotals: deltaCandidates.length,
    claimedTotals: claimed.length,
  };
}

type StaleOpenTicketRestoreResult = {
  restored: number;
  skipped: number;
  failed: number;
  checkedEvents: number;
  disabledEvents: number;
  errors: string[];
};

// Open tickets are provisional. If a previous-day open ticket was captured,
// then later disappeared without a matching closed invoice, treat it as
// cancelled and compensate the provisional stock movement with a negative
// stock_sync_log row. Closed invoices still remain the definitive source.
// deno-lint-ignore no-explicit-any
async function restoreStaleOpenTicketStock(
  supabase: any,
  connectionId: string,
  defaultDay: string,
  winerimToken: string,
  providerConfig: Record<string, unknown>,
  currentOpenDocIds: Set<string>,
): Promise<StaleOpenTicketRestoreResult> {
  const result: StaleOpenTicketRestoreResult = {
    restored: 0,
    skipped: 0,
    failed: 0,
    checkedEvents: 0,
    disabledEvents: 0,
    errors: [],
  };
  if (!isStaleOpenTicketRestoreEnabled(providerConfig)) return result;
  if (!winerimToken) {
    result.skipped++;
    result.errors.push("missing Winerim API token");
    return result;
  }

  const lookbackHours = staleOpenTicketRestoreLookbackHours(providerConfig);
  const since = new Date(Date.now() - lookbackHours * 60 * 60_000).toISOString();
  const { data: openEvents } = await supabase
    .from("sales_events")
    .select("id, provider_doc_id, business_day, raw_json, created_at")
    .eq("connection_id", connectionId)
    .eq("doc_type", "OpenTicket")
    .lt("business_day", defaultDay)
    .gte("created_at", since)
    .limit(1000);

  const staleEvents = (openEvents || [])
    .filter((event: { provider_doc_id?: string | null; raw_json?: unknown }) =>
      !currentOpenDocIds.has(String(event.provider_doc_id || "")) && !rawJsonDisablesStockSync(event.raw_json)
    );
  result.checkedEvents = staleEvents.length;
  if (staleEvents.length === 0) return result;

  const eventById = new Map<string, { id: string; business_day: string; raw_json?: unknown }>();
  for (const event of staleEvents as { id: string; business_day: string; raw_json?: unknown }[]) {
    eventById.set(event.id, event);
  }
  const staleEventIds = Array.from(eventById.keys());

  const stockRows: any[] = [];
  for (let i = 0; i < staleEventIds.length; i += 100) {
    const eventChunk = staleEventIds.slice(i, i + 100);
    const { data: chunkRows, error: chunkError } = await supabase
      .from("stock_sync_log")
      .select("id, sales_event_id, sales_line_item_id, provider_product_id, winerim_product_id, product_name, quantity, variant, stock_id")
      .eq("connection_id", connectionId)
      .eq("status", "SUCCESS")
      .in("sales_event_id", eventChunk);
    if (chunkError) {
      result.failed++;
      result.errors.push(`stock_sync_log lookup failed: ${chunkError.message}`);
      return result;
    }
    stockRows.push(...(chunkRows || []));
  }

  const positiveRows: any[] = [];
  const provisionalNetByKey = new Map<string, number>();
  const eventKeys = new Map<string, Set<string>>();
  const eventPositiveQty = new Map<string, number>();

  for (const row of stockRows) {
    const wineId = String(row.winerim_product_id || "");
    const event = eventById.get(String(row.sales_event_id || ""));
    const variant = normalizeWinerimVariant(row.variant);
    const qty = Number(row.quantity || 0);
    if (!event || !wineId || !variant || !Number.isFinite(qty)) continue;
    const key = `${event.business_day}::${wineId}::${variant}`;
    provisionalNetByKey.set(key, (provisionalNetByKey.get(key) || 0) + qty);
    if (!eventKeys.has(event.id)) eventKeys.set(event.id, new Set<string>());
    eventKeys.get(event.id)!.add(key);
    if (qty > 0) {
      positiveRows.push(row);
      eventPositiveQty.set(event.id, (eventPositiveQty.get(event.id) || 0) + qty);
    }
  }

  if (positiveRows.length === 0) return result;

  const days = Array.from(new Set(staleEvents.map((event: { business_day: string }) => event.business_day)));
  const { data: dayEvents } = await supabase
    .from("sales_events")
    .select("id, business_day, doc_type, raw_json")
    .eq("connection_id", connectionId)
    .in("business_day", days);

  const dayByDefinitiveEventId = new Map<string, string>();
  const definitiveEventIds = (dayEvents || [])
    .filter((event: { id: string; business_day: string; doc_type?: string | null; raw_json?: unknown }) =>
      String(event.doc_type || "").toLowerCase() !== "openticket" && !rawJsonDisablesStockSync(event.raw_json)
    )
    .map((event: { id: string; business_day: string }) => {
      dayByDefinitiveEventId.set(event.id, event.business_day);
      return event.id;
    });

  const definitiveQtyByKey = new Map<string, number>();
  for (let i = 0; i < definitiveEventIds.length; i += 100) {
    const chunk = definitiveEventIds.slice(i, i + 100);
    const { data: definitiveLines, error: definitiveLinesError } = await supabase
      .from("sales_line_items")
      .select("sales_event_id, quantity, winerim_product_id, format, is_wine_candidate")
      .eq("connection_id", connectionId)
      .not("winerim_product_id", "is", null)
      .in("sales_event_id", chunk);
    if (definitiveLinesError) {
      result.failed++;
      result.errors.push(`definitive sales_line_items lookup failed: ${definitiveLinesError.message}`);
      return result;
    }

    for (const line of (definitiveLines || []) as any[]) {
      const day = dayByDefinitiveEventId.get(line.sales_event_id);
      const wineId = String(line.winerim_product_id || "");
      const variant = variantForAgoraFormat(line.format);
      const qty = signedWholeSaleQuantity(line.quantity);
      if (!day || !wineId || qty === 0) continue;
      const key = `${day}::${wineId}::${variant}`;
      definitiveQtyByKey.set(key, (definitiveQtyByKey.get(key) || 0) + qty);
    }
  }

  const restoreRemainingByKey = new Map<string, number>();
  for (const [key, rawProvisionalQty] of provisionalNetByKey.entries()) {
    const provisionalQty = Math.max(0, rawProvisionalQty);
    const definitiveQty = Math.max(0, definitiveQtyByKey.get(key) || 0);
    const restoreQty = Math.max(0, provisionalQty - definitiveQty);
    if (restoreQty > 0) restoreRemainingByKey.set(key, restoreQty);
  }
  if (restoreRemainingByKey.size === 0) return result;

  const WINERIM_BASE = "https://app.winerim.com/api/v2";
  const winerimHeaders = {
    "WINERIM-API-TOKEN": winerimToken,
    "Content-Type": "application/json",
    "Accept": "application/json",
  };
  type StockEntry = { id: number; stock: number; stockActive: boolean; variant: WinerimVariant };
  const stockCache = new Map<string, StockEntry[]>();
  const fetchStockRows = async (wineId: string): Promise<StockEntry[]> => {
    if (stockCache.has(wineId)) return stockCache.get(wineId)!;
    const response = await fetch(`${WINERIM_BASE}/stock/wine/${wineId}`, { method: "GET", headers: winerimHeaders });
    if (!response.ok) {
      throw new Error(`GET /stock/wine/${wineId} → ${response.status}: ${(await response.text()).substring(0, 200)}`);
    }
    const data = await response.json();
    const normalized = parseWinerimStockRows(data)
      .map((stock) => {
        const canonical = findStockForVariant([stock], "copa")
          ? "copa"
          : findStockForVariant([stock], "botella")
            ? "botella"
            : findStockForVariant([stock], "magnum")
              ? "magnum"
              : null;
        return {
          id: Number(stock.id),
          stock: Number(stock.stock ?? 0),
          stockActive: readWinerimStockActive(stock),
          variant: canonical,
        };
      })
      .filter((stock): stock is StockEntry => Number.isFinite(stock.id) && stock.id > 0 && !!stock.variant);
    stockCache.set(wineId, normalized);
    return normalized;
  };

  const restoredByEvent = new Map<string, number>();
  const restoredByKey = new Map<string, number>();
  for (const row of positiveRows) {
    const event = eventById.get(String(row.sales_event_id || ""));
    const wineId = String(row.winerim_product_id || "");
    const variant = normalizeWinerimVariant(row.variant);
    const rowQty = Math.max(0, Number(row.quantity || 0));
    if (!event || !wineId || !variant || rowQty <= 0) continue;
    const key = `${event.business_day}::${wineId}::${variant}`;
    const remaining = restoreRemainingByKey.get(key) || 0;
    if (remaining <= 0) continue;
    const restoreQty = Math.min(rowQty, remaining);
    const idempotencyKey = `${connectionId}:${key}:open_ticket_reversal:${stableShortHash(String(row.id))}:qty:${restoreQty}`;

    let match: StockEntry | undefined;
    try {
      match = (await fetchStockRows(wineId)).find((stock) => stock.variant === variant);
    } catch (e) {
      result.failed++;
      result.errors.push(String(e));
      continue;
    }

    if (!match) {
      result.failed++;
      result.errors.push(`Variant '${variant}' not found for wine ${wineId}`);
      continue;
    }

    if (!match.stockActive) {
      const { error: inactiveLogError } = await supabase.from("stock_sync_log").insert({
        connection_id: connectionId,
        sales_event_id: row.sales_event_id,
        sales_line_item_id: row.sales_line_item_id,
        provider_product_id: row.provider_product_id,
        winerim_product_id: wineId,
        product_name: `${row.product_name || "Open ticket reversal"} [${variant}]`,
        quantity: 0,
        variant,
        stock_id: match.id,
        idempotency_key: idempotencyKey,
        status: "SUCCESS",
        winerim_response: {
          mode: "open_ticket_reversal_skipped_stock_inactive",
          businessDay: event.business_day,
          restoreQty,
          stockId: match.id,
          variant,
          previousStock: match.stock,
          newStock: match.stock,
          reason: "stock inactive; sales/import history cannot be deleted from middleware",
        },
        synced_at: new Date().toISOString(),
      });
      if (inactiveLogError) {
        result.skipped++;
        continue;
      }
      restoreRemainingByKey.set(key, remaining - restoreQty);
      restoredByEvent.set(event.id, (restoredByEvent.get(event.id) || 0) + restoreQty);
      restoredByKey.set(key, (restoredByKey.get(key) || 0) + restoreQty);
      result.skipped++;
      continue;
    }

    const { data: claim, error: claimError } = await supabase.from("stock_sync_log").insert({
      connection_id: connectionId,
      sales_event_id: row.sales_event_id,
      sales_line_item_id: row.sales_line_item_id,
      provider_product_id: row.provider_product_id,
      winerim_product_id: wineId,
      product_name: `${row.product_name || "Open ticket reversal"} [${variant}]`,
      quantity: -restoreQty,
      variant,
      stock_id: match.id,
      idempotency_key: idempotencyKey,
      status: "PENDING",
    }).select("id").single();
    if (claimError || !claim?.id) {
      result.skipped++;
      continue;
    }

    const previousStock = match.stock;
    const newStock = Math.max(0, Math.floor(previousStock + restoreQty));
    let response: Response;
    let text = "";
    let parsed: unknown;
    try {
      response = await fetch(`${WINERIM_BASE}/stock/${match.id}`, {
        method: "PUT",
        headers: winerimHeaders,
        body: JSON.stringify({ stock: newStock }),
      });
      text = await response.text();
      try { parsed = JSON.parse(text); } catch (_) { parsed = { raw: text.substring(0, 300) }; }
    } catch (e) {
      await supabase.from("stock_sync_log").update({
        status: "FAILED",
        error_message: `PUT exception: ${String(e)}`,
      }).eq("id", claim.id);
      result.failed++;
      continue;
    }

    if (!response.ok) {
      await supabase.from("stock_sync_log").update({
        status: "FAILED",
        error_message: `PUT /stock/${match.id} failed (${response.status}): ${text.substring(0, 300)}`,
        winerim_response: parsed,
      }).eq("id", claim.id);
      result.failed++;
      continue;
    }

    await supabase.from("stock_sync_log").update({
      status: "SUCCESS",
      winerim_response: {
        mode: "open_ticket_cancellation_restore",
        businessDay: event.business_day,
        restoredQty: restoreQty,
        provisionalQty: provisionalNetByKey.get(key) || 0,
        definitiveQty: definitiveQtyByKey.get(key) || 0,
        previousStock,
        newStock,
        stockId: match.id,
        variant,
        originalOpenTicketEventId: event.id,
        originalStockSyncLogId: row.id,
        stockUpdateResponse: parsed,
      },
      synced_at: new Date().toISOString(),
    }).eq("id", claim.id);

    restoreRemainingByKey.set(key, remaining - restoreQty);
    restoredByEvent.set(event.id, (restoredByEvent.get(event.id) || 0) + restoreQty);
    restoredByKey.set(key, (restoredByKey.get(key) || 0) + restoreQty);
    result.restored++;
    match.stock = newStock;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  for (const event of staleEvents as { id: string; raw_json?: unknown }[]) {
    const keys = eventKeys.get(event.id);
    if (!keys || keys.size === 0) continue;
    const hasDefinitiveCoverage = Array.from(keys).some((key) => (definitiveQtyByKey.get(key) || 0) > 0);
    if (hasDefinitiveCoverage) continue;
    const positiveQty = eventPositiveQty.get(event.id) || 0;
    const restoredQty = restoredByEvent.get(event.id) || 0;
    if (positiveQty <= 0 || restoredQty < positiveQty) continue;
    const raw = (event.raw_json && typeof event.raw_json === "object" && !Array.isArray(event.raw_json))
      ? event.raw_json as Record<string, unknown>
      : {};
    await supabase.from("sales_events").update({
      raw_json: {
        ...raw,
        _stock_sync_eligible: false,
        _open_ticket_cancelled_or_stale: true,
        _open_ticket_reversal_applied_at: new Date().toISOString(),
        _open_ticket_reversal_restored_qty: restoredQty,
      },
    }).eq("id", event.id);
    result.disabledEvents++;
  }

  return result;
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
    .select("id, business_day, raw_json")
    .eq("connection_id", connectionId)
    .gte("business_day", fromDay)
    .lte("business_day", toDay)
    .order("business_day", { ascending: true })
    .limit(10000);

  if (!events || events.length === 0) return [];

  const dayByEventId = new Map<string, string>();
  const eventIds: string[] = [];
  for (const ev of events as { id: string; business_day: string; raw_json?: unknown }[]) {
    if (rawJsonDisablesStockSync(ev.raw_json)) continue;
    eventIds.push(ev.id);
    dayByEventId.set(ev.id, ev.business_day);
  }
  if (eventIds.length === 0) return [];

  const days = new Set<string>();
  for (let i = 0; i < eventIds.length; i += 500) {
    const chunk = eventIds.slice(i, i + 500);
    const { data: rows } = await supabase
      .from("sales_line_items")
      .select("sales_event_id")
      .eq("connection_id", connectionId)
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
async function syncStockForDays(
  supabase: any,
  connectionId: string,
  days: string[],
  winerimToken: string,
  options: { incremental?: boolean; desiredEventIdsByDay?: Record<string, string[]> } = {},
): Promise<StockSyncTotals> {
  const totals: StockSyncTotals = { synced: 0, skipped: 0, failed: 0, checkedDays: 0, errors: [] };
  for (const day of days) {
    try {
      const result = options.incremental
        ? await syncStockForDayIncrementalByDayTotal(supabase, connectionId, day, winerimToken, options.desiredEventIdsByDay?.[day])
        : await syncStockForDay(supabase, connectionId, day, winerimToken);
      totals.synced += Number(result.synced || 0);
      totals.skipped += Number(result.skipped || 0);
      totals.failed += Number(result.failed || 0);
      totals.checkedDays++;
      if (Array.isArray(result.errors)) {
        totals.errors.push(...result.errors.map((err: unknown) => `${day}: ${String(err)}`));
      }
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

/**
 * Reversible quarantine for ambiguous Agora identities.
 * provider_config.auto_push_fail_closed_winerim_ids lists Winerim wine ids that must NEVER
 * be evaluated by auto-push (no CREATE/UPDATE/HIDE/DELETE, no per-wine task queries).
 * Absent/empty config = no behaviour change for any connection or mode.
 * This list is quarantine only: it must never be used to resolve or adopt an Agora identity.
 */
function autoPushFailClosedWinerimIds(providerConfig: unknown): string[] {
  const config = (providerConfig || {}) as Record<string, unknown>;
  return normalizeStringArray(config.auto_push_fail_closed_winerim_ids);
}



function agoraVintageDisambiguationProductIds(connection: any): string[] {
  const config = (connection?.provider_config && typeof connection.provider_config === "object")
    ? connection.provider_config as Record<string, unknown>
    : {};
  const namingConfig = (config.agora_product_naming && typeof config.agora_product_naming === "object")
    ? config.agora_product_naming as Record<string, unknown>
    : {};
  return normalizeStringArray(
    config.agora_vintage_disambiguation_product_ids ||
    namingConfig.vintage_disambiguation_product_ids,
  );
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
  expectedName?: string;
  expectedPrices?: Record<string, number>;
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

  // Index the catalog once. Large Agora catalogs can exceed 3 MB; scanning the
  // full XML with one regex per mapped product exhausts the Edge Function CPU.
  const productXmlById = new Map<string, { openingAttrs: string; xml: string }>();
  for (const element of extractXmlElementsWithAttrs(verifyXml, "Product")) {
    const openingMatch = element.xml.match(/^<Product\b([^>]*)>/i);
    if (!openingMatch) continue;
    const productId = openingMatch[1].match(/\bId="([^"]*)"/i)?.[1];
    if (productId) productXmlById.set(productId, { openingAttrs: openingMatch[1], xml: element.xml });
  }

  for (const product of products) {
    result.summary.checked++;
    const productElement = productXmlById.get(String(product.productId));

    if (!productElement) {
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

    const attrs = productElement.openingAttrs;
    const innerXml = productElement.xml;
    let productOk = true;

    if (product.expectedName) {
      const expectedName = normalizeAgoraTextAttribute(product.expectedName);
      const actualName = normalizeAgoraTextAttribute(
        decodeXmlAttribute(attrs.match(/\bName="([^"]*)"/i)?.[1] || ""),
      );
      if (actualName !== expectedName) {
        productOk = false;
        result.success = false;
        result.errors.push({
          code: "NAME_MISMATCH",
          message: `Product ${product.productId}: expected name "${expectedName}", got "${actualName}"`,
          field: "Name",
          context: { productId: product.productId, expected: expectedName, actual: actualName },
        });
      }
    }

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
      } else if (
        product.expectedPrices &&
        Number.isFinite(product.expectedPrices[pl.id]) &&
        Math.abs(priceVal - product.expectedPrices[pl.id]) > 0.005
      ) {
        productOk = false;
        result.verified_prices = false;
        result.errors.push({
          code: "PRICE_MISMATCH",
          message: `Product ${product.productId} (${product.format}): expected ${product.expectedPrices[pl.id].toFixed(2)} in PriceList "${pl.name}", got ${priceVal.toFixed(2)}`,
          field: "prices",
          context: {
            productId: product.productId,
            format: product.format,
            priceListId: pl.id,
            priceListName: pl.name,
            expected: product.expectedPrices[pl.id],
            actual: priceVal,
          },
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

interface AgoraHiddenGlassVariant {
  winerim_id: string;
  name: string;
  wine_type?: string | null;
  glass_sale_price: number;
  bottle_sale_price?: number;
  publish_bottle?: boolean;
  enabled?: boolean;
  source?: string;
  captured_at?: string;
}

function configuredHiddenGlassVariants(connection?: any): AgoraHiddenGlassVariant[] {
  const providerConfig = connection?.provider_config && typeof connection.provider_config === "object"
    ? connection.provider_config as Record<string, unknown>
    : {};
  if (providerConfig.publish_hidden_glass_variants !== true) return [];

  const configured = Array.isArray(providerConfig.agora_hidden_glass_variants)
    ? providerConfig.agora_hidden_glass_variants as Record<string, unknown>[]
    : [];

  return configured.flatMap((item) => {
    const winerimId = String(item?.winerim_id || item?.winerimWineId || "").trim();
    const name = String(item?.name || "").trim();
    const glassSalePrice = Number(item?.glass_sale_price ?? item?.price ?? 0);
    const bottleSalePrice = Number(item?.bottle_sale_price ?? 0);
    if (!winerimId || !name || !Number.isFinite(glassSalePrice) || glassSalePrice <= 0 || item?.enabled === false) {
      return [];
    }
    return [{
      winerim_id: winerimId,
      name,
      wine_type: item?.wine_type ? String(item.wine_type).toLowerCase() : null,
      glass_sale_price: glassSalePrice,
      bottle_sale_price: Number.isFinite(bottleSalePrice) && bottleSalePrice > 0 ? bottleSalePrice : undefined,
      publish_bottle: item?.publish_bottle === true,
      enabled: true,
      source: item?.source ? String(item.source) : undefined,
      captured_at: item?.captured_at ? String(item.captured_at) : undefined,
    }];
  });
}

function configuredHiddenGlassVariant(connection: any, winerimWineId: unknown): AgoraHiddenGlassVariant | null {
  const targetId = String(winerimWineId || "").trim();
  if (!targetId) return null;
  return configuredHiddenGlassVariants(connection).find((item) => item.winerim_id === targetId) || null;
}

// Winerim's public-menu active flag is intentionally independent from this
// per-connection POS exception. The marker exists only in memory and is never
// persisted back to the Winerim catalog cache.
// deno-lint-ignore no-explicit-any
function applyHiddenGlassVariantForAgora(connection: any, wine: any): any {
  const winerimWineId = wine?.winerim_id || wine?.id;
  const configured = configuredHiddenGlassVariant(connection, winerimWineId);
  if (!configured) return wine;
  const bottleSalePrice = configured.bottle_sale_price;
  const allowInactiveBottle = configured.publish_bottle === true &&
    Number.isFinite(Number(bottleSalePrice)) && Number(bottleSalePrice) > 0;
  return {
    ...(wine || {}),
    winerim_id: configured.winerim_id,
    id: wine?.id || configured.winerim_id,
    name: configured.name,
    wine_type: configured.wine_type || wine?.wine_type || null,
    glass_sale_price: configured.glass_sale_price,
    bottle_sale_price: allowInactiveBottle
      ? Number(bottleSalePrice)
      : wine?.bottle_sale_price ?? null,
    serve_by_glass: true,
    raw_payload: {
      ...(wine?.raw_payload || {}),
      agora_hidden_glass_variant: {
        source: configured.source || "CONNECTION_OVERRIDE",
        captured_at: configured.captured_at || null,
      },
    },
    _agora_allow_inactive_glass: true,
    _agora_allow_inactive_bottle: allowInactiveBottle,
  };
}

function isConfiguredHiddenFormatVariant(connection: any, wineOrId: any, formatType: string): boolean {
  const winerimWineId = typeof wineOrId === "object"
    ? wineOrId?.winerim_id || wineOrId?.id
    : wineOrId;
  const configured = configuredHiddenGlassVariant(connection, winerimWineId);
  if (!configured) return false;

  const format = String(formatType || "").toUpperCase();
  if (format === "GLASS") return true;
  if (format !== "BOTTLE" || configured.publish_bottle !== true) return false;

  const bottleSalePrice = configured.bottle_sale_price;
  return Number.isFinite(Number(bottleSalePrice)) && Number(bottleSalePrice) > 0;
}

function inactiveFormatAllowedByConnection(wine: any, formatType: string): boolean {
  const format = String(formatType || "").toUpperCase();
  if (format === "GLASS") return wine?._agora_allow_inactive_glass === true;
  if (format === "BOTTLE") return wine?._agora_allow_inactive_bottle === true;
  return false;
}

// deno-lint-ignore no-explicit-any
function validateWineForAgora(wine: any, formatType: string, connection?: any, priceLists?: { Id: string; Name: string }[]): WineValidationResult {
  const warnings: string[] = [];
  const missingFields: string[] = [];

  // Public-menu inactivity remains blocked unless this exact POS format has an
  // explicit connection-scoped override. No override is inferred globally.
  const inactiveFormatOverride = inactiveFormatAllowedByConnection(wine, formatType);
  if (wine.is_active === false && !inactiveFormatOverride) {
    missingFields.push("wine_inactive");
    return { valid: false, warnings: ["Wine is inactive in Winerim — blocked from Agora push"], missingFields };
  }
  if (inactiveFormatOverride) {
    warnings.push(`inactive_public_menu_${String(formatType || "").toLowerCase()}_published_by_connection_policy`);
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
    const glassPrice = extractGlassSalePrice(wine);
    if (!glassPrice || glassPrice <= 0) {
      missingFields.push("missing_glass_sale_price");
    } else if (wine.serve_by_glass !== true) {
      warnings.push("serve_by_glass_not_enabled_but_glass_price_present");
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

// deno-lint-ignore no-explicit-any
function isFormatUnavailableForAgora(wine: any, formatType: string): boolean {
  const fmt = String(formatType || "").toUpperCase();
  if (fmt === "BOTTLE") {
    const bottlePrice = extractBottleSalePrice(wine);
    return !bottlePrice || bottlePrice <= 0;
  }
  if (fmt === "GLASS") {
    const glassPrice = extractGlassSalePrice(wine);
    return !glassPrice || glassPrice <= 0;
  }
  if (fmt === "MAGNUM") {
    const magnumPrice = wine.magnum_sale_price ? Number(wine.magnum_sale_price) : null;
    return !magnumPrice || magnumPrice <= 0;
  }
  return false;
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

// A queued task normally contains one wine, but duplicate-safe naming depends
// on every active homonym. Build the same candidate group used by a full audit
// so independent tasks cannot alternately remove and restore suffixes.
// deno-lint-ignore no-explicit-any
function buildQueuedProductNameOverrides(
  connection: any,
  currentWine: any,
  homonymousWines: any[],
  formatTypes: string[],
  existingProducts: { Id: string; Name: string }[],
): Record<string, string> {
  const currentWineId = String(currentWine?.winerim_id || currentWine?.id || "");
  const requestedFormats = [...new Set(formatTypes.map((format) => String(format || "").toUpperCase()))];
  const winesById = new Map<string, any>();
  for (const wine of [...homonymousWines, currentWine]) {
    const wineId = String(wine?.winerim_id || wine?.id || "");
    const effectiveWine = applyHiddenGlassVariantForAgora(connection, wine);
    const includeInactiveFormat = requestedFormats.some((format) =>
      inactiveFormatAllowedByConnection(effectiveWine, format)
    );
    if (wineId && (wine?.is_active !== false || includeInactiveFormat)) {
      winesById.set(wineId, effectiveWine);
    }
  }

  const candidatesByProductId = new Map<string, {
    productId: string;
    baseName: string;
    winerimId: string;
    vintage: string | number | null | undefined;
  }>();

  for (const wine of winesById.values()) {
    const orderedDulceCode = saPedreraDulceCode(connection, wine);
    const singleDulceFormat = orderedDulceCode ? preferredSingleFormatForDulce(wine) : null;
    for (const format of requestedFormats) {
      if (singleDulceFormat && format !== singleDulceFormat) continue;
      if (isFormatUnavailableForAgora(wine, format)) continue;
      const productId = deterministicAgoraProductId(connection, wine, format);
      if (candidatesByProductId.has(productId)) continue;
      candidatesByProductId.set(productId, {
        productId,
        baseName: formatProductName(format, String(wine.name || "")),
        winerimId: String(wine.winerim_id || wine.id || ""),
        vintage: wine.vintage || wine.raw_payload?.vintage,
      });
    }
  }

  const resolvedNames = buildDuplicateSafeAgoraProductNames(
    [...candidatesByProductId.values()],
    existingProducts,
  );
  const overrides: Record<string, string> = {};
  for (const format of requestedFormats) {
    const productId = deterministicAgoraProductId(connection, currentWine, format);
    const candidate = candidatesByProductId.get(productId);
    if (candidate?.winerimId === currentWineId && resolvedNames[productId]) {
      overrides[productId] = resolvedNames[productId];
    }
  }
  return overrides;
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

const AGORA_STRUCTURE_WINE_TYPE_SPAIN_DO_FOREIGN_COUNTRY = "WINE_TYPE_SPAIN_DO_FOREIGN_COUNTRY";

function agoraTypeRootMappingKey(wineType: unknown): string | null {
  const canonicalType = canonicalAgoraWineType(wineType);
  if (!canonicalType) return null;
  return `botella_${canonicalType}`;
}

function cleanAgoraGeographicLabel(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function isSpainCountry(value: unknown): boolean {
  const normalized = normalizeRoutingText(value);
  return ["es", "esp", "espana", "spain"].includes(normalized);
}

function agoraCountryLabel(value: unknown): string | null {
  const raw = cleanAgoraGeographicLabel(value);
  if (!raw) return null;
  const normalized = normalizeRoutingText(raw);
  if (["xx", "sin pais", "unknown", "desconocido", "n a"].includes(normalized)) return null;
  const countryCode = raw.toUpperCase();
  return GEO_COUNTRY_NAMES[countryCode] || raw;
}

function isFallbackGeographicRegion(value: unknown): boolean {
  const normalized = normalizeRoutingText(value);
  return !normalized || [
    "sin region",
    "sin denominacion",
    "sin denominacion de origen",
    "sin do",
    "otras",
    "otros",
    "n a",
  ].includes(normalized);
}

interface AgoraFamilyRoutingRule {
  enabled?: boolean;
  format?: string;
  formats?: string[];
  wine_type?: string;
  wine_types?: string[];
  country?: string;
  countries?: string[];
  region?: string;
  regions?: string[];
  region_contains?: string | string[];
  family_id?: string;
  family_name?: string;
}

function normalizeRoutingText(value: unknown): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
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
function generateImportXml(wines: any[], masterData: any, connection: any, formatTypes: string[], customFamilyMappings?: Record<string, { id: string; name: string }>, forceEmptyPreparation = false, geographicConfig?: GeographicFamilyConfig, allWinesForGeo?: any[], explicitPriceListIds?: string[], productNameOverrides?: Record<string, string>, vinotecaCatalogRoutes?: Map<string, VinotecaCatalogRoute | null>): { xml: string; validationResults: { winerimId: string; formatType: string; validation: WineValidationResult }[]; productLabelsById: Record<string, { name: string; buttonText: string }>; vinoteca?: Record<string, unknown> | null } {
  const families = (masterData.families_json || []) as { Id: string; Name: string }[];
  const vats = (masterData.vats_json || []) as { Id: string; Name: string; VatRate: string }[];
  // Filter out deleted PriceLists — they must never appear in generated XML
  const allPriceListsRaw = (masterData.price_lists_json || []) as Record<string, unknown>[];
  const activePriceLists = allPriceListsRaw.filter(e => !isDeletedEntity(e)) as { Id: string; Name: string }[];
  const providerConfig = (connection.provider_config || {}) as Record<string, unknown>;
  const selectedPriceListIds = normalizeStringArray(explicitPriceListIds);
  if (selectedPriceListIds.length === 0 && providerConfig.price_write_scope === "SELECTED_SALE_CENTERS") {
    const selectedSaleCenterIds = new Set(normalizeStringArray(connection.selected_sale_center_ids));
    const saleCenters = (Array.isArray(masterData.sale_centers_json) ? masterData.sale_centers_json : []) as Record<string, unknown>[];
    for (const saleCenter of saleCenters) {
      if (isDeletedEntity(saleCenter) || !selectedSaleCenterIds.has(String(saleCenter.Id || ""))) continue;
      const priceListId = String(saleCenter.CurrentPriceListId || saleCenter.PriceListId || saleCenter.PriceList || "");
      if (priceListId && !selectedPriceListIds.includes(priceListId)) selectedPriceListIds.push(priceListId);
    }
  }
  const priceLists = providerConfig.price_write_scope === "SELECTED_SALE_CENTERS"
    ? activePriceLists.filter((priceList) => selectedPriceListIds.includes(String(priceList.Id)))
    : activePriceLists;
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

  function preparationPairForFormat(formatType: string): { typeId: string; orderId: string; valid: boolean; error?: string } {
    if (forceEmptyPreparation) return { typeId: "", orderId: "", valid: true };

    const routes = providerConfig.preparation_routes && typeof providerConfig.preparation_routes === "object"
      ? providerConfig.preparation_routes as Record<string, unknown>
      : {};
    const route = routes[formatType] && typeof routes[formatType] === "object"
      ? routes[formatType] as Record<string, unknown>
      : null;
    const typeId = String(route?.typeId || route?.preparationTypeId || defaultPrepTypeId || "");
    const orderId = String(route?.orderId || route?.preparationOrderId || defaultPrepOrderId || "");

    if (Boolean(typeId) !== Boolean(orderId)) {
      return { typeId: "", orderId: "", valid: false, error: `Incomplete preparation route for ${formatType}` };
    }
    if (typeId && !prepTypes.some((item) => String(item.Id) === typeId)) {
      return { typeId: "", orderId: "", valid: false, error: `Unknown PreparationTypeId ${typeId} for ${formatType}` };
    }
    if (orderId && !prepOrders.some((item) => String(item.Id) === orderId)) {
      return { typeId: "", orderId: "", valid: false, error: `Unknown PreparationOrderId ${orderId} for ${formatType}` };
    }
    return { typeId, orderId, valid: true };
  }

  // deno-lint-ignore no-explicit-any
  function findFamilyId(wineType: string | null, formatType?: string, wine?: any): { id: string; needsCreate: boolean; familyName: string; parentId?: string; grandparentId?: string; color?: string; buttonText?: string } {
    // Per-connection two-level layout used by El Porton de Sorni:
    // wine type root > Spanish DO/region OR foreign country. Glasses and
    // magnums keep their dedicated format families.
    if (
      String(providerConfig.family_structure_mode || "").trim().toUpperCase() ===
        AGORA_STRUCTURE_WINE_TYPE_SPAIN_DO_FOREIGN_COUNTRY &&
      formatType === "BOTTLE" &&
      wine
    ) {
      const canonicalType = canonicalAgoraWineType(wineType || wine.wine_type);
      const rootMappingKey = agoraTypeRootMappingKey(canonicalType);
      const configuredRoot = rootMappingKey ? customFamilyMappings?.[rootMappingKey] : null;
      const expectedRootName = configuredRoot?.name || geoTypeParentName(canonicalType || "otros");
      const existingRoot = families.find((family) =>
        (configuredRoot?.id && String(family.Id) === String(configuredRoot.id)) ||
        normalizeRoutingText(family.Name) === normalizeRoutingText(expectedRootName)
      );
      const rootId = String(existingRoot?.Id || configuredRoot?.id || stableFamilyId(expectedRootName));
      const rootName = existingRoot?.Name || expectedRootName;
      const rootColor = agoraProductColor(connection, canonicalType);
      if (!existingRoot && !newFamilies.some((family) => family.id === rootId)) {
        newFamilies.push({ id: rootId, name: rootName, color: rootColor, buttonText: rootName });
      }

      const raw = wine.raw_payload || {};
      const country = cleanAgoraGeographicLabel(raw.country || wine.country);
      const region = cleanAgoraGeographicLabel(wine.region || raw.region);
      const isSpanish = isSpainCountry(country);
      const invalidRegion = isFallbackGeographicRegion(region);
      const childLabel = isSpanish
        ? (invalidRegion ? "OTRAS DO ESPAÑA" : region)
        : (agoraCountryLabel(country) || "OTROS PAÍSES");
      const childTechnicalName = `${rootName} - ${childLabel}`;
      const existingChild = families.find((family) =>
        normalizeRoutingText(family.Name) === normalizeRoutingText(childTechnicalName)
      );
      let childId = String(existingChild?.Id || "");
      if (!childId) {
        for (let attempt = 0; attempt < 100; attempt++) {
          const candidate = stableFamilyId(attempt === 0 ? childTechnicalName : `${childTechnicalName}#${attempt}`);
          const liveCollision = families.find((family) => String(family.Id) === candidate);
          const plannedCollision = newFamilyHierarchy.find((family) => family.id === candidate);
          if (!liveCollision && !plannedCollision) {
            childId = candidate;
            break;
          }
          const collisionName = liveCollision?.Name || plannedCollision?.name || "";
          if (normalizeRoutingText(collisionName) === normalizeRoutingText(childTechnicalName)) {
            childId = candidate;
            break;
          }
        }
      }
      if (!childId) throw new Error(`Could not allocate a collision-free family ID for ${childTechnicalName}`);
      const childName = existingChild?.Name || childTechnicalName;
      if (!existingChild && !newFamilyHierarchy.some((family) => family.id === childId)) {
        newFamilyHierarchy.push({
          id: childId,
          name: childName,
          parentId: rootId,
          color: rootColor,
          buttonText: childLabel,
        });
      }
      // The family is included in this same XML when it is new. Returning
      // needsCreate=false avoids rendering the child a second time as a root.
      return {
        id: childId,
        needsCreate: false,
        familyName: childName,
        parentId: rootId,
        color: rootColor,
        buttonText: childLabel,
      };
    }

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

    // PRIORITY 0B: Explicit per-connection routing rules.
    // Used for clients that already have a production family tree in Agora
    // (for example, type + region families) and must keep that visual layout.
    const routingProviderConfig = (connection?.provider_config || {}) as Record<string, unknown>;
    const routingRules = Array.isArray(routingProviderConfig.agora_family_routing_rules)
      ? routingProviderConfig.agora_family_routing_rules as AgoraFamilyRoutingRule[]
      : [];
    if (routingRules.length > 0 && wine) {
      const raw = wine.raw_payload || {};
      const currentFormat = normalizeRoutingText(formatType || "BOTTLE");
      const currentType = normalizeRoutingText(wineType || wine.wine_type || raw.type || "");
      const currentCountry = normalizeRoutingText(raw.country || wine.country || "");
      const currentRegion = normalizeRoutingText(wine.region || raw.region || "");

      const listMatches = (expected: unknown[] | undefined, actual: string): boolean => {
        if (!expected || expected.length === 0) return true;
        return expected.map(normalizeRoutingText).includes(actual);
      };
      const singleMatches = (expected: unknown, actual: string): boolean => {
        if (!expected) return true;
        return normalizeRoutingText(expected) === actual;
      };
      const containsMatches = (expected: string | string[] | undefined, actual: string): boolean => {
        if (!expected) return true;
        const needles = Array.isArray(expected) ? expected : [expected];
        return needles.map(normalizeRoutingText).some(needle => needle && actual.includes(needle));
      };

      for (const rule of routingRules) {
        if (rule.enabled === false) continue;
        if (!rule.family_id && !rule.family_name) continue;
        if (!singleMatches(rule.format, currentFormat)) continue;
        if (!listMatches(rule.formats, currentFormat)) continue;
        if (!singleMatches(rule.wine_type, currentType)) continue;
        if (!listMatches(rule.wine_types, currentType)) continue;
        if (!singleMatches(rule.country, currentCountry)) continue;
        if (!listMatches(rule.countries, currentCountry)) continue;
        if (!singleMatches(rule.region, currentRegion)) continue;
        if (!listMatches(rule.regions, currentRegion)) continue;
        if (!containsMatches(rule.region_contains, currentRegion)) continue;

        const found = families.find(f =>
          (rule.family_id && String(f.Id) === String(rule.family_id)) ||
          (rule.family_name && normalizeRoutingText(f.Name) === normalizeRoutingText(rule.family_name))
        );
        if (found) return { id: found.Id, needsCreate: false, familyName: found.Name };
      }
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

  const newFamilies: { id: string; name: string; color?: string; buttonText?: string }[] = [];
  const newFamilyHierarchy: { id: string; name: string; parentId: string; color?: string; buttonText?: string }[] = [];
  const useCommercialCodeSort = shouldSortAgoraProductsByCommercialCode(connection);
  const useAlphabeticalWineNameSort = shouldSortAgoraProductsAlphabetically(connection);
  const codePrefixOrder = commercialCodePrefixOrder(connection);
  const productEntries: {
    wineName: string;
    formatOrder: number;
    familyId: string;
    commercialCode: CommercialCode | null;
    productId: string;
    productName: string;
    winerimId: string;
    vintage: string | number | null;
    renderXml: (finalProductName: string, finalButtonText: string) => string;
  }[] = [];

  // ── VINOTECA_REGION_REFERENCE_NATIVE_FORMATS (Don Bernardo allowlist only) ──
  const vinotecaNativeFormats = isVinotecaNativeFormatsConnection(connection.id, providerConfig);
  const vinotecaPlans: VinotecaReferencePlan[] = [];
  const vinotecaSkipped: VinotecaSkippedReference[] = [];
  const vinotecaRegionFamilies = new Map<string, { id: string; name: string }>();

  function vinotecaFamilyForRegion(region: string): { id: string; name: string } {
    const rootFamily = families.find((family) =>
      normalizeRoutingText(family.Name) === normalizeRoutingText(VINOTECA_ROOT_FAMILY_NAME)
    );
    if (!rootFamily) {
      throw new Error(`${VINOTECA_REGION_REFERENCE_NATIVE_FORMATS}: root family "${VINOTECA_ROOT_FAMILY_NAME}" not found in Agora master data`);
    }
    const rootId = String(rootFamily.Id);
    const key = vinotecaRegionKey(region);
    const cached = vinotecaRegionFamilies.get(key);
    if (cached) return cached;

    // Only a family that is simultaneously a direct child of THIS connection's
    // root, visible in POS and not deleted may be adopted. Legacy rootless /
    // hidden / deleted homonyms are left untouched. Ambiguity fails closed.
    const existingRegion = findAdoptableVinotecaRegionFamily(families, rootId, key);


    let regionId = String(existingRegion?.Id || "");
    const existingRegionName = String(existingRegion?.Name ?? "").trim();
    const technicalName = existingRegionName || `${VINOTECA_ROOT_FAMILY_NAME} - ${region}`;
    if (!regionId) {
      for (let attempt = 0; attempt < 100; attempt++) {
        const candidate = stableFamilyId(attempt === 0 ? technicalName : `${technicalName}#${attempt}`);
        const liveCollision = families.find((family) => String(family.Id) === candidate);
        const plannedCollision = newFamilyHierarchy.find((family) => family.id === candidate);
        if (!liveCollision && !plannedCollision) {
          regionId = candidate;
          break;
        }
      }
      if (!regionId) {
        throw new Error(`${VINOTECA_REGION_REFERENCE_NATIVE_FORMATS}: could not allocate a collision-free family ID for ${technicalName}`);
      }
      newFamilyHierarchy.push({
        id: regionId,
        name: technicalName,
        parentId: rootId,
        color: agoraProductColor(connection, null),
        buttonText: region,
      });
    }

    const resolved = { id: regionId, name: existingRegionName || technicalName };
    vinotecaRegionFamilies.set(key, resolved);
    return resolved;
  }

  if (vinotecaNativeFormats) {
    for (const wine of wines) {
      const wineId = String(wine.winerim_id || wine.id || "");
      const hasAdoptedRoute = vinotecaCatalogRoutes?.has(wineId) || false;
      const adoptedRoute = hasAdoptedRoute ? vinotecaCatalogRoutes?.get(wineId) : undefined;
      const { plan, skipped } = buildVinotecaReferencePlan({
        winerimWineId: wine.winerim_id || wine.id,
        wineName: wine.name,
        region: wine.region ?? wine.raw_payload?.region,
        bottleSalePrice: extractBottleSalePrice(wine),
        bottleCostPrice: extractBottleCostPrice(wine),
        glassSalePrice: extractGlassSalePrice(wine),
        glassCostPrice: extractGlassCostPrice(wine, connection),
        magnumSalePrice: wine.magnum_sale_price,
        magnumCostPrice: wine.magnum_purchase_price,
        isActive: wine.is_active,
      }, hasAdoptedRoute ? adoptedRoute : undefined);

      if (!plan) {
        if (skipped) vinotecaSkipped.push(skipped);
        validationResults.push({
          winerimId: String(skipped?.winerimWineId || wine.winerim_id || wine.id || ""),
          formatType: "BOTTLE",
          validation: {
            valid: false,
            warnings: [],
            missingFields: [],
            error: {
              code: "VINOTECA_REFERENCE_FAIL_CLOSED",
              message: `Skipped: ${skipped?.reason || "unknown_reason"}`,
            },
          },
        });
        continue;
      }

      vinotecaPlans.push(plan);
      const familyResult = vinotecaFamilyForRegion(plan.region);
      const baseFormat = plan.formats.find((format) => format.isBase)!;
      const extraFormats = plan.formats.filter((format) => !format.isBase);
      const productColor = agoraProductColor(connection, extractWineType(wine));
      const baseCost = baseFormat.costPrice.toFixed(2);

      validationResults.push({
        winerimId: plan.winerimWineId,
        formatType: baseFormat.format,
        validation: { valid: true, warnings: [], missingFields: [] },
      });

      productEntries.push({
        wineName: plan.wineName.toLowerCase(),
        formatOrder: 0,
        familyId: familyResult.id,
        commercialCode: commercialGenericCode(plan.wineName),
        productId: plan.productId,
        productName: plan.wineName,
        winerimId: plan.winerimWineId,
        vintage: wine.vintage ?? wine.raw_payload?.vintage ?? null,
        renderXml: (finalProductName: string, finalButtonText: string) => {
          const buttonText = String(finalButtonText || "").slice(0, 20);
          const pricesXml = priceLists.map((pl) =>
            `        <Price PriceListId="${pl.Id}" MainPrice="${baseFormat.salePrice.toFixed(2)}" AddinPrice="0.00" MenuItemPrice="0.00" />`
          ).join("\n");
          const costPricesXml = warehouses.map((wh) =>
            `        <CostPrice WarehouseId="${wh.Id}" CostPrice="${baseCost}" />`
          ).join("\n");
          const saleFormatsXml = extraFormats.length > 0
            ? `      <AdditionalSaleFormats>\n${extraFormats.map((format) => {
              const formatPrices = priceLists.map((pl) =>
                `            <Price PriceListId="${pl.Id}" MainPrice="${format.salePrice.toFixed(2)}" AddinPrice="0.00" MenuItemPrice="0.00" />`
              ).join("\n");
              const formatLabel = formatProductName(format.format, plan.wineName);
              const ratio = format.format === "GLASS" ? "0.20" : "2.00";
              return `        <SaleFormat Id="${format.agoraId}" Name="${escapeXml(formatLabel)}" ButtonText="${escapeXml(truncate(formatLabel, 20))}" Ratio="${ratio}" SaleableAsMain="true" SaleableAsAddin="false">\n          <Prices>\n${formatPrices}\n          </Prices>\n        </SaleFormat>`;
            }).join("\n")}\n      </AdditionalSaleFormats>\n`
            : "";
          return `    <Product Id="${plan.productId}" Name="${escapeXml(finalProductName)}" ButtonText="${escapeXml(buttonText)}" Color="${productColor}" PLU="" FamilyId="${familyResult.id}" VatId="${defaultVatId}" UseAsDirectSale="false" SaleableAsMain="true" SaleableAsAddin="false" IsSoldByWeight="false" AskForPreparationNotes="false" AskForAddins="false" PrintWhenPriceIsZero="false" PreparationTypeId="${VINOTECA_PREPARATION_TYPE_ID}" PreparationOrderId="${VINOTECA_PREPARATION_ORDER_ID}" CostPrice="${baseCost}">
      <Barcodes />
      <Prices>
${pricesXml}
      </Prices>
      <StorageOptions>
        <StorageOption WarehouseId="1" Location="" MinStock="0.00" MaxStock="0.00" />
      </StorageOptions>
${saleFormatsXml}      <CostPrices>
${costPricesXml}
      </CostPrices>
    </Product>`;

        },
      });
    }
  }

  for (const wine of vinotecaNativeFormats ? [] : wines) {

    const winerimId = Number(wine.winerim_id || wine.id || 0);
    const orderedDulceCode = saPedreraDulceCode(connection, wine);
    const orderedDulceFormat = orderedDulceCode ? preferredSingleFormatForDulce(wine) : null;

    for (const fmt of formatTypes) {
      const formatWine = applyHiddenGlassVariantForAgora(connection, wine);
      const wineName = formatWine.name || "Unknown Wine";
      const wineType = extractWineType(formatWine);
      // Sa Pedrera's D701-D709 screen uses one deterministic Agora product ID
      // per commercial code. Never emit bottle and glass entries with the same
      // ID; copa wins whenever it has a valid price.
      if (orderedDulceFormat && fmt !== orderedDulceFormat) continue;

      // Validate before generating (pass connection for glass cost fallback + priceLists emptiness check)
      const validation = validateWineForAgora(formatWine, fmt, connection, priceLists);
      validationResults.push({ winerimId: String(winerimId), formatType: fmt, validation });

      // Skip formats with missing required fields
      if (!validation.valid) continue;

      const preparationPair = preparationPairForFormat(fmt);
      if (!preparationPair.valid) {
        validationResults.push({
          winerimId: String(winerimId),
          formatType: fmt,
          validation: {
            valid: false,
            warnings: [],
            missingFields: ["PreparationTypeId", "PreparationOrderId"],
            error: { code: "INVALID_PREPARATION_ROUTE", message: preparationPair.error || "Invalid preparation route" },
          },
        });
        continue;
      }

      const isMagnum = fmt === "MAGNUM";
      const isGlass = fmt === "GLASS";
      const dedicatedSaPedreraFamily = saPedreraDedicatedFamily(connection, formatWine, fmt);
      const productId = deterministicAgoraProductId(connection, formatWine, fmt);

      const familyResult = orderedDulceCode
        ? { id: "903925", needsCreate: false, familyName: "DULCES WINERIM" }
        : dedicatedSaPedreraFamily
          ? dedicatedSaPedreraFamily
        : findFamilyId(wineType, fmt, formatWine);
      if (familyResult.needsCreate && !newFamilies.some(f => f.id === familyResult.id)) {
        newFamilies.push({ id: familyResult.id, name: familyResult.familyName });
      }

      const productName = formatProductName(isMagnum ? "MAGNUM" : isGlass ? "GLASS" : "BOTTLE", wineName);
      // Use REAL prices from normalized fields, never invent
      let mainPrice: string;
      let costPrice: string;

      if (isMagnum) {
        mainPrice = (Number(formatWine.magnum_sale_price) || 0).toFixed(2);
        costPrice = (Number(formatWine.magnum_purchase_price) || 0).toFixed(2);
      } else if (isGlass) {
        mainPrice = (extractGlassSalePrice(formatWine) || 0).toFixed(2);
        costPrice = (extractGlassCostPrice(formatWine, connection) || 0).toFixed(2);
      } else {
        mainPrice = (extractBottleSalePrice(formatWine) || 0).toFixed(2);
        costPrice = (extractBottleCostPrice(formatWine) || 0).toFixed(2);
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
        familyId: String(familyResult.id),
        commercialCode: commercialGenericCode(wineName),
        productId: String(productId),
        productName,
        winerimId: String(winerimId),
        vintage: formatWine.vintage ?? formatWine.raw_payload?.vintage ?? null,
        renderXml: (finalProductName: string, finalButtonText: string) => {
          const buttonText = String(finalButtonText || "").slice(0, 20);
          const productColor = agoraProductColor(connection, wineType);
          return `    <Product Id="${productId}" Name="${escapeXml(finalProductName)}" ButtonText="${escapeXml(buttonText)}" Color="${productColor}" PLU="" FamilyId="${familyResult.id}" VatId="${defaultVatId}" UseAsDirectSale="false" SaleableAsMain="true" SaleableAsAddin="false" IsSoldByWeight="false" AskForPreparationNotes="false" AskForAddins="false" PrintWhenPriceIsZero="false" PreparationTypeId="${preparationPair.typeId}" PreparationOrderId="${preparationPair.orderId}" CostPrice="${costPrice}">
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
      xml += `    <Family Id="${f.id}" Name="${escapeXml(f.name)}" ShowInPos="true" ButtonText="${escapeXml(truncate(f.buttonText || f.name, 20))}" Color="${f.color || "#8B0000"}" Order="100" />\n`;
    }
    // Then: hierarchical families (with parent)
    for (const f of newFamilyHierarchy) {
      xml += `    <Family Id="${f.id}" Name="${escapeXml(f.name)}" ShowInPos="true" ButtonText="${escapeXml(truncate(f.buttonText || f.name, 20))}" Color="${f.color || "#8B0000"}" Order="100" ParentFamilyId="${f.parentId}" />\n`;
    }
    xml += `  </Families>\n`;
  }

  if (useCommercialCodeSort) {
    productEntries.sort((a, b) =>
      a.familyId.localeCompare(b.familyId, "es") ||
      compareCommercialCodes(a.commercialCode, b.commercialCode, codePrefixOrder) ||
      a.formatOrder - b.formatOrder ||
      a.wineName.localeCompare(b.wineName, "es")
    );
  } else if (useAlphabeticalWineNameSort) {
    productEntries.sort((a, b) =>
      a.familyId.localeCompare(b.familyId, "es") ||
      compareAgoraWineNames(a.wineName, b.wineName) ||
      a.formatOrder - b.formatOrder ||
      Number(a.productId) - Number(b.productId)
    );
  } else {
    // Sort by wine name (alphabetical), then by format (BOT, COPA, MAG)
    productEntries.sort((a, b) => a.wineName.localeCompare(b.wineName, "es") || a.formatOrder - b.formatOrder);
  }

  const duplicateSafeProductLabels = buildDuplicateSafeAgoraProductLabels(
    productEntries.map((entry) => ({
      productId: entry.productId,
      baseName: entry.productName,
      winerimId: entry.winerimId,
      vintage: entry.vintage,
    })),
    existingProducts,
    { vintageDisambiguationProductIds: agoraVintageDisambiguationProductIds(connection) },
  );

  const productLabelsById: Record<string, { name: string; buttonText: string }> = {};
  const nextOrderByFamily = new Map<string, number>();
  // The Higuerón policy numbers each family independently. Other modes retain
  // their current XML ordering semantics and are normalized post-write when needed.
  const productXmls = productEntries.map((entry, idx) => {
    const duplicateSafeProductLabel = duplicateSafeProductLabels[entry.productId] || {
      name: entry.productName,
      buttonText: agoraProductButtonText(connection, entry.productName, 20),
    };
    const finalProductName = productNameOverrides?.[entry.productId] || duplicateSafeProductLabel.name;
    const finalButtonText = productNameOverrides?.[entry.productId]
      ? agoraProductButtonText(connection, finalProductName, 20)
      : duplicateSafeProductLabel.buttonText;
    const nextOrder = useAlphabeticalWineNameSort
      ? (nextOrderByFamily.get(entry.familyId) || 0) + 1
      : idx + 1;
    if (useAlphabeticalWineNameSort) nextOrderByFamily.set(entry.familyId, nextOrder);
    productLabelsById[entry.productId] = { name: finalProductName, buttonText: finalButtonText };
    return entry.renderXml(finalProductName, finalButtonText).replace('<Product Id=', `<Product Order="${nextOrder}" Id=`);
  });

  if (productXmls.length > 0) {
    xml += `  <Products>\n`;
    xml += productXmls.join("\n");
    xml += `\n  </Products>\n`;
  }
  xml += `</Import>`;

  return {
    xml,
    validationResults,
    productLabelsById,
    vinoteca: vinotecaNativeFormats
      ? {
        mode: VINOTECA_REGION_REFERENCE_NATIVE_FORMATS,
        plans: vinotecaPlans,
        skipped: vinotecaSkipped,
        regionFamilies: [...vinotecaRegionFamilies.values()],
        newFamilies: newFamilyHierarchy.map((family) => ({ id: family.id, name: family.name, parentId: family.parentId })),
      }
      : null,
  };
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

    // Absolute dry boundary for stock/sales-import. `force` never bypasses it.
    const stockFence = decideAgoraStockFence({ payload, providerConfig: connection.provider_config });

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
        let res = await fetchWithRetry(url, { headers }, 10_000);
        if (!res.ok) {
          res = await fetchWithRetry(`${baseUrlClean}/api/export/tickets/`, { headers }, 10_000);
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
          const res = await fetchWithRetry(url, { headers }, 10_000);
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
          const r = await fetchWithRetry(url, { headers }, 10_000);
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

    // ── PROBE OPEN TICKETS ──
    // Read-only probe for Agora's documented `/api/export/tickets/` endpoint.
    // This is the safe first step for "real time" pilots: it tells us whether the
    // installation exposes currently open tickets before any stock mutation is enabled.
    if (action === "probe-open-tickets") {
      const url = `${baseUrlClean}/api/export/tickets/`;
      try {
        const r = await fetchWithRetry(url, {
          headers: { ...headers, Accept: "application/json" },
        }, 10_000);
        const contentType = r.headers.get("content-type") || "";
        const text = await r.text();
        let tickets: any[] = [];
        let parseError: string | null = null;
        let payloadKeys: string[] = [];

        if (r.ok && text.trim()) {
          try {
            const parsed = JSON.parse(text);
            tickets = parseOpenTickets(parsed);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              payloadKeys = Object.keys(parsed).slice(0, 12);
            }
          } catch (e) {
            tickets = parseOpenTickets(text);
            if (!tickets.length) {
              parseError = `json_parse_error:${String((e as Error).message || e).slice(0, 120)}`;
            }
          }
        }

        const sample = tickets[0] || null;
        const sampleLines = Array.isArray(sample?.Lines) ? sample.Lines.length : 0;
        const xmlTicketCount = text.includes("<Ticket") ? countXmlOpenTickets(text) : 0;

        return new Response(JSON.stringify({
          success: r.ok && !parseError,
          status: r.status,
          ok: r.ok,
          contentType,
          endpoint: "/api/export/tickets/",
          count: tickets.length,
          xmlTicketCount,
          payloadKeys,
          sampleKeys: sample ? Object.keys(sample).slice(0, 20) : [],
          sampleLines,
          businessDays: Array.from(new Set(tickets.map((t) => String(t.BusinessDay || "")).filter(Boolean))).slice(0, 5),
          parseError,
          bodyPreview: text.slice(0, 300),
        }, null, 2), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({
          success: false,
          endpoint: "/api/export/tickets/",
          error: String((e as Error).message || e),
        }), { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }

    // ── OPEN TICKETS SYNC PILOT ──
    // Captures currently open tickets. Stock mutation is intentionally controlled by
    // provider_config.open_tickets_stock_sync_enabled so we can canary installations
    // without changing the stable invoice-based flow.
    if (action === "sync-open-tickets") {
      if (!isOpenTicketsSyncEnabled(connection) && payload.force !== true) {
        return new Response(
          JSON.stringify({ success: true, skipped: true, reason: "open_tickets_sync_disabled" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const providerConfig = ((connection.provider_config || {}) as Record<string, unknown>);
      const timeZone = String(providerConfig.sales_timezone || "Europe/Madrid");
      const defaultDay = isBusinessDay(businessDay) ? businessDay : todayInTimeZone(timeZone);
      const stockSyncEnabled = isOpenTicketsStockSyncEnabled(connection);
      const minLineAgeMinutes = Math.max(0, Number(providerConfig.open_tickets_min_line_age_minutes ?? 2));

      const url = `${baseUrlClean}/api/export/tickets/`;
      const res = await fetchWithRetry(url, { headers: { ...headers, Accept: "application/json" } }, 10_000);
      const text = await res.text();
      if (!res.ok) {
        return new Response(JSON.stringify({
          success: false,
          error: `Agora open tickets responded ${res.status}`,
          details: text.substring(0, 300),
        }), { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      let rawData: any;
      let tickets: any[] = [];
      try {
        rawData = text.trim() ? JSON.parse(text) : [];
        tickets = parseOpenTickets(rawData);
      } catch (e) {
        tickets = parseOpenTickets(text);
        if (!tickets.length) {
          return new Response(JSON.stringify({
            success: false,
            error: "Agora open tickets did not return JSON or supported XML",
            details: String((e as Error).message || e),
            bodyPreview: text.substring(0, 300),
          }), { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
      }

      const { data: familyRules } = await supabase
        .from("wine_family_rules")
        .select("family_name, is_wine")
        .eq("connection_id", connectionId);
      const customWineFamilies = familyRules
        ?.filter((r: { is_wine: boolean }) => r.is_wine)
        .map((r: { family_name: string }) => r.family_name.toLowerCase()) || [];
      const wineFamilies = [...DEFAULT_WINE_FAMILIES, ...customWineFamilies];

      const resolutionMap = await buildSalesResolutionMapFromDb(supabase, connectionId);
      const salesActiveWineFormats = await loadSalesActiveWineFormats(supabase, connectionId);
      const salesPairMappings = await loadSalesPairMappings(supabase, connectionId);

      let savedEvents = 0;
      let savedLines = 0;
      let resolvedLines = 0;
      let unresolvedLines = 0;
      let stockDeferredLines = 0;
      let staleDayStockSkippedLines = 0;
      const savedEventIdsByDay: Record<string, string[]> = {};
      const currentOpenDocIds = new Set<string>();

      for (let ticketIdx = 0; ticketIdx < tickets.length; ticketIdx++) {
        const ticket = tickets[ticketIdx] || {};
        const day = isBusinessDay(String(ticket.BusinessDay || "")) ? String(ticket.BusinessDay) : defaultDay;
        const docId = buildAgoraOpenTicketDocId(ticket, day, ticketIdx);
        currentOpenDocIds.add(docId);
        const lines = Array.isArray(ticket.Lines) ? ticket.Lines : [];
        let docTotal = 0;
        const lineData: Record<string, unknown>[] = [];
        const stockDayAllowed = isOpenTicketStockDayAllowed(day, defaultDay, providerConfig);

        for (const line of lines) {
          const rawTotal = agoraNumber(line.TotalAmount);
          const unitPrice = agoraNumber(line.UnitPrice || line.ProductPrice);
          const qty = agoraNumber(line.Quantity);
          const lineTotal = rawTotal > 0 ? rawTotal : unitPrice * qty;
          docTotal += lineTotal;

          const productName = String(line.ProductName || "");
          const formatName = String(line.SaleFormatName || "");
          const family = String(line.FamilyName || "");
          const legacyProviderProductId = String(line.ProductId || line.SaleFormatId || "");
          const salesIdentity = resolveAgoraSalesLineIdentityForConnection({
            connectionId,
            productId: line.ProductId,
            saleFormatId: line.SaleFormatId,
            legacyProviderProductId,
            resolutionMap,
            pairMappings: salesPairMappings,
            activeWineFormats: salesActiveWineFormats,
          });
          const productId = salesIdentity.providerProductId;
          const normalizedFmt = normalizeAgoraLineFormat(productName, formatName);
          const providerSoldAt = extractAgoraProviderSoldAt(line, null, ticket, day);
          const wr = isWineCandidate(family, productName, formatName, unitPrice, wineFamilies, DEFAULT_NON_WINE_FAMILIES);
          const resolution = salesIdentity.resolution || undefined;
          const winerimProductId = resolution?.winerim_wine_id || null;
          const isResolved = !!winerimProductId;
          const effectiveWineCandidate = isResolvedWineCandidate(winerimProductId, wr.candidate);
          const oldEnoughForStock = !stockSyncEnabled || isAgoraTimestampOldEnough(
            line.CreationDate,
            minLineAgeMinutes,
            timeZone,
          );
          const stockCandidate = effectiveWineCandidate && oldEnoughForStock && stockDayAllowed;
          if (isResolved) {
            resolvedLines++;
          } else if (wr.candidate) {
            unresolvedLines++;
          }
          if (isResolved && effectiveWineCandidate && !oldEnoughForStock) {
            stockDeferredLines++;
          }
          if (isResolved && effectiveWineCandidate && oldEnoughForStock && !stockDayAllowed) {
            staleDayStockSkippedLines++;
          }

          lineData.push({
            provider_product_id: productId,
            name: productName,
            format: canonicalAgoraSalesLineFormat({ connectionId, identity: salesIdentity, fallbackFormat: normalizedFmt }),
            family,
            quantity: qty,
            unit_price: unitPrice,
            total_amount: lineTotal,
            vat_rate: agoraNumber(line.VatRate),
            provider_sold_at: providerSoldAt.value,
            provider_sold_at_source: providerSoldAt.source,
            is_wine_candidate: stockCandidate,
            winerim_product_id: winerimProductId,
            mapped: isResolved,
          });
        }

        const rawJson = {
          ...ticket,
          _agora_source: "open_ticket",
          _stock_sync_eligible: stockSyncEnabled,
          _open_ticket_stock_sync_enabled: stockSyncEnabled,
          _open_ticket_stock_day_allowed: stockDayAllowed,
          _open_ticket_synced_at: new Date().toISOString(),
        };

        const { data: eventRow, error: eventErr } = await supabase
          .from("sales_events")
          .upsert({
            connection_id: connectionId,
            provider_doc_id: docId,
            business_day: day,
            doc_type: "OpenTicket",
            total_amount: agoraNumber(ticket.TotalAmount || docTotal),
            total_tax: agoraNumber(ticket.TotalTaxAmount || 0),
            total_net: agoraNumber(ticket.TotalNetAmount || 0),
            line_count: lineData.length,
            raw_json: rawJson,
          }, { onConflict: "connection_id,provider_doc_id" })
          .select("id").single();

        if (eventErr || !eventRow) continue;
        const replacement = await replaceSalesEventLinesPreservingStockClaims(
          supabase,
          connectionId,
          eventRow.id,
          lineData,
        );
        if (!replacement.ok) {
          console.error(`[sync-open-tickets] ${day}/${docId}: ${replacement.error}`);
          continue;
        }
        savedEvents++;
        savedLines += replacement.inserted;
        savedEventIdsByDay[day] ||= [];
        savedEventIdsByDay[day].push(eventRow.id);
      }

      let stockSyncResult: StockSyncTotals | null = null;
      let staleOpenTicketRestore: StaleOpenTicketRestoreResult | null = null;
      let warning: string | null = null;
      const winerimToken = (connection.winerim_api_token || "").trim();
      const daysWithSavedTickets = Object.keys(savedEventIdsByDay);
      if (stockFence.allowed && stockSyncEnabled && winerimToken) {
        staleOpenTicketRestore = await restoreStaleOpenTicketStock(
          supabase,
          connectionId,
          defaultDay,
          winerimToken,
          providerConfig,
          currentOpenDocIds,
        );
      }
      if (stockFence.allowed && resolvedLines > 0 && stockSyncEnabled) {
        if (!winerimToken) {
          warning = "Open tickets saved but Winerim stock was not synced: missing Winerim API token.";
          stockSyncResult = { synced: 0, skipped: 0, failed: 1, checkedDays: 0, errors: ["missing Winerim API token"] };
        } else {
          stockSyncResult = await syncStockForDays(supabase, connectionId, daysWithSavedTickets, winerimToken, {
            incremental: true,
            desiredEventIdsByDay: savedEventIdsByDay,
          });
        }
      } else if (resolvedLines > 0 && !stockSyncEnabled) {
        warning = "Open tickets captured only; provider_config.open_tickets_stock_sync_enabled is false.";
      }

      const now = new Date().toISOString();
      const nextConfig = {
        ...providerConfig,
        last_open_tickets_sync: {
          at: now,
          success: (stockSyncResult?.failed || 0) === 0,
          businessDays: daysWithSavedTickets.slice().sort(),
          ticketCount: tickets.length,
          savedEvents,
          savedLines,
          resolvedLines,
          unresolvedLines,
          stockDeferredLines,
          staleDayStockSkippedLines,
          minLineAgeMinutes,
          stockSyncEnabled,
          stockSync: stockSyncResult,
          staleOpenTicketRestore,
          warning,
        },
      };
      await supabase.from("pos_connections").update({ provider_config: nextConfig }).eq("id", connectionId);

      return new Response(JSON.stringify({
        success: (stockSyncResult?.failed || 0) === 0 && (staleOpenTicketRestore?.failed || 0) === 0,
        source: "open_tickets",
        businessDays: daysWithSavedTickets.slice().sort(),
        ticketCount: tickets.length,
        savedEvents,
        savedLines,
        resolvedLines,
        unresolvedLines,
        stockDeferredLines,
        staleDayStockSkippedLines,
        minLineAgeMinutes,
        stockSyncEnabled,
        stockSync: stockSyncResult,
        staleOpenTicketRestore,
        warning,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "fetch-day") {
      const day = businessDay;
      if (!day) {
        return new Response(JSON.stringify({ error: "businessDay is required" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const url = `${baseUrlClean}/api/export/?business-day=${day}&filter=Invoices`;
      const res = await fetchWithRetry(url, { headers }, 10_000);
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

      const salesEvents = invoices.map((inv: any, invIdx: number) => {
        const docId = buildAgoraInvoiceDocId(inv, day, invIdx);
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
            const lineTotal = rawTotal !== 0 ? rawTotal : uPrice * qty;
            docTotal += lineTotal;
            const productName = String(line.ProductName || "");
            const formatName = String(line.SaleFormatName || "");
            const normalizedFormat = normalizeAgoraLineFormat(productName, formatName);
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
          doc_type: agoraDocumentType(inv),
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

    // ── HISTORICAL SALES BACKFILL (analytics-only, never stock) ──
    // Use this for onboarding/audits where we want historical invoices stored for
    // analysis/matching but stock must only start from go-live. It deliberately:
    // - does not call Winerim stock endpoints;
    // - does not advance last_business_day_synced;
    // - marks raw_json so stock catch-up ignores these events later.
    if (action === "backfill-sales-analytics") {
      const dryRun = payload.dryRun === true;
      const includeToday = payload.includeToday === true;
      const today = formatBusinessDay(new Date());
      const defaultToDay = includeToday ? today : addUtcDays(today, -1);
      const lookbackDays = Math.min(Math.max(Number(daysBack || 90), 1), 120);
      const toDay = isBusinessDay(payload.toBusinessDay) ? payload.toBusinessDay : defaultToDay;
      const fromDay = isBusinessDay(payload.fromBusinessDay)
        ? payload.fromBusinessDay
        : addUtcDays(toDay, -(lookbackDays - 1));
      let days: string[];
      try {
        days = buildBusinessDayRange(fromDay, toDay, 120);
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const { data: familyRules } = await supabase
        .from("wine_family_rules")
        .select("family_name, is_wine")
        .eq("connection_id", connectionId);
      const customWineFamilies = familyRules
        ?.filter((r: { is_wine: boolean }) => r.is_wine)
        .map((r: { family_name: string }) => r.family_name.toLowerCase()) || [];
      const wineFamilies = [...DEFAULT_WINE_FAMILIES, ...customWineFamilies];

      const resolutionMap = await buildSalesResolutionMapFromDb(supabase, connectionId);
      const salesActiveWineFormats = await loadSalesActiveWineFormats(supabase, connectionId);
      const salesPairMappings = await loadSalesPairMappings(supabase, connectionId);

      const ACTION_DEADLINE_MS = 120_000;
      const actionStart = Date.now();
      const importedAt = new Date().toISOString();
      const errors: string[] = [];
      const daySummaries: { day: string; invoices: number; events: number; lines: number; resolvedLines: number; unresolvedWineLines: number }[] = [];
      let scannedDays = 0;
      let daysWithSales = 0;
      let savedEvents = 0;
      let savedLines = 0;
      let resolvedLines = 0;
      let unresolvedLines = 0;
      const savedEventIds: string[] = [];
      let aborted = false;
      let nextFromBusinessDay: string | null = null;

      for (const day of days) {
        if (Date.now() - actionStart > ACTION_DEADLINE_MS) {
          aborted = true;
          nextFromBusinessDay = day;
          break;
        }

        scannedDays++;
        const url = `${baseUrlClean}/api/export/?business-day=${day}&filter=Invoices`;
        let invoices: any[] = [];
        try {
          const res = await fetchWithRetry(url, { headers }, 10_000);
          if (!res.ok) {
            const body = await res.text().catch(() => "");
            errors.push(`${day}: Agora responded ${res.status} ${body.substring(0, 120)}`);
            continue;
          }
          const body = await res.text();
          const trimmed = body.trim();
          if (!trimmed || trimmed === "{}" || trimmed === "[]") {
            daySummaries.push({ day, invoices: 0, events: 0, lines: 0, resolvedLines: 0, unresolvedWineLines: 0 });
            continue;
          }
          invoices = parseInvoices(JSON.parse(trimmed));
        } catch (e) {
          errors.push(`${day}: ${String(e).substring(0, 180)}`);
          continue;
        }

        if (invoices.length > 0) daysWithSales++;

        let dayEvents = 0;
        let dayLines = 0;
        let dayResolvedLines = 0;
        let dayUnresolvedLines = 0;

        for (let invIdx = 0; invIdx < invoices.length; invIdx++) {
          const inv = invoices[invIdx];
          const docId = buildAgoraInvoiceDocId(inv, day, invIdx);
          const items = inv.InvoiceItems || [];
          let docTotal = 0;
          const lineData: Record<string, unknown>[] = [];

          for (const item of items) {
            for (const line of (item.Lines || [])) {
              const rawTotal = Number(line.TotalAmount || 0);
              const uP = Number(line.UnitPrice || 0);
              const qty = Number(line.Quantity || 0);
              const lineTotal = rawTotal !== 0 ? rawTotal : uP * qty;
              docTotal += lineTotal;
              const pName = String(line.ProductName || "");
              const fName = String(line.SaleFormatName || "");
              const normalizedFmt = normalizeAgoraLineFormat(pName, fName);
              const fam = String(line.FamilyName || "");
              const legacyProviderProductId = String(line.ProductId || "");
              const salesIdentity = resolveAgoraSalesLineIdentityForConnection({
                connectionId,
                productId: line.ProductId,
                saleFormatId: line.SaleFormatId,
                legacyProviderProductId,
                resolutionMap,
                pairMappings: salesPairMappings,
                activeWineFormats: salesActiveWineFormats,
              });
              const productId = salesIdentity.providerProductId;
              const providerSoldAt = extractAgoraProviderSoldAt(line, item, inv, day);
              const wr = isWineCandidate(fam, pName, fName, uP, wineFamilies, DEFAULT_NON_WINE_FAMILIES);
              const resolution = salesIdentity.resolution || undefined;
              const winerimProductId = resolution?.winerim_wine_id || null;
              const isResolved = !!winerimProductId;
              const effectiveWineCandidate = isResolvedWineCandidate(winerimProductId, wr.candidate);
              if (isResolved) {
                resolvedLines++;
                dayResolvedLines++;
              } else if (wr.candidate) {
                unresolvedLines++;
                dayUnresolvedLines++;
              }

              lineData.push({
                provider_product_id: productId,
                name: pName,
                format: canonicalAgoraSalesLineFormat({ connectionId, identity: salesIdentity, fallbackFormat: normalizedFmt }),
                family: fam,
                quantity: qty,
                unit_price: uP,
                total_amount: lineTotal,
                vat_rate: Number(line.VatRate || 0),
                provider_sold_at: providerSoldAt.value,
                provider_sold_at_source: providerSoldAt.source,
                is_wine_candidate: effectiveWineCandidate,
                winerim_product_id: winerimProductId,
                mapped: isResolved,
              });
            }
          }

          dayEvents++;
          dayLines += lineData.length;
          if (dryRun) continue;

          const { data: eventRow, error: eventErr } = await supabase
            .from("sales_events")
            .upsert({
              connection_id: connectionId,
              provider_doc_id: docId,
              business_day: day,
              doc_type: agoraDocumentType(inv),
              total_amount: Number(inv.TotalAmount || docTotal),
              total_tax: Number(inv.TotalTaxAmount || 0),
              total_net: Number(inv.TotalNetAmount || 0),
              line_count: lineData.length,
              raw_json: withHistoricalAnalyticsMetadata(inv, importedAt),
            }, { onConflict: "connection_id,provider_doc_id" })
            .select("id").single();

          if (eventErr || !eventRow) {
            errors.push(`${day}/${docId}: ${eventErr?.message || "event upsert failed"}`);
            continue;
          }
          const replacement = await replaceSalesEventLinesPreservingStockClaims(
            supabase,
            connectionId,
            eventRow.id,
            lineData,
          );
          if (!replacement.ok) {
            errors.push(`${day}/${docId}: ${replacement.error}`);
            continue;
          }
          savedEvents++;
          savedLines += replacement.inserted;
        }

        daySummaries.push({
          day,
          invoices: invoices.length,
          events: dayEvents,
          lines: dayLines,
          resolvedLines: dayResolvedLines,
          unresolvedWineLines: dayUnresolvedLines,
        });
      }

      if (!dryRun) {
        await supabase.from("pos_connections")
          .update({ last_sync_at: new Date().toISOString() })
          .eq("id", connectionId);
      }

      return new Response(
        JSON.stringify({
          success: errors.length === 0 && !aborted,
          dryRun,
          importMode: "historical_analytics",
          stockSyncSkipped: true,
          cursorAdvanced: false,
          fromBusinessDay: fromDay,
          toBusinessDay: toDay,
          scannedDays,
          daysRequested: days.length,
          daysWithSales,
          savedEvents,
          savedLines,
          resolvedLines,
          unresolvedLines,
          aborted,
          nextFromBusinessDay,
          errors: errors.slice(0, 50),
          daySummaries: daySummaries.filter((d) => d.invoices > 0).slice(-30),
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── SAVE SALES TO DB (with Winerim resolution) ──
    if (action === "save-sales") {
      const day = businessDay;
      if (!isBusinessDay(day)) {
        return new Response(JSON.stringify({ error: "businessDay must use YYYY-MM-DD" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const url = `${baseUrlClean}/api/export/?business-day=${day}&filter=Invoices`;
      const res = await fetchWithRetry(url, { headers }, 10_000);
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

      const resolutionMap = await buildSalesResolutionMapFromDb(supabase, connectionId);
      const salesActiveWineFormats = await loadSalesActiveWineFormats(supabase, connectionId);
      const salesPairMappings = await loadSalesPairMappings(supabase, connectionId);

      let savedEvents = 0;
      let savedLines = 0;
      let resolvedLines = 0;
      let unresolvedLines = 0;
      const savedEventIds: string[] = [];
      let ingestionError: string | null = null;

      for (let invIdx = 0; invIdx < invoices.length; invIdx++) {
        const inv = invoices[invIdx];
        const docId = buildAgoraInvoiceDocId(inv, day, invIdx);
        const items = inv.InvoiceItems || [];
        let docTotal = 0;
        const lineData: Record<string, unknown>[] = [];
        let invoiceResolvedLines = 0;
        let invoiceUnresolvedLines = 0;

        for (const item of items) {
          for (const line of (item.Lines || [])) {
            const rawTotal = Number(line.TotalAmount || 0);
            const uP = Number(line.UnitPrice || 0);
            const qty = Number(line.Quantity || 0);
            const lineTotal = rawTotal !== 0 ? rawTotal : uP * qty;
            docTotal += lineTotal;
            const pName = String(line.ProductName || "");
            const fName = String(line.SaleFormatName || "");
            const normalizedFmt = normalizeAgoraLineFormat(pName, fName);
            const fam = String(line.FamilyName || "");
            const legacyProviderProductId = String(line.ProductId || "");
            const salesIdentity = resolveAgoraSalesLineIdentityForConnection({
              connectionId,
              productId: line.ProductId,
              saleFormatId: line.SaleFormatId,
              legacyProviderProductId,
              resolutionMap,
              pairMappings: salesPairMappings,
              activeWineFormats: salesActiveWineFormats,
            });
            const productId = salesIdentity.providerProductId;
            const providerSoldAt = extractAgoraProviderSoldAt(line, item, inv, day);
            const wr = isWineCandidate(fam, pName, fName, uP, wineFamilies, DEFAULT_NON_WINE_FAMILIES);

            // Resolve to winerim wine
            const resolution = salesIdentity.resolution || undefined;
            const winerimProductId = resolution?.winerim_wine_id || null;
            const isResolved = !!winerimProductId;
            const effectiveWineCandidate = isResolvedWineCandidate(winerimProductId, wr.candidate);
            if (isResolved) invoiceResolvedLines++;
            else if (wr.candidate) invoiceUnresolvedLines++;

            lineData.push({
              provider_product_id: productId,
              name: pName, format: canonicalAgoraSalesLineFormat({ connectionId, identity: salesIdentity, fallbackFormat: normalizedFmt }), family: fam,
              quantity: qty, unit_price: uP, total_amount: lineTotal,
              provider_sold_at: providerSoldAt.value,
              provider_sold_at_source: providerSoldAt.source,
              vat_rate: Number(line.VatRate || 0), is_wine_candidate: effectiveWineCandidate,
              winerim_product_id: winerimProductId,
              mapped: isResolved,
            });
          }
        }

        const { data: eventRow, error: eventErr } = await supabase
          .from("sales_events")
          .upsert({
            connection_id: connectionId, provider_doc_id: docId, business_day: day,
            doc_type: agoraDocumentType(inv),
            total_amount: Number(inv.TotalAmount || docTotal),
            total_tax: Number(inv.TotalTaxAmount || 0),
            total_net: Number(inv.TotalNetAmount || 0),
            line_count: lineData.length, raw_json: withAgoraOperationalMetadata(inv, day),
          }, { onConflict: "connection_id,provider_doc_id" })
          .select("id").single();

        if (eventErr || !eventRow) {
          ingestionError = `Could not save invoice ${docId}: ${eventErr?.message || "missing sales event row"}`;
          break;
        }
        const replacement = await replaceSalesEventLinesPreservingStockClaims(
          supabase,
          connectionId,
          eventRow.id,
          lineData,
        );
        if (!replacement.ok) {
          ingestionError = `Could not replace lines for invoice ${docId}: ${replacement.error || "unknown line replacement error"}`;
          break;
        }
        savedEvents++;
        savedLines += replacement.inserted;
        resolvedLines += invoiceResolvedLines;
        unresolvedLines += invoiceUnresolvedLines;
        savedEventIds.push(eventRow.id);
      }

      if (ingestionError) {
        return new Response(
          JSON.stringify({
            success: false,
            error: ingestionError,
            savedEvents,
            savedLines,
            resolvedLines,
            unresolvedLines,
            businessDay: day,
            stockSync: null,
            cursorAdvanced: false,
            cursorBefore: String(connection.last_business_day_synced || "").trim() || null,
            cursorAfter: String(connection.last_business_day_synced || "").trim() || null,
          }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      let stockSyncResult: StockSyncTotals | null = null;
      let warning: string | null = null;
      const winerimToken = (connection.winerim_api_token || "").trim();
      const skipStockSync = !stockFence.allowed;
      const shouldSyncStock = stockFence.allowed && resolvedLines > 0;

      if (shouldSyncStock && winerimToken) {
        stockSyncResult = await syncStockForDays(supabase, connectionId, [day], winerimToken);
      }

      const cursorBefore = String(connection.last_business_day_synced || "").trim();
      const cursorAfter = cursorBefore || null;
      const cursorAdvanced = false;
      if (shouldSyncStock && !winerimToken) {
        warning = "Sales saved but Winerim stock was not synced: missing Winerim API token.";
      } else if ((stockSyncResult?.failed || 0) > 0) {
        warning = "Sales saved but Winerim stock sync had failures. The automatic sync will retry.";
      }

      const syncedAt = new Date().toISOString();
      const cursorResult = await updateSalesCursorMonotonically(
        supabase,
        connectionId,
        null,
        syncedAt,
      );
      if (cursorResult.error) {
        warning = `Sales saved but the sync timestamp could not be updated: ${cursorResult.error}`;
      }

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
          cursorBefore: cursorBefore || null,
          cursorAfter,
          warning,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── INTRADAY SALES SYNC (same business day, incremental stock deltas only) ──
    if (action === "sync-intraday-sales") {
      if (!isIntradaySalesSyncEnabled(connection) && payload.force !== true) {
        return new Response(
          JSON.stringify({ success: true, skipped: true, reason: "intraday_sales_sync_disabled" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const providerConfig = ((connection.provider_config || {}) as Record<string, unknown>);
      const timeZone = String(providerConfig.sales_timezone || "Europe/Madrid");
      const day = isBusinessDay(businessDay) ? businessDay : todayInTimeZone(timeZone);

      const url = `${baseUrlClean}/api/export/?business-day=${day}&filter=Invoices`;
      const res = await fetchWithRetry(url, { headers }, 10_000);
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return new Response(JSON.stringify({ success: false, error: `Agora responded ${res.status}`, details: body.substring(0, 200) }),
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

      const resolutionMap = await buildSalesResolutionMapFromDb(supabase, connectionId);
      const salesActiveWineFormats = await loadSalesActiveWineFormats(supabase, connectionId);
      const salesPairMappings = await loadSalesPairMappings(supabase, connectionId);

      let savedEvents = 0;
      let savedLines = 0;
      let resolvedLines = 0;
      let unresolvedLines = 0;
      const savedEventIds: string[] = [];
      const ingestionErrors: string[] = [];

      for (let invIdx = 0; invIdx < invoices.length; invIdx++) {
        const inv = invoices[invIdx];
        const docId = buildAgoraInvoiceDocId(inv, day, invIdx);
        const items = inv.InvoiceItems || [];
        let docTotal = 0;
        const lineData: Record<string, unknown>[] = [];

        for (const item of items) {
          for (const line of (item.Lines || [])) {
            const rawTotal = Number(line.TotalAmount || 0);
            const uP = Number(line.UnitPrice || 0);
            const qty = Number(line.Quantity || 0);
            const lineTotal = rawTotal !== 0 ? rawTotal : uP * qty;
            docTotal += lineTotal;
            const pName = String(line.ProductName || "");
            const fName = String(line.SaleFormatName || "");
            const normalizedFmt = normalizeAgoraLineFormat(pName, fName);
            const fam = String(line.FamilyName || "");
            const legacyProviderProductId = String(line.ProductId || "");
            const salesIdentity = resolveAgoraSalesLineIdentityForConnection({
              connectionId,
              productId: line.ProductId,
              saleFormatId: line.SaleFormatId,
              legacyProviderProductId,
              resolutionMap,
              pairMappings: salesPairMappings,
              activeWineFormats: salesActiveWineFormats,
            });
            const productId = salesIdentity.providerProductId;
            const providerSoldAt = extractAgoraProviderSoldAt(line, item, inv, day);
            const wr = isWineCandidate(fam, pName, fName, uP, wineFamilies, DEFAULT_NON_WINE_FAMILIES);
            const resolution = salesIdentity.resolution || undefined;
            const winerimProductId = resolution?.winerim_wine_id || null;
            const isResolved = !!winerimProductId;
            const effectiveWineCandidate = isResolvedWineCandidate(winerimProductId, wr.candidate);
            if (isResolved) {
              resolvedLines++;
            } else if (wr.candidate) {
              unresolvedLines++;
            }

            lineData.push({
              provider_product_id: productId,
              name: pName,
              format: canonicalAgoraSalesLineFormat({ connectionId, identity: salesIdentity, fallbackFormat: normalizedFmt }),
              family: fam,
              quantity: qty,
              unit_price: uP,
              total_amount: lineTotal,
              vat_rate: Number(line.VatRate || 0),
              provider_sold_at: providerSoldAt.value,
              provider_sold_at_source: providerSoldAt.source,
              is_wine_candidate: effectiveWineCandidate,
              winerim_product_id: winerimProductId,
              mapped: isResolved,
            });
          }
        }

        const { data: eventRow, error: eventErr } = await supabase
          .from("sales_events")
          .upsert({
            connection_id: connectionId,
            provider_doc_id: docId,
            business_day: day,
            doc_type: agoraDocumentType(inv),
            total_amount: Number(inv.TotalAmount || docTotal),
            total_tax: Number(inv.TotalTaxAmount || 0),
            total_net: Number(inv.TotalNetAmount || 0),
            line_count: lineData.length,
            raw_json: withAgoraOperationalMetadata(inv, day),
          }, { onConflict: "connection_id,provider_doc_id" })
          .select("id").single();

        if (eventErr || !eventRow) {
          ingestionErrors.push(`${day}/${docId}: ${eventErr?.message || "event upsert failed"}`);
          continue;
        }

        const replacement = await replaceSalesEventLinesPreservingStockClaims(
          supabase,
          connectionId,
          eventRow.id,
          lineData,
        );
        if (!replacement.ok) {
          ingestionErrors.push(`${day}/${docId}: ${replacement.error}`);
          continue;
        }
        savedLines += replacement.inserted;
        savedEvents++;
        savedEventIds.push(eventRow.id);
      }

      let stockSyncResult: StockSyncTotals | null = null;
      let warning: string | null = null;
      const winerimToken = (connection.winerim_api_token || "").trim();
      if (stockFence.allowed && resolvedLines > 0) {
        if (!winerimToken) {
          warning = "Sales saved but Winerim stock was not synced: missing Winerim API token.";
          stockSyncResult = { synced: 0, skipped: 0, failed: 1, checkedDays: 0, errors: [`${day}: missing Winerim API token`] };
        } else {
          stockSyncResult = await syncStockForDays(supabase, connectionId, [day], winerimToken, {
            incremental: true,
            desiredEventIdsByDay: { [day]: savedEventIds },
          });
        }
      }

      const now = new Date().toISOString();
      const nextConfig = {
        ...providerConfig,
        last_intraday_sales_sync: {
          at: now,
          day,
          success: (stockSyncResult?.failed || 0) === 0 && ingestionErrors.length === 0,
          invoiceCount: invoices.length,
          savedEvents,
          savedLines,
          resolvedLines,
          unresolvedLines,
          ingestionErrors,
          stockSync: stockSyncResult,
        },
      };

      await supabase.from("pos_connections")
        .update({ last_sync_at: now, provider_config: nextConfig })
        .eq("id", connectionId);

      return new Response(
        JSON.stringify({
          success: (stockSyncResult?.failed || 0) === 0 && ingestionErrors.length === 0,
          businessDay: day,
          invoiceCount: invoices.length,
          savedEvents,
          savedLines,
          resolvedLines,
          unresolvedLines,
          ingestionErrors,
          stockSync: stockSyncResult,
          stockSyncSkipped: stockFence.skipped,
          stockSyncSkippedReason: stockFence.reason,
          cursorAdvanced: false,
          warning,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── AUTO-SYNC SALES (find pending days and save them) ──
    if (action === "auto-sync-sales") {
      const providerConfig = ((connection.provider_config || {}) as Record<string, unknown>);
      // Open-ticket sync may pre-discount the current business day. Closed invoices
      // must reconcile by daily total so the same sale is not discounted twice.
      const useIncrementalStockSync = isIntradaySalesSyncEnabled(connection) || isOpenTicketsSyncEnabled(connection);
      // Do not advance beyond a business day that still has live open tickets.
      // Agora installations can keep a table open across midnight; without this
      // overlap, a later invoice close would fall behind the closed-day cursor.
      const persistedLastSynced = connection.last_business_day_synced;
      const activeOpenTicketDays = recentOpenTicketBusinessDays(providerConfig);
      const openTicketCursorCeiling = activeOpenTicketDays[0]
        ? addUtcDays(activeOpenTicketDays[0], -1)
        : null;
      const capClosedDayCursor = (day: string | null): string | null => {
        if (!day) return null;
        return openTicketCursorCeiling && day > openTicketCursorCeiling
          ? openTicketCursorCeiling
          : day;
      };
      const lastSynced = capClosedDayCursor(persistedLastSynced);
      const startDate = lastSynced
        ? new Date(new Date(lastSynced).getTime() + 86400000)
        : new Date(Date.now() - 30 * 86400000);
      const today = new Date();
      const yesterday = new Date(today.getTime() - 86400000);

      // Scan from startDate to yesterday (closed days only)
      // Wall-clock guard: bail out before edge runtime 150s idle timeout (504 IDLE_TIMEOUT)
      const ACTION_DEADLINE_MS = 120_000;
      const INVOICE_DEADLINE_RESERVE_MS = 15_000;
      const actionStart = Date.now();
      const pendingDays: string[] = [];
      const current = new Date(startDate);
      let scanAborted = false;
      let scanBlockedDay: string | null = null;
      let lastSuccessfullyScannedDay: string | null = null;
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
            lastSuccessfullyScannedDay = dayStr;
          } else {
            await res.text();
            scanBlockedDay = dayStr;
            break;
          }
        } catch (err) {
          scanBlockedDay = dayStr;
          break;
        }
        current.setDate(current.getDate() + 1);
      }
      if (scanAborted) {
        return new Response(
          JSON.stringify({ success: false, aborted: true, reason: "scan_deadline_exceeded", message: "Agora server unresponsive; aborted before timeout. Will retry next cron." }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (scanBlockedDay && pendingDays.length === 0) {
        return new Response(
          JSON.stringify({
            success: false,
            reason: "closed_day_scan_failed",
            blockedDay: scanBlockedDay,
            message: `Agora sales scan failed for ${scanBlockedDay}. Cursor was not advanced and cron will retry.`,
          }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      if (pendingDays.length === 0) {
        const winerimToken = (connection.winerim_api_token || "").trim();
        let stockSyncResult: StockSyncTotals | null = null;

        if (stockFence.allowed && winerimToken) {
          const lookbackDays = Math.min(Math.max(Number(connection.backfill_days || 30), 1), 30);
          const fromDay = new Date(yesterday.getTime() - (lookbackDays - 1) * 86400000).toISOString().split("T")[0];
          const toDay = yesterday.toISOString().split("T")[0];
          const stockCandidateDays = (await findSavedStockCandidateDays(supabase, connectionId, fromDay, toDay))
            .filter((day) => isStockSyncDayAllowed(day, providerConfig));
          if (stockCandidateDays.length > 0) {
            stockSyncResult = await syncStockForDays(supabase, connectionId, stockCandidateDays, winerimToken, { incremental: useIncrementalStockSync });
          }
        }

        const scannedCursor = capClosedDayCursor(lastSuccessfullyScannedDay);
        const cursorResult = await updateSalesCursorMonotonically(
          supabase,
          connectionId,
          scannedCursor,
        );
        if (cursorResult.error) {
          return new Response(
            JSON.stringify({
              success: false,
              reason: "cursor_update_failed",
              error: cursorResult.error,
              message: "Sales were checked, but the live cursor could not be persisted safely.",
            }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
        const cursorAdvancedTo = cursorResult.advanced ? cursorResult.cursor : null;

        return new Response(
          JSON.stringify({
            success: true,
            daysSynced: 0,
            totalEvents: 0,
            totalLines: 0,
            resolvedLines: 0,
            unresolvedLines: 0,
            stockSync: stockSyncResult,
            cursorAdvancedTo,
            activeOpenTicketDays,
            openTicketCursorCeiling,
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

      const resolutionMap = await buildSalesResolutionMapFromDb(supabase, connectionId);
      const salesActiveWineFormats = await loadSalesActiveWineFormats(supabase, connectionId);
      const salesPairMappings = await loadSalesPairMappings(supabase, connectionId);

      let totalEvents = 0, totalLines = 0, resolvedLines = 0, unresolvedLines = 0;
      let resumedExistingEvents = 0;
      const syncedDays: string[] = [];
      const stockDaysAttempted = new Set<string>();
      let stockBlockedDay: string | null = null;
      let saveBlockedDay: string | null = null;
      let saveBlockedReason: string | null = null;
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
        catch {
          saveBlockedDay = day;
          saveBlockedReason = "invoice_fetch_failed";
          break;
        }
        if (!res.ok) {
          await res.text();
          saveBlockedDay = day;
          saveBlockedReason = `invoice_fetch_http_${res.status}`;
          break;
        }
        const rawData = await res.json();
        const invoices = parseInvoices(rawData);
        let completeDocIds: Set<string>;
        try {
          completeDocIds = await loadCompleteSalesEventDocIdsForDay(supabase, connectionId, day);
        } catch (error) {
          saveBlockedDay = day;
          saveBlockedReason = `resume_checkpoint_failed:${error instanceof Error ? error.message : String(error)}`;
          break;
        }
        let dayEvents = 0;
        let dayResolvedLines = 0;

        for (let invIdx = 0; invIdx < invoices.length; invIdx++) {
          if (shouldPauseAgoraInvoiceProcessing(
            Date.now() - actionStart,
            ACTION_DEADLINE_MS,
            INVOICE_DEADLINE_RESERVE_MS,
          )) {
            processingAborted = true;
            break;
          }
          const inv = invoices[invIdx];
          const docId = buildAgoraInvoiceDocId(inv, day, invIdx);
          const items = inv.InvoiceItems || [];
          let docTotal = 0;
          const lineData: Record<string, unknown>[] = [];
          let invoiceResolvedLines = 0;
          let invoiceUnresolvedLines = 0;

          for (const item of items) {
            for (const line of (item.Lines || [])) {
              const rawTotal = Number(line.TotalAmount || 0);
              const uP = Number(line.UnitPrice || 0);
              const qty = Number(line.Quantity || 0);
              const lineTotal = rawTotal !== 0 ? rawTotal : uP * qty;
              docTotal += lineTotal;
              const pName = String(line.ProductName || "");
              const fName = String(line.SaleFormatName || "");
              const normalizedFmt = normalizeAgoraLineFormat(pName, fName);
              const fam = String(line.FamilyName || "");
              const legacyProviderProductId = String(line.ProductId || "");
              const salesIdentity = resolveAgoraSalesLineIdentityForConnection({
                connectionId,
                productId: line.ProductId,
                saleFormatId: line.SaleFormatId,
                legacyProviderProductId,
                resolutionMap,
                pairMappings: salesPairMappings,
                activeWineFormats: salesActiveWineFormats,
              });
              const productId = salesIdentity.providerProductId;
              const providerSoldAt = extractAgoraProviderSoldAt(line, item, inv, day);
              const wr = isWineCandidate(fam, pName, fName, uP, wineFamilies, DEFAULT_NON_WINE_FAMILIES);

              const resolution = salesIdentity.resolution || undefined;
              const winerimProductId = resolution?.winerim_wine_id || null;
              const isResolved = !!winerimProductId;
              const effectiveWineCandidate = isResolvedWineCandidate(winerimProductId, wr.candidate);
              if (isResolved) {
                invoiceResolvedLines++;
              } else if (wr.candidate) {
                invoiceUnresolvedLines++;
              }

              lineData.push({
                provider_product_id: productId,
                name: pName, format: canonicalAgoraSalesLineFormat({ connectionId, identity: salesIdentity, fallbackFormat: normalizedFmt }), family: fam,
                quantity: qty, unit_price: uP, total_amount: lineTotal,
                provider_sold_at: providerSoldAt.value,
                provider_sold_at_source: providerSoldAt.source,
                vat_rate: Number(line.VatRate || 0), is_wine_candidate: effectiveWineCandidate,
                winerim_product_id: winerimProductId,
                mapped: isResolved,
              });
            }
          }

          if (completeDocIds.has(docId)) {
            totalEvents++;
            dayEvents++;
            totalLines += lineData.length;
            resolvedLines += invoiceResolvedLines;
            unresolvedLines += invoiceUnresolvedLines;
            dayResolvedLines += invoiceResolvedLines;
            resumedExistingEvents++;
            continue;
          }

          const { data: eventRow, error: eventErr } = await supabase
            .from("sales_events")
            .upsert({
              connection_id: connectionId, provider_doc_id: docId, business_day: day,
              doc_type: agoraDocumentType(inv),
              total_amount: Number(inv.TotalAmount || docTotal),
              total_tax: Number(inv.TotalTaxAmount || 0),
              total_net: Number(inv.TotalNetAmount || 0),
              line_count: lineData.length, raw_json: withAgoraOperationalMetadata(inv, day),
            }, { onConflict: "connection_id,provider_doc_id" })
            .select("id").single();

          if (eventErr || !eventRow) {
            saveBlockedDay = day;
            saveBlockedReason = `event_upsert_failed:${eventErr?.message || "missing sales event row"}`;
            break;
          }
          const replacement = await replaceSalesEventLinesPreservingStockClaims(
            supabase,
            connectionId,
            eventRow.id,
            lineData,
          );
          if (!replacement.ok) {
            saveBlockedDay = day;
            saveBlockedReason = `line_replace_failed:${replacement.error || "unknown error"}`;
            break;
          }
          totalEvents++;
          dayEvents++;
          totalLines += replacement.inserted;
          resolvedLines += invoiceResolvedLines;
          unresolvedLines += invoiceUnresolvedLines;
          dayResolvedLines += invoiceResolvedLines;
          completeDocIds.add(docId);
        }

        if (processingAborted) break;
        if (saveBlockedDay) break;
        if (invoices.length > 0 && dayEvents !== invoices.length) {
          saveBlockedDay = day;
          saveBlockedReason = `incomplete_day:${dayEvents}/${invoices.length}`;
          break;
        }

        let stockOk = true;
        if (stockFence.allowed && dayResolvedLines > 0 && isStockSyncDayAllowed(day, providerConfig)) {
          if (!winerimToken) {
            stockOk = false;
            stockSyncTotals.failed++;
            stockSyncTotals.errors.push(`${day}: missing Winerim API token`);
          } else {
            const dayStock = await syncStockForDays(supabase, connectionId, [day], winerimToken, { incremental: useIncrementalStockSync });
            stockDaysAttempted.add(day);
            addStockTotals(dayStock);
            stockOk = dayStock.failed === 0;
          }
        }

        if (!stockOk) {
          stockBlockedDay = day;
          break;
        }

        const completedDayCursor = capClosedDayCursor(day);
        const cursorResult = await updateSalesCursorMonotonically(
          supabase,
          connectionId,
          completedDayCursor,
        );
        if (cursorResult.error) {
          saveBlockedDay = day;
          saveBlockedReason = `cursor_update_failed:${cursorResult.error}`;
          break;
        }
        syncedDays.push(day);
      }

      if (stockFence.allowed && !stockBlockedDay && !saveBlockedDay && winerimToken && Date.now() - actionStart < ACTION_DEADLINE_MS) {
        const lookbackDays = Math.min(Math.max(Number(connection.backfill_days || 30), 1), 30);
        const fromDay = new Date(yesterday.getTime() - (lookbackDays - 1) * 86400000).toISOString().split("T")[0];
        const toDay = yesterday.toISOString().split("T")[0];
        const catchupDays = (await findSavedStockCandidateDays(supabase, connectionId, fromDay, toDay))
          .filter((day) => isStockSyncDayAllowed(day, providerConfig))
          .filter((day) => !stockDaysAttempted.has(day));
        if (catchupDays.length > 0) {
          addStockTotals(await syncStockForDays(supabase, connectionId, catchupDays, winerimToken, { incremental: useIncrementalStockSync }));
        }
      }

      const stockSyncResult = stockSyncTotals.checkedDays > 0 || stockSyncTotals.failed > 0 ? stockSyncTotals : null;
      let cursorAdvancedTo: string | null = null;
      if (!processingAborted && !stockBlockedDay && !saveBlockedDay && lastSuccessfullyScannedDay) {
        const latestProcessedDay = capClosedDayCursor(syncedDays.at(-1) || lastSynced);
        const scannedCursor = capClosedDayCursor(lastSuccessfullyScannedDay);
        if (scannedCursor && (!latestProcessedDay || scannedCursor > latestProcessedDay)) {
          const cursorResult = await updateSalesCursorMonotonically(
            supabase,
            connectionId,
            scannedCursor,
          );
          if (cursorResult.error) {
            saveBlockedDay = scannedCursor;
            saveBlockedReason = `cursor_update_failed:${cursorResult.error}`;
          } else if (cursorResult.advanced) {
            cursorAdvancedTo = cursorResult.cursor;
          }
        }
      }

      return new Response(
        JSON.stringify({
          success: !processingAborted && !scanBlockedDay && !stockBlockedDay && !saveBlockedDay,
          daysSynced: syncedDays.length,
          pendingDaysFound: pendingDays.length,
          syncedDays,
          totalEvents,
          totalLines,
          resolvedLines,
          unresolvedLines,
          resumedExistingEvents,
          stockSync: stockSyncResult,
          cursorAdvancedTo,
          activeOpenTicketDays,
          openTicketCursorCeiling,
          blockedByScanFailure: scanBlockedDay,
          blockedByStockFailure: stockBlockedDay,
          blockedBySaveFailure: saveBlockedDay,
          blockedBySaveFailureReason: saveBlockedReason,
          aborted: processingAborted,
          message: stockBlockedDay
            ? `Stock sync failed for ${stockBlockedDay}. Cursor was not advanced and cron will retry.`
            : saveBlockedDay
              ? saveBlockedReason?.startsWith("cursor_update_failed")
                ? `Cursor update failed for ${saveBlockedDay}. The cursor was left unchanged and cron will retry.`
                : `Sales ingestion failed for ${saveBlockedDay}. Cursor was not advanced and cron will retry.`
              : scanBlockedDay
                ? `Agora sales scan failed for ${scanBlockedDay}. Cursor was advanced only through successfully checked days.`
              : processingAborted
                ? "Processing deadline reached. Completed invoices are durable checkpoints; cursor was advanced only through completed days."
                : undefined,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── READ-ONLY SALES RESOLUTION DEBUG (no writes, no TPV calls) ──
    // ── STOCK FENCE DRY-RUN (read-only, proves skip/fence blocks side effects) ──
    if (action === "debug-stock-fence") {
      const providerConfigForFence = (connection.provider_config || {}) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          success: true,
          connectionId,
          force: payload.force === true,
          skipStockSyncRequested: payload.skipStockSync === true,
          salesStockSyncEnabled: providerConfigForFence.sales_stock_sync_enabled !== false,
          stockSyncAllowed: stockFence.allowed,
          stockSyncSkipped: stockFence.skipped,
          stockSyncSkippedReason: stockFence.reason,
          wouldCallSyncStockForDays: stockFence.allowed,
          wouldCallWinerimSalesImport: stockFence.allowed,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (action === "debug-sales-resolution") {
      const resolutionMap = await buildSalesResolutionMapFromDb(supabase, connectionId);
      const salesActiveWineFormats = await loadSalesActiveWineFormats(supabase, connectionId);
      const salesPairMappings = await loadSalesPairMappings(supabase, connectionId);
      const requestedIds: string[] = [
        ...(payload.productId ? [String(payload.productId)] : []),
        ...(Array.isArray(payload.productIds) ? payload.productIds.map((id: unknown) => String(id)) : []),
      ].map((id) => id.trim()).filter(Boolean);

      const { count: unresolvedCandidateCount } = await supabase
        .from("sales_line_items")
        .select("id", { count: "exact", head: true })
        .eq("connection_id", connectionId)
        .eq("is_wine_candidate", true)
        .is("winerim_product_id", null);

      const results = requestedIds.map((productId) => {
        const resolution = resolutionMap.get(productId) || null;
        return { provider_product_id: productId, resolved: Boolean(resolution), resolution };
      });

      // Read-only forward-resolution probe for concrete ticket lines.
      const probeLines = Array.isArray(payload.lines) ? payload.lines as Record<string, unknown>[] : [];
      const lineResults = probeLines.map((probe) => {
        const identity = resolveAgoraSalesLineIdentityForConnection({
          connectionId,
          productId: probe.ProductId ?? probe.productId,
          saleFormatId: probe.SaleFormatId ?? probe.saleFormatId,
          legacyProviderProductId: String(probe.ProductId ?? probe.productId ?? ""),
          resolutionMap,
          pairMappings: salesPairMappings,
          activeWineFormats: salesActiveWineFormats,
        });
        return {
          input: {
            ProductId: String(probe.ProductId ?? probe.productId ?? ""),
            SaleFormatId: String(probe.SaleFormatId ?? probe.saleFormatId ?? ""),
            ProductName: String(probe.ProductName ?? probe.productName ?? ""),
          },
          providerProductId: identity.providerProductId,
          source: identity.source,
          kind: identity.resolution
            ? (identity.source === "pair_exact" ? "pair_exact" : "native")
            : "unresolved",
          blockedReason: identity.blockedReason ?? null,
          resolved: Boolean(identity.resolution),
          winerim_wine_id: identity.resolution?.winerim_wine_id ?? null,
          format: identity.resolution?.format ?? null,
          normalizedFormat: normalizeAgoraLineFormat(
            String(probe.ProductName ?? probe.productName ?? ""),
            String(probe.SaleFormatName ?? probe.saleFormatName ?? ""),
          ),
          persistedFormat: canonicalAgoraSalesLineFormat({
            connectionId,
            identity,
            fallbackFormat: normalizeAgoraLineFormat(
              String(probe.ProductName ?? probe.productName ?? ""),
              String(probe.SaleFormatName ?? probe.saleFormatName ?? ""),
            ),
          }),
        };
      });

      return new Response(
        JSON.stringify({
          success: true,
          connectionId,
          resolutionMapSize: resolutionMap.size,
          pairMappingCount: salesPairMappings ? salesPairMappings.size : null,
          unresolvedCandidateCount: unresolvedCandidateCount ?? 0,
          activeWineCount: salesActiveWineFormats ? salesActiveWineFormats.size : null,
          results,
          lineResults,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }


    // ── VINOTECA NATIVE FORMATS DRY-RUN (read-only, never sends XML) ──
    if (action === "vinoteca-dry-run") {
      if (!isVinotecaNativeFormatsConnection(connectionId, (connection.provider_config || {}) as Record<string, unknown>)) {
        return new Response(
          JSON.stringify({
            success: false,
            error: `Connection is not in the ${VINOTECA_REGION_REFERENCE_NATIVE_FORMATS} allowlist or the mode is not configured`,
          }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const requestedWineIds = [
        ...(payload.winerimWineId ? [String(payload.winerimWineId)] : []),
        ...(Array.isArray(payload.winerimWineIds) ? payload.winerimWineIds.map((id: unknown) => String(id)) : []),
      ].map((id) => id.trim()).filter(Boolean);

      const { data: masterData } = await supabase
        .from("agora_master_data").select("*").eq("connection_id", connectionId).single();
      if (!masterData) {
        return new Response(
          JSON.stringify({ success: false, error: "No master data cached for this connection" }),
          { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      let winesQuery = supabase.from("winerim_wines").select("*").eq("connection_id", connectionId);
      if (requestedWineIds.length > 0) winesQuery = winesQuery.in("winerim_id", requestedWineIds);
      const { data: dryRunWines } = await winesQuery.limit(requestedWineIds.length > 0 ? requestedWineIds.length : 200);

      if (!dryRunWines || dryRunWines.length === 0) {
        return new Response(
          JSON.stringify({ success: false, error: "No wines found for the requested winerimWineIds" }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const dryRun = generateImportXml(
        dryRunWines,
        masterData,
        connection,
        ["BOTTLE", "GLASS", "MAGNUM"],
        await loadCustomFamilyMappings(connectionId),
        false,
        undefined,
        undefined,
        undefined,
        undefined,
        await loadVinotecaCatalogRoutes(supabase, connectionId),
      );

      const existingIdentityIds = (dryRun.vinoteca?.plans as VinotecaReferencePlan[] | undefined || [])
        .flatMap((plan) => plan.formats.map((format) => format.agoraId));
      const { data: existingMappings } = existingIdentityIds.length > 0
        ? await supabase.from("product_mappings")
          .select("provider_product_id, winerim_wine_id, format_type, status")
          .eq("connection_id", connectionId).in("provider_product_id", existingIdentityIds)
        : { data: [] as Record<string, unknown>[] };
      const { data: existingTracking } = existingIdentityIds.length > 0
        ? await supabase.from("winerim_push_tracking")
          .select("agora_product_id, winerim_wine_id, format, sync_status")
          .eq("connection_id", connectionId).in("agora_product_id", existingIdentityIds)
        : { data: [] as Record<string, unknown>[] };

      return new Response(
        JSON.stringify({
          success: true,
          dryRun: true,
          sent: false,
          connectionId,
          mode: VINOTECA_REGION_REFERENCE_NATIVE_FORMATS,
          winesEvaluated: dryRunWines.length,
          vinoteca: dryRun.vinoteca,
          validationResults: dryRun.validationResults,
          existingMappings: existingMappings || [],
          existingTracking: existingTracking || [],
          xml: dryRun.xml,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ── RESOLVE EXISTING SALES LINES (re-resolution pass) ──
    if (action === "resolve-sales") {
      const resolutionMap = await buildSalesResolutionMapFromDb(supabase, connectionId);
      const salesActiveWineFormats = await loadSalesActiveWineFormats(supabase, connectionId);
      const salesPairMappings = await loadSalesPairMappings(supabase, connectionId);

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
      const res = await fetchWithRetry(url, { headers }, 10_000);
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
            const res = await fetchWithRetry(url, { headers }, 10_000);
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
      const res = await fetchWithRetry(url, { headers }, 10_000);
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
          const res = await fetchWithRetry(url, { headers }, 10_000);
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

        const resBody = await readResponseTextBestEffort(res);
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
      const MIN_TIME_FOR_CLAIM_MS = 3_000;
      const startTime = Date.now();
      let processed = 0, succeeded = 0, failed = 0;

      while (Date.now() - startTime < TIME_BUDGET_MS) {
        if (TIME_BUDGET_MS - (Date.now() - startTime) < MIN_TIME_FOR_CLAIM_MS) break;

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

        const unprocessedClaimedTasks = usedAtomicClaim ? [...(tasks as any[])] : [];
        const forgetClaimedTask = (taskId: string) => {
          const idx = unprocessedClaimedTasks.findIndex((task: any) => task.id === taskId);
          if (idx >= 0) unprocessedClaimedTasks.splice(idx, 1);
        };

        for (const t of tasks) {
          if (Date.now() - startTime >= TIME_BUDGET_MS) break;
          forgetClaimedTask(t.id);
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
              const resBody = await readResponseTextBestEffort(res);

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

        if (unprocessedClaimedTasks.length > 0) {
          for (const pending of unprocessedClaimedTasks) {
            await supabase.from("outbound_tasks").update({
              status: "QUEUED",
              attempts: Math.max(((pending as any).attempts || 1) - 1, 0),
              next_retry_at: null,
              updated_at: new Date().toISOString(),
            }).eq("id", (pending as any).id).eq("status", "RUNNING");
          }
          break;
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
        PreparationTypeId: (p as any).PreparationTypeId,
        PreparationOrderId: (p as any).PreparationOrderId,
        Order: (p as any).Order,
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

      // Only promote write_mode for normal onboarding. Read-only audits must not
      // become XML_IMPORT just because master data was readable.
      const preserveWriteMode = payload.preserveWriteMode === true ||
        ((connection.provider_config || {}) as Record<string, unknown>).read_only_onboarding === true;
      if (!preserveWriteMode && (families.length > 0 || products.length > 0)) {
        await supabase.from("pos_connections").update({
          write_mode: "XML_IMPORT",
        }).eq("id", connectionId).eq("write_mode", "NONE");

        // Preserve verified write capability. Master-data reads prove catalog access,
        // but must not downgrade a connection that already completed a real XML import.
        const { data: existingCaps } = await supabase
          .from("provider_capabilities")
          .select("can_write_products, readiness_status, write_mode")
          .eq("connection_id", connectionId)
          .maybeSingle();
        const existingWriteConfirmed = existingCaps?.can_write_products === "YES";
        await supabase.from("provider_capabilities").upsert({
          connection_id: connectionId, provider: "AGORA",
          can_read_sales: true, can_read_catalog: true,
          can_write_products: existingCaps?.can_write_products || "UNKNOWN",
          readiness_status: existingWriteConfirmed ? "READY" : (existingCaps?.readiness_status || "UNKNOWN"),
          write_mode: existingWriteConfirmed ? "XML_IMPORT" : (existingCaps?.write_mode || "XML_IMPORT"),
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
      const familyById = new Map(existingFamilies.map((family) => [String(family.Id), family]));
      const idCollisions: { id: string; expectedName: string; actualName: string }[] = [];

      for (const pf of PILOT_FAMILIES) {
        const existing = existingFamilies.find(f => f.Name.toUpperCase() === pf.name.toUpperCase());
        if (existing) {
          alreadyExist.push({ id: existing.Id, name: existing.Name, key: pf.key });
        } else {
          const newId = stableFamilyId(pf.name);
          const occupied = familyById.get(String(newId));
          if (occupied && occupied.Name.toUpperCase() !== pf.name.toUpperCase()) {
            idCollisions.push({ id: String(newId), expectedName: pf.name, actualName: occupied.Name });
          } else {
            toCreate.push({ id: newId, name: pf.name, key: pf.key });
          }
        }
      }

      if (idCollisions.length > 0) {
        return new Response(JSON.stringify({
          success: false,
          error: "AGORA_FAMILY_ID_COLLISION",
          collisions: idCollisions,
        }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
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
          xml += `    <Family Id="${f.id}" Name="${escXml(f.name)}" ShowInPos="false" ButtonText="${escXml(f.name.substring(0, 15))}" Color="#722F37" Order="200" />\n`;
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

      if (!importSuccess) {
        return new Response(JSON.stringify({
          success: false,
          created: [],
          reused: alreadyExist,
          error: importError,
          totalMappings: alreadyExist.length,
        }), { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      if (toCreate.length > 0) {
        const verifyUrl = `${baseUrlClean}/api/export-master/?filter=Families`;
        const verifyRes = await fetchWithRetry(verifyUrl, {
          headers: { "Api-Token": apiTokenClean, Accept: "application/xml" },
        }, 30000);
        const verifyXml = verifyRes.ok ? await verifyRes.text() : "";
        const verifiedFamilies = new Map(
          extractXmlElementsWithAttrs(verifyXml, "Family").map((family) => [String(family.attrs.Id || ""), family.attrs]),
        );
        const missingOrDifferent = toCreate.filter((family) => {
          const actual = verifiedFamilies.get(String(family.id));
          return !actual || String(actual.Name || "").toUpperCase() !== family.name.toUpperCase();
        });
        if (!verifyRes.ok || missingOrDifferent.length > 0) {
          return new Response(JSON.stringify({
            success: false,
            created: [],
            reused: alreadyExist,
            error: "AGORA_FAMILY_VERIFICATION_FAILED",
            missingOrDifferent,
          }), { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } });
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
        const verification: { id: string; expected: boolean; actual: boolean | null; ok: boolean }[] = [];
        let verificationError: string | null = null;

        if (parsed.success) {
          try {
            const freshRes = await fetchWithRetry(
              famUrl,
              { method: "GET", headers: { "Api-Token": apiTokenClean, Accept: "application/xml" } },
              30000,
            );
            const freshXml = await freshRes.text().catch(() => "");
            if (!freshRes.ok || !freshXml) {
              verificationError = `No se pudo verificar familias tras importar: HTTP ${freshRes.status}`;
            } else {
              const freshFamilyById = new Map<string, string>();
              const freshFamilyRegex = /<Family\b[^>]*\/>|<Family\b[^>]*>[\s\S]*?<\/Family>/g;
              let freshMatch: RegExpExecArray | null;
              while ((freshMatch = freshFamilyRegex.exec(freshXml)) !== null) {
                const freshId = /\bId="([^"]+)"/.exec(freshMatch[0])?.[1];
                if (freshId) freshFamilyById.set(freshId, freshMatch[0]);
              }
              for (const item of applied) {
                const freshEl = freshFamilyById.get(String(item.id));
                const actualAttr = freshEl ? /\bShowInPos="([^"]+)"/i.exec(freshEl)?.[1] : null;
                const actual = actualAttr == null ? null : actualAttr.toLowerCase() === "true";
                verification.push({ id: item.id, expected: item.showInPos, actual, ok: actual === item.showInPos });
              }
              if (verification.some((item) => !item.ok)) {
                verificationError = "Agora aceptó la importación, pero no persistió toda la visibilidad de familias";
              }
            }
          } catch (verifyError) {
            verificationError = `Verificación de familias falló: ${String(verifyError)}`;
          }
        }

        const verified = parsed.success && !verificationError && verification.length === applied.length;
        return new Response(JSON.stringify({
          success: verified, applied, skipped, verification,
          error: !parsed.success
            ? (parsed.errors.join("; ") || `HTTP ${importRes.status}: ${responseBody.slice(0, 300)}`)
            : verificationError,
          xmlPreview: xml.slice(0, 1000),
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: String(e) }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }

    // ── SET PRODUCT VISIBILITY (toggle or restore exact Agora sale flags, batched) ──
    // Pulls the FULL <Product .../> element from Agora's export-master XML (cached) and only
    // overrides the two visibility attributes. Minimal product XML is rejected by Agora (HTTP 500)
    // because required attributes (Price, Vat, ButtonText, Color, etc.) are missing.
    if (action === "set-product-visibility") {
      const updates: {
        productId: string;
        visible?: boolean;
        useAsDirectSale?: boolean;
        saleableAsMain?: boolean;
      }[] = payload.updates || [];
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
      const applied: { id: string; useAsDirectSale: boolean; saleableAsMain: boolean }[] = [];
      const skipped: string[] = [];
      for (const u of updates) {
        const pid = String(u.productId);
        const original = productElByIdLocal.get(pid);
        if (!original) { skipped.push(pid); continue; }
        const hasExactFlags = typeof u.useAsDirectSale === "boolean" && typeof u.saleableAsMain === "boolean";
        const hasVisibilityFlag = typeof u.visible === "boolean";
        if (!hasExactFlags && !hasVisibilityFlag) { skipped.push(pid); continue; }

        const useAsDirectSale = hasExactFlags ? u.useAsDirectSale! : u.visible!;
        const saleableAsMain = hasExactFlags ? u.saleableAsMain! : u.visible!;
        let patched = setAttr(original, "UseAsDirectSale", useAsDirectSale ? "true" : "false");
        patched = setAttr(patched, "SaleableAsMain", saleableAsMain ? "true" : "false");
        xml += `    ${patched}\n`;
        applied.push({ id: pid, useAsDirectSale, saleableAsMain });
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
        const verification: {
          id: string;
          expectedUseAsDirectSale: boolean;
          expectedSaleableAsMain: boolean;
          actualUseAsDirectSale: boolean | null;
          actualSaleableAsMain: boolean | null;
          ok: boolean;
        }[] = [];
        let verificationError: string | null = null;

        if (parsed.success) {
          try {
            invalidateAgoraProductsCache(connectionId);
            const fresh = await fetchAgoraProductsXmlCached(
              connectionId, baseUrlClean, apiTokenClean, fetchWithRetry, 30000, true,
            );
            if (!fresh.ok || !fresh.xml) {
              verificationError = `No se pudo verificar productos tras importar: HTTP ${fresh.status}`;
            } else {
              const freshProductById = new Map<string, string>();
              const freshProductRegex = /<Product\b[^>]*\/>|<Product\b[^>]*>[\s\S]*?<\/Product>/g;
              let freshMatch: RegExpExecArray | null;
              while ((freshMatch = freshProductRegex.exec(fresh.xml)) !== null) {
                const freshId = /\bId="([^"]+)"/.exec(freshMatch[0])?.[1];
                if (freshId) freshProductById.set(freshId, freshMatch[0]);
              }
              for (const item of applied) {
                const freshEl = freshProductById.get(String(item.id));
                const directAttr = freshEl ? /\bUseAsDirectSale="([^"]+)"/i.exec(freshEl)?.[1] : null;
                const saleableAttr = freshEl ? /\bSaleableAsMain="([^"]+)"/i.exec(freshEl)?.[1] : null;
                const actualUseAsDirectSale = directAttr == null ? null : directAttr.toLowerCase() === "true";
                const actualSaleableAsMain = saleableAttr == null ? null : saleableAttr.toLowerCase() === "true";
                verification.push({
                  id: item.id,
                  expectedUseAsDirectSale: item.useAsDirectSale,
                  expectedSaleableAsMain: item.saleableAsMain,
                  actualUseAsDirectSale,
                  actualSaleableAsMain,
                  ok: actualUseAsDirectSale === item.useAsDirectSale && actualSaleableAsMain === item.saleableAsMain,
                });
              }
              if (verification.some((item) => !item.ok)) {
                verificationError = "Agora aceptó la importación, pero no persistió toda la visibilidad de productos";
              }
            }
          } catch (verifyError) {
            verificationError = `Verificación de productos falló: ${String(verifyError)}`;
          }
        }

        const verified = parsed.success && !verificationError && verification.length === applied.length;
        return new Response(JSON.stringify({
          success: verified, applied, skipped, verification,
          error: !parsed.success
            ? (parsed.errors.join("; ") || `HTTP ${importRes.status}: ${responseBody.slice(0, 300)}`)
            : verificationError,
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

    // ── NORMALIZE EXISTING WINERIM FAMILY PRESENTATION ──
    // Safe operation: preserves the full Agora <Product> XML and only rewrites
    // Order plus the explicitly configured visible ButtonText policy.
    if (action === "reorder-products-by-commercial-code" || action === "reorder-winerim-family-products") {
      const dryRun = payload.dryRun !== false;
      const providerConfig = ((connection as any).provider_config || {}) as Record<string, unknown>;
      const requestedSortMode = String(payload.sortMode || "").trim().toUpperCase();
      const sortMode = action === "reorder-products-by-commercial-code"
        ? "COMMERCIAL_CODE_NUMERIC"
        : requestedSortMode || agoraProductSortMode(connection);
      const requestedButtonTextMode = String(payload.buttonTextMode || "").trim().toUpperCase();
      const buttonTextMode = action === "reorder-products-by-commercial-code"
        ? ""
        : requestedButtonTextMode || agoraProductButtonTextMode(connection);
      const useCommercialSort = sortMode === "COMMERCIAL_CODE_NUMERIC";
      const useAlphabeticalSort = sortMode === AGORA_SORT_ALPHABETICAL_WINE_NAME;
      const rewriteButtonText = [
        AGORA_BUTTON_TEXT_WINE_NAME_ONLY,
        AGORA_BUTTON_TEXT_WINE_NAME_WITH_FORMAT_SUFFIX,
      ].includes(buttonTextMode);
      if (!useCommercialSort && !useAlphabeticalSort) {
        return new Response(JSON.stringify({
          success: false,
          error: `Modo de orden no soportado: ${sortMode || "(vacío)"}`,
        }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      const configuredFamilyIds = Array.isArray(providerConfig.agora_product_sort_family_ids)
        ? providerConfig.agora_product_sort_family_ids.map((id) => String(id)).filter(Boolean)
        : [];
      const requestedFamilyIds = Array.isArray(payload.familyIds)
        ? payload.familyIds.map((id: unknown) => String(id)).filter(Boolean)
        : [];
      const requestedPrefixOrder = Array.isArray(payload.prefixOrder)
        ? payload.prefixOrder.map((v: unknown) => String(v || "").trim().toUpperCase()).filter(Boolean)
        : commercialCodePrefixOrder(connection);
      const prefixOrder = requestedPrefixOrder.length > 0 ? requestedPrefixOrder : DEFAULT_COMMERCIAL_CODE_PREFIX_ORDER;

      const familiesRes = await fetchWithRetry(`${baseUrlClean}/api/export-master/?filter=Families`, {
        method: "GET",
        headers: { "Api-Token": apiTokenClean, Accept: "application/xml" },
      }, 30000);
      const familiesXml = await familiesRes.text().catch(() => "");
      if (!familiesRes.ok || !familiesXml) {
        return new Response(JSON.stringify({
          success: false,
          error: `No se pudo leer familias Agora: HTTP ${familiesRes.status}`,
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const familyElements = extractXmlElementsWithAttrs(familiesXml, "Family");
      const familyById = new Map<string, { id: string; name: string; showInPos: string | null }>();
      for (const fam of familyElements) {
        const id = String(fam.attrs.Id || "");
        if (!id) continue;
        familyById.set(id, {
          id,
          name: String(fam.attrs.Name || ""),
          showInPos: fam.attrs.ShowInPos || null,
        });
      }

      const inferredWinerimFamilyIds = Array.from(familyById.values())
        .filter((fam) => /\bWINERIM\b/i.test(fam.name))
        .map((fam) => fam.id);
      const targetFamilyIds = new Set<string>(
        requestedFamilyIds.length > 0
          ? requestedFamilyIds
          : configuredFamilyIds.length > 0
            ? configuredFamilyIds
            : inferredWinerimFamilyIds,
      );

      if (targetFamilyIds.size === 0) {
        return new Response(JSON.stringify({
          success: false,
          error: "No hay familias objetivo. Indica familyIds o configura provider_config.agora_product_sort_family_ids.",
        }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const cachedProducts = await fetchAgoraProductsXmlCached(connectionId, baseUrlClean, apiTokenClean, fetchWithRetry, 30000, true);
      if (!cachedProducts.ok) {
        return new Response(JSON.stringify({
          success: false,
          error: `No se pudo leer catálogo Agora: HTTP ${cachedProducts.status}`,
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const productElements = extractXmlElementsWithAttrs(cachedProducts.xml, "Product");
      type ProductSortPlan = {
        productId: string;
        name: string;
        buttonText: string;
        nextButtonText: string;
        familyId: string;
        familyName: string;
        code: CommercialCode | null;
        formatOrder: number;
        previousOrder: number | null;
        nextOrder: number;
        orderChanged: boolean;
        buttonTextChanged: boolean;
        changed: boolean;
        xmlBefore: string;
        xmlAfter: string;
      };
      const byFamily = new Map<string, ProductSortPlan[]>();

      for (const product of productElements) {
        const familyId = String(product.attrs.FamilyId || "");
        if (!targetFamilyIds.has(familyId)) continue;
        const productId = String(product.attrs.Id || "");
        if (!productId) continue;
        const name = String(product.attrs.Name || "");
        const buttonText = String(product.attrs.ButtonText || "");
        const decodedName = normalizeAgoraTextAttribute(decodeXmlAttribute(name));
        const decodedButtonText = normalizeAgoraTextAttribute(decodeXmlAttribute(buttonText));
        const code = commercialGenericCode(name) || commercialGenericCode(buttonText);
        const previousOrderRaw = product.attrs.Order;
        const previousOrder = previousOrderRaw && /^\d+$/.test(previousOrderRaw)
          ? Number(previousOrderRaw)
          : null;
        const familyName = familyById.get(familyId)?.name || familyId;
        const entry: ProductSortPlan = {
          productId,
          name: decodedName,
          buttonText: decodedButtonText,
          nextButtonText: rewriteButtonText
            ? agoraProductButtonText({ provider_config: { agora_product_button_text_mode: buttonTextMode } }, decodedName, 20)
            : decodedButtonText,
          familyId,
          familyName,
          code,
          formatOrder: inferAgoraFormatOrderFromName(name),
          previousOrder,
          nextOrder: 0,
          orderChanged: false,
          buttonTextChanged: false,
          changed: false,
          xmlBefore: product.xml,
          xmlAfter: product.xml,
        };
        const list = byFamily.get(familyId) || [];
        list.push(entry);
        byFamily.set(familyId, list);
      }

      if (byFamily.size === 0) {
        return new Response(JSON.stringify({
          success: true,
          dryRun,
          targetFamilyIds: Array.from(targetFamilyIds),
          families: [],
          changed: 0,
          message: "No hay productos en las familias objetivo.",
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const changedPlans: ProductSortPlan[] = [];
      const familyPlans: {
        familyId: string;
        familyName: string;
        prefixOrder: string[];
        total: number;
        coded: number;
        uncoded: number;
        changed: number;
        first: { productId: string; name: string; code: string | null; sortOrder: number }[];
        last: { productId: string; name: string; code: string | null; sortOrder: number }[];
      }[] = [];
      const codeLabel = (code: CommercialCode | null): string | null => code ? `${code.prefix}${String(code.number).padStart(3, "0")}${code.suffix || ""}` : null;

      for (const [familyId, products] of byFamily.entries()) {
        const familyNameForSort = products[0]?.familyName || familyById.get(familyId)?.name || familyId;
        const familyPrefixOrder = commercialCodePrefixOrderForFamily(connection, familyId, familyNameForSort, prefixOrder);
        products.sort((a, b) => {
          if (useAlphabeticalSort) {
            return compareAgoraWineNames(a.name, b.name) ||
              a.formatOrder - b.formatOrder ||
              Number(a.productId) - Number(b.productId);
          }
          return compareCommercialCodes(a.code, b.code, familyPrefixOrder) ||
            a.formatOrder - b.formatOrder ||
            a.name.localeCompare(b.name, "es") ||
            Number(a.productId) - Number(b.productId);
        });

        if (rewriteButtonText) {
          const uniqueButtonTexts = buildUniqueAgoraButtonTexts(
            { provider_config: { agora_product_button_text_mode: buttonTextMode } },
            products.map((product) => ({
              key: product.productId,
              technicalName: product.name,
              existingButtonText: product.buttonText,
            })),
            20,
          );
          for (const product of products) {
            product.nextButtonText = uniqueButtonTexts[product.productId] || product.nextButtonText;
          }
        }

        products.forEach((p, idx) => {
          p.nextOrder = idx + 1;
          p.orderChanged = p.previousOrder !== p.nextOrder;
          p.buttonTextChanged = rewriteButtonText && p.buttonText !== p.nextButtonText;
          p.changed = p.orderChanged || p.buttonTextChanged;
          p.xmlAfter = setXmlAttrValue(p.xmlBefore, "Order", String(p.nextOrder));
          if (rewriteButtonText) {
            p.xmlAfter = setXmlAttrValue(p.xmlAfter, "ButtonText", p.nextButtonText);
          }
          if (p.changed) changedPlans.push(p);
        });

        familyPlans.push({
          familyId,
          familyName: familyNameForSort,
          prefixOrder: familyPrefixOrder,
          total: products.length,
          coded: products.filter((p) => Boolean(p.code)).length,
          uncoded: products.filter((p) => !p.code).length,
          changed: products.filter((p) => p.changed).length,
          first: products.slice(0, 8).map((p) => ({
            productId: p.productId,
            name: rewriteButtonText ? p.nextButtonText : p.name,
            code: codeLabel(p.code),
            sortOrder: p.nextOrder,
          })),
          last: products.slice(-8).map((p) => ({
            productId: p.productId,
            name: rewriteButtonText ? p.nextButtonText : p.name,
            code: codeLabel(p.code),
            sortOrder: p.nextOrder,
          })),
        });
      }

      const duplicateVisibleLabels: Array<{ familyId: string; familyName: string; buttonText: string; productIds: string[] }> = [];
      if (rewriteButtonText) {
        for (const [familyId, products] of byFamily.entries()) {
          const byLabel = new Map<string, ProductSortPlan[]>();
          for (const product of products) {
            const key = normalizeRoutingText(product.nextButtonText);
            const sameLabel = byLabel.get(key) || [];
            sameLabel.push(product);
            byLabel.set(key, sameLabel);
          }
          for (const [label, productsWithLabel] of byLabel.entries()) {
            if (!label || productsWithLabel.length < 2) continue;
            duplicateVisibleLabels.push({
              familyId,
              familyName: productsWithLabel[0]?.familyName || familyId,
              buttonText: productsWithLabel[0]?.nextButtonText || label,
              productIds: productsWithLabel.map((product) => product.productId),
            });
          }
        }
      }

      const productXml = Array.from(byFamily.values())
        .flat()
        .map((p) => `    ${p.xmlAfter}`)
        .join("\n");
      const xml = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n<Import>\n  <Products>\n${productXml}\n  </Products>\n</Import>`;
      const rollbackXml = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n<Import>\n  <Products>\n${Array.from(byFamily.values()).flat().map((p) => `    ${p.xmlBefore}`).join("\n")}\n  </Products>\n</Import>`;

      if (dryRun) {
        return new Response(JSON.stringify({
          success: true,
          dryRun: true,
          sortMode,
          buttonTextMode: buttonTextMode || null,
          prefixOrder: useCommercialSort ? prefixOrder : undefined,
          targetFamilyIds: Array.from(targetFamilyIds),
          families: familyPlans,
          changed: changedPlans.length,
          duplicateVisibleLabels,
          changedPreview: changedPlans.slice(0, 50).map((p) => ({
            familyId: p.familyId,
            familyName: p.familyName,
            productId: p.productId,
            name: p.name,
            code: codeLabel(p.code),
            previousOrder: p.previousOrder,
            nextOrder: p.nextOrder,
            previousButtonText: p.buttonText,
            nextButtonText: p.nextButtonText,
            orderChanged: p.orderChanged,
            buttonTextChanged: p.buttonTextChanged,
          })),
          xml: payload.includeXml === true ? xml : undefined,
          rollbackXml: payload.includeXml === true ? rollbackXml : undefined,
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      if (duplicateVisibleLabels.length > 0) {
        return new Response(JSON.stringify({
          success: false,
          dryRun: false,
          sortMode,
          buttonTextMode: buttonTextMode || null,
          error: "La etiqueta visible sin prefijo produciría duplicados dentro de una familia.",
          duplicateVisibleLabels,
        }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const importUrl = `${baseUrlClean}/api/import/`;
      const xmlHeaders = {
        "Api-Token": apiTokenClean,
        Accept: "application/xml",
        "Content-Type": "application/xml; charset=utf-8",
      };
      const importRes = await fetchWithRetry(importUrl, { method: "POST", headers: xmlHeaders, body: xml }, 60000);
      const responseBody = await importRes.text().catch(() => "");
      const parsed = parseAgoraImportResponse(importRes.status, responseBody);
      if (!parsed.success) {
        return new Response(JSON.stringify({
          success: false,
          dryRun: false,
          sortMode,
          buttonTextMode: buttonTextMode || null,
          prefixOrder: useCommercialSort ? prefixOrder : undefined,
          targetFamilyIds: Array.from(targetFamilyIds),
          families: familyPlans,
          changed: changedPlans.length,
          error: parsed.errors.join("; ") || `HTTP ${importRes.status}: ${responseBody.slice(0, 500)}`,
          xmlSent: xml,
          rollbackXml,
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      invalidateAgoraProductsCache(connectionId);
      const verifyCached = await fetchAgoraProductsXmlCached(connectionId, baseUrlClean, apiTokenClean, fetchWithRetry, 30000, true);
      const verifyProducts = new Map<string, string>();
      if (verifyCached.ok) {
        for (const product of extractXmlElementsWithAttrs(verifyCached.xml, "Product")) {
          const id = String(product.attrs.Id || "");
          if (id) verifyProducts.set(id, product.xml);
        }
      }
      const verification = changedPlans.map((p) => {
        const live = verifyProducts.get(p.productId) || "";
        const sortOrder = live ? extractXmlAttrValue(live, "Order") : null;
        const liveButtonTextRaw = live ? extractXmlAttrValue(live, "ButtonText") : null;
        const liveButtonText = liveButtonTextRaw === null
          ? null
          : normalizeAgoraTextAttribute(decodeXmlAttribute(liveButtonTextRaw));
        const orderOk = sortOrder === String(p.nextOrder);
        const buttonTextOk = !rewriteButtonText || liveButtonText === p.nextButtonText;
        return {
          productId: p.productId,
          expectedOrder: String(p.nextOrder),
          actualOrder: sortOrder,
          expectedButtonText: rewriteButtonText ? p.nextButtonText : undefined,
          actualButtonText: rewriteButtonText ? liveButtonText : undefined,
          ok: orderOk && buttonTextOk,
        };
      });

      return new Response(JSON.stringify({
        success: true,
        dryRun: false,
        sortMode,
        buttonTextMode: buttonTextMode || null,
        prefixOrder: useCommercialSort ? prefixOrder : undefined,
        targetFamilyIds: Array.from(targetFamilyIds),
        families: familyPlans,
        changed: changedPlans.length,
        verification: {
          catalogFetched: verifyCached.ok,
          checked: verification.length,
          ok: verification.every((v) => v.ok),
          failures: verification.filter((v) => !v.ok).slice(0, 50),
        },
        rollbackXml,
        importResponse: parsed,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── NORMALIZE WINERIM-OWNED PRODUCT PRESENTATION ──
    // Preserves each live Agora product XML and only changes presentation
    // attributes. Ownership is proven by winerim_push_tracking; legacy products
    // are never selected even when they share a family with Winerim products.
    if (action === "normalize-winerim-product-presentation") {
      const dryRun = payload.dryRun !== false;
      if (!dryRun && payload.confirm !== "NORMALIZE_WINERIM_PRESENTATION") {
        return new Response(JSON.stringify({
          success: false,
          error: "Production normalization requires confirm=NORMALIZE_WINERIM_PRESENTATION",
        }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const presentationConfig = ((connection.provider_config || {}) as Record<string, unknown>);
      if (presentationConfig.agora_product_presentation_enabled !== true) {
        return new Response(JSON.stringify({
          success: false,
          error: "provider_config.agora_product_presentation_enabled must be true",
        }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      if (!shouldSortAgoraProductsAlphabetically(connection)) {
        return new Response(JSON.stringify({
          success: false,
          error: `Unsupported presentation sort mode: ${agoraProductSortMode(connection) || "(empty)"}`,
        }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      const presentationButtonMode = agoraProductButtonTextMode(connection);
      if (![AGORA_BUTTON_TEXT_WINE_NAME_ONLY, AGORA_BUTTON_TEXT_WINE_NAME_WITH_FORMAT_SUFFIX].includes(presentationButtonMode)) {
        return new Response(JSON.stringify({
          success: false,
          error: `Unsupported presentation button mode: ${presentationButtonMode || "(empty)"}`,
        }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const requestedProductIds = new Set(
        Array.isArray(payload.productIds)
          ? payload.productIds.map((value: unknown) => String(value || "").trim()).filter(Boolean)
          : [],
      );
      const { data: trackingRows, error: trackingError } = await supabase
        .from("winerim_push_tracking")
        .select("agora_product_id,winerim_wine_id,format,source,sync_status")
        .eq("connection_id", connectionId)
        .eq("source", "WINERIM")
        .in("sync_status", ["VERIFIED", "PUSHED"]);
      if (trackingError) {
        return new Response(JSON.stringify({ success: false, error: trackingError.message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const ownedRowsByProductId = new Map<string, { productId: string; wineId: string; format: string }>();
      for (const row of trackingRows || []) {
        const productId = String(row.agora_product_id || "").trim();
        const wineId = String(row.winerim_wine_id || "").trim();
        const format = String(row.format || "").trim().toUpperCase();
        if (!productId || !wineId || !["BOTTLE", "GLASS", "MAGNUM"].includes(format)) continue;
        if (requestedProductIds.size > 0 && !requestedProductIds.has(productId)) continue;
        ownedRowsByProductId.set(productId, { productId, wineId, format });
      }
      if (ownedRowsByProductId.size === 0) {
        return new Response(JSON.stringify({
          success: true,
          dryRun,
          changed: 0,
          message: "No verified Winerim-owned products matched the request.",
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const wineIds = [...new Set([...ownedRowsByProductId.values()].map((row) => row.wineId))];
      const wineRows: any[] = [];
      for (let index = 0; index < wineIds.length; index += 500) {
        const { data: chunk, error: wineError } = await supabase
          .from("winerim_wines")
          .select("winerim_id,name,wine_type,region,raw_payload,is_active,bottle_sale_price,glass_sale_price,magnum_sale_price")
          .eq("connection_id", connectionId)
          .in("winerim_id", wineIds.slice(index, index + 500));
        if (wineError) {
          return new Response(JSON.stringify({ success: false, error: wineError.message }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        wineRows.push(...(chunk || []));
      }
      const wineById = new Map(wineRows.map((wine) => [String(wine.winerim_id), applyHiddenGlassVariantForAgora(connection, wine)]));

      const familiesRes = await fetchWithRetry(`${baseUrlClean}/api/export-master/?filter=Families`, {
        method: "GET",
        headers: { "Api-Token": apiTokenClean, Accept: "application/xml" },
      }, 30000);
      const familiesXml = await familiesRes.text().catch(() => "");
      if (!familiesRes.ok || !familiesXml) {
        return new Response(JSON.stringify({
          success: false,
          error: `Could not read Agora families: HTTP ${familiesRes.status}`,
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      const freshProducts = await fetchAgoraProductsXmlCached(
        connectionId, baseUrlClean, apiTokenClean, fetchWithRetry, 30000, true,
      );
      if (!freshProducts.ok) {
        return new Response(JSON.stringify({
          success: false,
          error: `Could not read Agora products: HTTP ${freshProducts.status}`,
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      type LiveFamily = { id: string; name: string; xml: string; attrs: Record<string, string> };
      const liveFamilies = extractXmlElementsWithAttrs(familiesXml, "Family").map((family) => ({
        id: String(family.attrs.Id || ""),
        name: normalizeAgoraTextAttribute(decodeXmlAttribute(family.attrs.Name || "")),
        xml: family.xml,
        attrs: family.attrs,
      })).filter((family) => family.id);
      const familyById = new Map(liveFamilies.map((family) => [family.id, family]));
      const liveProducts = extractXmlElementsWithAttrs(freshProducts.xml, "Product");
      const productById = new Map(liveProducts.map((product) => [String(product.attrs.Id || ""), product]));
      const customMappings = (await loadCustomFamilyMappings(connectionId)) || {};
      const routingMode = String(presentationConfig.family_structure_mode || "").trim().toUpperCase();
      const useDoCountryRouting = routingMode === AGORA_STRUCTURE_WINE_TYPE_SPAIN_DO_FOREIGN_COUNTRY;

      type PlannedFamily = {
        id: string;
        name: string;
        buttonText: string;
        color: string;
        parentId: string | null;
        live: LiveFamily | null;
        xmlAfter: string;
        changed: boolean;
      };
      const plannedFamilies = new Map<string, PlannedFamily>();

      const planFamily = (params: { id: string; name: string; buttonText: string; color: string; parentId?: string | null }): PlannedFamily => {
        const live = familyById.get(params.id) || liveFamilies.find((family) =>
          normalizeRoutingText(family.name) === normalizeRoutingText(params.name)
        ) || null;
        const id = live?.id || params.id;
        const liveName = live?.name || params.name;
        let xmlAfter = live?.xml || `<Family Id="${escapeXmlAttribute(id)}" Name="${escapeXmlAttribute(liveName)}" ShowInPos="true" ButtonText="${escapeXmlAttribute(params.buttonText.slice(0, 20))}" Color="${params.color}" Order="100"${params.parentId ? ` ParentFamilyId="${escapeXmlAttribute(params.parentId)}"` : ""} />`;
        xmlAfter = setXmlAttrValue(xmlAfter, "ShowInPos", "true");
        xmlAfter = setXmlAttrValue(xmlAfter, "Color", params.color);
        xmlAfter = setXmlAttrValue(xmlAfter, "ButtonText", params.buttonText.slice(0, 20));
        if (params.parentId) xmlAfter = setXmlAttrValue(xmlAfter, "ParentFamilyId", params.parentId);
        const changed = !live ||
          String(live.attrs.ShowInPos || "").toLowerCase() !== "true" ||
          String(live.attrs.Color || "").toUpperCase() !== params.color.toUpperCase() ||
          normalizeAgoraTextAttribute(decodeXmlAttribute(live.attrs.ButtonText || "")) !== params.buttonText.slice(0, 20) ||
          (params.parentId ? String(live.attrs.ParentFamilyId || "") !== params.parentId : false);
        const plan = { id, name: liveName, buttonText: params.buttonText, color: params.color, parentId: params.parentId || null, live, xmlAfter, changed };
        plannedFamilies.set(id, plan);
        return plan;
      };

      const targetFamilyFor = (wine: any, format: string, currentFamilyId: string): string => {
        if (!useDoCountryRouting || format !== "BOTTLE") return currentFamilyId;
        const wineType = canonicalAgoraWineType(extractWineType(wine));
        const mappingKey = agoraTypeRootMappingKey(wineType);
        const configuredRoot = mappingKey ? customMappings[mappingKey] : null;
        const root = configuredRoot
          ? (familyById.get(String(configuredRoot.id)) || liveFamilies.find((family) =>
              normalizeRoutingText(family.name) === normalizeRoutingText(configuredRoot.name)
            ))
          : null;
        if (!root) throw new Error(`Missing root family mapping ${mappingKey || "(unknown)"} for wine ${wine.winerim_id}`);
        const color = agoraProductColor(connection, wineType);
        planFamily({ id: root.id, name: root.name, buttonText: root.attrs.ButtonText ? normalizeAgoraTextAttribute(decodeXmlAttribute(root.attrs.ButtonText)) : root.name, color });

        const raw = wine.raw_payload || {};
        const country = cleanAgoraGeographicLabel(raw.country || wine.country);
        const region = cleanAgoraGeographicLabel(wine.region || raw.region);
        const invalidRegion = isFallbackGeographicRegion(region);
        const childLabel = isSpainCountry(country)
          ? (invalidRegion ? "OTRAS DO ESPAÑA" : region)
          : (agoraCountryLabel(country) || "OTROS PAÍSES");
        const childName = `${root.name} - ${childLabel}`;
        const existingChild = liveFamilies.find((family) =>
          normalizeRoutingText(family.name) === normalizeRoutingText(childName)
        );
        let childId = existingChild?.id || "";
        if (!childId) {
          for (let attempt = 0; attempt < 100; attempt++) {
            const candidate = stableFamilyId(attempt === 0 ? childName : `${childName}#${attempt}`);
            const liveCollision = familyById.get(candidate);
            const plannedCollision = plannedFamilies.get(candidate);
            if (!liveCollision && !plannedCollision) {
              childId = candidate;
              break;
            }
            const collisionName = liveCollision?.name || plannedCollision?.name || "";
            if (normalizeRoutingText(collisionName) === normalizeRoutingText(childName)) {
              childId = candidate;
              break;
            }
          }
        }
        if (!childId) throw new Error(`Could not allocate a collision-free family ID for ${childName}`);
        return planFamily({
          id: childId,
          name: existingChild?.name || childName,
          buttonText: childLabel,
          color,
          parentId: root.id,
        }).id;
      };

      if (useDoCountryRouting) {
        for (const [mappingKey, configuredRoot] of Object.entries(customMappings)) {
          if (!mappingKey.startsWith("botella_")) continue;
          const root = familyById.get(String(configuredRoot.id)) || liveFamilies.find((family) =>
            normalizeRoutingText(family.name) === normalizeRoutingText(configuredRoot.name)
          );
          if (!root) {
            return new Response(JSON.stringify({
              success: false,
              error: `Missing configured root family ${mappingKey}`,
            }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
          }
          planFamily({
            id: root.id,
            name: root.name,
            buttonText: root.attrs.ButtonText
              ? normalizeAgoraTextAttribute(decodeXmlAttribute(root.attrs.ButtonText))
              : root.name,
            color: agoraProductColor(connection, mappingKey.slice("botella_".length)),
          });
        }
      }

      type PresentationPlan = {
        productId: string;
        wineId: string;
        format: string;
        wineName: string;
        wineType: string;
        previousFamilyId: string;
        nextFamilyId: string;
        previousButtonText: string;
        nextButtonText: string;
        previousColor: string;
        nextColor: string;
        previousOrder: number | null;
        nextOrder: number;
        xmlBefore: string;
        xmlAfter: string;
        changed: boolean;
      };
      const plans: PresentationPlan[] = [];
      const skipped: Array<{ productId: string; reason: string }> = [];

      for (const ownership of ownedRowsByProductId.values()) {
        const wine = wineById.get(ownership.wineId);
        const liveProduct = productById.get(ownership.productId);
        if (!wine) {
          skipped.push({ productId: ownership.productId, reason: "wine_not_found" });
          continue;
        }
        if (!liveProduct) {
          skipped.push({ productId: ownership.productId, reason: "agora_product_not_found" });
          continue;
        }
        const effectiveActive = wine.is_active !== false || inactiveFormatAllowedByConnection(wine, ownership.format);
        if (!effectiveActive || isFormatUnavailableForAgora(wine, ownership.format)) {
          skipped.push({ productId: ownership.productId, reason: "format_not_currently_eligible" });
          continue;
        }
        const technicalName = normalizeAgoraTextAttribute(decodeXmlAttribute(liveProduct.attrs.Name || ""));
        const currentFamilyId = String(liveProduct.attrs.FamilyId || "");
        let targetFamilyId: string;
        try {
          targetFamilyId = targetFamilyFor(wine, ownership.format, currentFamilyId);
        } catch (error) {
          return new Response(JSON.stringify({ success: false, error: String(error) }), {
            status: 409,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const previousButtonText = normalizeAgoraTextAttribute(decodeXmlAttribute(liveProduct.attrs.ButtonText || ""));
        plans.push({
          productId: ownership.productId,
          wineId: ownership.wineId,
          format: ownership.format,
          wineName: String(wine.name || technicalName),
          wineType: canonicalAgoraWineType(extractWineType(wine)),
          previousFamilyId: currentFamilyId,
          nextFamilyId: targetFamilyId,
          previousButtonText,
          nextButtonText: agoraProductButtonText(connection, technicalName, 20),
          previousColor: String(liveProduct.attrs.Color || ""),
          nextColor: agoraProductColor(connection, extractWineType(wine)),
          previousOrder: /^\d+$/.test(String(liveProduct.attrs.Order || "")) ? Number(liveProduct.attrs.Order) : null,
          nextOrder: 0,
          xmlBefore: liveProduct.xml,
          xmlAfter: liveProduct.xml,
          changed: false,
        });
      }

      const plansByFamily = new Map<string, PresentationPlan[]>();
      for (const plan of plans) {
        const familyPlans = plansByFamily.get(plan.nextFamilyId) || [];
        familyPlans.push(plan);
        plansByFamily.set(plan.nextFamilyId, familyPlans);
      }
      const targetProductIds = new Set(plans.map((plan) => plan.productId));
      const presentationFormatOrder: Record<string, number> = { BOTTLE: 0, GLASS: 1, MAGNUM: 2 };
      const duplicateVisibleLabels: Array<{ familyId: string; label: string; productIds: string[] }> = [];
      for (const [familyId, familyPlans] of plansByFamily.entries()) {
        familyPlans.sort((left, right) =>
          compareAgoraWineNames(left.wineName, right.wineName) ||
          (presentationFormatOrder[left.format] ?? 9) - (presentationFormatOrder[right.format] ?? 9) ||
          Number(left.productId) - Number(right.productId)
        );
        const uniqueLabels = buildUniqueAgoraButtonTexts(
          connection,
          familyPlans.map((plan) => ({
            key: plan.productId,
            technicalName: normalizeAgoraTextAttribute(decodeXmlAttribute(productById.get(plan.productId)?.attrs.Name || "")),
            existingButtonText: plan.previousButtonText,
          })),
          20,
        );
        const nonOwnedProducts = liveProducts.filter((product) =>
          String(product.attrs.FamilyId || "") === familyId && !targetProductIds.has(String(product.attrs.Id || ""))
        );
        const occupiedLabels = new Set(nonOwnedProducts.map((product) =>
          normalizeRoutingText(normalizeAgoraTextAttribute(decodeXmlAttribute(product.attrs.ButtonText || product.attrs.Name || "")))
        ).filter(Boolean));
        const legacyMaxOrder = nonOwnedProducts.reduce((max, product) => {
          const order = /^\d+$/.test(String(product.attrs.Order || "")) ? Number(product.attrs.Order) : 0;
          return Math.max(max, order);
        }, 0);
        const firstOrder = nonOwnedProducts.length > 0 ? legacyMaxOrder + 1 : 1;
        familyPlans.forEach((plan, index) => {
          plan.nextButtonText = uniqueLabels[plan.productId] || plan.nextButtonText;
          const normalizedLabel = normalizeRoutingText(plan.nextButtonText);
          if (occupiedLabels.has(normalizedLabel)) {
            duplicateVisibleLabels.push({ familyId, label: plan.nextButtonText, productIds: [plan.productId] });
          }
          occupiedLabels.add(normalizedLabel);
          plan.nextOrder = firstOrder + index;
          plan.xmlAfter = setXmlAttrValue(plan.xmlBefore, "FamilyId", plan.nextFamilyId);
          plan.xmlAfter = setXmlAttrValue(plan.xmlAfter, "ButtonText", plan.nextButtonText);
          plan.xmlAfter = setXmlAttrValue(plan.xmlAfter, "Color", plan.nextColor);
          plan.xmlAfter = setXmlAttrValue(plan.xmlAfter, "Order", String(plan.nextOrder));
          plan.changed = plan.previousFamilyId !== plan.nextFamilyId ||
            plan.previousButtonText !== plan.nextButtonText ||
            plan.previousColor.toUpperCase() !== plan.nextColor.toUpperCase() ||
            plan.previousOrder !== plan.nextOrder;
        });
      }

      if (duplicateVisibleLabels.length > 0) {
        return new Response(JSON.stringify({
          success: false,
          dryRun,
          error: "Visible labels collide with non-Winerim products in a target family.",
          duplicateVisibleLabels,
        }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const changedProducts = plans.filter((plan) => plan.changed);
      const changedFamilies = [...plannedFamilies.values()].filter((family) => family.changed);
      const familyXml = changedFamilies.map((family) => `    ${family.xmlAfter}`).join("\n");
      const productXml = changedProducts.map((plan) => `    ${plan.xmlAfter}`).join("\n");
      let xml = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n<Import>\n`;
      if (familyXml) xml += `  <Families>\n${familyXml}\n  </Families>\n`;
      if (productXml) xml += `  <Products>\n${productXml}\n  </Products>\n`;
      xml += `</Import>`;

      const rollbackFamilies = changedFamilies.map((family) => {
        if (family.live) return `    ${family.live.xml}`;
        let hidden = setXmlAttrValue(family.xmlAfter, "ShowInPos", "false");
        hidden = setXmlAttrValue(hidden, "Order", "99999");
        return `    ${hidden}`;
      }).join("\n");
      const rollbackProducts = changedProducts.map((plan) => `    ${plan.xmlBefore}`).join("\n");
      let rollbackXml = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n<Import>\n`;
      if (rollbackFamilies) rollbackXml += `  <Families>\n${rollbackFamilies}\n  </Families>\n`;
      if (rollbackProducts) rollbackXml += `  <Products>\n${rollbackProducts}\n  </Products>\n`;
      rollbackXml += `</Import>`;

      const summary = {
        owned: ownedRowsByProductId.size,
        eligible: plans.length,
        skipped,
        changedProducts: changedProducts.length,
        changedFamilies: changedFamilies.length,
        movedProducts: changedProducts.filter((plan) => plan.previousFamilyId !== plan.nextFamilyId).length,
        recoloredProducts: changedProducts.filter((plan) => plan.previousColor.toUpperCase() !== plan.nextColor.toUpperCase()).length,
        relabeledProducts: changedProducts.filter((plan) => plan.previousButtonText !== plan.nextButtonText).length,
        reorderedProducts: changedProducts.filter((plan) => plan.previousOrder !== plan.nextOrder).length,
      };
      const preview = changedProducts.slice(0, 100).map((plan) => ({
        productId: plan.productId,
        wineId: plan.wineId,
        format: plan.format,
        wineName: plan.wineName,
        family: `${plan.previousFamilyId} -> ${plan.nextFamilyId}`,
        buttonText: `${plan.previousButtonText} -> ${plan.nextButtonText}`,
        color: `${plan.previousColor} -> ${plan.nextColor}`,
        order: `${plan.previousOrder ?? "null"} -> ${plan.nextOrder}`,
      }));

      if (dryRun || (changedProducts.length === 0 && changedFamilies.length === 0)) {
        return new Response(JSON.stringify({
          success: true,
          dryRun,
          summary,
          families: [...plannedFamilies.values()].map((family) => ({
            id: family.id,
            name: family.name,
            buttonText: family.buttonText,
            color: family.color,
            parentId: family.parentId,
            exists: Boolean(family.live),
            changed: family.changed,
          })),
          preview,
          xml: payload.includeXml === true ? xml : undefined,
          rollbackXml: payload.includeXml === true ? rollbackXml : undefined,
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const importRes = await fetchWithRetry(`${baseUrlClean}/api/import/`, {
        method: "POST",
        headers: {
          "Api-Token": apiTokenClean,
          Accept: "application/xml",
          "Content-Type": "application/xml; charset=utf-8",
        },
        body: xml,
      }, 60000);
      const responseBody = await importRes.text().catch(() => "");
      const parsed = parseAgoraImportResponse(importRes.status, responseBody);
      if (!parsed.success) {
        return new Response(JSON.stringify({
          success: false,
          dryRun: false,
          summary,
          error: parsed.errors.join("; ") || `HTTP ${importRes.status}: ${responseBody.slice(0, 500)}`,
          rollbackXml,
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      invalidateAgoraProductsCache(connectionId);
      const [verifyProductsFresh, verifyFamiliesRes] = await Promise.all([
        fetchAgoraProductsXmlCached(connectionId, baseUrlClean, apiTokenClean, fetchWithRetry, 30000, true),
        fetchWithRetry(`${baseUrlClean}/api/export-master/?filter=Families`, {
          method: "GET",
          headers: { "Api-Token": apiTokenClean, Accept: "application/xml" },
        }, 30000),
      ]);
      const verifyFamiliesXml = await verifyFamiliesRes.text().catch(() => "");
      const verifyProductById = new Map(
        (verifyProductsFresh.ok ? extractXmlElementsWithAttrs(verifyProductsFresh.xml, "Product") : [])
          .map((product) => [String(product.attrs.Id || ""), product]),
      );
      const verifyFamilyById = new Map(
        (verifyFamiliesRes.ok ? extractXmlElementsWithAttrs(verifyFamiliesXml, "Family") : [])
          .map((family) => [String(family.attrs.Id || ""), family]),
      );
      const productFailures: Array<Record<string, unknown>> = changedProducts.flatMap<Record<string, unknown>>((plan) => {
        const live = verifyProductById.get(plan.productId);
        if (!live) return [{ productId: plan.productId, error: "missing_after_write" }];
        const actualButton = normalizeAgoraTextAttribute(decodeXmlAttribute(live.attrs.ButtonText || ""));
        const ok = String(live.attrs.FamilyId || "") === plan.nextFamilyId &&
          actualButton === plan.nextButtonText &&
          String(live.attrs.Color || "").toUpperCase() === plan.nextColor.toUpperCase() &&
          String(live.attrs.Order || "") === String(plan.nextOrder);
        return ok ? [] : [{
          productId: plan.productId,
          expected: { familyId: plan.nextFamilyId, buttonText: plan.nextButtonText, color: plan.nextColor, order: String(plan.nextOrder) },
          actual: { familyId: live.attrs.FamilyId, buttonText: actualButton, color: live.attrs.Color, order: live.attrs.Order },
        }];
      });
      const familyFailures: Array<Record<string, unknown>> = changedFamilies.flatMap<Record<string, unknown>>((plan) => {
        const live = verifyFamilyById.get(plan.id);
        if (!live) return [{ familyId: plan.id, error: "missing_after_write" }];
        const actualButton = normalizeAgoraTextAttribute(decodeXmlAttribute(live.attrs.ButtonText || ""));
        const ok = String(live.attrs.Color || "").toUpperCase() === plan.color.toUpperCase() &&
          String(live.attrs.ShowInPos || "").toLowerCase() === "true" &&
          actualButton === plan.buttonText.slice(0, 20) &&
          (plan.parentId ? String(live.attrs.ParentFamilyId || "") === plan.parentId : true);
        return ok ? [] : [{ familyId: plan.id, expected: plan, actual: live.attrs }];
      });

      let automaticRollback: Record<string, unknown> | null = null;
      if (productFailures.length > 0 || familyFailures.length > 0) {
        const rollbackRes = await fetchWithRetry(`${baseUrlClean}/api/import/`, {
          method: "POST",
          headers: {
            "Api-Token": apiTokenClean,
            Accept: "application/xml",
            "Content-Type": "application/xml; charset=utf-8",
          },
          body: rollbackXml,
        }, 60000);
        const rollbackBody = await rollbackRes.text().catch(() => "");
        const rollbackParsed = parseAgoraImportResponse(rollbackRes.status, rollbackBody);
        const rollbackProductFailures: Array<Record<string, unknown>> = [];
        const rollbackFamilyFailures: Array<Record<string, unknown>> = [];

        if (rollbackParsed.success) {
          invalidateAgoraProductsCache(connectionId);
          const [rollbackProductsFresh, rollbackFamiliesRes] = await Promise.all([
            fetchAgoraProductsXmlCached(connectionId, baseUrlClean, apiTokenClean, fetchWithRetry, 30000, true),
            fetchWithRetry(`${baseUrlClean}/api/export-master/?filter=Families`, {
              method: "GET",
              headers: { "Api-Token": apiTokenClean, Accept: "application/xml" },
            }, 30000),
          ]);
          const rollbackFamiliesXml = await rollbackFamiliesRes.text().catch(() => "");
          const rollbackProductById = new Map(
            (rollbackProductsFresh.ok ? extractXmlElementsWithAttrs(rollbackProductsFresh.xml, "Product") : [])
              .map((product) => [String(product.attrs.Id || ""), product]),
          );
          const rollbackFamilyById = new Map(
            (rollbackFamiliesRes.ok ? extractXmlElementsWithAttrs(rollbackFamiliesXml, "Family") : [])
              .map((family) => [String(family.attrs.Id || ""), family]),
          );

          for (const plan of changedProducts) {
            const live = rollbackProductById.get(plan.productId);
            const actualButton = live
              ? normalizeAgoraTextAttribute(decodeXmlAttribute(live.attrs.ButtonText || ""))
              : "";
            const restored = Boolean(live) &&
              String(live?.attrs.FamilyId || "") === plan.previousFamilyId &&
              actualButton === plan.previousButtonText &&
              String(live?.attrs.Color || "").toUpperCase() === plan.previousColor.toUpperCase() &&
              String(live?.attrs.Order || "") === String(plan.previousOrder ?? "");
            if (!restored) {
              rollbackProductFailures.push({
                productId: plan.productId,
                expected: {
                  familyId: plan.previousFamilyId,
                  buttonText: plan.previousButtonText,
                  color: plan.previousColor,
                  order: plan.previousOrder,
                },
                actual: live?.attrs || null,
              });
            }
          }

          for (const plan of changedFamilies) {
            const live = rollbackFamilyById.get(plan.id);
            const expectedXml = plan.live
              ? plan.live.xml
              : setXmlAttrValue(setXmlAttrValue(plan.xmlAfter, "ShowInPos", "false"), "Order", "99999");
            const expected = extractXmlElementsWithAttrs(expectedXml, "Family")[0]?.attrs || {};
            const actualButton = live
              ? normalizeAgoraTextAttribute(decodeXmlAttribute(live.attrs.ButtonText || ""))
              : "";
            const expectedButton = normalizeAgoraTextAttribute(decodeXmlAttribute(expected.ButtonText || ""));
            const restored = Boolean(live) &&
              actualButton === expectedButton &&
              String(live?.attrs.Color || "").toUpperCase() === String(expected.Color || "").toUpperCase() &&
              String(live?.attrs.ShowInPos || "").toLowerCase() === String(expected.ShowInPos || "").toLowerCase() &&
              String(live?.attrs.ParentFamilyId || "") === String(expected.ParentFamilyId || "");
            if (!restored) {
              rollbackFamilyFailures.push({ familyId: plan.id, expected, actual: live?.attrs || null });
            }
          }
        }

        automaticRollback = {
          attempted: true,
          success: rollbackParsed.success && rollbackProductFailures.length === 0 && rollbackFamilyFailures.length === 0,
          importResponse: rollbackParsed,
          productFailures: rollbackProductFailures.slice(0, 50),
          familyFailures: rollbackFamilyFailures.slice(0, 50),
        };
      }

      return new Response(JSON.stringify({
        success: productFailures.length === 0 && familyFailures.length === 0,
        dryRun: false,
        summary,
        verification: {
          productsCatalogFetched: verifyProductsFresh.ok,
          familiesCatalogFetched: verifyFamiliesRes.ok,
          checkedProducts: changedProducts.length,
          checkedFamilies: changedFamilies.length,
          productFailures: productFailures.slice(0, 50),
          familyFailures: familyFailures.slice(0, 50),
        },
        rollbackXml,
        automaticRollback,
        importResponse: parsed,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── RESTORE A SNAPSHOTTED WINERIM PRESENTATION ──
    // Accepts only products owned by this connection and only mapped wine
    // families (or their direct children). This keeps emergency rollback on
    // the same resilient Agora transport as every production write.
    if (action === "restore-winerim-product-presentation") {
      if (payload.confirm !== "RESTORE_WINERIM_PRESENTATION") {
        return new Response(JSON.stringify({
          success: false,
          error: "Presentation restore requires confirm=RESTORE_WINERIM_PRESENTATION",
        }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const restoreXml = String(payload.rollbackXml || "").trim();
      if (!restoreXml.startsWith("<?xml") || !/<Import\b/.test(restoreXml) || !/<\/Import>\s*$/.test(restoreXml)) {
        return new Response(JSON.stringify({ success: false, error: "INVALID_PRESENTATION_ROLLBACK_XML" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (new TextEncoder().encode(restoreXml).byteLength > 5 * 1024 * 1024) {
        return new Response(JSON.stringify({ success: false, error: "PRESENTATION_ROLLBACK_XML_TOO_LARGE" }), {
          status: 413,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const restoreProducts = extractXmlElementsWithAttrs(restoreXml, "Product");
      const restoreFamilies = extractXmlElementsWithAttrs(restoreXml, "Family");
      const restoreProductIds = [...new Set(restoreProducts.map((product) => String(product.attrs.Id || "")).filter(Boolean))];
      if (restoreProductIds.length !== restoreProducts.length || restoreProductIds.length === 0) {
        return new Response(JSON.stringify({ success: false, error: "INVALID_PRESENTATION_ROLLBACK_PRODUCT_IDS" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const { data: restoreOwnership, error: restoreOwnershipError } = await supabase
        .from("winerim_push_tracking")
        .select("agora_product_id")
        .eq("connection_id", connectionId)
        .eq("source", "WINERIM")
        .in("sync_status", ["VERIFIED", "PUSHED"])
        .in("agora_product_id", restoreProductIds);
      if (restoreOwnershipError) {
        return new Response(JSON.stringify({ success: false, error: restoreOwnershipError.message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const ownedRestoreIds = new Set((restoreOwnership || []).map((row) => String(row.agora_product_id || "")));
      const unownedRestoreIds = restoreProductIds.filter((productId) => !ownedRestoreIds.has(productId));
      if (unownedRestoreIds.length > 0) {
        return new Response(JSON.stringify({
          success: false,
          error: "PRESENTATION_ROLLBACK_CONTAINS_UNOWNED_PRODUCTS",
          productIds: unownedRestoreIds,
        }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const customMappings = (await loadCustomFamilyMappings(connectionId)) || {};
      const rootFamilyIds = new Set(
        Object.values(customMappings).map((mapping) => String(mapping.id || "")).filter(Boolean),
      );
      const liveFamiliesRes = await fetchWithRetry(`${baseUrlClean}/api/export-master/?filter=Families`, {
        method: "GET",
        headers: { "Api-Token": apiTokenClean, Accept: "application/xml" },
      }, 30000);
      const liveFamiliesXml = await liveFamiliesRes.text().catch(() => "");
      if (!liveFamiliesRes.ok || !liveFamiliesXml) {
        return new Response(JSON.stringify({ success: false, error: `Could not read Agora families: HTTP ${liveFamiliesRes.status}` }), {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const liveRestoreFamilies = extractXmlElementsWithAttrs(liveFamiliesXml, "Family");
      const allowedFamilyIds = new Set(rootFamilyIds);
      for (const family of liveRestoreFamilies) {
        if (rootFamilyIds.has(String(family.attrs.ParentFamilyId || ""))) {
          allowedFamilyIds.add(String(family.attrs.Id || ""));
        }
      }
      const disallowedFamilyIds = restoreFamilies
        .map((family) => String(family.attrs.Id || ""))
        .filter((familyId) => !familyId || !allowedFamilyIds.has(familyId));
      if (disallowedFamilyIds.length > 0) {
        return new Response(JSON.stringify({
          success: false,
          error: "PRESENTATION_ROLLBACK_CONTAINS_UNSCOPED_FAMILIES",
          familyIds: disallowedFamilyIds,
        }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const restoreRes = await fetchWithRetry(`${baseUrlClean}/api/import/`, {
        method: "POST",
        headers: {
          "Api-Token": apiTokenClean,
          Accept: "application/xml",
          "Content-Type": "application/xml; charset=utf-8",
        },
        body: restoreXml,
      }, 60000);
      const restoreBody = await restoreRes.text().catch(() => "");
      const restoreParsed = parseAgoraImportResponse(restoreRes.status, restoreBody);
      if (!restoreParsed.success) {
        return new Response(JSON.stringify({
          success: false,
          error: restoreParsed.errors.join("; ") || `HTTP ${restoreRes.status}`,
          importResponse: restoreParsed,
        }), { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      invalidateAgoraProductsCache(connectionId);
      const [restoredProductsFresh, restoredFamiliesRes] = await Promise.all([
        fetchAgoraProductsXmlCached(connectionId, baseUrlClean, apiTokenClean, fetchWithRetry, 30000, true),
        fetchWithRetry(`${baseUrlClean}/api/export-master/?filter=Families`, {
          method: "GET",
          headers: { "Api-Token": apiTokenClean, Accept: "application/xml" },
        }, 30000),
      ]);
      const restoredFamiliesXml = await restoredFamiliesRes.text().catch(() => "");
      const restoredProductById = new Map(
        (restoredProductsFresh.ok ? extractXmlElementsWithAttrs(restoredProductsFresh.xml, "Product") : [])
          .map((product) => [String(product.attrs.Id || ""), product]),
      );
      const restoredFamilyById = new Map(
        (restoredFamiliesRes.ok ? extractXmlElementsWithAttrs(restoredFamiliesXml, "Family") : [])
          .map((family) => [String(family.attrs.Id || ""), family]),
      );
      const comparableAttrs = ["FamilyId", "ButtonText", "Color", "Order"];
      // Agora normalizes Family.Order internally on import, so it is not a
      // stable rollback invariant. Product order remains strictly verified.
      const comparableFamilyAttrs = ["ShowInPos", "ButtonText", "Color", "ParentFamilyId"];
      const productFailures = restoreProducts.flatMap<Record<string, unknown>>((expected) => {
        const id = String(expected.attrs.Id || "");
        const actual = restoredProductById.get(id);
        const differences = comparableAttrs.filter((attr) =>
          normalizeAgoraTextAttribute(decodeXmlAttribute(actual?.attrs[attr] || "")) !==
          normalizeAgoraTextAttribute(decodeXmlAttribute(expected.attrs[attr] || ""))
        );
        return actual && differences.length === 0 ? [] : [{ productId: id, differences, actual: actual?.attrs || null }];
      });
      const familyFailures = restoreFamilies.flatMap<Record<string, unknown>>((expected) => {
        const id = String(expected.attrs.Id || "");
        const actual = restoredFamilyById.get(id);
        const differences = comparableFamilyAttrs.filter((attr) =>
          normalizeAgoraTextAttribute(decodeXmlAttribute(actual?.attrs[attr] || "")) !==
          normalizeAgoraTextAttribute(decodeXmlAttribute(expected.attrs[attr] || ""))
        );
        return actual && differences.length === 0 ? [] : [{ familyId: id, differences, actual: actual?.attrs || null }];
      });

      return new Response(JSON.stringify({
        success: productFailures.length === 0 && familyFailures.length === 0,
        restoredProducts: restoreProducts.length,
        restoredFamilies: restoreFamilies.length,
        verification: {
          productsCatalogFetched: restoredProductsFresh.ok,
          familiesCatalogFetched: restoredFamiliesRes.ok,
          productFailures: productFailures.slice(0, 50),
          familyFailures: familyFailures.slice(0, 50),
        },
        importResponse: restoreParsed,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── SA PEDRERA CONTROLLED TRIAL: publish active D### postres into DULCES WINERIM ──
    // This is intentionally scoped to Sa Pedrera and does not alter the normal automatic routing.
    if (action === "sa-pedrera-dulces-winerim-trial") {
      const dryRun = payload.dryRun !== false;
      const targetFamilyId = String(payload.familyId || "903925");
      const targetFamilyName = String(payload.familyName || "DULCES WINERIM");
      const requestedCodes = Array.isArray(payload.codes)
        ? payload.codes.map((code: unknown) => String(code || "").toUpperCase().replace(/\s+/g, "")).filter((code: string) => /^D\d{3}$/.test(code))
        : null;
      const nowIso = new Date().toISOString();
      const locationName = String((connection as any).location_name || (connection as any).name || "");

      if (!/sa\s*pedrera/i.test(locationName)) {
        return new Response(JSON.stringify({
          success: false,
          error: `Accion bloqueada: la conexion no parece Sa Pedrera (${locationName || "sin nombre"})`,
        }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const escapeTrialXml = (s: string): string =>
        String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
      const truncateTrial = (s: string, maxLen: number): string => String(s || "").length <= maxLen ? String(s || "") : String(s || "").substring(0, maxLen);
      const findVatIdForTrial = (vatList: { Id: string; VatRate: string }[], rate?: number): string | null => {
        if (!rate) return null;
        const rateStr = (rate / 100).toFixed(2);
        const found = vatList.find((v) => String(v.VatRate) === rateStr);
        return found?.Id || null;
      };
      const extractXmlAttr = (xml: string, attr: string): string | null => {
        const re = new RegExp(`\\b${attr}="([^"]*)"`);
        return re.exec(xml)?.[1] || null;
      };
      const setXmlAttr = (el: string, attr: string, value: string): string => {
        const re = new RegExp(`\\b${attr}="[^"]*"`);
        if (re.test(el)) return el.replace(re, `${attr}="${escapeTrialXml(value)}"`);
        return el.replace(/(\s*\/?>)$/, ` ${attr}="${escapeTrialXml(value)}"$1`);
      };
      const patchProductOrder = (el: string, sortOrder: number): string => setXmlAttr(el, "Order", String(sortOrder));

      const { data: masterData } = await supabase
        .from("agora_master_data")
        .select("*")
        .eq("connection_id", connectionId)
        .single();
      if (!masterData) {
        return new Response(JSON.stringify({ success: false, error: "No master data cached. Run sync-master-data first." }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const families = ((masterData as any).families_json || []) as { Id: string; Name: string; Order?: string; Color?: string; ButtonText?: string; ShowInPos?: string }[];
      const vats = ((masterData as any).vats_json || []) as { Id: string; Name: string; VatRate: string }[];
      const priceLists = (((masterData as any).price_lists_json || []) as Record<string, unknown>[])
        .filter((pl) => !isDeletedEntity(pl)) as { Id: string; Name: string }[];
      const warehouses = ((masterData as any).warehouses_json || []) as { Id: string; Name: string }[];
      if (priceLists.length === 0) {
        return new Response(JSON.stringify({ success: false, error: "Agora no tiene PriceLists disponibles; no se importan productos sin precios." }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const { data: winerimRows, error: winesError } = await supabase
        .from("winerim_wines")
        .select("*")
        .eq("connection_id", connectionId)
        .eq("is_active", true)
        .eq("wine_type", "postre");
      if (winesError) {
        return new Response(JSON.stringify({ success: false, error: winesError.message }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const winesByCode = new Map<string, any>();
      for (const wine of winerimRows || []) {
        const code = commercialDCode(wine.name);
        if (code && (!requestedCodes || requestedCodes.includes(code)) && !winesByCode.has(code)) {
          winesByCode.set(code, wine);
        }
      }
      const targetCodes = (requestedCodes || Array.from(winesByCode.keys()))
        .sort((a, b) => Number(a.replace("D", "")) - Number(b.replace("D", "")));
      const missingCodes = requestedCodes ? targetCodes.filter((code) => !winesByCode.has(code)) : [];
      if (missingCodes.length > 0) {
        return new Response(JSON.stringify({ success: false, error: `Faltan vinos activos Winerim: ${missingCodes.join(", ")}` }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      if (targetCodes.length === 0) {
        return new Response(JSON.stringify({ success: false, error: "No hay vinos activos Winerim con codigo D### en postre/dulce." }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      const orderedWines = targetCodes.map((code) => winesByCode.get(code)).filter(Boolean);

      const cached = await fetchAgoraProductsXmlCached(connectionId, baseUrlClean, apiTokenClean, fetchWithRetry, 30000, true);
      if (!cached.ok) {
        return new Response(JSON.stringify({ success: false, error: `No se pudo leer catalogo Agora antes del cambio: HTTP ${cached.status}` }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const productElById = new Map<string, string>();
      const productRegex = /<Product\b[^>]*\/>|<Product\b[^>]*>[\s\S]*?<\/Product>/g;
      let productMatch: RegExpExecArray | null;
      while ((productMatch = productRegex.exec(cached.xml)) !== null) {
        const full = productMatch[0];
        const id = extractXmlAttr(full, "Id");
        if (id) productElById.set(String(id), full);
      }

      const familyElById = new Map<string, string>();
      const familyRegex = /<Family\b[^>]*\/>|<Family\b[^>]*>[\s\S]*?<\/Family>/g;
      const familiesXmlRes = await fetchWithRetry(`${baseUrlClean}/api/export-master/?filter=Families`, {
        method: "GET",
        headers: { "Api-Token": apiTokenClean, Accept: "application/xml" },
      }, 30000);
      const familiesXml = await familiesXmlRes.text().catch(() => "");
      if (!familiesXmlRes.ok || !familiesXml) {
        return new Response(JSON.stringify({ success: false, error: `No se pudo leer familias Agora antes del cambio: HTTP ${familiesXmlRes.status}` }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      let familyMatch: RegExpExecArray | null;
      while ((familyMatch = familyRegex.exec(familiesXml)) !== null) {
        const full = familyMatch[0];
        const id = extractXmlAttr(full, "Id");
        if (id) familyElById.set(String(id), full);
      }

      const existingTargetFamily = families.find((f) => String(f.Id) === targetFamilyId);
      const targetFamilyOrder = String((existingTargetFamily as any)?.Order || "18");
      const familyXml = `    <Family Id="${targetFamilyId}" Name="${escapeTrialXml(targetFamilyName)}" ShowInPos="true" ButtonText="${escapeTrialXml(truncateTrial(targetFamilyName, 20))}" Color="#8B0000" Order="${escapeTrialXml(targetFamilyOrder)}" />`;
      const defaultVatId = (connection as any).default_vat_id || findVatIdForTrial(vats, (connection as any).default_vat_rate) || (vats.length > 0 ? vats[0].Id : "3");
      let defaultPrepTypeId = String((connection as any).default_preparation_type_id || "");
      let defaultPrepOrderId = String((connection as any).default_preparation_order_id || "");
      if ((defaultPrepTypeId.length > 0) !== (defaultPrepOrderId.length > 0)) {
        defaultPrepTypeId = "";
        defaultPrepOrderId = "";
      }

      const productPlans: {
        code: string;
        wineName: string;
        winerimWineId: string;
        format: "BOTTLE" | "GLASS";
        productId: string;
        productName: string;
        price: number;
        cost: number;
        sortOrder: number;
        existedBefore: boolean;
        previous?: { productId: string; name: string | null; familyId: string | null; sortOrder: string | null };
        renderXml: () => string;
      }[] = [];

      let sortOrder = 1;
      for (const wine of orderedWines) {
        const code = commercialDCode(wine.name) || "";
        const glassPrice = extractGlassSalePrice(wine) || 0;
        const bottlePrice = extractBottleSalePrice(wine) || 0;
        const fmt = preferredSingleFormatForDulce(wine);
        const isGlass = fmt === "GLASS";
        const price = isGlass ? glassPrice : bottlePrice;
        if (!price || price <= 0) continue;

        // Agora tablets sort these buttons by Product.Id, not by Order.
        // Use explicit D-code IDs to keep the visual order D701, D702, D710...
        const productId = String(903000 + Number(code.replace("D", "")));
        const productName = formatProductName(fmt, wine.name);
        const cost = isGlass ? (extractGlassCostPrice(wine, connection) || 0) : (extractBottleCostPrice(wine) || 0);
        const previousEl = productElById.get(productId);
        const currentOrder = sortOrder++;
        const pricesXml = priceLists.map((pl) =>
          `        <Price PriceListId="${pl.Id}" MainPrice="${price.toFixed(2)}" AddinPrice="0.00" MenuItemPrice="0.00" />`
        ).join("\n");
        const costPricesXml = warehouses.map((wh) =>
          `        <CostPrice WarehouseId="${wh.Id}" CostPrice="${cost.toFixed(2)}" />`
        ).join("\n");

        productPlans.push({
          code,
          wineName: wine.name,
          winerimWineId: String(wine.winerim_id),
          format: fmt,
          productId,
          productName,
          price,
          cost,
          sortOrder: currentOrder,
          existedBefore: Boolean(previousEl),
          previous: previousEl ? {
            productId,
            name: extractXmlAttr(previousEl, "Name"),
            familyId: extractXmlAttr(previousEl, "FamilyId"),
            sortOrder: extractXmlAttr(previousEl, "Order"),
          } : undefined,
          renderXml: () => {
            const buttonText = truncateTrial(productName, 20);
            return `    <Product Order="${currentOrder}" Id="${productId}" Name="${escapeTrialXml(productName)}" ButtonText="${escapeTrialXml(buttonText)}" Color="#8B0000" PLU="" FamilyId="${targetFamilyId}" VatId="${defaultVatId}" UseAsDirectSale="false" SaleableAsMain="true" SaleableAsAddin="false" IsSoldByWeight="false" AskForPreparationNotes="false" AskForAddins="false" PrintWhenPriceIsZero="false" PreparationTypeId="${escapeTrialXml(defaultPrepTypeId)}" PreparationOrderId="${escapeTrialXml(defaultPrepOrderId)}" CostPrice="${cost.toFixed(2)}">
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

      if (productPlans.length === 0) {
        return new Response(JSON.stringify({ success: false, error: "No hay formatos con precio para los codigos D activos." }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const productXml = productPlans.map((p) => p.renderXml()).join("\n");
      const xml = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n<Import>\n  <Families>\n${familyXml}\n  </Families>\n  <Products>\n${productXml}\n  </Products>\n</Import>`;

      const previousFamilyEl = familyElById.get(targetFamilyId) || null;
      const rollbackExistingProductXml = productPlans
        .filter((p) => p.existedBefore && productElById.has(p.productId))
        .map((p) => patchProductOrder(productElById.get(p.productId) || "", Number(p.previous?.sortOrder || p.sortOrder)))
        .filter(Boolean)
        .join("\n");
      const rollbackFamilyXml = previousFamilyEl ? `    ${previousFamilyEl}` : `    <Family Id="${targetFamilyId}" Name="DULCE WINERIM" ShowInPos="false" ButtonText="DULCE WINERIM" Color="#999999" Order="${escapeTrialXml(targetFamilyOrder)}" />`;
      const rollbackXml = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n<Import>\n  <Families>\n${rollbackFamilyXml}\n  </Families>${rollbackExistingProductXml ? `\n  <Products>\n${rollbackExistingProductXml}\n  </Products>` : ""}\n</Import>`;
      const snapshot = {
        generatedAt: nowIso,
        familyBefore: previousFamilyEl ? {
          id: targetFamilyId,
          name: extractXmlAttr(previousFamilyEl, "Name"),
          showInPos: extractXmlAttr(previousFamilyEl, "ShowInPos"),
          order: extractXmlAttr(previousFamilyEl, "Order"),
        } : null,
        existingProductsBefore: productPlans.filter((p) => p.previous).map((p) => p.previous),
        newProductIds: productPlans.filter((p) => !p.existedBefore).map((p) => p.productId),
      };

      if (dryRun) {
        return new Response(JSON.stringify({
          success: true,
          dryRun: true,
          targetFamily: { id: targetFamilyId, name: targetFamilyName, order: targetFamilyOrder },
          plannedProducts: productPlans.map(({ renderXml: _renderXml, ...p }) => p),
          snapshot,
          xml,
          rollbackXml,
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const importUrl = `${baseUrlClean}/api/import/`;
      const xmlHeadersTrial = {
        "Api-Token": apiTokenClean,
        Accept: "application/xml",
        "Content-Type": "application/xml; charset=utf-8",
      };
      const importRes = await fetchWithRetry(importUrl, { method: "POST", headers: xmlHeadersTrial, body: xml }, 60000);
      const responseBody = await importRes.text().catch(() => "");
      const parsed = parseAgoraImportResponse(importRes.status, responseBody);
      if (!parsed.success) {
        return new Response(JSON.stringify({
          success: false,
          dryRun: false,
          error: parsed.errors.join("; ") || `HTTP ${importRes.status}: ${responseBody.slice(0, 500)}`,
          targetFamily: { id: targetFamilyId, name: targetFamilyName, order: targetFamilyOrder },
          plannedProducts: productPlans.map(({ renderXml: _renderXml, ...p }) => p),
          snapshot,
          rollbackXml,
          xmlSent: xml,
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      invalidateAgoraProductsCache(connectionId);
      await supabase.from("provider_capabilities").upsert({
        connection_id: connectionId,
        provider: "AGORA",
        can_read_sales: true,
        can_read_catalog: true,
        can_write_products: "YES",
        write_endpoint: "/api/import/",
        readiness_status: "READY",
        write_mode: "XML_IMPORT",
        last_checked_at: nowIso,
      }, { onConflict: "connection_id" });

      for (const p of productPlans) {
        await supabase.from("product_mappings").upsert({
          connection_id: connectionId,
          provider_product_id: p.productId,
          provider_product_name: p.productName,
          winerim_wine_id: p.winerimWineId,
          winerim_wine_name: p.wineName,
          match_method: "XML_IMPORT_ORDERED_SINGLE",
          match_score: 100,
          match_reasons: [`Sa Pedrera ordered D-code single-button sync: ${targetFamilyName}`],
          status: "CONFIRMED",
          format_type: p.format,
          agora_product_id: p.productId,
          last_synced_at: nowIso,
          last_sync_error: null,
        }, { onConflict: "connection_id,provider_product_id" });

        await upsertPushTracking(supabase, connectionId, p.winerimWineId, p.format, {
          sync_status: "PUSHED",
          agora_product_id: p.productId,
          agora_family_id: targetFamilyId,
          pushed_at: nowIso,
          last_error: null,
        });
      }

      const verifyCached = await fetchAgoraProductsXmlCached(connectionId, baseUrlClean, apiTokenClean, fetchWithRetry, 30000, true);
      const verifiedProducts: { productId: string; ok: boolean; familyId: string | null; name: string | null; sortOrder: string | null }[] = [];
      if (verifyCached.ok) {
        const verifyById = new Map<string, string>();
        let verifyMatch: RegExpExecArray | null;
        while ((verifyMatch = productRegex.exec(verifyCached.xml)) !== null) {
          const full = verifyMatch[0];
          const id = extractXmlAttr(full, "Id");
          if (id) verifyById.set(String(id), full);
        }
        for (const p of productPlans) {
          const el = verifyById.get(p.productId) || "";
          const familyId = el ? extractXmlAttr(el, "FamilyId") : null;
          const name = el ? extractXmlAttr(el, "Name") : null;
          const verified = familyId === targetFamilyId && name === p.productName;
          verifiedProducts.push({
            productId: p.productId,
            ok: verified,
            familyId,
            name,
            sortOrder: el ? extractXmlAttr(el, "Order") : null,
          });
          if (verified) {
            await upsertPushTracking(supabase, connectionId, p.winerimWineId, p.format, {
              sync_status: "VERIFIED",
              agora_product_id: p.productId,
              agora_family_id: targetFamilyId,
              pushed_at: nowIso,
              verified_at: new Date().toISOString(),
              last_error: null,
            });
          }
        }
      }

      return new Response(JSON.stringify({
        success: true,
        dryRun: false,
        targetFamily: { id: targetFamilyId, name: targetFamilyName, order: targetFamilyOrder },
        plannedProducts: productPlans.map(({ renderXml: _renderXml, ...p }) => p),
        snapshot,
        verification: {
          catalogFetched: verifyCached.ok,
          products: verifiedProducts,
          allOk: verifiedProducts.length === productPlans.length && verifiedProducts.every((p) => p.ok),
        },
        rollbackXml,
        importResponse: parsed,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
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
      const { xml, validationResults, productLabelsById } = generateImportXml(wines, masterData, connection, formatTypes, customFamilyMappings, false, isGeoModePreview ? geoConfigPreview : undefined, isGeoModePreview ? wines : undefined);

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
          productLabelsById,
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
      // VINOTECA connections MUST persist native identities (BOTTLE 2M / GLASS 3M /
      // MAGNUM 4M) — never the generic 500k/700k/900k scheme.
      const vinotecaNativeImport = isVinotecaNativeFormatsConnection(
        connectionId,
        (connection.provider_config || {}) as Record<string, unknown>,
      );
      const importAgoraIdFor = (fmt: string, wineId: unknown): string => {
        const numericId = Number(wineId || 0);
        const genericFallback = fmt === "MAGNUM"
          ? String(900000 + numericId)
          : fmt === "GLASS"
          ? String(700000 + numericId)
          : String(500000 + numericId);
        return trackingAgoraProductIdForFormat({
          vinotecaNativeFormats: vinotecaNativeImport,
          format: fmt,
          winerimWineId: wineId,
          genericFallback,
        }) || genericFallback;
      };

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
      const { xml, validationResults, productLabelsById } = generateImportXml(wines, masterData, connection, formatTypes, customFamilyMappings, false, isGeoModeBulk ? geoConfigBulk : undefined, isGeoModeBulk ? wines : undefined);

      if (dryRun) {
        return new Response(
          JSON.stringify({ success: true, dryRun: true, xml, validationResults, productLabelsById }),
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
          const productName = productLabelsById[agoraProductId]?.name || formatProductName(fmt, wine.name);

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
            verification.success = false;
            verification.verified_exists = false;
            verification.verified_prices = false;
            verification.errors.push({
              code: "VERIFY_FETCH_FAILED",
              message: `Export-master returned ${cachedProducts.status} — verification incomplete`,
            });
          }
        } catch (verifyErr) {
          verification.success = false;
          verification.verified_exists = false;
          verification.verified_prices = false;
          verification.errors.push({
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

        const { data: cachedWineArr } = await supabase
          .from("winerim_wines").select("*")
          .eq("connection_id", task.connection_id).eq("winerim_id", winerimWineId).limit(1);

        let wineArr = cachedWineArr || [];
        if (wineArr.length === 0) {
          const hiddenGlass = configuredHiddenGlassVariant(connection, winerimWineId);
          if (hiddenGlass) {
            wineArr = [applyHiddenGlassVariantForAgora(connection, {
              winerim_id: hiddenGlass.winerim_id,
              name: hiddenGlass.name,
              wine_type: hiddenGlass.wine_type || null,
              is_active: false,
              raw_payload: {},
            })];
          }
        }

        if (wineArr.length === 0) {
          await supabase.from("outbound_tasks").update({
            status: "FAILED", last_error: `Wine ${winerimWineId} not found in cache`,
          }).eq("id", task.id);
          return new Response(JSON.stringify({ success: false, status: "FAILED" }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        // In VINOTECA_REGION_REFERENCE_NATIVE_FORMATS the identities are the
        // builder's deterministic ones (BOTTLE ProductId 2M+id, GLASS/MAGNUM
        // SaleFormatId 3M/4M+id), never the generic 500k/700k/900k scheme.
        const vinotecaNativeFormatsTask = isVinotecaNativeFormatsConnection(
          connection.id,
          (connection.provider_config || {}) as Record<string, unknown>,
        );
        const vinotecaCatalogRoutes = await loadVinotecaCatalogRoutes(supabase, task.connection_id);
        const adoptedCatalogRoute = vinotecaCatalogRoutes?.get(String(winerimWineId));
        const productIdByFormat = Object.fromEntries(
          fmtTypes.map((fmt: string) => [
            fmt,
            (vinotecaNativeFormatsTask && adoptedCatalogRoute
              ? adoptedCatalogRoute.formatIds[fmt as VinotecaFormat]
              : null)
              || (vinotecaNativeFormatsTask ? vinotecaFormatId(fmt, winerimWineId) : null)
              || deterministicAgoraProductId(connection, wineArr[0], fmt),
          ]),
        ) as Record<string, string>;

        // Resolve duplicate names against Agora's current product catalog. A
        // confirmed mapping may outlive a hidden/deleted product and must never
        // keep an obsolete suffix alive. The shared cache avoids re-downloading
        // export-master for every item in a long queue; post-write verification
        // invalidates and refreshes it after each accepted import.
        const namingCatalog = await fetchAgoraProductsXmlCached(
          task.connection_id, baseUrlClean, apiTokenClean, fetchWithRetry, 30000,
        );
        const namingProductsById = new Map<string, { Id: string; Name: string }>();
        const namingProducts = namingCatalog.ok
          ? extractXmlElementsWithAttrs(namingCatalog.xml, "Product").map((product) => ({
              Id: String(product.attrs.Id || ""),
              Name: decodeXmlAttribute(product.attrs.Name || ""),
            }))
          : ((masterData.products_summary_json || []) as { Id: string; Name: string }[]);
        for (const product of namingProducts) {
          if (product.Id && product.Name) namingProductsById.set(String(product.Id), product);
        }
        masterData.products_summary_json = [...namingProductsById.values()];

        const normalizedCurrentWineName = normalizeAgoraTextAttribute(wineArr[0].name).toLocaleLowerCase("es");
        const homonymPrefix = String(wineArr[0].name || "").trim().replace(/([\\%_])/g, "\\$1");
        const { data: homonymCandidates, error: homonymousWinesError } = await supabase
          .from("winerim_wines")
          .select("*")
          .eq("connection_id", task.connection_id)
          .eq("is_active", true)
          .ilike("name", `${homonymPrefix}%`);
        if (homonymousWinesError) {
          throw new Error(`Could not resolve duplicate-safe product names: ${homonymousWinesError.message}`);
        }
        const homonymousWines = (homonymCandidates || []).filter((wine) =>
          normalizeAgoraTextAttribute(wine.name).toLocaleLowerCase("es") === normalizedCurrentWineName
        );
        const queuedProductNameOverrides = buildQueuedProductNameOverrides(
          connection,
          wineArr[0],
          homonymousWines,
          fmtTypes,
          [...namingProductsById.values()],
        );

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
        const frozenPriceListIds = normalizeStringArray(taskPayload._effective_price_list_ids);
        const { xml, validationResults, vinoteca: vinotecaTaskMeta } = generateImportXml(
          wineArr,
          masterData,
          connection,
          fmtTypes,
          customFamilyMappings,
          forceEmptyPreparation,
          isGeoMode ? geoConfig : undefined,
          isGeoMode ? wineArr : undefined,
          frozenPriceListIds,
          queuedProductNameOverrides,
          vinotecaCatalogRoutes,
        );

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
        const preSendProductRegex = /<Product\b[^>]*\bId="(\d+)"[^>]*>([\s\S]*?)<\/Product>/gi;
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
        // Match the Product Id regardless of attribute order, without capturing FamilyId/VatId.
        const sentPricesByProduct: Record<string, { priceListId: string; mainPrice: string }[]> = {};
        const productBlockRegex = /<Product\b[^>]*\bId="(\d+)"[^>]*>([\s\S]*?)<\/Product>/gi;
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
        // Extract expected familyIds from sent XML regardless of attribute order.
        const expectedFamilies: Record<string, string> = {};
        const famRegex = /<Product\b[^>]*\bId="(\d+)"[^>]*\bFamilyId="([^"]*)"/g;
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
          // The import may have been preceded by a cached catalog read. Always
          // verify against a fresh response so an accepted-but-not-persisted
          // write can never be reported as SUCCESS.
          invalidateAgoraProductsCache(task.connection_id);
          const cachedProductsTask = await fetchAgoraProductsXmlCached(
            task.connection_id, baseUrlClean, apiTokenClean, fetchWithRetry, 30000, true,
          );
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
            const productId = productIdByFormat[fmt];
            const sentName = new RegExp(
              `<Product\\b[^>]*\\bId="${productId}"[^>]*\\bName="([^"]*)"`,
              "i",
            ).exec(xml)?.[1];
            const expectedName = sentName ? decodeXmlAttribute(sentName) : formatProductName(fmt, wineArr[0].name);
            const expectedPrices = Object.fromEntries(
              (sentPricesByProduct[productId] || []).map((price) => [price.priceListId, Number(price.mainPrice)]),
            );
            return {
              productId,
              productName: expectedName,
              format: fmt,
              erpId: winerimWineId || "",
              expectedFamilyId: expectedFamilies[productId] || undefined,
              expectedName,
              expectedPrices,
            };
          });

          // ── VINOTECA native formats: verify the builder's own identities ──
          const vinotecaPlanForTask = vinotecaNativeFormatsTask
            ? ((vinotecaTaskMeta?.plans as VinotecaReferencePlan[] | undefined) || [])
              .find((plan) => plan.winerimWineId === String(winerimWineId || "")) || null
            : null;
          const runTaskVerification = (currentVerifyXml: string) =>
            vinotecaPlanForTask
              ? verifyVinotecaNativeFormatsImport({
                plan: vinotecaPlanForTask,
                sentXml: xml,
                actualXml: currentVerifyXml,
                scopedPriceLists: effectivePriceLists,
                priceListToSaleCenters: effectivePlToSc,
              })
              : verifyAgoraProductsAgainstScope(
                currentVerifyXml, productsToVerify,
                effectivePriceLists,
                effectivePlToSc,
              );


          if (verifyRes.ok) {
            let verifyXml = await verifyRes.text();

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
              ...runTaskVerification(verifyXml),
              selected_sale_centers: effectiveSaleCenters,
              selected_price_lists: effectivePriceLists,
              ignored_price_lists: effectiveIgnoredPriceLists,
              verification_scope_source: effectiveScopeSource,
              scope_frozen: !!hasFrozenScope,
              scope_frozen_at: taskPayload._scope_frozen_at || null,
              legacy_verification_scope: !hasFrozenScope && (!!taskPayload._legacy_verification_scope || (!taskPayload._sale_center_id && normalizeStringArray(taskPayload._selected_sale_center_ids).length === 0)),
            };

            // A newly created product can take a moment to become visible in
            // export-master. Retry only NOT_FOUND failures with forced reads;
            // other verification failures are deterministic and should fail now.
            let verificationAttempts = 1;
            while (
              !taskVerification.success &&
              verificationAttempts < 3 &&
              taskVerification.errors.length > 0 &&
              taskVerification.errors.every((issue: AgoraVerificationIssue) =>
                issue.code === "NOT_FOUND" || issue.code === "SALE_FORMAT_NOT_FOUND")
            ) {
              verificationAttempts++;
              await new Promise((resolve) => setTimeout(resolve, verificationAttempts * 1_500));
              invalidateAgoraProductsCache(task.connection_id);
              const retryProducts = await fetchAgoraProductsXmlCached(
                task.connection_id, baseUrlClean, apiTokenClean, fetchWithRetry, 30000, true,
              );
              if (!retryProducts.ok) break;
              verifyXml = retryProducts.xml;
              for (const p of productsToVerify) {
                const pRegex = new RegExp(
                  `<Product[^>]*Id="${p.productId}"[^>]*>([\\s\\S]*?)<\\/Product>`, "i",
                );
                const pMatch = verifyXml.match(pRegex);
                const actualPrices: { priceListId: string; mainPrice: string }[] = [];
                if (pMatch) {
                  const apReg = /<Price[^>]*PriceListId="(\d+)"[^>]*MainPrice="([^"]*)"/gi;
                  let ap;
                  while ((ap = apReg.exec(pMatch[1])) !== null) {
                    actualPrices.push({ priceListId: ap[1], mainPrice: ap[2] });
                  }
                }
                actualPricesByProduct[p.productId] = actualPrices;
              }
              taskVerification = {
                ...runTaskVerification(verifyXml),
                selected_sale_centers: effectiveSaleCenters,
                selected_price_lists: effectivePriceLists,
                ignored_price_lists: effectiveIgnoredPriceLists,
                verification_scope_source: effectiveScopeSource,
                scope_frozen: !!hasFrozenScope,
                scope_frozen_at: taskPayload._scope_frozen_at || null,
                legacy_verification_scope: !hasFrozenScope && (!!taskPayload._legacy_verification_scope || (!taskPayload._sale_center_id && normalizeStringArray(taskPayload._selected_sale_center_ids).length === 0)),
              };
            }
            taskVerification.post_import_verification_attempts = verificationAttempts;
          } else {
            taskVerification.success = false;
            taskVerification.verified_exists = false;
            taskVerification.verified_prices = false;
            taskVerification.errors.push({
              code: "VERIFY_FETCH_FAILED",
              message: `Export-master returned ${verifyRes.status} — verification incomplete`,
            });
          }
        } catch (_verifyErr) {
          taskVerification.success = false;
          taskVerification.verified_exists = false;
          taskVerification.verified_prices = false;
          taskVerification.errors.push({
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

        const productsToVerifyIds = fmtTypes.map((fmt: string) => productIdByFormat[fmt]);

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
          const verificationIssues = [
            ...(taskVerification.errors as AgoraVerificationIssue[]),
            ...(taskVerification.warnings as AgoraVerificationIssue[]),
          ];
          const failMsg = `Post-import verification failed: ${verificationIssues.map((e) => `[${e.code}] ${e.message}`).join("; ")}`.substring(0, 1000);
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
              agora_product_id: (vinotecaNativeFormatsTask
                ? productIdByFormat[fmt]
                : trackingAgoraProductIdForFormat({
                  vinotecaNativeFormats: false,
                  format: fmt,
                  winerimWineId,
                  genericFallback: productIdByFormat[fmt],
                })) || undefined,
              last_error: failMsg.substring(0, 500),
              pushed_at: new Date().toISOString(),
            });
          }
          return new Response(JSON.stringify({ success: false, status: "FAILED", verification: taskVerification, diagnostics }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        // Store diagnostics even on success
        await supabase.from("outbound_tasks").update({
          payload_json: updatedPayload,
        }).eq("id", task.id);

        // Success - update mappings
        for (const fmt of fmtTypes) {
          const agoraProductId = productIdByFormat[fmt];
          const sentNameMatch = new RegExp(
            `<Product\\b[^>]*\\bId="${agoraProductId}"[^>]*\\bName="([^"]*)"`,
            "i",
          ).exec(xml);
          const productName = sentNameMatch
            ? decodeXmlAttribute(sentNameMatch[1])
            : formatProductName(fmt, wineArr[0].name);

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
          readiness_status: "READY",
          write_mode: "XML_IMPORT",
          write_endpoint: "/api/import/",
          last_checked_at: new Date().toISOString(),
        }, { onConflict: "connection_id" });

        await supabase.from("outbound_tasks").update({
          status: "SUCCESS", last_error: null,
          external_id: ((vinotecaNativeFormatsTask ? vinotecaPlanForTask?.productId : null)
            || productIdByFormat[fmtTypes[0]]) || null,
        }).eq("id", task.id);

        // auto_push_verified_ready is NOT set here — manual verification required

        // ── PUSH TRACKING: Mark PUSHED (or VERIFIED if verification passed) per format ──
        const pushStatus = taskVerification.success ? "VERIFIED" : "PUSHED";
        for (const fmt of fmtTypes) {
          const fmtProductId = productIdByFormat[fmt];
          const trackedProductId = vinotecaNativeFormatsTask
            ? fmtProductId
            : trackingAgoraProductIdForFormat({
              vinotecaNativeFormats: false,
              format: fmt,
              winerimWineId,
              genericFallback: fmtProductId,
            });
          await upsertPushTracking(supabase, task.connection_id, winerimWineId, fmt, {
            sync_status: pushStatus,
            task_id: task.id,
            agora_product_id: trackedProductId || undefined,
            agora_family_id: expectedFamilies[fmtProductId] || undefined,
            pushed_at: new Date().toISOString(),
            verified_at: taskVerification.success ? new Date().toISOString() : null,
            last_error: null,
          });
        }

        // Reset failure counter on success — connection is healthy again
        await resetFailureCounter(supabase, task.connection_id);
        const affectedFamilyIds = Array.from(new Set(Object.values(expectedFamilies).filter(Boolean)));
        return new Response(JSON.stringify({ success: true, status: "SUCCESS", parsedResponse, verification: taskVerification, affectedFamilyIds }),
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
      const selectedPriceWriteScope = (connection.provider_config as any)?.price_write_scope === "SELECTED_SALE_CENTERS";
      const scopePayload = buildAgoraVerificationScopePayload(masterData, {
        explicitSaleCenterIds: normalizeStringArray(payload.saleCenterIds || payload.saleCenterId),
        connectionSelectedSaleCenterIds: connection.selected_sale_center_ids || [],
        verificationMode: selectedPriceWriteScope ? "SELECTED_SALE_CENTERS" : "PRODUCTION_ALL_ACTIVE_SALE_CENTERS",
      });

      // ── Pre-load wine eligibility data to filter formats per wine ──
      const wineEligibility: Record<string, {
        winerim_id: string;
        name: string;
        wine_type: string | null;
        raw_payload: Record<string, unknown> | null;
        is_active?: boolean;
        serve_by_glass: boolean;
        bottle_sale_price: number | null;
        glass_sale_price: number | null;
        magnum_sale_price: number | null;
        _agora_allow_inactive_glass?: boolean;
        _agora_allow_inactive_bottle?: boolean;
      }> = {};
      for (let i = 0; i < winerimWineIds.length; i += 500) {
        const chunk = winerimWineIds.slice(i, i + 500);
        const { data: wines } = await supabase
          .from("winerim_wines")
          .select("winerim_id, name, wine_type, raw_payload, is_active, serve_by_glass, bottle_sale_price, glass_sale_price, magnum_sale_price")
          .eq("connection_id", connectionId)
          .in("winerim_id", chunk);
        for (const w of (wines || [])) {
          const effectiveWine = applyHiddenGlassVariantForAgora(connection, w);
          wineEligibility[w.winerim_id] = {
            winerim_id: String(w.winerim_id),
            name: String(effectiveWine.name || ""),
            wine_type: effectiveWine.wine_type,
            raw_payload: effectiveWine.raw_payload,
            is_active: effectiveWine.is_active,
            serve_by_glass: effectiveWine.serve_by_glass,
            bottle_sale_price: effectiveWine.bottle_sale_price,
            glass_sale_price: effectiveWine.glass_sale_price,
            magnum_sale_price: effectiveWine.magnum_sale_price,
            _agora_allow_inactive_glass: effectiveWine._agora_allow_inactive_glass,
            _agora_allow_inactive_bottle: effectiveWine._agora_allow_inactive_bottle,
          };
        }
      }
      for (const hiddenGlass of configuredHiddenGlassVariants(connection)) {
        if (!winerimWineIds.map(String).includes(hiddenGlass.winerim_id)) continue;
        const existing = wineEligibility[hiddenGlass.winerim_id] || {};
        const effectiveWine = applyHiddenGlassVariantForAgora(connection, {
          ...existing,
          winerim_id: hiddenGlass.winerim_id,
          name: existing.name || hiddenGlass.name,
          wine_type: existing.wine_type || hiddenGlass.wine_type || null,
          is_active: existing.is_active ?? false,
          raw_payload: existing.raw_payload || {},
        });
        wineEligibility[hiddenGlass.winerim_id] = effectiveWine;
      }

      const eligibleFormatsByWine = new Map<string, string[]>();
      const requestedProductIds: string[] = [];
      for (const wineId of winerimWineIds) {
        const elig = wineEligibility[wineId];
        const eligibleFormats = formatTypes.filter((fmt: string) => {
          if (elig?.is_active === false && !inactiveFormatAllowedByConnection(elig, fmt)) return false;
          if (fmt === "GLASS") return (elig?.glass_sale_price ?? 0) > 0;
          if (fmt === "BOTTLE") return (elig?.bottle_sale_price ?? 0) > 0;
          if (fmt === "MAGNUM") return (elig?.magnum_sale_price ?? 0) > 0;
          return false;
        });
        eligibleFormatsByWine.set(String(wineId), eligibleFormats);
        for (const fmt of eligibleFormats) {
          requestedProductIds.push(deterministicAgoraProductId(connection, elig, fmt));
        }
      }

      // A deterministic Winerim ID must never overwrite an unrelated Agora
      // product. Existing IDs are writable only when prior Winerim ownership is
      // proven by tracking or an XML_IMPORT mapping for the same wine/format.
      const ownershipKeys = new Set<string>();
      for (let i = 0; i < requestedProductIds.length; i += 500) {
        const productIdChunk = requestedProductIds.slice(i, i + 500);
        const [{ data: trackingRows }, { data: mappingRows }] = await Promise.all([
          supabase.from("winerim_push_tracking")
            .select("agora_product_id,winerim_wine_id,format,source,sync_status")
            .eq("connection_id", connectionId)
            .eq("source", "WINERIM")
            .eq("sync_status", "VERIFIED")
            .in("agora_product_id", productIdChunk),
          supabase.from("product_mappings")
            .select("provider_product_id,winerim_wine_id,format_type,match_method,status")
            .eq("connection_id", connectionId)
            .eq("status", "CONFIRMED")
            .in("provider_product_id", productIdChunk),
        ]);
        for (const row of trackingRows || []) {
          ownershipKeys.add(`${row.agora_product_id}:${row.winerim_wine_id}:${String(row.format || "").toUpperCase()}`);
        }
        for (const row of mappingRows || []) {
          if (!String(row.match_method || "").startsWith("XML_IMPORT")) continue;
          ownershipKeys.add(`${row.provider_product_id}:${row.winerim_wine_id}:${String(row.format_type || "").toUpperCase()}`);
        }
      }
      const idCollisions: Record<string, unknown>[] = [];
      for (const wineId of winerimWineIds) {
        const wine = wineEligibility[String(wineId)];
        for (const fmt of eligibleFormatsByWine.get(String(wineId)) || []) {
          const providerProductId = deterministicAgoraProductId(connection, wine, fmt);
          if (!existingProductIds.has(providerProductId)) continue;
          if (!ownershipKeys.has(`${providerProductId}:${wineId}:${fmt}`)) {
            idCollisions.push({ providerProductId, winerimWineId: wineId, format: fmt });
          }
        }
      }
      if (idCollisions.length > 0) {
        return new Response(JSON.stringify({
          success: false,
          error: "AGORA_PRODUCT_ID_COLLISION",
          message: "A deterministic Winerim product ID is already occupied by a product without proven Winerim ownership.",
          collisions: idCollisions.slice(0, 50),
        }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      let queuedCreate = 0, queuedUpdate = 0, skippedDuplicate = 0, skippedNoFormats = 0;
      for (const wineId of winerimWineIds) {
        // ── Filter formats based on wine eligibility ──
        const eligibleFormats = eligibleFormatsByWine.get(String(wineId)) || [];
        if (eligibleFormats.length === 0) {
          skippedNoFormats++;
          continue;
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
        const wine = wineEligibility[String(wineId)];
        const formatProductIds = Object.fromEntries(
          eligibleFormats.map((fmt: string) => [fmt, deterministicAgoraProductId(connection, wine, fmt)]),
        ) as Record<string, string>;
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
      const MIN_TIME_FOR_CLAIM_MS = 3_000;
      const startTime = Date.now();
      let processed = 0, succeeded = 0, failed = 0;
      const useCommercialCodePresentation = shouldSortAgoraProductsByCommercialCode(connection);
      const useAlphabeticalPresentation = shouldSortAgoraProductsAlphabetically(connection);
      const shouldReorderAfterSuccess = useCommercialCodePresentation || useAlphabeticalPresentation;
      const useOwnedPresentationNormalizer =
        ((connection.provider_config || {}) as Record<string, unknown>).agora_product_presentation_enabled === true;
      const familiesToReorderAfterSuccess = new Set<string>();

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

      let initialConsecutiveFailures = (connection as any).consecutive_failures || 0;
      if (breakerPausedUntil && breakerPausedUntil <= nowIso && initialConsecutiveFailures >= 10) {
        initialConsecutiveFailures = 0;
        await supabase.from("pos_connections").update({
          consecutive_failures: 0,
          circuit_breaker_paused_until: null,
          circuit_breaker_reason: null,
        }).eq("id", connectionId);
      }

      // Helper: compute exponential backoff delay (in seconds)
      const backoffDelaySec = (attempts: number) =>
        Math.min(60 * 60, Math.pow(2, attempts) * 60); // 2,4,8,16,32 min, cap 60min

      // Helper: register a failure and possibly trip the circuit breaker
      let runConsecutiveFailures = initialConsecutiveFailures;
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
        if (TIME_BUDGET_MS - (Date.now() - startTime) < MIN_TIME_FOR_CLAIM_MS) break;

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

        const unprocessedClaimedTasks = usedAtomicClaim ? [...(tasks as any[])] : [];
        const forgetClaimedTask = (taskId: string) => {
          const idx = unprocessedClaimedTasks.findIndex((task: any) => task.id === taskId);
          if (idx >= 0) unprocessedClaimedTasks.splice(idx, 1);
        };

        for (const t of tasks) {
          if (Date.now() - startTime >= TIME_BUDGET_MS) break;
          if (runConsecutiveFailures >= 10) break;
          forgetClaimedTask(t.id);
          try {
            if ((t as any).task_type === "AGORA_HIDE_PRODUCT") {
              const { data: fullTask } = await supabase.from("outbound_tasks").select("*").eq("id", t.id).single();
              if (!fullTask) { failed++; processed++; continue; }
              const p = fullTask.payload_json as Record<string, unknown>;
              const productIds = (p._product_ids as string[]) || [];
              const wineName = String(p._wine_name || "Unknown");
              const escXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
              const productElById = new Map<string, string>();
              const setAttr = (el: string, attr: string, value: string): string => {
                const re = new RegExp(`\\b${attr}="[^"]*"`);
                if (re.test(el)) return el.replace(re, `${attr}="${value}"`);
                return el.replace(/(\s*\/?>)$/, ` ${attr}="${value}"$1`);
              };
              const getAttr = (el: string, attr: string): string | null => {
                const match = new RegExp(`\\b${attr}="([^"]*)"`).exec(el);
                return match?.[1] ?? null;
              };

              if (productIds.length === 0) {
                await supabase.from("outbound_tasks").update({ status: "FAILED", last_error: "No product IDs to hide" }).eq("id", t.id);
                failed++; processed++; continue;
              }

              const cached = await fetchAgoraProductsXmlCached(connectionId, baseUrlClean, apiTokenClean, fetchWithRetry, 30000);
              if (cached.ok) {
                const productRegex = /<Product\b[^>]*\/>|<Product\b[^>]*>[\s\S]*?<\/Product>/g;
                const idAttr = /\bId="([^"]+)"/;
                let mProd: RegExpExecArray | null;
                while ((mProd = productRegex.exec(cached.xml)) !== null) {
                  const full = mProd[0];
                  const idm = idAttr.exec(full);
                  if (idm) productElById.set(String(idm[1]), full);
                }
              } else {
                console.warn(`[AGORA_HIDE_PRODUCT] Could not fetch product master for name-preserving hide: HTTP ${cached.status}`);
              }

              const vatIdHide = String((connection as any).default_vat_id || "1");
              let productsXml = "";
              for (const pid of productIds) {
                const original = productElById.get(String(pid));
                if (original) {
                  let patched = setAttr(original, "UseAsDirectSale", "false");
                  patched = setAttr(patched, "SaleableAsMain", "false");
                  const currentName = getAttr(patched, "Name");
                  if (currentName?.match(/^\[INACTIVO\]\s*/i)) {
                    patched = setAttr(patched, "Name", currentName.replace(/^\[INACTIVO\]\s*/i, ""));
                  }
                  productsXml += `    ${patched}\n`;
                } else {
                  productsXml += `    <Product Id="${pid}" Name="${escXml(wineName)}" VatId="${vatIdHide}" UseAsDirectSale="false" SaleableAsMain="false" />\n`;
                }
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
              const resBody = await readResponseTextBestEffort(res);

              if (res.ok) {
                await supabase.from("outbound_tasks").update({ status: "SUCCESS", last_error: null }).eq("id", t.id);
                invalidateAgoraProductsCache(connectionId);
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
              const resBody = await readResponseTextBestEffort(res);

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
                if (shouldReorderAfterSuccess && targetFamilyId) {
                  familiesToReorderAfterSuccess.add(String(targetFamilyId));
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
                if (shouldReorderAfterSuccess && Array.isArray(result?.affectedFamilyIds)) {
                  for (const familyId of result.affectedFamilyIds) {
                    if (familyId) familiesToReorderAfterSuccess.add(String(familyId));
                  }
                }
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

        if (unprocessedClaimedTasks.length > 0) {
          for (const pending of unprocessedClaimedTasks) {
            await supabase.from("outbound_tasks").update({
              status: "QUEUED",
              attempts: Math.max(((pending as any).attempts || 1) - 1, 0),
              next_retry_at: null,
              updated_at: new Date().toISOString(),
            }).eq("id", (pending as any).id).eq("status", "RUNNING");
          }
          break;
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
      let productPresentationResult: unknown = null;

      if (shouldReorderAfterSuccess && familiesToReorderAfterSuccess.size > 0 && !breakerTripped) {
        const { data: reorderData, error: reorderError } = await supabase.functions.invoke("agora-proxy", {
          body: {
            action: useOwnedPresentationNormalizer
              ? "normalize-winerim-product-presentation"
              : useCommercialCodePresentation
                ? "reorder-products-by-commercial-code"
                : "reorder-winerim-family-products",
            connectionId,
            familyIds: Array.from(familiesToReorderAfterSuccess),
            dryRun: false,
            ...(useOwnedPresentationNormalizer ? { confirm: "NORMALIZE_WINERIM_PRESENTATION" } : {}),
          },
        });
        productPresentationResult = reorderError
          ? { success: false, error: reorderError.message, familyIds: Array.from(familiesToReorderAfterSuccess) }
          : reorderData;
      }

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
        productPresentation: productPresentationResult,
        commercialCodeSort: useCommercialCodePresentation ? productPresentationResult : null,
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

    // ── CLEANUP AND PUSH GLASSES (wines with a Winerim glass price) ──
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

      // 3) Find wines that have glass_sale_price
      const { data: glassWines } = await supabase
        .from("winerim_wines")
        .select("winerim_id, name, wine_type, glass_sale_price")
        .eq("connection_id", connectionId)
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

    // ── BACKFILL PREPARATION FIELDS (re-push with the configured prep pair) ──
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

      const hasPrepPair = Boolean(connection.default_preparation_type_id && connection.default_preparation_order_id);
      const forceEmptyPreparation = payload.forceEmptyPreparation === true || !hasPrepPair;

      // Queue UPDATE tasks. If the connection has a valid default pair, generateImportXml
      // writes it into each product; otherwise both preparation fields stay empty.
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
            _force_empty_preparation: forceEmptyPreparation,
            ...prepScopePayload,
          },
          status: "QUEUED",
        });
        queued++;
      }

      return new Response(JSON.stringify({ success: true, queued, skipped, totalTargets: targetWineIds.length, forceEmptyPreparation, hasPrepPair }),
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
        verificationMode: (connection.provider_config as any)?.price_write_scope === "SELECTED_SALE_CENTERS"
          ? "SELECTED_SALE_CENTERS"
          : "PRODUCTION_ALL_ACTIVE_SALE_CENTERS",
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
        verificationMode: (connection.provider_config as any)?.price_write_scope === "SELECTED_SALE_CENTERS"
          ? "SELECTED_SALE_CENTERS"
          : "PRODUCTION_ALL_ACTIVE_SALE_CENTERS",
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
      
      const verificationPageSize = 500;
      const mappings: any[] = [];
      for (let offset = 0; ; offset += verificationPageSize) {
        const { data: mappingPage, error: mappingPageError } = await supabase
          .from("product_mappings")
          .select("provider_product_id, provider_product_name, winerim_wine_id, format_type")
          .eq("connection_id", connectionId)
          .eq("status", "CONFIRMED")
          .eq("match_method", "XML_IMPORT")
          .range(offset, offset + verificationPageSize - 1);
        if (mappingPageError) {
          return new Response(JSON.stringify({
            success: false,
            error: `Could not load product mappings for verification: ${mappingPageError.message}`,
          }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        mappings.push(...(mappingPage || []));
        if ((mappingPage || []).length < verificationPageSize) break;
      }

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
      const verificationWines: any[] = [];
      for (let offset = 0; ; offset += verificationPageSize) {
        const { data: winePage, error: winePageError } = await supabase
          .from("winerim_wines")
          .select("winerim_id, is_active, bottle_sale_price, glass_sale_price, magnum_sale_price")
          .eq("connection_id", connectionId)
          .range(offset, offset + verificationPageSize - 1);
        if (winePageError) {
          return new Response(JSON.stringify({
            success: false,
            error: `Could not load Winerim eligibility for tracking verification: ${winePageError.message}`,
          }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        verificationWines.push(...(winePage || []));
        if ((winePage || []).length < verificationPageSize) break;
      }

      const verificationWineById = new Map(
        verificationWines.map((wine: any) => [
          String(wine.winerim_id),
          applyHiddenGlassVariantForAgora(connection, wine),
        ]),
      );
      const actualProductById = new Map(
        extractXmlElementsWithAttrs(verifyXml, "Product")
          .map((product) => [String(product.attrs.Id || ""), product] as const)
          .filter(([productId]) => Boolean(productId)),
      );
      const errorsByProductId = new Map<string, string[]>();
      for (const issue of verifyResult.errors) {
        const productId = String(issue.context?.productId || "");
        if (!productId) continue;
        const messages = errorsByProductId.get(productId) || [];
        messages.push(issue.message);
        errorsByProductId.set(productId, messages);
      }

      const verifiedAt = new Date().toISOString();
      const trackingRows = (mappings || []).map((m: any) => {
        const productId = String(m.provider_product_id || "");
        const productErrors = errorsByProductId.get(productId) || [];
        const wine = verificationWineById.get(String(m.winerim_wine_id || ""));
        const configuredInactiveFormat = isConfiguredHiddenFormatVariant(
          connection,
          wine || m.winerim_wine_id,
          String(m.format_type || ""),
        );
        const shouldTrackAsHidden = Boolean(
          !configuredInactiveFormat && (
            !wine ||
            wine.is_active === false ||
            isFormatUnavailableForAgora(wine, String(m.format_type || ""))
          ),
        );
        const actualProduct = actualProductById.get(productId);
        const actualProductIsSaleable = Boolean(
          actualProduct &&
          (
            ["true", "1"].includes(String(actualProduct.attrs.UseAsDirectSale || "").toLowerCase()) ||
            ["true", "1"].includes(String(actualProduct.attrs.SaleableAsMain || "").toLowerCase())
          ),
        );
        const retiredVisibilityError = shouldTrackAsHidden && actualProductIsSaleable
          ? `Retired product ${productId} is still saleable in Agora`
          : null;
        const effectiveErrors = shouldTrackAsHidden
          ? (retiredVisibilityError ? [retiredVisibilityError] : [])
          : productErrors;
        const productOk = effectiveErrors.length === 0;
        const syncStatus = shouldTrackAsHidden && productOk
          ? "HIDDEN"
          : productOk ? "VERIFIED" : "FAILED";
        return {
          connection_id: connectionId,
          winerim_wine_id: m.winerim_wine_id,
          format: m.format_type,
          agora_product_id: productId,
          agora_family_id: null,
          source: "WINERIM",
          sync_status: syncStatus,
          task_id: null,
          last_error: productOk ? null : effectiveErrors.join("; ").substring(0, 500),
          pushed_at: null,
          verified_at: productOk ? verifiedAt : null,
        };
      });

      const trackingErrors: string[] = [];
      let trackingUpdated = 0;
      for (let offset = 0; offset < trackingRows.length; offset += 250) {
        const chunk = trackingRows.slice(offset, offset + 250);
        const { error: trackingError } = await supabase
          .from("winerim_push_tracking")
          .upsert(chunk, { onConflict: "connection_id,winerim_wine_id,format" });
        if (trackingError) {
          trackingErrors.push(trackingError.message);
        } else {
          trackingUpdated += chunk.length;
        }
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
        trackingPersistence: {
          attempted: trackingRows.length,
          updated: trackingUpdated,
          errors: trackingErrors,
        },
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
      const res = await fetchWithRetry(url, { headers }, 10_000);
      const data = await res.json();
      return new Response(JSON.stringify({ data, status: res.status }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── EVALUATE AUTO-PUSH ──
    // Deploy marker 2026-06-10: Sa Pedrera CREATE guard must skip already verified formats before re-enabling automatic catalog pushes.
    if (action === "evaluate-auto-push") {
      let winerimWineIds = normalizeStringArray(payload.winerimWineIds || []);
      const evtType = payload.eventType || "CREATE";
      const forceEvaluate = payload.forceEvaluate === true;
      const dryRun = payload.dryRun === true;
      // Single write barrier: forceEvaluate and dryRun are both read-only modes.
      const autoPushWritesEnabled = !forceEvaluate && !dryRun;

      const autoPushOnCreate = connection.auto_push_on_create ?? false;
      const autoPushOnUpdate = connection.auto_push_on_update ?? false;
      const autoPushBottle = connection.auto_push_bottle ?? true;
      const autoPushGlass = connection.auto_push_glass ?? false;
      const requireReview = connection.require_manual_review_before_push ?? true;
      const providerConfig = (connection.provider_config || {}) as Record<string, unknown>;

      // ── FAIL-CLOSED IDENTITY QUARANTINE ──
      // Ambiguous Agora identities (multiple products/vintages for the same wine) can never be
      // created or adopted deterministically. Drop those Winerim ids here, before ANY
      // CREATE/UPDATE/HIDE/DELETE decision or per-wine task lookup: zero tasks, zero writes.
      const failClosedWinerimIds = autoPushFailClosedWinerimIds(providerConfig);
      const failClosedExcluded: string[] = [];
      if (failClosedWinerimIds.length > 0) {
        const quarantined = new Set(failClosedWinerimIds);
        const kept: string[] = [];
        for (const id of winerimWineIds) {
          if (quarantined.has(id)) failClosedExcluded.push(id);
          else kept.push(id);
        }
        winerimWineIds = kept;
        if (winerimWineIds.length === 0) {
          return new Response(JSON.stringify({
            success: true,
            queued: 0,
            wouldQueue: 0,
            skipped: failClosedExcluded.length,
            hidQueued: 0,
            skippedReasons: failClosedExcluded.map((id) => ({
              winerim_id: id,
              reason: "auto_push_fail_closed_identity_excluded",
            })),
            totalWines: 0,
            eventType: evtType,
            failClosedExcluded,
          }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
      }



      // UPDATE canary guard: only allow listed Winerim IDs through when provider_config has an update allowlist.
      if (evtType === "UPDATE") {
        const updateAllowlist = normalizeStringArray(
          providerConfig.auto_push_update_winerim_ids ||
          providerConfig.auto_push_update_canary_winerim_ids
        );
        if (updateAllowlist.length > 0) {
          const allowed = new Set(updateAllowlist);
          const originalCount = winerimWineIds.length;
          winerimWineIds = winerimWineIds.filter((id) => allowed.has(id));
          if (winerimWineIds.length === 0) {
            return new Response(JSON.stringify({
              success: true,
              queued: 0,
              skipped: originalCount,
              hidQueued: 0,
              skippedReasons: updateAllowlist.map((id) => ({
                winerim_id: id,
                reason: "auto_push_update_canary_waiting_for_allowed_wine",
              })),
              totalWines: 0,
              eventType: evtType,
              updateAllowlist,
            }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
          }
        }
      }

      if (!forceEvaluate) {
        if (evtType === "CREATE" && !autoPushOnCreate) {
          return new Response(JSON.stringify({ success: true, skipped: true, reason: "auto_push_on_create disabled" }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        if (evtType === "UPDATE" && !autoPushOnUpdate) {
          return new Response(JSON.stringify({ success: true, skipped: true, reason: "auto_push_on_update disabled" }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
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
        .from("agora_master_data").select("id, families_json, vats_json, price_lists_json, warehouses_json, sale_centers_json, products_summary_json, preparation_types_json, preparation_orders_json")
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

      const { data: cachedWines } = await supabase
        .from("winerim_wines").select("winerim_id, name, price, format, winery, grape_variety, region, vintage, raw_payload, wine_type, bottle_sale_price, bottle_purchase_price, glass_sale_price, glass_cost_price, magnum_sale_price, magnum_purchase_price, serve_by_glass, is_active")
        .eq("connection_id", connectionId).in("winerim_id", winerimWineIds);

      const wines = (cachedWines || []).map((wine: any) => applyHiddenGlassVariantForAgora(connection, wine));
      const cachedWineIds = new Set(wines.map((wine: any) => String(wine.winerim_id)));
      const requestedWineIdSet = new Set(winerimWineIds.map(String));
      for (const hiddenGlass of configuredHiddenGlassVariants(connection)) {
        if (!requestedWineIdSet.has(hiddenGlass.winerim_id) || cachedWineIds.has(hiddenGlass.winerim_id)) continue;
        wines.push(applyHiddenGlassVariantForAgora(connection, {
          winerim_id: hiddenGlass.winerim_id,
          name: hiddenGlass.name,
          wine_type: hiddenGlass.wine_type || null,
          is_active: false,
          raw_payload: {},
        }));
      }

      if (wines.length === 0) {
        return new Response(JSON.stringify({ success: true, skipped: true, reason: "no wines found" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      let queued = 0;
      let wouldQueue = 0;
      let skipped = 0;
      const skippedReasons: { winerim_id: string; reason: string }[] = [];
      for (const excludedId of failClosedExcluded) {
        skipped++;
        skippedReasons.push({ winerim_id: excludedId, reason: "auto_push_fail_closed_identity_excluded" });
      }


      // ── UPDATE differential guard precompute ──
      // Read the current Agora Products XML ONCE and load custom family mappings ONCE.
      // If the diff finds no exportable change per format, we skip queueing that format.
      const updateDiffEnabled = evtType === "UPDATE" && (providerConfig as any).auto_push_update_diff_enabled !== false;
      let updateDiffCurrentXml: string | null = null;
      let updateDiffError: string | null = null;
      let updateDiffCustomMappings: Record<string, { id: string; name: string }> | undefined = undefined;
      let updateDiffExistingProducts: { Id: string; Name: string }[] = [];
      let updateDiffActiveWines: any[] = [];
      let updateDiffVinotecaRoutes: Map<string, VinotecaCatalogRoute | null> | undefined;
      const updateDiffScopedPriceListIds: string[] = Array.isArray((autoPushScopePayload as any)._effective_price_list_ids)
        ? ((autoPushScopePayload as any)._effective_price_list_ids as string[])
        : [];
      const updateDiffGeoConfig = (connection.provider_config as any)?.geographic_config as GeographicFamilyConfig | undefined;
      const updateDiffIsGeoMode = (connection.provider_config as any)?.family_structure_mode === "GEOGRAPHIC_FAMILIES" && updateDiffGeoConfig;
      if (updateDiffEnabled) {
        try {
          // Fresh read ONCE per evaluation (never per product): deciding
          // "no_agora_changes" against a stale Products cache silently drops
          // real price updates. forceRefresh=true here, and only here.
          const cachedForDiff = await fetchAgoraProductsXmlCached(connectionId, baseUrlClean, apiTokenClean, fetchWithRetry, 30000, true);
          if (cachedForDiff && cachedForDiff.ok && cachedForDiff.xml && cachedForDiff.xml.includes("<Product")) {
            updateDiffCurrentXml = cachedForDiff.xml;
            updateDiffExistingProducts = extractXmlElementsWithAttrs(cachedForDiff.xml, "Product")
              .map((product) => ({
                Id: String(product.attrs.Id || ""),
                Name: decodeXmlAttribute(product.attrs.Name || ""),
              }))
              .filter((product) => Boolean(product.Id && product.Name));
          } else {
            updateDiffError = `cache_status_${cachedForDiff?.status ?? "unknown"}`;
          }
        } catch (e) {
          updateDiffError = `fetch_error:${(e as Error).message?.slice(0, 80) || "unknown"}`;
        }
        try {
          updateDiffCustomMappings = await loadCustomFamilyMappings(connectionId);
          updateDiffVinotecaRoutes = await loadVinotecaCatalogRoutes(supabase, connectionId);
        } catch (_e) {
          // Non-fatal — expected XML generation will use master data defaults.
        }
        try {
          const { data: activeWinesForDiff, error: activeWinesForDiffError } = await supabase
            .from("winerim_wines")
            .select("winerim_id, name, price, format, winery, grape_variety, region, vintage, raw_payload, wine_type, bottle_sale_price, bottle_purchase_price, glass_sale_price, glass_cost_price, magnum_sale_price, magnum_purchase_price, serve_by_glass, is_active")
            .eq("connection_id", connectionId)
            .eq("is_active", true);
          if (activeWinesForDiffError) throw activeWinesForDiffError;
          updateDiffActiveWines = activeWinesForDiff || [];
        } catch (e) {
          updateDiffCurrentXml = null;
          updateDiffError = `naming_context_error:${(e as Error).message?.slice(0, 80) || "unknown"}`;
        }
      }

      let hidQueued = 0;
      for (const wine of wines) {
        // ── INACTIVE WINE → queue HIDE task to set ShowInPos=false in Agora ──
        if (wine.is_active === false) {
          const formatsKeptInAgora = new Set(
            ["BOTTLE", "GLASS", "MAGNUM"].filter((format) =>
              inactiveFormatAllowedByConnection(wine, format)
            ),
          );
          // Check if already has a verified push (i.e. product exists in Agora)
          const { data: existingPush } = await supabase
            .from("winerim_push_tracking").select("format, agora_product_id, source")
            .eq("connection_id", connectionId).eq("winerim_wine_id", wine.winerim_id)
            .eq("source", "WINERIM")
            .in("sync_status", ["VERIFIED", "PUSHED"]);

          const existingPushesToHide = (existingPush || []).filter((push: any) =>
            !formatsKeptInAgora.has(String(push.format || "").toUpperCase())
          );
          if (existingPushesToHide.length > 0) {
            // Check no existing hide task queued
            const { data: existingHide } = await supabase
              .from("outbound_tasks").select("id")
              .eq("connection_id", connectionId)
              .eq("task_type", "AGORA_HIDE_PRODUCT")
              .contains("payload_json", { _winerim_wine_id: wine.winerim_id })
              .in("status", ["QUEUED", "RUNNING"]).limit(1);
            
            if (!existingHide || existingHide.length === 0) {
              const productIds = existingPushesToHide.map(p => p.agora_product_id).filter(Boolean);
              if (autoPushWritesEnabled) {
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
                // Update tracking to reflect hidden status
                for (const p of existingPushesToHide) {
                  await supabase.from("winerim_push_tracking")
                    .update({ sync_status: "HIDDEN" })
                    .eq("connection_id", connectionId)
                    .eq("winerim_wine_id", wine.winerim_id)
                    .eq("format", p.format);
                }
              }
              hidQueued++;
            }
          }
          if (formatsKeptInAgora.size === 0) {
            skipped++;
            skippedReasons.push({ winerim_id: wine.winerim_id, reason: (forceEvaluate || dryRun) ? "wine_inactive_would_hide" : "wine_inactive_hide_queued" });
            continue;
          }
          skippedReasons.push({
            winerim_id: wine.winerim_id,
            reason: `inactive_public_menu_formats_kept_by_connection_policy:${[...formatsKeptInAgora].join("+")}`,
          });
        }

        const { data: existingPublishedFormats } = await supabase
          .from("winerim_push_tracking").select("format, agora_product_id, source")
          .eq("connection_id", connectionId).eq("winerim_wine_id", wine.winerim_id)
          .eq("source", "WINERIM")
          .in("sync_status", ["VERIFIED", "PUSHED"]);
        const formatsToHide = (existingPublishedFormats || [])
          .filter((push: any) => Boolean(push.agora_product_id))
          .filter((push: any) => isFormatUnavailableForAgora(wine, String(push.format || "")));

        if (formatsToHide.length > 0) {
          const { data: existingHide } = await supabase
            .from("outbound_tasks").select("id")
            .eq("connection_id", connectionId)
            .eq("task_type", "AGORA_HIDE_PRODUCT")
            .contains("payload_json", { _winerim_wine_id: wine.winerim_id })
            .in("status", ["QUEUED", "RUNNING"]).limit(1);
          const hideFormats = formatsToHide.map((push: any) => String(push.format || "").toUpperCase());

          if (!existingHide || existingHide.length === 0) {
            const productIds = formatsToHide.map((push: any) => push.agora_product_id).filter(Boolean);
            if (autoPushWritesEnabled) {
              await supabase.from("outbound_tasks").insert({
                connection_id: connectionId,
                task_type: "AGORA_HIDE_PRODUCT",
                payload_json: {
                  _winerim_wine_id: wine.winerim_id,
                  _product_ids: productIds,
                  _wine_name: wine.name,
                  _formats: hideFormats,
                  _trigger_source: "AUTO_PRICE_REMOVED",
                },
                status: "QUEUED",
              });
              for (const p of formatsToHide) {
                await supabase.from("winerim_push_tracking")
                  .update({ sync_status: "HIDDEN" })
                  .eq("connection_id", connectionId)
                  .eq("winerim_wine_id", wine.winerim_id)
                  .eq("format", p.format);
              }
            }
            hidQueued++;
            skippedReasons.push({
              winerim_id: wine.winerim_id,
              reason: !autoPushWritesEnabled
                ? `price_missing_would_hide:${hideFormats.join("+")}`
                : `price_missing_hide_queued:${hideFormats.join("+")}`,
            });
          } else {
            skippedReasons.push({ winerim_id: wine.winerim_id, reason: `price_missing_hide_already_pending:${hideFormats.join("+")}` });
          }
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
        const orderedDulceCode = saPedreraDulceCode(connection, wine);
        if (orderedDulceCode) {
          const singleFormat = preferredSingleFormatForDulce(wine);
          if (singleFormat === "GLASS" && !autoPushGlass) {
            skippedReasons.push({ winerim_id: wine.winerim_id, reason: "sa_pedrera_dulce_glass_skipped:auto_push_glass_disabled" });
          } else if (singleFormat === "BOTTLE" && !autoPushBottle) {
            skippedReasons.push({ winerim_id: wine.winerim_id, reason: "sa_pedrera_dulce_bottle_skipped:auto_push_bottle_disabled" });
          } else {
            const validation = validateWineForAgora(wine, singleFormat, connection);
            if (validation.valid) {
              formatTypes.push(singleFormat);
            } else {
              skippedReasons.push({
                winerim_id: wine.winerim_id,
                reason: `sa_pedrera_dulce_${singleFormat.toLowerCase()}_validation_failed:${validation.missingFields.join(",")}`,
              });
            }
          }
        } else {
          if (autoPushBottle) {
            const bottleValidation = validateWineForAgora(wine, "BOTTLE", connection);
            if (bottleValidation.valid) {
              formatTypes.push("BOTTLE");
            } else {
              skippedReasons.push({ winerim_id: wine.winerim_id, reason: `bottle_validation_failed:${bottleValidation.missingFields.join(",")}` });
            }
          }
          if (autoPushGlass) {
            // GLASS gate: must have glass_sale_price>0. The legacy serve_by_glass
            // flag is only advisory because Winerim can expose a valid copa price
            // without marking that older boolean.
            if (!wine.glass_sale_price || Number(wine.glass_sale_price) <= 0) {
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
        }
        if (formatTypes.length === 0) { skipped++; continue; }

        if (evtType === "CREATE") {
          const { data: verifiedPushes } = await supabase
            .from("winerim_push_tracking")
            .select("format, agora_product_id, sync_status")
            .eq("connection_id", connectionId)
            .eq("winerim_wine_id", wine.winerim_id)
            .in("format", formatTypes)
            .in("sync_status", ["VERIFIED", "PUSHED"]);
          const verifiedFormats = new Set((verifiedPushes || [])
            .filter((push: any) => Boolean(push.agora_product_id))
            .map((push: any) => String(push.format || "").toUpperCase()));

          if (formatTypes.every((fmt) => verifiedFormats.has(fmt))) {
            skipped++;
            skippedReasons.push({ winerim_id: wine.winerim_id, reason: "create_skipped:formats_already_verified" });
            continue;
          }
        }

        if (evtType === "UPDATE" && updateDiffEnabled && updateDiffCurrentXml && !forceEvaluate) {
          const normalizedUpdateWineName = normalizeAgoraTextAttribute(wine.name).toLocaleLowerCase("es");
          const updateHomonymousWines = updateDiffActiveWines.filter((candidate) =>
            normalizeAgoraTextAttribute(candidate.name).toLocaleLowerCase("es") === normalizedUpdateWineName
          );
          const expectedUpdateNameOverrides = buildQueuedProductNameOverrides(
            connection,
            wine,
            updateHomonymousWines,
            formatTypes,
            updateDiffExistingProducts,
          );
          const { xml: expectedUpdateXml } = generateImportXml(
            [wine],
            masterData,
            connection,
            formatTypes,
            updateDiffCustomMappings,
            false,
            updateDiffIsGeoMode ? updateDiffGeoConfig : undefined,
            updateDiffIsGeoMode ? [wine] : undefined,
            updateDiffScopedPriceListIds,
            expectedUpdateNameOverrides,
            updateDiffVinotecaRoutes,
          );
          const expectedProducts = extractXmlElementsWithAttrs(expectedUpdateXml, "Product");
          const updateDiffReasons: string[] = [];
          const allExpectedProductsMatch = expectedProducts.length > 0 && expectedProducts.every((expectedProduct) => {
            const productId = String(expectedProduct.attrs.Id || "");
            const actualProduct = productId
              ? findXmlElementByAttr(updateDiffCurrentXml!, "Product", "Id", productId)
              : null;
            if (!actualProduct) {
              updateDiffReasons.push(`PRODUCT_${productId || "UNKNOWN"}_MISSING`);
              return false;
            }
            const reasons = agoraProductDifferenceReasons(
              expectedProduct,
              actualProduct,
              updateDiffScopedPriceListIds,
            );
            for (const reason of reasons) updateDiffReasons.push(`PRODUCT_${productId}:${reason}`);
            return reasons.length === 0;
          });

          if (allExpectedProductsMatch) {
            skipped++;
            skippedReasons.push({ winerim_id: wine.winerim_id, reason: "update_skipped:no_agora_changes" });
            continue;
          }
          skippedReasons.push({
            winerim_id: wine.winerim_id,
            reason: `update_diff_detected:${updateDiffReasons.slice(0, 6).join(",")}`,
          });
        } else if (evtType === "UPDATE" && updateDiffEnabled && updateDiffError && !forceEvaluate) {

          skippedReasons.push({ winerim_id: wine.winerim_id, reason: `update_diff_unavailable:${updateDiffError}` });
        }

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

        if (!autoPushWritesEnabled) {
          wouldQueue++;
          skippedReasons.push({
            winerim_id: wine.winerim_id,
            reason: `${dryRun ? "dry_run_would_queue" : "would_queue"}:${formatTypes.join("+")}`,
          });
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

      console.log(`[evaluate-auto-push] connection=${connectionId} event=${evtType} forceEvaluate=${forceEvaluate} dryRun=${dryRun} queued=${queued} wouldQueue=${wouldQueue} skipped=${skipped} hidQueued=${hidQueued}`);

      return new Response(JSON.stringify({
        success: true, queued, wouldQueue, skipped, hidQueued, skippedReasons,
        totalWines: wines.length, eventType: evtType, forceEvaluate, dryRun,
        failClosedExcluded,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── READ-ONLY EXPECTED CATALOG AUDIT ──
    // Generates the exact XML Winerim would send, compares it with a forced
    // fresh Agora Products read and reports ownership. It performs no writes.
    if (action === "audit-winerim-products") {
      const requestedWineIds = normalizeStringArray(payload.winerimWineIds);
      const { data: masterData } = await supabase
        .from("agora_master_data")
        .select("*")
        .eq("connection_id", connectionId)
        .single();
      if (!masterData) {
        return new Response(JSON.stringify({ success: false, error: "NO_MASTER_DATA" }), {
          status: 409,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const wines: any[] = [];
      const auditWineBatchSize = 500;
      if (requestedWineIds.length > 0) {
        for (let offset = 0; offset < requestedWineIds.length; offset += auditWineBatchSize) {
          const requestedBatch = requestedWineIds.slice(offset, offset + auditWineBatchSize);
          const { data: wineBatch, error: winesError } = await supabase
            .from("winerim_wines")
            .select("*")
            .eq("connection_id", connectionId)
            .eq("is_active", true)
            .in("winerim_id", requestedBatch)
            .order("winerim_id", { ascending: true });
          if (winesError) throw winesError;
          wines.push(...(wineBatch || []));
        }
      } else {
        for (let offset = 0; ; offset += auditWineBatchSize) {
          const { data: wineBatch, error: winesError } = await supabase
            .from("winerim_wines")
            .select("*")
            .eq("connection_id", connectionId)
            .eq("is_active", true)
            .order("winerim_id", { ascending: true })
            .range(offset, offset + auditWineBatchSize - 1);
          if (winesError) throw winesError;
          wines.push(...(wineBatch || []));
          if (!wineBatch || wineBatch.length < auditWineBatchSize) break;
          }
      }

      // The regular Winerim catalog endpoint intentionally omits public-menu
      // inactive wines. Merge the connection-scoped GLASS exceptions after
      // the active query so the audit sees exactly what Agora should expose.
      const hiddenGlassConfig = configuredHiddenGlassVariants(connection)
        .filter((item) => requestedWineIds.length === 0 || requestedWineIds.includes(item.winerim_id));
      if (hiddenGlassConfig.length > 0) {
        const hiddenWineIds = hiddenGlassConfig.map((item) => item.winerim_id);
        const hiddenCachedById = new Map<string, any>();
        for (let offset = 0; offset < hiddenWineIds.length; offset += auditWineBatchSize) {
          const hiddenBatch = hiddenWineIds.slice(offset, offset + auditWineBatchSize);
          const { data: hiddenCached, error: hiddenCachedError } = await supabase
            .from("winerim_wines")
            .select("*")
            .eq("connection_id", connectionId)
            .in("winerim_id", hiddenBatch);
          if (hiddenCachedError) throw hiddenCachedError;
          for (const wine of hiddenCached || []) hiddenCachedById.set(String(wine.winerim_id), wine);
        }

        const auditWineById = new Map(wines.map((wine: any) => [String(wine.winerim_id), wine]));
        for (const hiddenGlass of hiddenGlassConfig) {
          const cachedWine = hiddenCachedById.get(hiddenGlass.winerim_id) || {
            winerim_id: hiddenGlass.winerim_id,
            name: hiddenGlass.name,
            wine_type: hiddenGlass.wine_type || null,
            is_active: false,
            raw_payload: {},
          };
          auditWineById.set(
            hiddenGlass.winerim_id,
            applyHiddenGlassVariantForAgora(connection, cachedWine),
          );
        }
        wines.splice(0, wines.length, ...auditWineById.values());
      }

      // Product names can be disambiguated by other products already present in
      // Agora. Build expected XML from the same fresh catalog that will be used
      // for comparison; a stale master-data summary can otherwise report a
      // deliberate suffix as a false mismatch.
      invalidateAgoraProductsCache(connectionId);
      const actualCatalog = await fetchAgoraProductsXmlCached(
        connectionId, baseUrlClean, apiTokenClean, fetchWithRetry, 30000, true,
      );
      if (!actualCatalog.ok) {
        return new Response(JSON.stringify({
          success: false,
          error: "AGORA_PRODUCTS_READ_FAILED",
          status: actualCatalog.status,
        }), { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      const actualCatalogProducts = extractXmlElementsWithAttrs(actualCatalog.xml, "Product");
      masterData.products_summary_json = actualCatalogProducts.map((product) => ({
        Id: String(product.attrs.Id || ""),
        Name: decodeXmlAttribute(product.attrs.Name || ""),
      })).filter((product) => product.Id && product.Name);

      const customMappings = await loadCustomFamilyMappings(connectionId);
      const selectedScope = (connection.provider_config as any)?.price_write_scope === "SELECTED_SALE_CENTERS";
      const scope = buildAgoraVerificationScope(masterData, {
        connectionSelectedSaleCenterIds: connection.selected_sale_center_ids || [],
        verificationMode: selectedScope ? "SELECTED_SALE_CENTERS" : "PRODUCTION_ALL_ACTIVE_SALE_CENTERS",
      });
      const geoConfig = (connection.provider_config as any)?.geographic_config as GeographicFamilyConfig | undefined;
      const isGeoMode = (connection.provider_config as any)?.family_structure_mode === "GEOGRAPHIC_FAMILIES" && geoConfig;
      const auditVinotecaRoutes = await loadVinotecaCatalogRoutes(supabase, connectionId);
      const auditVinotecaNative = isVinotecaNativeFormatsConnection(
        connectionId,
        (connection.provider_config || {}) as Record<string, unknown>,
      );
      const expectedOwnershipByProductId = new Map<string, { winerimWineId: string; format: string }[]>();
      const expectedAuditValidationKeys = new Set<string>();
      for (const wine of wines) {
        for (const format of ["BOTTLE", "GLASS", "MAGNUM"]) {
          const adoptedRoute = auditVinotecaRoutes?.get(String(wine.winerim_id));
          const productId = (adoptedRoute?.formatIds[format as VinotecaFormat])
            || (auditVinotecaNative ? vinotecaFormatId(format, wine.winerim_id) : null)
            || deterministicAgoraProductId(connection, wine, format);
          const owners = expectedOwnershipByProductId.get(productId) || [];
          owners.push({
              winerimWineId: String(wine.winerim_id),
              format,
          });
          expectedOwnershipByProductId.set(productId, owners);
        }
        const winerimWineId = String(wine.winerim_id || wine.id || "");
        const activeOrConfiguredBottle = wine.is_active !== false ||
          inactiveFormatAllowedByConnection(wine, "BOTTLE");
        const activeOrConfiguredGlass = wine.is_active !== false ||
          inactiveFormatAllowedByConnection(wine, "GLASS");
        if (activeOrConfiguredBottle && Number(extractBottleSalePrice(wine) || 0) > 0) {
          expectedAuditValidationKeys.add(`${winerimWineId}:BOTTLE`);
        }
        if (activeOrConfiguredGlass && Number(extractGlassSalePrice(wine) || 0) > 0) {
          expectedAuditValidationKeys.add(`${winerimWineId}:GLASS`);
        }
        if (wine.is_active !== false && Number(wine.magnum_sale_price || 0) > 0) {
          expectedAuditValidationKeys.add(`${winerimWineId}:MAGNUM`);
        }
      }
      const { xml: expectedXml, validationResults } = generateImportXml(
        wines,
        masterData,
        connection,
        ["BOTTLE", "GLASS", "MAGNUM"],
        customMappings,
        false,
        isGeoMode ? geoConfig : undefined,
        isGeoMode ? wines : undefined,
        scope.selectedPriceListIds,
        undefined,
        auditVinotecaRoutes,
      );
      const validationFailures = validationResults.filter((item) =>
        !item.validation.valid && (
          item.winerimId === "_CONNECTION_CONFIG" ||
          expectedAuditValidationKeys.has(`${item.winerimId}:${item.formatType}`)
        )
      );
      if (validationFailures.length > 0) {
        return new Response(JSON.stringify({
          success: false,
          readOnly: true,
          error: "EXPECTED_XML_VALIDATION_FAILED",
          validationFailures,
        }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const expectedProducts = extractXmlElementsWithAttrs(expectedXml, "Product");
      applyUniqueExpectedAgoraButtonTexts(connection, expectedProducts, actualCatalogProducts);
      const actualById = new Map(
        actualCatalogProducts.map((product) => [String(product.attrs.Id || ""), product]),
      );
      const expectedIds = expectedProducts.map((product) => String(product.attrs.Id || "")).filter(Boolean);
      const ownershipKeys = new Set<string>();
      for (let i = 0; i < expectedIds.length; i += 500) {
        const idChunk = expectedIds.slice(i, i + 500);
        const [{ data: trackingRows }, { data: mappingRows }] = await Promise.all([
          supabase.from("winerim_push_tracking")
            .select("agora_product_id,winerim_wine_id,format,source,sync_status")
            .eq("connection_id", connectionId)
            .eq("source", "WINERIM")
            .eq("sync_status", "VERIFIED")
            .in("agora_product_id", idChunk),
          supabase.from("product_mappings")
            .select("provider_product_id,winerim_wine_id,format_type,match_method,status")
            .eq("connection_id", connectionId)
            .eq("status", "CONFIRMED")
            .in("provider_product_id", idChunk),
        ]);
        for (const row of trackingRows || []) {
          ownershipKeys.add(`${row.agora_product_id}:${row.winerim_wine_id}:${String(row.format || "").toUpperCase()}`);
        }
        for (const row of mappingRows || []) {
          if (!String(row.match_method || "").startsWith("XML_IMPORT")) continue;
          ownershipKeys.add(`${row.provider_product_id}:${row.winerim_wine_id}:${String(row.format_type || "").toUpperCase()}`);
        }
      }

      const details = expectedProducts.map((expected) => {
        const productId = String(expected.attrs.Id || "");
        const actual = actualById.get(productId);
        const differences = actual
          ? agoraProductDifferenceReasons(expected, actual, scope.selectedPriceListIds)
          : ["PRODUCT_MISSING"];
        const expectedFormatOrder = inferAgoraFormatOrderFromName(decodeXmlAttribute(expected.attrs.Name || ""));
        const expectedFormat = expectedFormatOrder === 1 ? "GLASS" : expectedFormatOrder === 2 ? "MAGNUM" : "BOTTLE";
        const expectedOwner = (expectedOwnershipByProductId.get(productId) || [])
          .find((owner) => owner.format === expectedFormat) || expectedOwnershipByProductId.get(productId)?.[0];
        const ownedByWinerim = Boolean(expectedOwner && ownershipKeys.has(
          `${productId}:${expectedOwner.winerimWineId}:${expectedOwner.format}`,
        ));
        const status = !actual
          ? "MISSING"
          : differences.length === 0
          ? "MATCH"
          : "DIFFERENT";
        return {
          productId,
          status,
          ownedByWinerim,
          expectedWinerimWineId: expectedOwner?.winerimWineId || null,
          expectedFormat: expectedOwner?.format || null,
          expectedName: decodeXmlAttribute(expected.attrs.Name || ""),
          actualName: actual ? decodeXmlAttribute(actual.attrs.Name || "") : null,
          expectedFamilyId: expected.attrs.FamilyId || null,
          actualFamilyId: actual?.attrs.FamilyId || null,
          differences,
        };
      });

      return new Response(JSON.stringify({
        success: true,
        readOnly: true,
        expected: details.length,
        matched: details.filter((item) => item.status === "MATCH").length,
        missing: details.filter((item) => item.status === "MISSING").length,
        different: details.filter((item) => item.status === "DIFFERENT").length,
        unownedExisting: details.filter((item) => item.status !== "MISSING" && !item.ownedByWinerim).length,
        selectedPriceLists: scope.selectedPriceLists,
        validationFailures: [],
        details,
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
