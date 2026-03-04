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

// ── WINE VALIDATION ──
interface WineValidationResult {
  valid: boolean;
  warnings: string[];
  missingFields: string[];
}

// deno-lint-ignore no-explicit-any
function validateWineForAgora(wine: any, formatType: string, connection?: any): WineValidationResult {
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
    // PRIORITY 4: Glass eligibility requires serve_by_glass + glass_sale_price
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
      // Cost was estimated from bottle price
      const glassesPerBottle = connection?.estimated_glasses_per_bottle || 5;
      warnings.push(`glass_cost_estimated_from_bottle_price_divided_by_${glassesPerBottle}`);
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
function generateImportXml(wines: any[], masterData: any, connection: any, formatTypes: string[]): { xml: string; validationResults: { winerimId: string; formatType: string; validation: WineValidationResult }[] } {
  const families = (masterData.families_json || []) as { Id: string; Name: string }[];
  const vats = (masterData.vats_json || []) as { Id: string; Name: string; VatRate: string }[];
  const priceLists = (masterData.price_lists_json || []) as { Id: string; Name: string }[];
  const prepTypes = (masterData.preparation_types_json || []) as { Id: string; Name: string }[];
  const prepOrders = (masterData.preparation_orders_json || []) as { Id: string; Name: string }[];
  const warehouses = (masterData.warehouses_json || []) as { Id: string; Name: string }[];
  const existingProducts = (masterData.products_summary_json || []) as { Id: string; Name: string }[];

  const defaultVatId = connection.default_vat_id || findVatIdByRate(vats, connection.default_vat_rate) || (vats.length > 0 ? vats[0].Id : "3");
  const defaultPrepTypeId = connection.default_preparation_type_id || (prepTypes.length > 0 ? prepTypes[0].Id : "1");
  const defaultPrepOrderId = connection.default_preparation_order_id || (prepOrders.length > 0 ? prepOrders[0].Id : "1");
  const defaultWarehouseId = connection.default_warehouse_id || (warehouses.length > 0 ? warehouses[0].Id : "1");
  const autoCreateFamilies = connection.auto_create_families ?? false;

  function findFamilyId(wineType: string | null): { id: string; needsCreate: boolean; familyName: string } {
    // First try connection default
    if (connection.default_family_id) {
      const found = families.find(f => f.Id === connection.default_family_id);
      if (found) return { id: found.Id, needsCreate: false, familyName: found.Name };
    }

    // Try matching wine type (only from real type field, not grape/region)
    if (wineType) {
      const typeKey = wineType.toLowerCase();
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
  const validationResults: { winerimId: string; formatType: string; validation: WineValidationResult }[] = [];

  for (const wine of wines) {
    const winerimId = Number(wine.winerim_id || wine.id || 0);
    const wineName = wine.name || "Unknown Wine";
    const wineType = extractWineType(wine);

    for (const fmt of formatTypes) {
      // Validate before generating (pass connection for glass cost fallback)
      const validation = validateWineForAgora(wine, fmt, connection);
      validationResults.push({ winerimId: String(winerimId), formatType: fmt, validation });

      // Skip formats with missing required fields
      if (!validation.valid) continue;

      const isGlass = fmt === "GLASS";
      const productId = isGlass ? 700000 + winerimId : 500000 + winerimId;

      const familyResult = findFamilyId(wineType);
      if (familyResult.needsCreate && !newFamilies.some(f => f.id === familyResult.id)) {
        newFamilies.push({ id: familyResult.id, name: familyResult.familyName });
      }

      const productName = isGlass ? `COPA ${wineName}` : `BOT. ${wineName}`;
      const buttonText = truncate(isGlass ? `COPA ${wineName}` : `BOT. ${wineName}`, 20);

      // Use REAL prices from normalized fields, never invent
      let mainPrice: string;
      let costPrice: string;

      if (isGlass) {
        mainPrice = (extractGlassSalePrice(wine) || 0).toFixed(2);
        costPrice = (extractGlassCostPrice(wine, connection) || 0).toFixed(2);
      } else {
        mainPrice = (extractBottleSalePrice(wine) || 0).toFixed(2);
        costPrice = (extractBottleCostPrice(wine) || 0).toFixed(2);
      }

      const pricesXml = priceLists.map(pl =>
        `        <Price PriceListId="${pl.Id}" MainPrice="${mainPrice}" AddinPrice="" MenuItemPrice="0.00" />`
      ).join("\n");

      const costPricesXml = warehouses.map(wh =>
        `        <CostPrice WarehouseId="${wh.Id}" CostPrice="${costPrice}" />`
      ).join("\n");

      // PRIORITY 6: Do NOT set BaseSaleFormatId — create standalone products
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

      return new Response(
        JSON.stringify({ daysWithSales, totalScanned, totalInvoicesFound }),
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
            const wineResult = isWineCandidate(family, productName, formatName, uPrice, wineFamilies, DEFAULT_NON_WINE_FAMILIES);
            lines.push({
              provider_product_id: String(line.ProductId || ""),
              name: productName, format: formatName, family,
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

    // ── SAVE SALES TO DB ──
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
            const wr = isWineCandidate(fam, pName, fName, uP, wineFamilies, DEFAULT_NON_WINE_FAMILIES);
            lineData.push({
              provider_product_id: String(line.ProductId || ""),
              name: pName, format: fName, family: fam,
              quantity: qty, unit_price: uP, total_amount: lineTotal,
              vat_rate: Number(line.VatRate || 0), is_wine_candidate: wr.candidate,
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
        JSON.stringify({ success: true, savedEvents, savedLines, businessDay: day }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
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
      const config = await loadConfig(supabase, connectionId);
      const url = `${baseUrlClean}/api/export/?filter=${endpoint}`;
      const res = await fetch(url, { headers });
      if (!res.ok) {
        return new Response(JSON.stringify({ error: `Agora responded ${res.status}` }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } });
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
          let parsed; try { parsed = JSON.parse(responseBody); } catch { parsed = { raw: responseBody }; }

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

    // ── PROCESS OUTBOUND QUEUE (legacy JSON) ──
    if (action === "process-outbound-queue") {
      const { data: tasks } = await supabase
        .from("outbound_tasks").select("id")
        .eq("connection_id", connectionId).in("task_type", ["AGORA_UPSERT_PRODUCT"])
        .eq("status", "QUEUED").order("created_at").limit(10);

      if (!tasks || tasks.length === 0) {
        return new Response(JSON.stringify({ success: true, processed: 0 }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      let processed = 0, succeeded = 0, failed = 0;
      for (const t of tasks) {
        try {
          const { data: result } = await supabase.functions.invoke("agora-proxy", {
            body: { action: "process-outbound-task", connectionId, taskId: t.id },
          });
          processed++;
          if (result?.status === "SUCCESS") succeeded++; else failed++;
        } catch (_) { failed++; processed++; }
      }

      return new Response(JSON.stringify({ success: true, processed, succeeded, failed }),
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
      const url = `${baseUrlClean}/api/export-master/?filter=Families,Vats,PriceLists,PreparationTypes,PreparationOrders,Products,Warehouses`;
      const xmlHeaders = { "Api-Token": apiTokenClean, Accept: "application/xml" };
      
      let res: Response;
      try {
        res = await fetchWithRetry(url, { headers: xmlHeaders }, 30000);
      } catch (e) {
        return new Response(
          JSON.stringify({ success: false, error: `Failed to reach Agora: ${e}` }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return new Response(
          JSON.stringify({ success: false, error: `Agora responded ${res.status}`, body: body.substring(0, 2048) }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const rawXml = await res.text();
      
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

      const families = extractElements(rawXml, "Family");
      const vats = extractElements(rawXml, "Vat");
      const priceLists = extractElements(rawXml, "PriceList");
      const prepTypes = extractElements(rawXml, "PreparationType");
      const prepOrders = extractElements(rawXml, "PreparationOrder");
      const warehouses = extractElements(rawXml, "Warehouse").filter(w => w.Name);
      const products = extractElements(rawXml, "Product");

      const productsSummary = products.map(p => ({
        Id: p.Id, Name: p.Name, FamilyId: p.FamilyId, VatId: p.VatId,
      }));

      await supabase.from("agora_master_data").upsert({
        connection_id: connectionId,
        families_json: families, vats_json: vats, price_lists_json: priceLists,
        preparation_types_json: prepTypes, preparation_orders_json: prepOrders,
        warehouses_json: warehouses, products_summary_json: productsSummary,
        raw_xml_preview: rawXml.substring(0, 5000),
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
          masterData: { families, vats, priceLists, preparationTypes: prepTypes, preparationOrders: prepOrders, warehouses },
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── PREVIEW XML (dry-run, no send) ──
    if (action === "preview-xml") {
      const winerimWineIds = payload.winerimWineIds || [];
      const formatTypes = payload.formatTypes || ["BOTTLE"];
      
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

      const { xml, validationResults } = generateImportXml(wines, masterData, connection, formatTypes);

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

      return new Response(
        JSON.stringify({ success: true, xml, wineCount: wines.length, validationResults, sourceDataSummary }),
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

      const { data: wines } = await supabase
        .from("winerim_wines").select("*").eq("connection_id", connectionId).in("winerim_id", winerimWineIds);

      if (!wines || wines.length === 0) {
        return new Response(JSON.stringify({ success: false, error: "No wines found" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const { xml, validationResults } = generateImportXml(wines, masterData, connection, formatTypes);

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
          const agoraProductId = fmt === "GLASS" 
            ? String(700000 + Number(wine.winerim_id || 0))
            : String(500000 + Number(wine.winerim_id || 0));

          await supabase.from("product_mappings").upsert({
            connection_id: connectionId,
            provider_product_id: agoraProductId,
            provider_product_name: fmt === "GLASS" ? `COPA ${wine.name}` : `BOT. ${wine.name}`,
            winerim_wine_id: wine.winerim_id, winerim_wine_name: wine.name,
            match_method: "XML_IMPORT", match_score: 100,
            match_reasons: ["Created via XML import"],
            status: parsedResponse.success ? "CONFIRMED" : "PENDING",
            format_type: fmt, agora_product_id: agoraProductId,
            last_synced_at: parsedResponse.success ? new Date().toISOString() : null,
            last_sync_error: parsedResponse.success ? null : parsedResponse.errors.join("; ").substring(0, 500),
          }, { onConflict: "connection_id,provider_product_id" });
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

      // Check capabilities - must be YES (not UNKNOWN)
      const { data: caps } = await supabase
        .from("provider_capabilities").select("can_write_products").eq("connection_id", task.connection_id).single();
      if (!caps || caps.can_write_products !== "YES") {
        await supabase.from("outbound_tasks").update({
          status: "BLOCKED", blocked_reason: `Write capability is ${caps?.can_write_products || "UNKNOWN"}. Run a manual XML import first to verify.`,
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

        const { xml, validationResults } = generateImportXml(wineArr, masterData, connection, fmtTypes);

        // Check if any products were actually generated (validation may have skipped all)
        if (!xml.includes("<Product ")) {
          const reasons = validationResults.map(v => v.validation.missingFields.join(", ")).filter(Boolean).join("; ");
          await supabase.from("outbound_tasks").update({
            status: "BLOCKED", blocked_reason: `Validation failed: ${reasons || "no products generated"}`,
          }).eq("id", task.id);
          return new Response(JSON.stringify({ success: false, status: "BLOCKED", validationResults }),
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

        // Success - update mappings
        for (const fmt of fmtTypes) {
          const agoraProductId = fmt === "GLASS"
            ? String(700000 + Number(winerimWineId || 0))
            : String(500000 + Number(winerimWineId || 0));

          await supabase.from("product_mappings").upsert({
            connection_id: task.connection_id,
            provider_product_id: agoraProductId,
            provider_product_name: fmt === "GLASS" ? `COPA ${wineArr[0].name}` : `BOT. ${wineArr[0].name}`,
            winerim_wine_id: winerimWineId, winerim_wine_name: wineArr[0].name,
            match_method: "XML_IMPORT", match_score: 100,
            status: "CONFIRMED", format_type: fmt, agora_product_id: agoraProductId,
            last_synced_at: new Date().toISOString(),
          }, { onConflict: "connection_id,provider_product_id" });
        }

        await supabase.from("outbound_tasks").update({
          status: "SUCCESS", last_error: null,
          external_id: String(500000 + Number(winerimWineId || 0)),
        }).eq("id", task.id);

        // auto_push_verified_ready is NOT set here — manual verification required

        return new Response(JSON.stringify({ success: true, status: "SUCCESS", parsedResponse }),
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

    // ── QUEUE XML OUTBOUND TASKS ──
    if (action === "queue-xml-outbound") {
      const winerimWineIds = payload.winerimWineIds || [];
      const formatTypes = payload.formatTypes || ["BOTTLE"];

      let queued = 0;
      for (const wineId of winerimWineIds) {
        const { data: existing } = await supabase
          .from("outbound_tasks").select("id")
          .eq("connection_id", connectionId)
          .eq("task_type", "AGORA_XML_UPSERT_PRODUCT")
          .contains("payload_json", { _winerim_wine_id: wineId })
          .in("status", ["QUEUED", "RUNNING"])
          .limit(1);

        if (existing && existing.length > 0) continue;

        await supabase.from("outbound_tasks").insert({
          connection_id: connectionId,
          task_type: "AGORA_XML_UPSERT_PRODUCT",
          payload_json: {
            _winerim_wine_id: wineId,
            _format_types: formatTypes,
            _write_mode: "XML_IMPORT",
            _trigger_source: "MANUAL",
          },
          status: "QUEUED",
        });
        queued++;
      }

      return new Response(JSON.stringify({ success: true, queued }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── PROCESS XML OUTBOUND QUEUE (batch) ──
    if (action === "process-xml-outbound-queue") {
      const { data: tasks } = await supabase
        .from("outbound_tasks").select("id")
        .eq("connection_id", connectionId)
        .eq("task_type", "AGORA_XML_UPSERT_PRODUCT")
        .eq("status", "QUEUED")
        .order("created_at").limit(10);

      if (!tasks || tasks.length === 0) {
        return new Response(JSON.stringify({ success: true, processed: 0 }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      let processed = 0, succeeded = 0, failed = 0;
      for (const t of tasks) {
        try {
          const { data: result } = await supabase.functions.invoke("agora-proxy", {
            body: { action: "process-xml-outbound-task", connectionId, taskId: t.id },
          });
          processed++;
          if (result?.status === "SUCCESS") succeeded++; else failed++;
        } catch (_) { failed++; processed++; }
      }

      return new Response(JSON.stringify({ success: true, processed, succeeded, failed }),
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
        .from("agora_master_data").select("id, families_json, vats_json, price_lists_json, warehouses_json")
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
