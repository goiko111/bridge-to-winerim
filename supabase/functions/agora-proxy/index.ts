import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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

  // ProductName prefix takes priority (Agora convention: "BOT. …", "COPA …", "MAG. …")
  if (pn.startsWith("BOT.") || pn.startsWith("BOT ")) return "BOT";
  if (pn.startsWith("COPA ") || pn.startsWith("COPA.")) return "COPA";
  if (pn.startsWith("MAG.") || pn.startsWith("MAG ") || pn.startsWith("MAGNUM")) return "MAGNUM";

  // Fallback to SaleFormatName
  if (sf.includes("COPA") || sf.includes("GLASS") || sf.includes("VERRE")) return "COPA";
  if (sf.includes("MAG") || sf.includes("MAGNUM")) return "MAGNUM";
  if (sf.includes("BOT") || sf.includes("BOTTLE") || sf.includes("75CL") || sf.includes("BOTELLA")) return "BOT";

  // If SaleFormatName is non-empty, keep as-is normalized
  if (saleFormatName.trim()) return saleFormatName.trim();
  return "";
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

// ── XML IMPORT GENERATOR (HARDENED) ──
// deno-lint-ignore no-explicit-any
function generateImportXml(wines: any[], masterData: any, connection: any, formatTypes: string[], customFamilyMappings?: Record<string, { id: string; name: string }>, forceEmptyPreparation = false): { xml: string; validationResults: { winerimId: string; formatType: string; validation: WineValidationResult }[] } {
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

  function findFamilyId(wineType: string | null, formatType?: string): { id: string; needsCreate: boolean; familyName: string } {
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
  const productXmls: string[] = [];

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

      const familyResult = findFamilyId(wineType, fmt);
      if (familyResult.needsCreate && !newFamilies.some(f => f.id === familyResult.id)) {
        newFamilies.push({ id: familyResult.id, name: familyResult.familyName });
      }

      const productName = isMagnum ? `MAG. ${wineName}` : isGlass ? `COPA ${wineName}` : `BOT. ${wineName}`;
      const buttonText = truncate(productName, 20);

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

      productXmls.push(`    <Product Id="${productId}" Name="${escapeXml(productName)}" ButtonText="${escapeXml(buttonText)}" Color="#8B0000" PLU="" FamilyId="${familyResult.id}" VatId="${defaultVatId}" UseAsDirectSale="true" SaleableAsMain="true" SaleableAsAddin="false" IsSoldByWeight="false" AskForPreparationNotes="false" AskForAddins="false" PrintWhenPriceIsZero="false" PreparationTypeId="${defaultPrepTypeId}" PreparationOrderId="${defaultPrepOrderId}" CostPrice="${costPrice}">
      <Prices>
${pricesXml}
      </Prices>
      <CostPrices>
${costPricesXml}
      </CostPrices>
    </Product>`);
    }
  }

  let xml = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n<Import>\n`;

  if (newFamilies.length > 0) {
    xml += `  <Families>\n`;
    for (const f of newFamilies) {
      xml += `    <Family Id="${f.id}" Name="${escapeXml(f.name)}" ShowInPos="true" ButtonText="${escapeXml(truncate(f.name, 15))}" Color="#8B0000" Order="100" />\n`;
    }
    xml += `  </Families>\n`;
  }

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
    let baseUrlClean = base_url.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(baseUrlClean)) {
      baseUrlClean = `http://${baseUrlClean}`;
    }
    const apiTokenClean = api_token.trim();
    const headers: Record<string, string> = { "Api-Token": apiTokenClean, Accept: "*/*" };

    async function fetchWithRetry(url: string, opts: RequestInit = {}, timeoutMs = 15000): Promise<Response> {
      const controller1 = new AbortController();
      const t1 = setTimeout(() => controller1.abort(), timeoutMs);
      try {
        const r = await fetch(url, { ...opts, signal: controller1.signal });
        clearTimeout(t1);
        return r;
      } catch (_e1) {
        clearTimeout(t1);
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

      await supabase.from("pos_connections")
        .update({ last_business_day_synced: day, last_sync_at: new Date().toISOString() })
        .eq("id", connectionId);

      return new Response(
        JSON.stringify({ success: true, savedEvents, savedLines, resolvedLines, unresolvedLines, businessDay: day }),
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
      const pendingDays: string[] = [];
      const current = new Date(startDate);
      while (current <= yesterday && pendingDays.length < 30) {
        const dayStr = current.toISOString().split("T")[0];
        const url = `${baseUrlClean}/api/export/?business-day=${dayStr}&filter=Invoices`;
        try {
          const res = await fetch(url, { headers });
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

      if (pendingDays.length === 0) {
        return new Response(
          JSON.stringify({ success: true, daysSynced: 0, message: "No pending days to sync" }),
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
      let lastDay = "";

      for (const day of pendingDays) {
        const url = `${baseUrlClean}/api/export/?business-day=${day}&filter=Invoices`;
        const res = await fetch(url, { headers });
        if (!res.ok) { await res.text(); continue; }
        const rawData = await res.json();
        const invoices = parseInvoices(rawData);

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
          totalEvents++;

          await supabase.from("sales_line_items").delete().eq("sales_event_id", eventRow.id);
          const linesToInsert = lineData.map((l) => ({ ...l, sales_event_id: eventRow.id, connection_id: connectionId }));
          if (linesToInsert.length > 0) {
            const { error: lineErr } = await supabase.from("sales_line_items").insert(linesToInsert);
            if (!lineErr) totalLines += linesToInsert.length;
          }
        }
        lastDay = day;
      }

      if (lastDay) {
        await supabase.from("pos_connections")
          .update({ last_business_day_synced: lastDay, last_sync_at: new Date().toISOString() })
          .eq("id", connectionId);
      }

      return new Response(
        JSON.stringify({ success: true, daysSynced: pendingDays.length, totalEvents, totalLines, resolvedLines, unresolvedLines }),
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

    // ── SYNC STOCK TO WINERIM ──
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

      const { data: events } = await supabase
        .from("sales_events").select("id")
        .eq("connection_id", connectionId).eq("business_day", day);

      if (!events || events.length === 0) {
        return new Response(JSON.stringify({ success: true, message: "No sales events for this day", synced: 0, skipped: 0, failed: 0 }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const eventIds = events.map((e: { id: string }) => e.id);
      const { data: lines } = await supabase
        .from("sales_line_items")
        .select("id, sales_event_id, name, quantity, winerim_product_id, provider_product_id, is_wine_candidate")
        .in("sales_event_id", eventIds);

      if (!lines || lines.length === 0) {
        return new Response(JSON.stringify({ success: true, message: "No line items found", synced: 0, skipped: 0, failed: 0 }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const mappedLines = lines.filter((l: any) => l.winerim_product_id && l.is_wine_candidate);
      let synced = 0, skipped = 0, failed = 0;

      const winerimHeaders = {
        "Authorization": `Bearer ${winerimToken}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
      };

      for (const line of mappedLines) {
        const { data: existing } = await supabase
          .from("stock_sync_log").select("id")
          .eq("sales_line_item_id", (line as any).id).eq("status", "SUCCESS").limit(1);

        if (existing && existing.length > 0) { skipped++; continue; }

        const { data: logEntry } = await supabase
          .from("stock_sync_log")
          .insert({
            connection_id: connectionId, sales_event_id: (line as any).sales_event_id,
            sales_line_item_id: (line as any).id, provider_product_id: (line as any).provider_product_id,
            winerim_product_id: (line as any).winerim_product_id, product_name: (line as any).name,
            quantity: Math.abs(Number((line as any).quantity)), status: "PENDING",
          }).select("id").single();

        try {
          const res = await fetch("https://api.winerim.com/api/v2/stock", {
            method: "PUT", headers: winerimHeaders,
            body: JSON.stringify({ product_id: (line as any).winerim_product_id, quantity_change: -Math.abs(Number((line as any).quantity)) }),
          });
          const responseBody = await res.text();
          let parsed; try { parsed = JSON.parse(responseBody); } catch (_) { parsed = { raw: responseBody }; }

          if (res.ok) {
            await supabase.from("stock_sync_log").update({ status: "SUCCESS", winerim_response: parsed, synced_at: new Date().toISOString() }).eq("id", logEntry?.id);
            synced++;
          } else {
            await supabase.from("stock_sync_log").update({ status: "FAILED", error_message: responseBody.substring(0, 500), winerim_response: parsed }).eq("id", logEntry?.id);
            failed++;
          }
        } catch (e) {
          await supabase.from("stock_sync_log").update({ status: "FAILED", error_message: String(e) }).eq("id", logEntry?.id);
          failed++;
        }
      }

      return new Response(
        JSON.stringify({ success: true, synced, skipped, failed, unmapped: lines.length - mappedLines.length, totalLines: lines.length, mappedLines: mappedLines.length }),
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

      await supabase.from("outbound_tasks").update({ status: "RUNNING", attempts: task.attempts + 1 }).eq("id", task.id);
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
          const shouldRetry = task.attempts + 1 < (task.max_attempts || 3);
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

        return new Response(JSON.stringify({ success: true, status: "SUCCESS", externalId, responsePreview: resPreview }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      } catch (e) {
        const shouldRetry = task.attempts + 1 < (task.max_attempts || 3);
        await supabase.from("outbound_tasks").update({
          status: shouldRetry ? "QUEUED" : "FAILED", last_error: String(e).substring(0, 500),
        }).eq("id", task.id);
        return new Response(JSON.stringify({ success: false, status: shouldRetry ? "QUEUED" : "FAILED" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });
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
        const { data: tasks } = await supabase
          .from("outbound_tasks").select("id, task_type, payload_json, external_id, attempts")
          .eq("connection_id", connectionId).in("task_type", ["AGORA_UPSERT_PRODUCT", "AGORA_MIGRATE_FAMILY"])
          .eq("status", "QUEUED").order("created_at").limit(BATCH_SIZE);

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
              const productName = fmt === "MAGNUM" ? `MAG. ${wineName}` : fmt === "GLASS" ? `COPA ${wineName}` : `BOT. ${wineName}`;

              const escXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
              const migrateXml = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n<Import>\n  <Products>\n    <Product Id="${productId}" Name="${escXml(productName)}" FamilyId="${targetFamilyId}" />\n  </Products>\n</Import>`;

              await supabase.from("outbound_tasks").update({ status: "RUNNING", attempts: ((t as any).attempts || 0) + 1 }).eq("id", t.id);

              const importUrl = `${baseUrlClean}/api/import/`;
              const res = await fetchWithRetry(importUrl, {
                method: "POST",
                headers: { ...headers, "Content-Type": "application/xml" },
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
                body: { action: "process-outbound-task", connectionId, taskId: t.id },
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

      // ── Fetch 2: Products separately (can be large) ──
      const productsUrl = `${baseUrlClean}/api/export-master/?filter=Products`;
      let productsXml = "";
      try {
        const prodRes = await fetchWithRetry(productsUrl, { headers: xmlHeaders }, 30000);
        if (prodRes.ok) {
          productsXml = await prodRes.text();
          if (!productsXml.trimEnd().endsWith(">")) {
            truncationWarnings.push(`Products XML appears truncated (${productsXml.length} bytes)`);
          }
        } else {
          console.warn(`[sync-master-data] Products fetch returned ${prodRes.status}`);
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
      const formatTypes = payload.formatTypes || ["BOTTLE"];

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

      const { xml, validationResults } = generateImportXml(wines, masterData, connection, formatTypes, customFamilyMappings);

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

      const { xml, validationResults } = generateImportXml(wines, masterData, connection, formatTypes, customFamilyMappings);

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
          const productName = fmt === "MAGNUM" ? `MAG. ${wine.name}` : fmt === "GLASS" ? `COPA ${wine.name}` : `BOT. ${wine.name}`;

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
          const verifyUrl = `${baseUrlClean}/api/export-master/?filter=Products`;
          const verifyRes = await fetchWithRetry(verifyUrl, { headers: { "Api-Token": apiTokenClean, Accept: "application/xml" } }, 30000);

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

          if (verifyRes.ok) {
            const verifyXml = await verifyRes.text();

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
                  productName: fmt === "MAGNUM" ? `MAG. ${wine.name}` : fmt === "GLASS" ? `COPA ${wine.name}` : `BOT. ${wine.name}`,
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

      await supabase.from("outbound_tasks").update({ status: "RUNNING", attempts: task.attempts + 1 }).eq("id", task.id);

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
        const { xml, validationResults } = generateImportXml(wineArr, masterData, connection, fmtTypes, customFamilyMappings, forceEmptyPreparation);

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
          const shouldRetry = task.attempts + 1 < (task.max_attempts || 3) && importRes.status >= 500;
          const errorMsg = parsedResponse.errors.length > 0 
            ? parsedResponse.errors.join("; ").substring(0, 500)
            : `HTTP ${importRes.status}: ${parsedResponse.rawPreview.substring(0, 300)}`;
          
          // If it's a data error (4xx), don't retry - BLOCK
          const isDataError = importRes.status >= 400 && importRes.status < 500;
          await supabase.from("outbound_tasks").update({
            status: isDataError ? "BLOCKED" : (shouldRetry ? "QUEUED" : "FAILED"),
            last_error: errorMsg,
            blocked_reason: isDataError ? `Data error: ${errorMsg}` : null,
          }).eq("id", task.id);

          if (importRes.status === 404 || importRes.status === 405) {
            await supabase.from("provider_capabilities").update({ can_write_products: "NO" }).eq("connection_id", task.connection_id);
          }

          return new Response(JSON.stringify({ success: false, status: isDataError ? "BLOCKED" : (shouldRetry ? "QUEUED" : "FAILED"), parsedResponse }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } });
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
          const verifyUrl = `${baseUrlClean}/api/export-master/?filter=Products`;
          const verifyRes = await fetchWithRetry(verifyUrl, { headers: { "Api-Token": apiTokenClean, Accept: "application/xml" } }, 30000);

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
          const productName = fmt === "MAGNUM" ? `MAG. ${wineArr[0].name}` : fmt === "GLASS" ? `COPA ${wineArr[0].name}` : `BOT. ${wineArr[0].name}`;

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
          await upsertPushTracking(supabase, task.connection_id, winerimWineId, fmt, {
            sync_status: pushStatus,
            task_id: task.id,
            pushed_at: new Date().toISOString(),
            verified_at: taskVerification.success ? new Date().toISOString() : null,
            last_error: null,
          });
        }

        return new Response(JSON.stringify({ success: true, status: "SUCCESS", parsedResponse, verification: taskVerification }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });

      } catch (e) {
        const shouldRetry = task.attempts + 1 < (task.max_attempts || 3);
        await supabase.from("outbound_tasks").update({
          status: shouldRetry ? "QUEUED" : "FAILED",
          last_error: String(e).substring(0, 500),
        }).eq("id", task.id);
        return new Response(JSON.stringify({ success: false, status: shouldRetry ? "QUEUED" : "FAILED" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });
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

      let queuedCreate = 0, queuedUpdate = 0, skippedDuplicate = 0;
      for (const wineId of winerimWineIds) {
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
        const existsInAgora = formatTypes.some((fmt: string) => existingProductIds.has(formatProductIds[fmt] || ""));
        const operationType = existsInAgora ? "UPDATE" : "CREATE";

        await supabase.from("outbound_tasks").insert({
          connection_id: connectionId,
          task_type: "AGORA_XML_UPSERT_PRODUCT",
          payload_json: {
            _winerim_wine_id: wineId,
            _format_types: formatTypes,
            _write_mode: "XML_IMPORT",
            _trigger_source: "MANUAL",
            _operation: operationType,
            ...scopePayload,
            ...(familyOverrideId ? { _family_override_id: familyOverrideId } : {}),
          },
          status: "QUEUED",
        });
        if (operationType === "CREATE") queuedCreate++; else queuedUpdate++;

        // ── PUSH TRACKING: Mark QUEUED per format ──
        for (const fmt of formatTypes) {
          await upsertPushTracking(supabase, connectionId, wineId, fmt, {
            sync_status: "QUEUED",
          });
        }
      }

      return new Response(JSON.stringify({
        success: true,
        queued: queuedCreate + queuedUpdate,
        queuedCreate,
        queuedUpdate,
        skippedDuplicate,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── PROCESS XML OUTBOUND QUEUE (time-budgeted, auto-retry from UI) ──
    if (action === "process-xml-outbound-queue") {
      const BATCH_SIZE = 10;
      const TIME_BUDGET_MS = 20_000; // keep responses comfortably below browser/network timeouts
      const startTime = Date.now();
      let processed = 0, succeeded = 0, failed = 0;

      while (Date.now() - startTime < TIME_BUDGET_MS) {
        const { data: tasks } = await supabase
          .from("outbound_tasks").select("id")
          .eq("connection_id", connectionId)
          .eq("task_type", "AGORA_XML_UPSERT_PRODUCT")
          .eq("status", "QUEUED")
          .order("created_at").limit(BATCH_SIZE);

        if (!tasks || tasks.length === 0) break;

        for (const t of tasks) {
          if (Date.now() - startTime >= TIME_BUDGET_MS) break;
          try {
            const { data: result } = await supabase.functions.invoke("agora-proxy", {
              body: { action: "process-xml-outbound-task", connectionId, taskId: t.id },
            });
            processed++;
            if (result?.status === "SUCCESS") succeeded++; else failed++;
          } catch (err) { failed++; processed++; }
        }
      }

      // Check if there are remaining tasks
      const { count: remaining } = await supabase
        .from("outbound_tasks").select("id", { count: "exact", head: true })
        .eq("connection_id", connectionId)
        .eq("task_type", "AGORA_XML_UPSERT_PRODUCT")
        .eq("status", "QUEUED");

      return new Response(JSON.stringify({ success: true, processed, succeeded, failed, remaining: remaining || 0, done: (remaining || 0) === 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── BACKFILL PRICES (re-push UPDATE for products missing PriceList entries) ──
    if (action === "backfill-prices") {
      const winerimWineIds = payload.winerimWineIds || [];
      const formatTypes = payload.formatTypes || ["BOTTLE", "GLASS"];

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
      const verifyUrl = `${baseUrlClean}/api/export-master/?filter=Products`;
      const verifyRes = await fetchWithRetry(verifyUrl, { headers: { "Api-Token": apiTokenClean, Accept: "application/xml" } }, 30000);
      
      if (!verifyRes.ok) {
        return new Response(JSON.stringify({ success: false, error: `Agora responded ${verifyRes.status}` }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const verifyXml = await verifyRes.text();
      
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
        const verifyUrl = `${baseUrlClean}/api/export-master/?filter=Products`;
        const verifyRes = await fetchWithRetry(verifyUrl, { headers: { "Api-Token": apiTokenClean, Accept: "application/xml" } }, 20000);
        if (verifyRes.ok) {
          const verifyXml = await verifyRes.text();
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
            const { xml } = generateImportXml(sampleWines, masterData, connection, ["BOTTLE", "GLASS"], customMappings);
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

      // FIX PRIORITY 7: Must have can_write_products=YES AND auto_push_verified_ready=true
      const { data: caps } = await supabase
        .from("provider_capabilities").select("can_write_products").eq("connection_id", connectionId).single();
      if (!caps || caps.can_write_products !== "YES") {
        return new Response(JSON.stringify({ success: true, skipped: true, reason: "can_write_products is not YES" }),
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
        .from("winerim_wines").select("winerim_id, name, price, format, winery, grape_variety, region, vintage, raw_payload, wine_type, bottle_sale_price, bottle_purchase_price, glass_sale_price, glass_cost_price, serve_by_glass, is_active")
        .eq("connection_id", connectionId).in("winerim_id", winerimWineIds);

      if (!wines || wines.length === 0) {
        return new Response(JSON.stringify({ success: true, skipped: true, reason: "no wines found" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      let queued = 0;
      let skipped = 0;
      const skippedReasons: { winerim_id: string; reason: string }[] = [];

      for (const wine of wines) {
        // Block inactive wines from auto-push
        if (wine.is_active === false) {
          skipped++;
          skippedReasons.push({ winerim_id: wine.winerim_id, reason: "wine_inactive" });
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
        if (formatTypes.length === 0) { skipped++; continue; }

        // Debounce
        const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
        const { data: recentTask } = await supabase
          .from("outbound_tasks").select("id")
          .eq("connection_id", connectionId)
          .eq("task_type", "AGORA_XML_UPSERT_PRODUCT")
          .contains("payload_json", { _winerim_wine_id: wine.winerim_id })
          .in("status", ["QUEUED", "RUNNING"])
          .gte("created_at", fiveMinAgo).limit(1);

        if (recentTask && recentTask.length > 0) {
          skipped++;
          skippedReasons.push({ winerim_id: wine.winerim_id, reason: "debounce_recent_task" });
          continue;
        }

        // Anti-spam
        const { data: recentFailures } = await supabase
          .from("outbound_tasks").select("id, status")
          .eq("connection_id", connectionId)
          .eq("task_type", "AGORA_XML_UPSERT_PRODUCT")
          .contains("payload_json", { _winerim_wine_id: wine.winerim_id })
          .order("created_at", { ascending: false }).limit(3);

        if (recentFailures && recentFailures.length >= 3 && recentFailures.every((t: any) => t.status === "FAILED" || t.status === "BLOCKED")) {
          skipped++;
          skippedReasons.push({ winerim_id: wine.winerim_id, reason: "too_many_failures_manual_intervention_required" });
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

      console.log(`[evaluate-auto-push] connection=${connectionId} event=${evtType} queued=${queued} skipped=${skipped}`);

      return new Response(JSON.stringify({
        success: true, queued, skipped, skippedReasons,
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
        const verifyUrl = `${baseUrlClean}/api/export-master/?filter=Products`;
        const verifyRes = await fetchWithRetry(verifyUrl, { headers: { "Api-Token": apiTokenClean, Accept: "application/xml" } }, 30000);
        if (verifyRes.ok) {
          readBackRaw = await verifyRes.text();
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

    // ── AUTO SYNC SALES (scheduled or manual) ──
    if (action === "auto-sync-sales") {
      // Find days to sync: from last_business_day_synced to yesterday
      const lastSynced = conn.last_business_day_synced;
      const today = new Date();
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      const endDay = yesterday.toISOString().slice(0, 10);

      // Determine start day
      let startDate: Date;
      if (lastSynced) {
        startDate = new Date(lastSynced);
        startDate.setDate(startDate.getDate() + 1); // day after last synced
      } else {
        // Default: backfill_days from connection config
        startDate = new Date(today);
        startDate.setDate(startDate.getDate() - (conn.backfill_days || 30));
      }

      const startDay = startDate.toISOString().slice(0, 10);
      if (startDay > endDay) {
        return new Response(JSON.stringify({ 
          success: true, message: "Already up to date", lastSynced, startDay, endDay, daysSynced: 0, totalEvents: 0, totalLines: 0, resolvedLines: 0, unresolvedLines: 0
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // Gather days to process
      const daysToSync: string[] = [];
      const cursor = new Date(startDate);
      while (cursor.toISOString().slice(0, 10) <= endDay) {
        daysToSync.push(cursor.toISOString().slice(0, 10));
        cursor.setDate(cursor.getDate() + 1);
      }

      // Cap at 30 days per run to avoid timeouts
      const batch = daysToSync.slice(0, 30);

      // Build resolution lookup once
      const { data: familyRules } = await supabase
        .from("wine_family_rules")
        .select("family_name, is_wine")
        .eq("connection_id", connectionId);
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
      let lastDaySynced = lastSynced || "";

      for (const day of batch) {
        try {
          const url = `${baseUrlClean}/api/export/?business-day=${day}&filter=Invoices`;
          const res = await fetch(url, { headers });
          if (!res.ok) { console.log(`[auto-sync] ${day}: Agora ${res.status}`); continue; }

          const rawData = await res.json();
          const invoices = parseInvoices(rawData);
          if (invoices.length === 0) { lastDaySynced = day; continue; }

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
            totalEvents++;

            await supabase.from("sales_line_items").delete().eq("sales_event_id", eventRow.id);
            const linesToInsert = lineData.map((l) => ({ ...l, sales_event_id: eventRow.id, connection_id: connectionId }));
            if (linesToInsert.length > 0) {
              const { error: lineErr } = await supabase.from("sales_line_items").insert(linesToInsert);
              if (!lineErr) totalLines += linesToInsert.length;
            }
          }

          lastDaySynced = day;
        } catch (dayErr) {
          console.error(`[auto-sync] ${day} error:`, dayErr);
        }
      }

      // Update connection
      if (lastDaySynced) {
        await supabase.from("pos_connections")
          .update({ last_business_day_synced: lastDaySynced, last_sync_at: new Date().toISOString() })
          .eq("id", connectionId);
      }

      console.log(`[auto-sync] ${connectionId}: ${batch.length} days, ${totalEvents} events, ${totalLines} lines, ${resolvedLines} resolved, ${unresolvedLines} unresolved`);

      return new Response(JSON.stringify({
        success: true, daysSynced: batch.length, totalDaysPending: daysToSync.length,
        totalEvents, totalLines, resolvedLines, unresolvedLines,
        startDay: batch[0], endDay: batch[batch.length - 1], lastSynced: lastDaySynced,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    return new Response(
      JSON.stringify({ error: "Unknown action" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("agora-proxy error:", err);
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
