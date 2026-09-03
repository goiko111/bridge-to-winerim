import fs from "node:fs";
import path from "node:path";

const envPath = path.resolve(".env");
const env = Object.fromEntries(
  fs.readFileSync(envPath, "utf8")
    .split(/\n/)
    .filter((line) => line.trim() && !line.trim().startsWith("#"))
    .map((line) => {
      const [key, ...rest] = line.split("=");
      return [key, rest.join("=").replace(/^"|"$/g, "")];
    }),
);

const SUPABASE_URL = env.VITE_SUPABASE_URL;
const SUPABASE_KEY = env.VITE_SUPABASE_PUBLISHABLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error("Missing VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY in .env");
}

const APPLY = process.argv.includes("--apply");
const SKIP_SYNC_MASTER = process.argv.includes("--skip-sync-master");
const ONLY_ARG = process.argv.find((arg) => arg.startsWith("--only="));
const ONLY = ONLY_ARG ? new Set(ONLY_ARG.replace("--only=", "").split(",").map((s) => s.trim()).filter(Boolean)) : null;

const REST_HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
};

const CONNECTION_ID = "e2f6ce27-0e94-444f-9d64-09ba425a2b83";

const TARGETS = [
  {
    key: "tintos",
    familyId: "900157",
    familyName: "TINTOS WINERIM",
    wineTypes: ["tinto"],
    format: "BOTTLE",
    color: "#8B0000",
    requiredPrefixes: ["T"],
  },
  {
    key: "blancos",
    familyId: "904241",
    familyName: "BLANCOS WINERIM",
    wineTypes: ["blanco"],
    format: "BOTTLE",
    color: "#8B0000",
  },
  {
    key: "rosados",
    familyId: "903516",
    familyName: "ROSADOS WINERIM",
    wineTypes: ["rosado"],
    format: "BOTTLE",
    color: "#8B0000",
  },
  {
    key: "espumosos",
    familyId: "908875",
    familyName: "ESPUMOSOS WINERIM",
    wineTypes: ["espumoso"],
    format: "BOTTLE",
    color: "#8B0000",
  },
  {
    key: "fortificados",
    familyId: "908182",
    familyName: "FORTIFICADOS WINERIM",
    wineTypes: ["fortificado"],
    format: "BOTTLE",
    color: "#8B0000",
  },
  {
    key: "magnums",
    familyId: "904289",
    familyName: "MAGNUM WINERIM",
    wineTypes: null,
    format: "DYNAMIC_MAGNUM",
    color: "#1E3A8A",
  },
  {
    key: "copas",
    familyId: "901954",
    familyName: "COPAS WINERIM",
    wineTypes: null,
    format: "GLASS",
    color: "#2563EB",
    excludeWineTypes: ["postre", "dulce"],
  },
];

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function truncate(value, max) {
  const s = String(value ?? "");
  return s.length <= max ? s : s.slice(0, max);
}

function asNumber(value) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function normalizeType(value) {
  return String(value ?? "").trim().toLowerCase();
}

function extractAttr(xml, attr) {
  const re = new RegExp(`\\b${attr}="([^"]*)"`);
  const value = re.exec(xml)?.[1] ?? null;
  return value === null ? null : decodeXml(value);
}

function decodeXml(value) {
  return String(value)
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function setAttr(xml, attr, value) {
  const escaped = escapeXml(value);
  const re = new RegExp(`\\b${attr}="[^"]*"`);
  if (re.test(xml)) return xml.replace(re, `${attr}="${escaped}"`);
  return xml.replace(/(\s*\/?>)/, ` ${attr}="${escaped}"$1`);
}

function commercialCode(name) {
  const s = String(name ?? "").trim();
  const mag = /\bMAGNUM\s*[-_ ]*(\d{1,3})\b/i.exec(s);
  if (mag) return { prefix: "MAGNUM", number: Number(mag[1]), suffix: "", value: `MAGNUM${Number(mag[1])}` };
  const match = /\b([BRTEDG])\s*[-_ ]?(\d{1,3})([A-Z])?\b/i.exec(s);
  if (!match) return null;
  return {
    prefix: match[1].toUpperCase(),
    number: Number(match[2]),
    suffix: (match[3] || "").toUpperCase(),
    value: `${match[1].toUpperCase()}${Number(match[2])}${(match[3] || "").toUpperCase()}`,
  };
}

function compareWineCode(a, b) {
  const ca = commercialCode(a.name);
  const cb = commercialCode(b.name);
  if (ca && cb) {
    if (ca.prefix !== cb.prefix) return ca.prefix.localeCompare(cb.prefix);
    if (ca.number !== cb.number) return ca.number - cb.number;
    return ca.suffix.localeCompare(cb.suffix);
  }
  if (ca && !cb) return -1;
  if (!ca && cb) return 1;
  return String(a.name ?? "").localeCompare(String(b.name ?? ""), "es");
}

function formatProductName(format, wineName) {
  if (format === "MAGNUM") return `M ${wineName}`;
  if (format === "GLASS") return `C ${wineName}`;
  return `B ${wineName}`;
}

function productIdFor(format, wine) {
  const winerimId = Number(wine.winerim_id);
  if (format === "MAGNUM") return String(900000 + winerimId);
  if (format === "GLASS") return String(700000 + winerimId);
  return String(500000 + winerimId);
}

function priceFor(format, wine) {
  if (format === "MAGNUM") return asNumber(wine.magnum_sale_price);
  if (format === "GLASS") return asNumber(wine.glass_sale_price);
  return asNumber(wine.bottle_sale_price ?? wine.price);
}

function costFor(format, wine) {
  if (format === "MAGNUM") return asNumber(wine.magnum_purchase_price ?? wine.magnum_cost_price);
  if (format === "GLASS") return asNumber(wine.glass_purchase_price ?? wine.glass_cost_price);
  return asNumber(wine.bottle_purchase_price ?? wine.purchase_price ?? wine.cost_price);
}

function isEligible(target, wine) {
  const type = normalizeType(wine.wine_type ?? wine.raw_payload?.type);
  if (target.wineTypes && !target.wineTypes.includes(type)) return false;
  if (target.excludeWineTypes?.includes(type)) return false;
  const code = commercialCode(wine.name);
  if (target.requiredPrefixes && !target.requiredPrefixes.includes(code?.prefix)) return false;
  if (target.key !== "magnums" && target.format === "BOTTLE" && code?.prefix === "MAGNUM") return false;
  if (target.key === "magnums") {
    return asNumber(wine.magnum_sale_price) > 0 || (code?.prefix === "MAGNUM" && asNumber(wine.bottle_sale_price ?? wine.price) > 0);
  }
  if (target.format === "GLASS" && wine.serve_by_glass !== true) return false;
  return priceFor(target.format, wine) > 0;
}

function actualFormatFor(target, wine) {
  if (target.format !== "DYNAMIC_MAGNUM") return target.format;
  return asNumber(wine.magnum_sale_price) > 0 ? "MAGNUM" : "BOTTLE";
}

async function rest(path, init = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { ...REST_HEADERS, ...(init.headers || {}) },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`REST ${response.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

async function functionInvoke(functionName, body) {
  const response = await fetch(`${SUPABASE_URL}/functions/v1/${functionName}`, {
    method: "POST",
    headers: REST_HEADERS,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
  if (!response.ok) throw new Error(`${functionName} ${response.status}: ${text.slice(0, 500)}`);
  return parsed;
}

async function fetchXml(url, token, options = {}) {
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: {
      "Api-Token": token,
      Accept: "application/xml",
      "Content-Type": "application/xml; charset=utf-8",
    },
    body: options.body,
  });
  const text = await response.text();
  return { ok: response.ok, status: response.status, text };
}

function indexElements(xml, tagName) {
  const result = [];
  const regex = new RegExp(`<${tagName}\\b[^>]*\\/>|<${tagName}\\b[^>]*>[\\s\\S]*?<\\/${tagName}>`, "g");
  let match;
  while ((match = regex.exec(xml))) {
    const full = match[0];
    const id = extractAttr(full, "Id");
    result.push({ id, xml: full, name: extractAttr(full, "Name"), familyId: extractAttr(full, "FamilyId") });
  }
  return result;
}

function patchExistingProductXml(existingXml, plan, connection) {
  let xml = existingXml;
  xml = setAttr(xml, "FamilyId", plan.familyId);
  xml = setAttr(xml, "Name", plan.productName);
  xml = setAttr(xml, "ButtonText", truncate(plan.productName, 20));
  xml = setAttr(xml, "UseAsDirectSale", "false");
  xml = setAttr(xml, "SaleableAsMain", "true");
  xml = setAttr(xml, "SortOrder", String(plan.order));
  xml = setAttr(xml, "Order", String(plan.order));
  const prepType = String(connection.default_preparation_type_id || "");
  const prepOrder = String(connection.default_preparation_order_id || "");
  if ((prepType.length > 0) === (prepOrder.length > 0)) {
    xml = setAttr(xml, "PreparationTypeId", prepType);
    xml = setAttr(xml, "PreparationOrderId", prepOrder);
  }
  return `    ${xml.trim()}`;
}

function buildNewProductXml(plan, connection, priceLists, warehouses, defaultVatId) {
  const prepType = String(connection.default_preparation_type_id || "");
  const prepOrder = String(connection.default_preparation_order_id || "");
  const pricesXml = priceLists.map((pl) =>
    `        <Price PriceListId="${escapeXml(pl.Id)}" MainPrice="${plan.price.toFixed(2)}" AddinPrice="0.00" MenuItemPrice="0.00" />`,
  ).join("\n");
  const costPricesXml = warehouses.map((wh) =>
    `        <CostPrice WarehouseId="${escapeXml(wh.Id)}" CostPrice="${plan.cost.toFixed(2)}" />`,
  ).join("\n");
  return `    <Product SortOrder="${plan.order}" Order="${plan.order}" Id="${escapeXml(plan.productId)}" Name="${escapeXml(plan.productName)}" ButtonText="${escapeXml(truncate(plan.productName, 20))}" Color="${escapeXml(plan.color)}" PLU="" FamilyId="${escapeXml(plan.familyId)}" VatId="${escapeXml(defaultVatId)}" UseAsDirectSale="false" SaleableAsMain="true" SaleableAsAddin="false" IsSoldByWeight="false" AskForPreparationNotes="false" AskForAddins="false" PrintWhenPriceIsZero="false" PreparationTypeId="${escapeXml(prepType)}" PreparationOrderId="${escapeXml(prepOrder)}" CostPrice="${plan.cost.toFixed(2)}">
      <Prices>
${pricesXml}
      </Prices>
      <CostPrices>
${costPricesXml}
      </CostPrices>
    </Product>`;
}

function findDefaultVatId(connection, vats) {
  if (connection.default_vat_id) return String(connection.default_vat_id);
  const targetRate = asNumber(connection.default_vat_rate || 10) / 100;
  const found = vats.find((vat) => Math.abs(asNumber(vat.VatRate) - targetRate) < 0.0001);
  return String(found?.Id || vats[0]?.Id || "3");
}

function buildTargetPlan(target, wines, productById, productsByName, connection) {
  const selected = wines.filter((wine) => isEligible(target, wine)).sort(compareWineCode);
  const plans = [];
  const ambiguous = [];
  let order = 1;
  for (const wine of selected) {
    const format = actualFormatFor(target, wine);
    const productName = formatProductName(format, wine.name);
    const standardId = productIdFor(format, wine);
    const byId = productById.get(standardId);
    const byName = productsByName.get(productName) || [];
    let existing = null;
    let matchMethod = "NEW";
    if (byId?.name === productName) {
      existing = byId;
      matchMethod = "ID";
    } else if (byName.length === 1) {
      existing = byName[0];
      matchMethod = "NAME";
    } else if (byName.length > 1) {
      ambiguous.push({ productName, ids: byName.map((p) => p.id) });
      continue;
    } else if (byId) {
      existing = byId;
      matchMethod = "ID_NAME_MISMATCH";
    }
    plans.push({
      targetKey: target.key,
      familyId: target.familyId,
      familyName: target.familyName,
      color: target.color,
      order: order++,
      wine,
      wineName: wine.name,
      winerimWineId: String(wine.winerim_id),
      format,
      productId: existing?.id || standardId,
      productName,
      price: priceFor(format, wine),
      cost: costFor(format, wine),
      existedBefore: Boolean(existing),
      matchMethod,
      previous: existing ? {
        productId: existing.id,
        name: existing.name,
        familyId: existing.familyId,
        familyName: null,
        sortOrder: extractAttr(existing.xml, "SortOrder"),
        order: extractAttr(existing.xml, "Order"),
        useAsDirectSale: extractAttr(existing.xml, "UseAsDirectSale"),
        saleableAsMain: extractAttr(existing.xml, "SaleableAsMain"),
      } : null,
      existingXml: existing?.xml || null,
    });
  }
  return { selectedCount: selected.length, plans, ambiguous };
}

function buildXmlForTarget(target, plans, familyBefore, connection, priceLists, warehouses, vats) {
  const defaultVatId = findDefaultVatId(connection, vats);
  const existingOrder = familyBefore ? extractAttr(familyBefore.xml, "Order") : null;
  const familyOrder = existingOrder || String(18 + TARGETS.findIndex((t) => t.key === target.key));
  const familyXml = `    <Family Id="${escapeXml(target.familyId)}" Name="${escapeXml(target.familyName)}" ShowInPos="true" ButtonText="${escapeXml(truncate(target.familyName, 20))}" Color="${escapeXml(target.color)}" Order="${escapeXml(familyOrder)}" />`;
  const productXml = plans.map((plan) => plan.existingXml
    ? patchExistingProductXml(plan.existingXml, plan, connection)
    : buildNewProductXml(plan, connection, priceLists, warehouses, defaultVatId)
  ).join("\n");
  return `<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n<Import>\n  <Families>\n${familyXml}\n  </Families>\n  <Products>\n${productXml}\n  </Products>\n</Import>`;
}

function parseImportOk(status, text) {
  if (status >= 200 && status < 300 && !/<Error\b/i.test(text) && !/Exception|duplicate key|error/i.test(text)) return true;
  return false;
}

async function upsertMapping(plan) {
  const payload = {
    connection_id: CONNECTION_ID,
    provider_product_id: plan.productId,
    provider_product_name: plan.productName,
    winerim_wine_id: plan.winerimWineId,
    winerim_wine_name: plan.wineName,
    match_method: `XML_IMPORT_${plan.targetKey.toUpperCase()}`,
    match_score: 100,
    match_reasons: [`Sa Pedrera ${plan.familyName} controlled family sync`],
    status: "CONFIRMED",
    format_type: plan.format,
    agora_product_id: plan.productId,
    last_synced_at: new Date().toISOString(),
    last_sync_error: null,
  };
  await rest("product_mappings?on_conflict=connection_id,provider_product_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify(payload),
  });
}

async function upsertTracking(plan, familyId) {
  const rows = await rest(`winerim_push_tracking?select=id&connection_id=eq.${CONNECTION_ID}&winerim_wine_id=eq.${encodeURIComponent(plan.winerimWineId)}&format=eq.${plan.format}&limit=1`);
  const payload = {
    connection_id: CONNECTION_ID,
    winerim_wine_id: plan.winerimWineId,
    format: plan.format,
    source: "WINERIM",
    sync_status: "VERIFIED",
    agora_product_id: plan.productId,
    agora_family_id: familyId,
    pushed_at: new Date().toISOString(),
    verified_at: new Date().toISOString(),
    last_error: null,
  };
  if (rows?.[0]?.id) {
    await rest(`winerim_push_tracking?id=eq.${rows[0].id}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(payload),
    });
  } else {
    await rest("winerim_push_tracking", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(payload),
    });
  }
}

async function main() {
  const [connection] = await rest(`pos_connections?select=*&id=eq.${CONNECTION_ID}`);
  if (!connection) throw new Error("Sa Pedrera connection not found");
  if (!/sa\s*pedrera/i.test(connection.location_name || "")) {
    throw new Error(`Connection guard failed: ${connection.location_name}`);
  }
  if (!connection.api_token) throw new Error("Connection API token unavailable from Lovable Cloud");

  const masterRows = await rest(`agora_master_data?select=*&connection_id=eq.${CONNECTION_ID}`);
  const master = masterRows?.[0];
  if (!master) throw new Error("No Agora master data cached");

  const wines = await rest(`winerim_wines?select=*&connection_id=eq.${CONNECTION_ID}&is_active=eq.true&limit=2000`);
  const baseUrl = String(connection.base_url).replace(/\/+$/, "");
  const productsRes = await fetchXml(`${baseUrl}/api/export-master/?filter=Products`, connection.api_token);
  if (!productsRes.ok) throw new Error(`Products export failed HTTP ${productsRes.status}: ${productsRes.text.slice(0, 300)}`);
  const familiesRes = await fetchXml(`${baseUrl}/api/export-master/?filter=Families`, connection.api_token);
  if (!familiesRes.ok) throw new Error(`Families export failed HTTP ${familiesRes.status}: ${familiesRes.text.slice(0, 300)}`);

  const products = indexElements(productsRes.text, "Product");
  const families = indexElements(familiesRes.text, "Family");
  const productById = new Map(products.map((p) => [String(p.id), p]));
  const productsByName = new Map();
  for (const product of products) {
    if (!product.name) continue;
    const list = productsByName.get(product.name) || [];
    list.push(product);
    productsByName.set(product.name, list);
  }
  const familyById = new Map(families.map((f) => [String(f.id), f]));
  const priceLists = (master.price_lists_json || []).filter((pl) => !pl.DeletionDate);
  const warehouses = master.warehouses_json || [];
  const vats = master.vats_json || [];

  const selectedTargets = TARGETS.filter((target) => !ONLY || ONLY.has(target.key));
  const snapshot = {
    generatedAt: new Date().toISOString(),
    connectionId: CONNECTION_ID,
    location: connection.location_name,
    apply: APPLY,
    targetKeys: selectedTargets.map((t) => t.key),
    families: [],
  };

  let totalPlans = 0;
  for (const target of selectedTargets) {
    const { selectedCount, plans, ambiguous } = buildTargetPlan(target, wines, productById, productsByName, connection);
    if (ambiguous.length) {
      throw new Error(`${target.key}: ambiguous existing products ${JSON.stringify(ambiguous.slice(0, 10))}`);
    }
    const familyBefore = familyById.get(target.familyId) || null;
    snapshot.families.push({
      key: target.key,
      familyId: target.familyId,
      familyName: target.familyName,
      selectedCount,
      plannedCount: plans.length,
      existingCount: plans.filter((p) => p.existedBefore).length,
      newCount: plans.filter((p) => !p.existedBefore).length,
      familyBefore: familyBefore ? {
        id: familyBefore.id,
        name: familyBefore.name,
        showInPos: extractAttr(familyBefore.xml, "ShowInPos"),
        order: extractAttr(familyBefore.xml, "Order"),
        deletionDate: extractAttr(familyBefore.xml, "DeletionDate"),
      } : null,
      products: plans.map((p) => ({
        code: commercialCode(p.wineName)?.value || null,
        order: p.order,
        winerimWineId: p.winerimWineId,
        productId: p.productId,
        name: p.productName,
        format: p.format,
        price: p.price,
        existedBefore: p.existedBefore,
        matchMethod: p.matchMethod,
        previous: p.previous,
        after: {
          familyId: target.familyId,
          familyName: target.familyName,
          useAsDirectSale: "false",
          saleableAsMain: "true",
        },
      })),
    });
    totalPlans += plans.length;

    console.log(`${APPLY ? "APPLY" : "DRY"} ${target.key}: selected=${selectedCount} planned=${plans.length} existing=${plans.filter((p) => p.existedBefore).length} new=${plans.filter((p) => !p.existedBefore).length}`);
    if (!APPLY) continue;
    if (plans.length === 0) continue;

    const xml = buildXmlForTarget(target, plans, familyBefore, connection, priceLists, warehouses, vats);
    const importRes = await fetchXml(`${baseUrl}/api/import/`, connection.api_token, { method: "POST", body: xml });
    if (!parseImportOk(importRes.status, importRes.text)) {
      snapshot.failedAt = target.key;
      snapshot.failedImport = { status: importRes.status, body: importRes.text.slice(0, 1000), xml };
      throw new Error(`${target.key}: Agora import failed HTTP ${importRes.status}: ${importRes.text.slice(0, 500)}`);
    }

    for (const plan of plans) {
      await upsertMapping(plan);
      await upsertTracking(plan, target.familyId);
    }

    const verifyRes = await fetchXml(`${baseUrl}/api/export-master/?filter=Products`, connection.api_token);
    if (!verifyRes.ok) throw new Error(`${target.key}: verification export failed HTTP ${verifyRes.status}`);
    const verifyProducts = indexElements(verifyRes.text, "Product");
    const verifyById = new Map(verifyProducts.map((p) => [String(p.id), p]));
    const bad = [];
    for (const plan of plans) {
      const product = verifyById.get(plan.productId);
      const familyId = product?.xml ? extractAttr(product.xml, "FamilyId") : null;
      const saleable = product?.xml ? extractAttr(product.xml, "SaleableAsMain") : null;
      const direct = product?.xml ? extractAttr(product.xml, "UseAsDirectSale") : null;
      const name = product?.xml ? extractAttr(product.xml, "Name") : null;
      if (familyId !== target.familyId || saleable !== "true" || direct !== "false" || name !== plan.productName) {
        bad.push({ productId: plan.productId, name, familyId, saleable, direct, expectedName: plan.productName });
      }
    }
    if (bad.length) {
      snapshot.failedAt = `${target.key}:verify`;
      snapshot.verificationBad = bad;
      throw new Error(`${target.key}: verification failed for ${bad.length} products`);
    }
    console.log(`VERIFIED ${target.key}: ${plans.length}/${plans.length}`);
  }

  const outName = APPLY
    ? `SA_PEDRERA_WINERIM_FAMILIES_APPLIED_2026-06-09.json`
    : `SA_PEDRERA_WINERIM_FAMILIES_DRY_RUN_2026-06-09.json`;
  fs.writeFileSync(outName, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(`snapshot=${outName} totalPlans=${totalPlans}`);

  if (APPLY && !SKIP_SYNC_MASTER) {
    const sync = await functionInvoke("agora-proxy", { action: "sync-master-data", connectionId: CONNECTION_ID, forceRefresh: true });
    console.log(`syncMaster=${sync?.success === true ? "ok" : "check"} products=${sync?.counts?.products ?? sync?.productCount ?? "?"} families=${sync?.counts?.families ?? sync?.familyCount ?? "?"}`);
  } else if (APPLY) {
    console.log("syncMaster=skipped");
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
