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

  // Merge defaults + user config
  const wineFamilies = [...DEFAULT_WINE_FAMILIES, ...config.wine_families_whitelist.map(s => s.toLowerCase())];
  const nonWineFamilies = [...DEFAULT_NON_WINE_FAMILIES, ...config.non_wine_families_blacklist.map(s => s.toLowerCase())];
  const wineKeywords = [...DEFAULT_WINE_KEYWORDS, ...config.wine_keywords_whitelist.map(s => s.toLowerCase())];
  const nonWineKeywords = [...DEFAULT_NON_WINE_KEYWORDS, ...config.non_wine_keywords_blacklist.map(s => s.toLowerCase())];
  const formatWhitelist = [...DEFAULT_FORMAT_WHITELIST, ...config.format_whitelist.map(s => s.toLowerCase())];

  // ── HARD RULES (short-circuit) ──
  // Hard NOT_WINE: food/menu keywords in name or food family
  for (const kw of nonWineKeywords) {
    if (n === kw || n.startsWith(kw + " ") || n.endsWith(" " + kw) || n.includes(" " + kw + " ")) {
      // Only hard-rule for strong food indicators
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

  // Hard WINE: wine keywords in name or wine family
  for (const kw of ["vino", "tinto", "blanco", "rosado", "cava", "champagne", "brut"]) {
    if (n === kw || n.startsWith(kw + " ") || n.endsWith(" " + kw) || n.includes(" " + kw + " ")) {
      reasons.push(`hard_wine_name:${kw}`);
      return { classification: "WINE", score: 100, reasons };
    }
  }
  // Bottle/glass patterns
  if (/\b(botella|bot\.?\s|75\s?cl|copa de vino)\b/i.test(n)) {
    reasons.push(`hard_wine_bottle_pattern`);
    return { classification: "WINE", score: 100, reasons };
  }

  // ── SCORING ──
  let score = 0;

  // Family: +50 / -50
  for (const kw of nonWineFamilies) {
    if (f.includes(kw)) { score -= 50; reasons.push(`family_blacklist:${kw}`); break; }
  }
  for (const kw of wineFamilies) {
    if (f.includes(kw)) { score += 50; reasons.push(`family_whitelist:${kw}`); break; }
  }

  // Keywords: +30 / -60
  for (const kw of wineKeywords) {
    if (n.includes(kw)) { score += 30; reasons.push(`keyword_wine:${kw}`); break; }
  }
  for (const kw of nonWineKeywords) {
    if (n.includes(kw)) { score -= 60; reasons.push(`keyword_non_wine:${kw}`); break; }
  }

  // Format: +20 bottle, +10 glass
  for (const kw of formatWhitelist) {
    if (fmt.includes(kw) || n.includes(kw)) {
      const isBottle = ["bot", "bottle", "botella", "75cl", "magnum", "jeroboam", "37.5cl", "150cl"].includes(kw);
      score += isBottle ? 20 : 10;
      reasons.push(`format_${isBottle ? "bottle" : "glass"}:${kw}`);
      break;
    }
  }

  // Price heuristic (only if no strong signal)
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

// Legacy wrapper for backward compat
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

// Helper to load classification config for a connection
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

// ── XML IMPORT GENERATOR ──
// deno-lint-ignore no-explicit-any
function generateImportXml(wines: any[], masterData: any, connection: any, formatTypes: string[]): string {
  const families = (masterData.families_json || []) as { Id: string; Name: string }[];
  const vats = (masterData.vats_json || []) as { Id: string; Name: string; VatRate: string }[];
  const priceLists = (masterData.price_lists_json || []) as { Id: string; Name: string }[];
  const prepTypes = (masterData.preparation_types_json || []) as { Id: string; Name: string }[];
  const prepOrders = (masterData.preparation_orders_json || []) as { Id: string; Name: string }[];
  const warehouses = (masterData.warehouses_json || []) as { Id: string; Name: string }[];
  const existingProducts = (masterData.products_summary_json || []) as { Id: string; Name: string }[];

  // Resolve defaults from connection settings
  const defaultVatId = connection.default_vat_id || findVatIdByRate(vats, connection.default_vat_rate) || (vats.length > 0 ? vats[0].Id : "3");
  const defaultPrepTypeId = connection.default_preparation_type_id || (prepTypes.length > 0 ? prepTypes[0].Id : "1");
  const defaultPrepOrderId = connection.default_preparation_order_id || (prepOrders.length > 0 ? prepOrders[0].Id : "1");
  const defaultWarehouseId = connection.default_warehouse_id || (warehouses.length > 0 ? warehouses[0].Id : "1");
  const autoCreateFamilies = connection.auto_create_families ?? false;

  // Wine type -> family mapping
  const WINE_FAMILY_MAP: Record<string, string[]> = {
    "tinto": ["VINOS TINTOS", "Tintos", "Tinto"],
    "blanco": ["VINOS BLANCOS", "Blancos", "Blanco"],
    "rosado": ["VINOS ROSADOS", "Rosados", "Rosado"],
    "espumoso": ["ESPUMOSOS", "Espumosos", "Cava", "Champagne"],
    "cava": ["ESPUMOSOS", "Cava", "Espumosos"],
    "champagne": ["ESPUMOSOS", "Champagne", "Espumosos"],
    "generoso": ["GENEROSOS", "Generosos", "Jerez"],
    "fortificado": ["GENEROSOS", "Generosos"],
  };

  function findFamilyId(wineType?: string): { id: string; needsCreate: boolean; familyName: string } {
    // First try connection default
    if (connection.default_family_id) {
      const found = families.find(f => f.Id === connection.default_family_id);
      if (found) return { id: found.Id, needsCreate: false, familyName: found.Name };
    }

    // Try matching wine type
    if (wineType) {
      const typeKey = wineType.toLowerCase();
      const candidates = WINE_FAMILY_MAP[typeKey] || [];
      for (const candidate of candidates) {
        const found = families.find(f => f.Name.toLowerCase() === candidate.toLowerCase());
        if (found) return { id: found.Id, needsCreate: false, familyName: found.Name };
      }
    }

    // Fallback: search for generic wine family
    const genericNames = ["Vinos", "Vino", "Wine", "Wines", connection.default_wine_family_name || "Vinos"];
    for (const name of genericNames) {
      const found = families.find(f => f.Name.toLowerCase() === name.toLowerCase());
      if (found) return { id: found.Id, needsCreate: false, familyName: found.Name };
    }

    // Auto-create if enabled
    if (autoCreateFamilies) {
      const newFamilyName = wineType ? `Vinos ${wineType.charAt(0).toUpperCase() + wineType.slice(1)}` : "Vinos";
      const newId = String(900000 + Math.floor(Math.random() * 10000));
      return { id: newId, needsCreate: true, familyName: newFamilyName };
    }

    // Ultimate fallback: first family
    if (families.length > 0) return { id: families[0].Id, needsCreate: false, familyName: families[0].Name };
    return { id: "1", needsCreate: false, familyName: "Vinos" };
  }

  function findVatIdByRate(vatList: { Id: string; VatRate: string }[], rate?: number): string | null {
    if (!rate) return null;
    const rateStr = (rate / 100).toFixed(2); // 10 -> 0.10
    const found = vatList.find(v => v.VatRate === rateStr);
    return found?.Id || null;
  }

  function escapeXml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  }

  function truncate(s: string, maxLen: number): string {
    return s.length <= maxLen ? s : s.substring(0, maxLen);
  }

  // Build products and track needed families
  const newFamilies: { id: string; name: string }[] = [];
  const productXmls: string[] = [];

  for (const wine of wines) {
    const winerimId = Number(wine.winerim_id || wine.id || 0);
    const wineName = wine.name || "Unknown Wine";
    const wineType = wine.grape_variety || wine.region || "";

    for (const fmt of formatTypes) {
      const isGlass = fmt === "GLASS";
      const productId = isGlass ? 700000 + winerimId : 500000 + winerimId;
      const saleFormatId = productId; // BaseSaleFormatId = same as productId for simple products

      // Check if product already exists
      const existsAlready = existingProducts.some(p => p.Id === String(productId));

      const familyResult = findFamilyId(wineType);
      if (familyResult.needsCreate && !newFamilies.some(f => f.id === familyResult.id)) {
        newFamilies.push({ id: familyResult.id, name: familyResult.familyName });
      }

      const productName = isGlass ? `COPA ${wineName}` : `BOT. ${wineName}`;
      const buttonText = truncate(isGlass ? `COPA ${wineName}` : `BOT. ${wineName}`, 20);
      const costPrice = (wine.price ? Number(wine.price) * 0.4 : 0).toFixed(2); // estimate cost as 40% of sale price
      const salePrice = wine.price ? Number(wine.price).toFixed(2) : "0.00";
      const glassSalePrice = wine.price ? (Number(wine.price) / 5).toFixed(2) : "0.00"; // ~1/5 of bottle
      const mainPrice = isGlass ? glassSalePrice : salePrice;

      // Build Prices XML for all price lists
      const pricesXml = priceLists.map(pl =>
        `        <Price PriceListId="${pl.Id}" MainPrice="${mainPrice}" AddinPrice="" MenuItemPrice="0.00" />`
      ).join("\n");

      // Build CostPrices XML for all warehouses
      const costPricesXml = warehouses.map(wh =>
        `        <CostPrice WarehouseId="${wh.Id}" CostPrice="${costPrice}" />`
      ).join("\n");

      productXmls.push(`    <Product Id="${productId}" Name="${escapeXml(productName)}" BaseSaleFormatId="${saleFormatId}" ButtonText="${escapeXml(buttonText)}" Color="#8B0000" PLU="" FamilyId="${familyResult.id}" VatId="${defaultVatId}" UseAsDirectSale="true" SaleableAsMain="true" SaleableAsAddin="false" IsSoldByWeight="false" AskForPreparationNotes="false" AskForAddins="false" PrintWhenPriceIsZero="false" PreparationTypeId="${defaultPrepTypeId}" PreparationOrderId="${defaultPrepOrderId}" CostPrice="${costPrice}">
      <Prices>
${pricesXml}
      </Prices>
      <CostPrices>
${costPricesXml}
      </CostPrices>
    </Product>`);
    }
  }

  // Build final XML
  let xml = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n<Import>\n`;

  // Add new families if needed
  if (newFamilies.length > 0) {
    xml += `  <Families>\n`;
    for (const f of newFamilies) {
      xml += `    <Family Id="${f.id}" Name="${escapeXml(f.name)}" ShowInPos="true" ButtonText="${escapeXml(truncate(f.name, 15))}" Color="#8B0000" Order="100" />\n`;
    }
    xml += `  </Families>\n`;
  }

  // Add products
  xml += `  <Products>\n`;
  xml += productXmls.join("\n");
  xml += `\n  </Products>\n`;
  xml += `</Import>`;

  return xml;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { action, connectionId, businessDay, daysBack, lastBusinessDay, filter } = await req.json();

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

    // Helper: fetch with timeout + 1 retry
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

      const { data: familyRules } = await supabase
        .from("wine_family_rules")
        .select("family_name, is_wine")
        .eq("connection_id", connectionId);

      const customWineFamilies = familyRules
        ?.filter((r: { is_wine: boolean }) => r.is_wine)
        .map((r: { family_name: string }) => r.family_name.toLowerCase()) || [];
      const wineFamilies = [...DEFAULT_WINE_FAMILIES, ...customWineFamilies];

      const allFamilies = new Set<string>();

      const salesEvents = invoices.map((inv) => {
        const docId = String(inv.InvoiceId || inv.Id || "");
        const items = inv.InvoiceItems || [];
        const lines: {
          provider_product_id: string; name: string; format: string; family: string;
          quantity: number; unit_price: number; total_amount: number; vat_rate: number;
          is_wine_candidate: boolean; wine_score: number; wine_reasons: string[];
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
        const itemCount = salesEvents.reduce((c: number, ev: { lines: { family: string }[] }) =>
          c + ev.lines.filter((l) => l.family === f).length, 0);
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
        return new Response(
          JSON.stringify({ error: "businessDay required" }),
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
          console.log(`[discover-catalog] Trying ${variation.url}`);
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
      const body = await res.text();
      const parsed = JSON.parse(body);
      let items: Record<string, unknown>[] = [];
      if (Array.isArray(parsed)) items = parsed;
      else if (typeof parsed === "object" && parsed !== null) {
        for (const key of Object.keys(parsed)) {
          if (Array.isArray(parsed[key]) && parsed[key].length > 0) { items = parsed[key]; break; }
        }
      }

      let upserted = 0;
      let wineCandidates = 0;
      let needsReview = 0;

      for (const item of items) {
        const prodId = String(item.ProductId || item.Id || item.ArticleId || item.ItemId || "");
        if (!prodId) continue;
        const name = String(item.ProductName || item.Name || item.ArticleName || item.ItemName || "Unknown");
        const family = String(item.FamilyName || item.Family || item.Category || item.GroupName || "");
        const vatRate = Number(item.VatRate || item.TaxRate || 0);
        const format = String(item.SaleFormatName || item.Format || item.UnitName || "");
        const price = Number(item.Price || item.UnitPrice || item.SalePrice || 0);

        const cr = classifyProduct(family, name, format, price, config);
        if (cr.classification === "WINE") wineCandidates++;
        if (cr.classification === "NEEDS_REVIEW") needsReview++;

        await supabase.from("provider_products").upsert({
          connection_id: connectionId, provider_product_id: prodId,
          name, family, vat_rate: vatRate, sale_format: format, price,
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
        catalog_wine_candidate_count: wineCandidates,
      }).eq("id", connectionId);

      return new Response(
        JSON.stringify({ success: true, totalProducts: upserted, wineCandidates, needsReview, endpoint }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── BUILD DERIVED CATALOG ──
    if (action === "build-derived-catalog") {
      const scanDays = daysBack || 30;
      const config = await loadConfig(supabase, connectionId);
      const productMap = new Map<string, { name: string; family: string; format: string; vatRate: number; totalPrice: number; count: number }>();
      let daysScanned = 0;
      let totalInvoices = 0;

      for (let i = 0; i < scanDays * 2 && daysScanned < scanDays; i++) {
        const day = new Date(Date.now() - i * 86400000).toISOString().split("T")[0];
        try {
          const url = `${baseUrlClean}/api/export/?business-day=${day}&filter=Invoices`;
          const res = await fetchWithRetry(url, { headers });
          if (!res.ok) continue;
          const body = await res.text();
          const trimmed = body.trim();
          if (!trimmed || trimmed === "{}" || trimmed === "[]") continue;
          const parsed = JSON.parse(trimmed);
          const invoices = parseInvoices(parsed);
          if (invoices.length === 0) continue;
          daysScanned++;
          totalInvoices += invoices.length;
          for (const inv of invoices) {
            for (const item of (inv.InvoiceItems || [])) {
              for (const line of (item.Lines || [])) {
                const prodId = String(line.ProductId || "");
                if (!prodId) continue;
                const existing = productMap.get(prodId);
                const uPrice = Number(line.UnitPrice || 0);
                if (existing) { existing.count++; existing.totalPrice += uPrice; }
                else {
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

      // Fetch all AUTO products for this connection (paginated)
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
            wine_score: cr.score,
            wine_reasons: cr.reasons,
            last_score: cr.score,
            last_reasons: cr.reasons,
          }).eq("id", p.id);

          totalRecomputed++;
          if (cr.classification === "WINE") wineCount++;
          else if (cr.classification === "NOT_WINE") notWineCount++;
          else reviewCount++;
        }

        offset += batchSize;
        if (products.length < batchSize) break;
      }

      // Update connection metadata
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
        return new Response(
          JSON.stringify({ error: "businessDay required" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const winerimToken = (connection.winerim_api_token || "").trim();
      if (!winerimToken) {
        return new Response(
          JSON.stringify({ success: false, error: "No Winerim API token configured" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Get all mapped wine line items for this day
      const { data: events } = await supabase
        .from("sales_events")
        .select("id")
        .eq("connection_id", connectionId)
        .eq("business_day", day);

      if (!events || events.length === 0) {
        return new Response(
          JSON.stringify({ success: true, message: "No sales events for this day", synced: 0, skipped: 0, failed: 0 }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const eventIds = events.map((e: { id: string }) => e.id);
      const { data: lines } = await supabase
        .from("sales_line_items")
        .select("id, sales_event_id, name, quantity, winerim_product_id, provider_product_id, is_wine_candidate")
        .in("sales_event_id", eventIds);

      if (!lines || lines.length === 0) {
        return new Response(
          JSON.stringify({ success: true, message: "No line items found", synced: 0, skipped: 0, failed: 0 }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Filter: only mapped wine items with winerim_product_id
      const mappedLines = lines.filter((l: { winerim_product_id: string | null; is_wine_candidate: boolean }) =>
        l.winerim_product_id && l.is_wine_candidate
      );

      let synced = 0;
      let skipped = 0;
      let failed = 0;

      const winerimHeaders = {
        "Authorization": `Bearer ${winerimToken}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
      };

      for (const line of mappedLines) {
        // Check if already synced
        const { data: existing } = await supabase
          .from("stock_sync_log")
          .select("id")
          .eq("sales_line_item_id", line.id)
          .eq("status", "SUCCESS")
          .limit(1);

        if (existing && existing.length > 0) {
          skipped++;
          continue;
        }

        // Create pending log entry
        const { data: logEntry } = await supabase
          .from("stock_sync_log")
          .insert({
            connection_id: connectionId,
            sales_event_id: line.sales_event_id,
            sales_line_item_id: line.id,
            provider_product_id: line.provider_product_id,
            winerim_product_id: line.winerim_product_id,
            product_name: line.name,
            quantity: Math.abs(Number(line.quantity)),
            status: "PENDING",
          })
          .select("id")
          .single();

        try {
          const res = await fetch("https://api.winerim.com/api/v2/stock", {
            method: "PUT",
            headers: winerimHeaders,
            body: JSON.stringify({
              product_id: line.winerim_product_id,
              quantity_change: -Math.abs(Number(line.quantity)),
            }),
          });

          const responseBody = await res.text();
          let parsed;
          try { parsed = JSON.parse(responseBody); } catch { parsed = { raw: responseBody }; }

          if (res.ok) {
            await supabase.from("stock_sync_log").update({
              status: "SUCCESS",
              winerim_response: parsed,
              synced_at: new Date().toISOString(),
            }).eq("id", logEntry?.id);
            synced++;
          } else {
            await supabase.from("stock_sync_log").update({
              status: "FAILED",
              error_message: responseBody.substring(0, 500),
              winerim_response: parsed,
            }).eq("id", logEntry?.id);
            failed++;
          }
        } catch (e) {
          await supabase.from("stock_sync_log").update({
            status: "FAILED",
            error_message: String(e),
          }).eq("id", logEntry?.id);
          failed++;
        }
      }

      const unmappedCount = lines.length - mappedLines.length;

      return new Response(
        JSON.stringify({
          success: true,
          synced,
          skipped,
          failed,
          unmapped: unmappedCount,
          totalLines: lines.length,
          mappedLines: mappedLines.length,
        }),
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
          // Try OPTIONS first for safe detection
          let res: Response;
          try {
            res = await fetchWithRetry(`${baseUrlClean}${ep.path}`, {
              method: "OPTIONS",
              headers: { ...headers, "Content-Type": "application/json" },
            }, 8000);
          } catch (_) {
            // OPTIONS not supported, try POST with minimal payload
            res = await fetchWithRetry(`${baseUrlClean}${ep.path}`, {
              method: "POST",
              headers: { ...headers, "Content-Type": "application/json" },
              body: JSON.stringify({ _test: true, Name: "WINERIM_TEST_PROBE", ExternalRef: "WINERIM_TEST_PROBE_DELETE" }),
            }, 8000);
          }

          const bodyText = await res.text();
          const bodyPreview = bodyText.substring(0, 512);

          // 200/201/202 = endpoint exists and accepted (may have created something)
          // 400 with validation error = endpoint exists, supports write
          // 404/405 = endpoint doesn't exist
          const supports = res.status !== 404 && res.status !== 405 && res.status !== 501;

          results.push({ path: ep.path, label: ep.label, status: res.status, supports, body: bodyPreview });

          if (supports && !writeEndpoint) {
            writeEndpoint = ep.path;
            canWrite = "YES";

            // If we got 200/201 (accidentally created), try to rollback
            if (res.status === 200 || res.status === 201) {
              try {
                const created = JSON.parse(bodyText);
                const createdId = created?.Id || created?.ProductId || created?.ArticleId;
                if (createdId) {
                  // Attempt DELETE rollback
                  await fetchWithRetry(`${baseUrlClean}${ep.path}/${createdId}`, {
                    method: "DELETE",
                    headers,
                  }, 5000).catch(() => {});
                }
              } catch (_) { /* rollback best-effort */ }
              // If no rollback possible, mark as UNKNOWN for safety
              canWrite = "UNKNOWN";
            }
          }
        } catch (e) {
          results.push({ path: ep.path, label: ep.label, status: 0, supports: false, body: String(e) });
        }
      }

      // Upsert capabilities
      await supabase.from("provider_capabilities").upsert({
        connection_id: connectionId,
        provider: "AGORA",
        can_read_sales: true,
        can_read_catalog: !!connection.catalog_endpoint,
        can_write_products: canWrite,
        write_endpoint: writeEndpoint,
        write_endpoints_json: results,
        last_checked_at: new Date().toISOString(),
      }, { onConflict: "connection_id" });

      return new Response(
        JSON.stringify({ success: true, canWrite, writeEndpoint, results }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── PROCESS OUTBOUND TASK ──
    if (action === "process-outbound-task") {
      const { taskId } = await req.json().catch(() => ({ taskId: undefined }));
      const taskIdToUse = taskId || (await req.json().catch(() => ({}))).taskId;

      // Fetch task
      const { data: task, error: taskErr } = await supabase
        .from("outbound_tasks")
        .select("*")
        .eq("id", taskId)
        .single();
      if (taskErr || !task) {
        return new Response(JSON.stringify({ error: "Task not found" }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // Check capabilities
      const { data: caps } = await supabase
        .from("provider_capabilities")
        .select("*")
        .eq("connection_id", task.connection_id)
        .single();

      if (!caps || caps.can_write_products === "NO") {
        await supabase.from("outbound_tasks").update({
          status: "BLOCKED",
          blocked_reason: "Agora installation does not support write operations. Export the product data and provide to your Agora installer.",
        }).eq("id", task.id);
        return new Response(JSON.stringify({ success: false, status: "BLOCKED", reason: "Write not supported" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      if (caps.can_write_products === "UNKNOWN") {
        await supabase.from("outbound_tasks").update({
          status: "BLOCKED",
          blocked_reason: "Write capability not confirmed. Run capability detection first, or confirm manually.",
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

      // Mark as running
      await supabase.from("outbound_tasks").update({ status: "RUNNING", attempts: task.attempts + 1 }).eq("id", task.id);

      const payload = task.payload_json;

      try {
        // Check if product already exists (idempotency via ExternalRef)
        let existingProductId = task.external_id;

        if (!existingProductId && payload.ExternalRef) {
          // Try to find by ExternalRef in catalog
          const { data: existingProduct } = await supabase
            .from("provider_products")
            .select("provider_product_id")
            .eq("connection_id", task.connection_id)
            .eq("provider_product_id", payload.ExternalRef)
            .single();
          if (existingProduct) existingProductId = existingProduct.provider_product_id;
        }

        let res: Response;
        if (existingProductId) {
          // Try PUT/PATCH for update
          res = await fetchWithRetry(`${baseUrlClean}${writeEp}/${existingProductId}`, {
            method: "PUT",
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
        } else {
          // POST for create
          res = await fetchWithRetry(`${baseUrlClean}${writeEp}`, {
            method: "POST",
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
        }

        const resBody = await res.text();
        const resPreview = resBody.substring(0, 2048);

        if (res.status === 401 || res.status === 403) {
          await supabase.from("outbound_tasks").update({
            status: "FAILED", last_error: `Auth error ${res.status}: ${resPreview}`,
          }).eq("id", task.id);
          // Flag connection
          await supabase.from("pos_connections").update({ enabled: false }).eq("id", task.connection_id);
          return new Response(JSON.stringify({ success: false, status: "FAILED", error: "Auth error" }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        if (res.status === 404 || res.status === 405) {
          await supabase.from("outbound_tasks").update({
            status: "BLOCKED", blocked_reason: `Endpoint returned ${res.status}. Write not supported.`,
          }).eq("id", task.id);
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
          return new Response(JSON.stringify({ success: false, status: shouldRetry ? "QUEUED" : "FAILED", error: resPreview }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        // Success - extract external ID
        let externalId = existingProductId;
        try {
          const created = JSON.parse(resBody);
          externalId = String(created?.Id || created?.ProductId || created?.ArticleId || externalId || "");
        } catch (_) {}

        await supabase.from("outbound_tasks").update({
          status: "SUCCESS", external_id: externalId, last_error: null,
        }).eq("id", task.id);

        // Update provider_products sync status
        if (payload._winerim_wine_id) {
          await supabase.from("provider_products").update({
            sync_status: "SYNCED", sync_error: null, last_synced_at: new Date().toISOString(),
          }).eq("connection_id", task.connection_id).eq("winerim_wine_id", payload._winerim_wine_id);
        }

        return new Response(JSON.stringify({ success: true, status: "SUCCESS", externalId }),
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

    // ── QUEUE OUTBOUND TASKS (push wines to Agora) ──
    if (action === "queue-outbound") {
      const { winerimWineIds } = await req.json().catch(() => ({ winerimWineIds: [] }));
      
      // Get connection defaults
      const defaultFamily = connection.default_wine_family_name || "Vinos";
      const defaultVat = Number(connection.default_vat_rate || 10);
      const defaultBottleFormat = connection.default_bottle_format_name || "BOT";

      // Get mapped wines
      const { data: mappings } = await supabase
        .from("product_mappings")
        .select("*, winerim_wines!inner(name, price, format, winerim_id, sku, ean)")
        .eq("connection_id", connectionId)
        .eq("status", "CONFIRMED")
        .in("winerim_wine_id", winerimWineIds || []);

      if (!mappings || mappings.length === 0) {
        // Fallback: get winerim wines directly
        const { data: wines } = await supabase
          .from("winerim_wines")
          .select("*")
          .eq("connection_id", connectionId)
          .in("winerim_id", winerimWineIds || []);

        if (!wines || wines.length === 0) {
          return new Response(JSON.stringify({ success: false, error: "No wines found to push" }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        let queued = 0;
        for (const wine of wines) {
          const payload = {
            Name: wine.name,
            FamilyName: defaultFamily,
            SaleFormatName: defaultBottleFormat,
            Price: wine.price || 0,
            VatRate: defaultVat,
            ExternalRef: `WINERIM_${wine.winerim_id}`,
            _winerim_wine_id: wine.winerim_id,
          };

          // Check idempotency - skip if task already exists
          const { data: existing } = await supabase
            .from("outbound_tasks")
            .select("id")
            .eq("connection_id", connectionId)
            .eq("task_type", "AGORA_UPSERT_PRODUCT")
            .contains("payload_json", { ExternalRef: payload.ExternalRef })
            .in("status", ["QUEUED", "RUNNING", "SUCCESS"])
            .limit(1);

          if (existing && existing.length > 0) continue;

          await supabase.from("outbound_tasks").insert({
            connection_id: connectionId,
            task_type: "AGORA_UPSERT_PRODUCT",
            payload_json: payload,
            status: "QUEUED",
          });
          queued++;
        }

        return new Response(JSON.stringify({ success: true, queued }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      let queued = 0;
      for (const m of mappings) {
        const wine = (m as any).winerim_wines;
        const payload = {
          Name: wine.name,
          FamilyName: defaultFamily,
          SaleFormatName: defaultBottleFormat,
          Price: wine.price || 0,
          VatRate: defaultVat,
          ExternalRef: `WINERIM_${wine.winerim_id}`,
          SKU: wine.sku || undefined,
          EAN: wine.ean || undefined,
          _winerim_wine_id: wine.winerim_id,
        };

        const { data: existing } = await supabase
          .from("outbound_tasks")
          .select("id")
          .eq("connection_id", connectionId)
          .eq("task_type", "AGORA_UPSERT_PRODUCT")
          .contains("payload_json", { ExternalRef: payload.ExternalRef })
          .in("status", ["QUEUED", "RUNNING", "SUCCESS"])
          .limit(1);

        if (existing && existing.length > 0) continue;

        await supabase.from("outbound_tasks").insert({
          connection_id: connectionId,
          task_type: "AGORA_UPSERT_PRODUCT",
          payload_json: payload,
          status: "QUEUED",
        });
        queued++;
      }

      return new Response(JSON.stringify({ success: true, queued }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── PROCESS OUTBOUND QUEUE (batch worker) ──
    if (action === "process-outbound-queue") {
      const { data: tasks } = await supabase
        .from("outbound_tasks")
        .select("id")
        .eq("connection_id", connectionId)
        .eq("status", "QUEUED")
        .order("created_at")
        .limit(10);

      if (!tasks || tasks.length === 0) {
        return new Response(JSON.stringify({ success: true, processed: 0 }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      let processed = 0;
      let succeeded = 0;
      let failed = 0;

      for (const t of tasks) {
        try {
          // Recursive call to process single task
          const { data: result } = await supabase.functions.invoke("agora-proxy", {
            body: { action: "process-outbound-task", connectionId, taskId: t.id },
          });
          processed++;
          if (result?.status === "SUCCESS") succeeded++;
          else failed++;
        } catch (_) { failed++; processed++; }
      }

      return new Response(JSON.stringify({ success: true, processed, succeeded, failed }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── EXPORT PRODUCTS (JSON/CSV fallback) ──
    if (action === "export-products") {
      const { format: exportFormat, winerimWineIds: exportIds } = await req.json().catch(() => ({ format: "json", winerimWineIds: [] }));

      let wines: any[] = [];
      if (exportIds && exportIds.length > 0) {
        const { data } = await supabase.from("winerim_wines").select("*").eq("connection_id", connectionId).in("winerim_id", exportIds);
        wines = data || [];
      } else {
        // All confirmed mappings
        const { data: mappings } = await supabase
          .from("product_mappings")
          .select("winerim_wine_id, winerim_wine_name")
          .eq("connection_id", connectionId)
          .eq("status", "CONFIRMED");
        if (mappings) {
          const ids = mappings.map(m => m.winerim_wine_id).filter(Boolean);
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
        externalRef: `WINERIM_${w.winerim_id}`,
        name: w.name,
        family: defaultFamily,
        format: defaultFormat,
        vat_rate: defaultVat,
        price: w.price || 0,
        sku: w.sku || "",
        ean: w.ean || "",
      }));

      if (exportFormat === "csv") {
        const csvHeader = "externalRef,name,family,format,vat_rate,price,sku,ean";
        const csvRows = exportRows.map(r =>
          `"${r.externalRef}","${r.name.replace(/"/g, '""')}","${r.family}","${r.format}",${r.vat_rate},${r.price},"${r.sku}","${r.ean}"`
        );
        return new Response(
          [csvHeader, ...csvRows].join("\n"),
          { headers: { ...corsHeaders, "Content-Type": "text/csv", "Content-Disposition": "attachment; filename=agora-import.csv" } }
        );
      }

      return new Response(
        JSON.stringify({ success: true, products: exportRows, count: exportRows.length }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── SYNC AGORA MASTER DATA ──
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
      
      // Parse XML using regex-based extraction (no external XML parser in Deno edge functions)
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
        // Also match non-self-closing (for Products with children)
        const openRegex = new RegExp(`<${tagName}\\s([^>]*?)>`, "gi");
        while ((match = openRegex.exec(xml)) !== null) {
          const attrs: Record<string, string> = {};
          const attrRegex = /(\w+)="([^"]*)"/g;
          let attrMatch;
          while ((attrMatch = attrRegex.exec(match[1])) !== null) {
            attrs[attrMatch[1]] = attrMatch[2];
          }
          // Avoid duplicates from self-closing
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
      const warehouses = extractElements(rawXml, "Warehouse").filter(w => w.Name); // filter out empty
      const products = extractElements(rawXml, "Product");

      // Products summary: just Id + Name + FamilyId to keep it lightweight
      const productsSummary = products.map(p => ({
        Id: p.Id, Name: p.Name, FamilyId: p.FamilyId, VatId: p.VatId,
      }));

      // Upsert master data
      await supabase.from("agora_master_data").upsert({
        connection_id: connectionId,
        families_json: families,
        vats_json: vats,
        price_lists_json: priceLists,
        preparation_types_json: prepTypes,
        preparation_orders_json: prepOrders,
        warehouses_json: warehouses,
        products_summary_json: productsSummary,
        raw_xml_preview: rawXml.substring(0, 5000),
        fetched_at: new Date().toISOString(),
      }, { onConflict: "connection_id" });

      // Update write_mode on connection if we got valid data
      if (families.length > 0 || products.length > 0) {
        await supabase.from("pos_connections").update({
          write_mode: "XML_IMPORT",
        }).eq("id", connectionId).eq("write_mode", "NONE");

        // Update capabilities
        await supabase.from("provider_capabilities").upsert({
          connection_id: connectionId,
          provider: "AGORA",
          can_read_sales: true,
          can_read_catalog: true,
          can_write_products: "YES",
          write_endpoint: "/api/import/",
          last_checked_at: new Date().toISOString(),
        }, { onConflict: "connection_id" });
      }

      return new Response(
        JSON.stringify({
          success: true,
          families: families.length,
          vats: vats.length,
          priceLists: priceLists.length,
          preparationTypes: prepTypes.length,
          preparationOrders: prepOrders.length,
          warehouses: warehouses.length,
          products: productsSummary.length,
          masterData: { families, vats, priceLists, preparationTypes: prepTypes, preparationOrders: prepOrders, warehouses },
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── PREVIEW XML (dry-run, no send) ──
    if (action === "preview-xml") {
      const { winerimWineIds, formatTypes } = await req.json().catch(() => ({ winerimWineIds: [], formatTypes: ["BOTTLE"] }));
      
      // Load master data
      const { data: masterData } = await supabase
        .from("agora_master_data")
        .select("*")
        .eq("connection_id", connectionId)
        .single();

      if (!masterData) {
        return new Response(
          JSON.stringify({ success: false, error: "No master data cached. Run 'Sync Master Data' first." }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Load wines
      const { data: wines } = await supabase
        .from("winerim_wines")
        .select("*")
        .eq("connection_id", connectionId)
        .in("winerim_id", winerimWineIds || []);

      if (!wines || wines.length === 0) {
        return new Response(
          JSON.stringify({ success: false, error: "No wines found" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const xml = generateImportXml(wines, masterData, connection, formatTypes || ["BOTTLE"]);

      return new Response(
        JSON.stringify({ success: true, xml, wineCount: wines.length }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── XML IMPORT (POST /api/import/) ──
    if (action === "xml-import") {
      const { winerimWineIds, formatTypes, dryRun } = await req.json().catch(() => ({ winerimWineIds: [], formatTypes: ["BOTTLE"], dryRun: false }));

      // Load master data
      const { data: masterData } = await supabase
        .from("agora_master_data")
        .select("*")
        .eq("connection_id", connectionId)
        .single();

      if (!masterData) {
        return new Response(
          JSON.stringify({ success: false, error: "No master data. Run 'Sync Master Data' first." }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Load wines
      const { data: wines } = await supabase
        .from("winerim_wines")
        .select("*")
        .eq("connection_id", connectionId)
        .in("winerim_id", winerimWineIds || []);

      if (!wines || wines.length === 0) {
        return new Response(
          JSON.stringify({ success: false, error: "No wines found" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const xml = generateImportXml(wines, masterData, connection, formatTypes || ["BOTTLE"]);

      if (dryRun) {
        return new Response(
          JSON.stringify({ success: true, dryRun: true, xml }),
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
        importRes = await fetchWithRetry(importUrl, {
          method: "POST",
          headers: xmlHeaders,
          body: xml,
        }, 30000);
      } catch (e) {
        return new Response(
          JSON.stringify({ success: false, error: `Failed to reach Agora import: ${e}` }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const responseBody = await importRes.text().catch(() => "");
      const responsePreview = responseBody.substring(0, 2048);

      // Update mappings
      const fmtTypes = formatTypes || ["BOTTLE"];
      for (const wine of wines) {
        for (const fmt of fmtTypes) {
          const agoraProductId = fmt === "GLASS" 
            ? String(700000 + Number(wine.winerim_id || 0))
            : String(500000 + Number(wine.winerim_id || 0));

          await supabase.from("product_mappings").upsert({
            connection_id: connectionId,
            provider_product_id: agoraProductId,
            provider_product_name: fmt === "GLASS" ? `COPA ${wine.name}` : `BOT. ${wine.name}`,
            winerim_wine_id: wine.winerim_id,
            winerim_wine_name: wine.name,
            match_method: "XML_IMPORT",
            match_score: 100,
            match_reasons: ["Created via XML import"],
            status: importRes.ok ? "CONFIRMED" : "PENDING",
            format_type: fmt,
            agora_product_id: agoraProductId,
            last_synced_at: importRes.ok ? new Date().toISOString() : null,
            last_sync_error: importRes.ok ? null : responsePreview.substring(0, 500),
          }, { onConflict: "connection_id,provider_product_id" });
        }
      }

      return new Response(
        JSON.stringify({
          success: importRes.ok,
          status: importRes.status,
          responsePreview,
          xmlSent: xml.substring(0, 3000),
          winesProcessed: wines.length,
          formatsUsed: fmtTypes,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── PROCESS OUTBOUND TASK (XML_IMPORT mode) ──
    if (action === "process-xml-outbound-task") {
      const { taskId } = await req.json().catch(() => ({ taskId: undefined }));

      const { data: task, error: taskErr } = await supabase
        .from("outbound_tasks")
        .select("*")
        .eq("id", taskId)
        .single();
      if (taskErr || !task) {
        return new Response(JSON.stringify({ error: "Task not found" }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // Mark as running
      await supabase.from("outbound_tasks").update({ status: "RUNNING", attempts: task.attempts + 1 }).eq("id", task.id);

      try {
        // Load master data
        const { data: masterData } = await supabase
          .from("agora_master_data")
          .select("*")
          .eq("connection_id", task.connection_id)
          .single();

        if (!masterData) {
          await supabase.from("outbound_tasks").update({
            status: "BLOCKED", blocked_reason: "No master data cached. Run 'Sync Master Data' first.",
          }).eq("id", task.id);
          return new Response(JSON.stringify({ success: false, status: "BLOCKED" }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        const payload = task.payload_json as Record<string, unknown>;
        const winerimWineId = payload._winerim_wine_id as string;
        const fmtTypes = (payload._format_types as string[]) || ["BOTTLE"];

        // Load wine
        const { data: wineArr } = await supabase
          .from("winerim_wines")
          .select("*")
          .eq("connection_id", task.connection_id)
          .eq("winerim_id", winerimWineId)
          .limit(1);

        if (!wineArr || wineArr.length === 0) {
          await supabase.from("outbound_tasks").update({
            status: "FAILED", last_error: `Wine ${winerimWineId} not found in cache`,
          }).eq("id", task.id);
          return new Response(JSON.stringify({ success: false, status: "FAILED" }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        const xml = generateImportXml(wineArr, masterData, connection, fmtTypes);

        // POST
        const importUrl = `${baseUrlClean}/api/import/`;
        const xmlHeaders = {
          "Api-Token": apiTokenClean,
          Accept: "application/xml",
          "Content-Type": "application/xml; charset=utf-8",
        };

        const importRes = await fetchWithRetry(importUrl, {
          method: "POST",
          headers: xmlHeaders,
          body: xml,
        }, 30000);

        const responseBody = await importRes.text().catch(() => "");
        const responsePreview = responseBody.substring(0, 2048);

        if (!importRes.ok) {
          const shouldRetry = task.attempts + 1 < (task.max_attempts || 3);
          await supabase.from("outbound_tasks").update({
            status: shouldRetry ? "QUEUED" : "FAILED",
            last_error: `HTTP ${importRes.status}: ${responsePreview}`,
          }).eq("id", task.id);
          return new Response(JSON.stringify({ success: false, status: shouldRetry ? "QUEUED" : "FAILED" }),
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
            winerim_wine_id: winerimWineId,
            winerim_wine_name: wineArr[0].name,
            match_method: "XML_IMPORT",
            match_score: 100,
            status: "CONFIRMED",
            format_type: fmt,
            agora_product_id: agoraProductId,
            last_synced_at: new Date().toISOString(),
          }, { onConflict: "connection_id,provider_product_id" });
        }

        await supabase.from("outbound_tasks").update({
          status: "SUCCESS", last_error: null,
          external_id: String(500000 + Number(winerimWineId || 0)),
        }).eq("id", task.id);

        return new Response(JSON.stringify({ success: true, status: "SUCCESS", responsePreview }),
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
      const { winerimWineIds, formatTypes } = await req.json().catch(() => ({ winerimWineIds: [], formatTypes: ["BOTTLE"] }));
      const fmtTypes = formatTypes || ["BOTTLE"];

      let queued = 0;
      for (const wineId of (winerimWineIds || [])) {
        // Check idempotency
        const { data: existing } = await supabase
          .from("outbound_tasks")
          .select("id")
          .eq("connection_id", connectionId)
          .eq("task_type", "AGORA_XML_UPSERT_PRODUCT")
          .contains("payload_json", { _winerim_wine_id: wineId })
          .in("status", ["QUEUED", "RUNNING", "SUCCESS"])
          .limit(1);

        if (existing && existing.length > 0) continue;

        await supabase.from("outbound_tasks").insert({
          connection_id: connectionId,
          task_type: "AGORA_XML_UPSERT_PRODUCT",
          payload_json: {
            _winerim_wine_id: wineId,
            _format_types: fmtTypes,
            _write_mode: "XML_IMPORT",
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
        .from("outbound_tasks")
        .select("id")
        .eq("connection_id", connectionId)
        .eq("task_type", "AGORA_XML_UPSERT_PRODUCT")
        .eq("status", "QUEUED")
        .order("created_at")
        .limit(10);

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
    console.error("agora-proxy error:", err);
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
