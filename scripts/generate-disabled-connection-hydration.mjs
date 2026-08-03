#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/;
const FORMAT_TO_STOCK_VARIANT = Object.freeze({
  BOTTLE: "botella",
  GLASS: "copa",
  MAGNUM: "magnum",
});
const OUTPUT_FILES = Object.freeze({
  plan: "hydration-plan.json",
  sql: "hydrate-disabled-connection.sql",
  manifest: "manifest.sha256",
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sqlText(value) {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlJson(value) {
  return `${sqlText(canonicalJson(value))}::jsonb`;
}

function sqlNumber(value) {
  if (value === null || value === undefined || value === "") return "NULL";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) throw new Error("HYDRATION_NON_FINITE_NUMBER");
  return String(numeric);
}

function sqlBoolean(value) {
  return value === true ? "true" : "false";
}

function sqlTextArray(values) {
  return `ARRAY[${values.map(sqlText).join(", ")}]::text[]`;
}

function assertPlainObject(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value;
}

function exactArray(value, code) {
  if (!Array.isArray(value)) throw new Error(code);
  return value;
}

function normalizeId(value, code) {
  const id = String(value ?? "").trim();
  if (!POSITIVE_INTEGER_PATTERN.test(id)) throw new Error(code);
  return id;
}

function decodeXmlAttribute(value) {
  return value.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|apos|quot|lt|gt);/g, (entity, body) => {
    if (body === "amp") return "&";
    if (body === "apos") return "'";
    if (body === "quot") return '"';
    if (body === "lt") return "<";
    if (body === "gt") return ">";
    const codePoint = body.startsWith("#x")
      ? Number.parseInt(body.slice(2), 16)
      : Number.parseInt(body.slice(1), 10);
    if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
      throw new Error("HYDRATION_XML_INVALID_ENTITY");
    }
    return String.fromCodePoint(codePoint);
  }).replace(/&[^;\s]+;/g, () => {
    throw new Error("HYDRATION_XML_UNKNOWN_ENTITY");
  });
}

function parseAttributes(source) {
  const attributes = {};
  let offset = 0;
  while (offset < source.length) {
    const whitespace = source.slice(offset).match(/^\s+/);
    if (whitespace) offset += whitespace[0].length;
    if (offset >= source.length) break;
    const match = source.slice(offset).match(/^([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/);
    if (!match) throw new Error("HYDRATION_XML_INVALID_ATTRIBUTE");
    const [, name, , doubleQuoted, singleQuoted] = match;
    if (Object.hasOwn(attributes, name)) throw new Error(`HYDRATION_XML_DUPLICATE_ATTRIBUTE_${name}`);
    attributes[name] = decodeXmlAttribute(doubleQuoted ?? singleQuoted ?? "");
    offset += match[0].length;
  }
  return attributes;
}

/**
 * Strict structural parser for the subset emitted by Agora export-master.
 * It deliberately rejects DTDs, entities, CDATA and mixed-content XML.
 */
export function parseAgoraMasterXml(xmlInput) {
  const xml = String(xmlInput ?? "").replace(/^\uFEFF/, "");
  if (!xml.trim()) throw new Error("HYDRATION_MASTER_XML_EMPTY");
  if (/<!DOCTYPE|<!ENTITY|<!\[CDATA\[/i.test(xml)) throw new Error("HYDRATION_XML_UNSAFE_DECLARATION");

  const tokenPattern = /<\?[^?]*\?>|<!--[\s\S]*?-->|<\/\s*[A-Za-z_][A-Za-z0-9_.:-]*\s*>|<[A-Za-z_][A-Za-z0-9_.:-]*(?:\s+[\s\S]*?)?\s*\/?>/g;
  const stack = [];
  let root = null;
  let cursor = 0;
  let match;

  while ((match = tokenPattern.exec(xml)) !== null) {
    const text = xml.slice(cursor, match.index);
    if (text.trim()) throw new Error("HYDRATION_XML_MIXED_CONTENT_NOT_ALLOWED");
    cursor = tokenPattern.lastIndex;
    const token = match[0];
    if (token.startsWith("<?") || token.startsWith("<!--")) continue;

    if (token.startsWith("</")) {
      const name = token.match(/^<\/\s*([A-Za-z_][A-Za-z0-9_.:-]*)\s*>$/)?.[1];
      const current = stack.pop();
      if (!name || !current || current.name !== name) throw new Error("HYDRATION_XML_UNBALANCED_TAG");
      continue;
    }

    const selfClosing = /\/\s*>$/.test(token);
    const body = token.slice(1, selfClosing ? token.lastIndexOf("/") : -1).trim();
    const nameMatch = body.match(/^([A-Za-z_][A-Za-z0-9_.:-]*)/);
    if (!nameMatch) throw new Error("HYDRATION_XML_INVALID_TAG");
    const node = {
      name: nameMatch[1],
      attributes: parseAttributes(body.slice(nameMatch[0].length)),
      children: [],
    };
    if (stack.length) stack.at(-1).children.push(node);
    else if (root) throw new Error("HYDRATION_XML_MULTIPLE_ROOTS");
    else root = node;
    if (!selfClosing) stack.push(node);
  }

  if (xml.slice(cursor).trim()) throw new Error("HYDRATION_XML_TRAILING_CONTENT");
  if (stack.length || !root) throw new Error("HYDRATION_XML_UNBALANCED_TAG");
  if (root.name !== "Export") throw new Error("HYDRATION_XML_EXPECTED_EXPORT_ROOT");

  const sections = (name) => root.children.filter((child) => child.name === name);
  const familiesSections = sections("Families");
  const productsSections = sections("Products");
  if (familiesSections.length !== 1 || productsSections.length !== 1) {
    throw new Error("HYDRATION_XML_EXPECTED_SINGLE_FAMILIES_AND_PRODUCTS");
  }
  if (familiesSections[0].children.some((node) => node.name !== "Family")) {
    throw new Error("HYDRATION_XML_UNEXPECTED_FAMILIES_CHILD");
  }
  if (productsSections[0].children.some((node) => node.name !== "Product")) {
    throw new Error("HYDRATION_XML_UNEXPECTED_PRODUCTS_CHILD");
  }

  const families = familiesSections[0].children.map((node) => ({ ...node.attributes }));
  const products = productsSections[0].children.map((node) => {
    const pricesContainer = node.children.filter((child) => child.name === "Prices");
    if (pricesContainer.length > 1) throw new Error("HYDRATION_XML_MULTIPLE_PRICES_CONTAINERS");
    const prices = pricesContainer.flatMap((container) => container.children.map((price) => {
      if (price.name !== "Price") throw new Error("HYDRATION_XML_UNEXPECTED_PRICES_CHILD");
      return { ...price.attributes };
    }));
    return { attributes: { ...node.attributes }, prices };
  });

  const familyIds = new Set();
  for (const family of families) {
    const id = normalizeId(family.Id, "HYDRATION_MASTER_INVALID_FAMILY_ID");
    if (familyIds.has(id)) throw new Error(`HYDRATION_MASTER_DUPLICATE_FAMILY_${id}`);
    familyIds.add(id);
  }
  const productIds = new Set();
  for (const product of products) {
    const id = normalizeId(product.attributes.Id, "HYDRATION_MASTER_INVALID_PRODUCT_ID");
    if (productIds.has(id)) throw new Error(`HYDRATION_MASTER_DUPLICATE_PRODUCT_${id}`);
    productIds.add(id);
  }
  return { families, products };
}

function normalizeCurrentWines(winesDocument, stockDocument) {
  const wines = exactArray(winesDocument?.wines, "HYDRATION_WINERIM_WINES_ARRAY_REQUIRED");
  const stocks = exactArray(stockDocument?.stocks, "HYDRATION_WINERIM_STOCKS_ARRAY_REQUIRED");
  if (winesDocument?.success !== true || stockDocument?.success !== true) {
    throw new Error("HYDRATION_WINERIM_SOURCE_NOT_SUCCESSFUL");
  }
  const wineById = new Map();
  for (const rawWine of wines) {
    const wine = assertPlainObject(rawWine, "HYDRATION_WINERIM_WINE_INVALID");
    const id = normalizeId(wine.id, "HYDRATION_WINERIM_WINE_ID_INVALID");
    if (wineById.has(id)) throw new Error(`HYDRATION_WINERIM_DUPLICATE_WINE_${id}`);
    if (!String(wine.name ?? "").trim()) throw new Error(`HYDRATION_WINERIM_WINE_NAME_MISSING_${id}`);
    wineById.set(id, wine);
  }

  const stocksByWineVariant = new Map();
  for (const rawStock of stocks) {
    const stock = assertPlainObject(rawStock, "HYDRATION_WINERIM_STOCK_INVALID");
    const stockId = normalizeId(stock.id, "HYDRATION_WINERIM_STOCK_ID_INVALID");
    const wineId = normalizeId(stock.winePrice?.wine?.id, "HYDRATION_WINERIM_STOCK_WINE_ID_INVALID");
    const variant = String(stock.winePrice?.variant ?? "").trim().toLowerCase();
    if (!variant) throw new Error(`HYDRATION_WINERIM_STOCK_VARIANT_MISSING_${stockId}`);
    const key = `${wineId}:${variant}`;
    const entries = stocksByWineVariant.get(key) ?? [];
    entries.push({ ...stock, id: Number(stockId), wineId, variant });
    stocksByWineVariant.set(key, entries);
  }

  const cacheRows = [...wineById.entries()].map(([wineId, wine]) => {
    const variants = {};
    for (const [formatType, stockVariant] of Object.entries(FORMAT_TO_STOCK_VARIANT)) {
      const candidates = stocksByWineVariant.get(`${wineId}:${stockVariant}`) ?? [];
      variants[formatType] = candidates.length === 1 ? candidates[0] : null;
    }
    const allStocks = [...stocksByWineVariant.entries()]
      .filter(([key]) => key.startsWith(`${wineId}:`))
      .flatMap(([, entries]) => entries)
      .sort((left, right) => left.id - right.id);
    const bottle = variants.BOTTLE;
    const glass = variants.GLASS;
    const magnum = variants.MAGNUM;
    const fallback = bottle ?? glass ?? magnum ?? allStocks[0] ?? null;
    return {
      winerimId: wineId,
      name: String(wine.name).trim(),
      sku: wine.sku == null ? null : String(wine.sku),
      ean: wine.ean == null ? null : String(wine.ean),
      vintage: wine.vintage == null ? null : String(wine.vintage),
      winery: wine.winery == null ? null : String(wine.winery),
      region: wine.region == null ? null : String(wine.region),
      grapeVariety: wine.grape_variety == null ? null : String(wine.grape_variety),
      wineType: wine.type == null ? null : String(wine.type),
      price: fallback ? Number(fallback.winePrice?.price) : null,
      stockQuantity: bottle ? Number(bottle.stock) : null,
      bottleSalePrice: bottle ? Number(bottle.winePrice?.price) : null,
      glassSalePrice: glass ? Number(glass.winePrice?.price) : null,
      magnumSalePrice: magnum ? Number(magnum.winePrice?.price) : null,
      bottleStockId: bottle?.id ?? null,
      glassStockId: glass?.id ?? null,
      magnumStockId: magnum?.id ?? null,
      serveByGlass: Boolean(glass),
      pricingStatus: fallback ? "READY" : "MISSING",
      pricingMissingReason: fallback ? null : "NO_CURRENT_STOCK_VARIANT",
      rawPayload: { wine, stocks: allStocks.map(({ wineId: _wineId, variant: _variant, ...entry }) => entry) },
    };
  }).sort((left, right) => Number(left.winerimId) - Number(right.winerimId));

  return { wineById, stocksByWineVariant, cacheRows };
}

function providerProductRows(master, acceptedMappings) {
  const mappingByProduct = new Map(acceptedMappings.map((mapping) => [mapping.providerProductId, mapping]));
  const familyNames = new Map(master.families.map((family) => [String(family.Id), String(family.Name ?? "")]));
  return master.products.map((product) => {
    const attributes = product.attributes;
    const providerProductId = String(attributes.Id);
    const accepted = mappingByProduct.get(providerProductId) ?? null;
    const primaryPrice = product.prices[0]?.MainPrice ?? 0;
    return {
      providerProductId,
      name: String(attributes.Name ?? "").trim(),
      family: familyNames.get(String(attributes.FamilyId ?? "")) ?? null,
      vatRate: 0,
      saleFormat: accepted?.formatType ?? null,
      price: Number(primaryPrice),
      isWineCandidate: Boolean(accepted),
      wineScore: accepted ? 100 : 0,
      wineReasons: accepted ? ["RESCUE_EXACT_ID_WINE_VARIANT"] : [],
      winerimWineId: accepted?.winerimWineId ?? null,
      rawPayload: { attributes, prices: product.prices },
    };
  }).sort((left, right) => Number(left.providerProductId) - Number(right.providerProductId));
}

export function buildDisabledConnectionHydration({
  connectionId,
  snapshot,
  masterXml,
  winesDocument,
  stockDocument,
  generatedAt = new Date().toISOString(),
  sourceDigests = null,
}) {
  if (!UUID_PATTERN.test(String(connectionId ?? ""))) throw new Error("HYDRATION_CONNECTION_ID_INVALID");
  const snapshotObject = assertPlainObject(snapshot, "HYDRATION_SNAPSHOT_INVALID");
  const snapshotConnection = assertPlainObject(snapshotObject.connection?.data, "HYDRATION_SNAPSHOT_CONNECTION_REQUIRED");
  if (String(snapshotConnection.id) !== connectionId) throw new Error("HYDRATION_SNAPSHOT_CONNECTION_MISMATCH");
  const mappings = exactArray(snapshotObject.mappings?.data, "HYDRATION_SNAPSHOT_MAPPINGS_REQUIRED");
  const master = parseAgoraMasterXml(masterXml);
  const productById = new Map(master.products.map((product) => [String(product.attributes.Id), product]));
  const { wineById, stocksByWineVariant, cacheRows } = normalizeCurrentWines(winesDocument, stockDocument);
  const mappingIdCounts = new Map();
  for (const mapping of mappings) {
    const providerProductId = String(mapping?.provider_product_id ?? "").trim();
    mappingIdCounts.set(providerProductId, (mappingIdCounts.get(providerProductId) ?? 0) + 1);
  }

  const acceptedMappings = [];
  const rejectedMappings = [];
  for (const mapping of mappings) {
    const providerProductId = String(mapping?.provider_product_id ?? "").trim();
    const winerimWineId = String(mapping?.winerim_wine_id ?? "").trim();
    const formatType = String(mapping?.format_type ?? "").trim().toUpperCase();
    let rejection = null;
    if (mapping?.status !== "CONFIRMED") rejection = "MAPPING_STATUS_NOT_CONFIRMED";
    else if (!POSITIVE_INTEGER_PATTERN.test(providerProductId) || !productById.has(providerProductId)) rejection = "PROVIDER_PRODUCT_NOT_IN_CURRENT_MASTER";
    else if ((mappingIdCounts.get(providerProductId) ?? 0) !== 1) rejection = "AMBIGUOUS_PROVIDER_PRODUCT_MAPPING";
    else if (!POSITIVE_INTEGER_PATTERN.test(winerimWineId) || !wineById.has(winerimWineId)) rejection = "WINERIM_WINE_NOT_CURRENT";
    else if (!Object.hasOwn(FORMAT_TO_STOCK_VARIANT, formatType)) rejection = "UNSUPPORTED_FORMAT_TYPE";
    else {
      const stockCandidates = stocksByWineVariant.get(`${winerimWineId}:${FORMAT_TO_STOCK_VARIANT[formatType]}`) ?? [];
      if (stockCandidates.length === 0) rejection = "STOCK_VARIANT_NOT_CURRENT";
      else if (stockCandidates.length !== 1) rejection = "AMBIGUOUS_STOCK_VARIANT";
      else {
        const providerProduct = productById.get(providerProductId);
        const wine = wineById.get(winerimWineId);
        acceptedMappings.push({
          providerProductId,
          providerProductName: String(providerProduct.attributes.Name ?? mapping.provider_product_name ?? "").trim(),
          winerimWineId,
          winerimWineName: String(wine.name).trim(),
          formatType,
          stockVariant: FORMAT_TO_STOCK_VARIANT[formatType],
          stockId: stockCandidates[0].id,
          status: "CONFIRMED",
          matchMethod: "RESCUE_EXACT_ID_WINE_VARIANT",
        });
      }
    }
    if (rejection) {
      rejectedMappings.push({
        providerProductId: providerProductId || null,
        providerProductName: mapping?.provider_product_name ?? null,
        winerimWineId: winerimWineId || null,
        winerimWineName: mapping?.winerim_wine_name ?? null,
        formatType: formatType || null,
        reason: rejection,
      });
    }
  }
  acceptedMappings.sort((left, right) => Number(left.providerProductId) - Number(right.providerProductId));
  rejectedMappings.sort((left, right) => Number(left.providerProductId ?? 0) - Number(right.providerProductId ?? 0));

  const rejectionCounts = {};
  for (const rejected of rejectedMappings) rejectionCounts[rejected.reason] = (rejectionCounts[rejected.reason] ?? 0) + 1;
  const providers = providerProductRows(master, acceptedMappings);
  const plan = {
    schemaVersion: 1,
    kind: "disabled-connection-hydration",
    generatedAt,
    connectionId,
    locationName: String(snapshotConnection.location_name ?? ""),
    sourceDigests,
    sourceSnapshotState: {
      enabled: snapshotConnection.enabled === true,
      catalogSyncEnabled: snapshotConnection.catalog_sync_enabled === true,
      writeMode: String(snapshotConnection.write_mode ?? ""),
      informationalOnly: true,
    },
    requiredTargetStateBeforeAndAfter: {
      enabled: false,
      catalogSyncEnabled: false,
      writeMode: "NONE",
    },
    forbiddenWrites: [
      "credentials",
      "provider_config",
      "cursors",
      "sales",
      "stock_sync_log",
      "outbound_tasks",
      "runtime_canary_connections",
      "activation",
    ],
    counts: {
      snapshotMappings: mappings.length,
      acceptedMappings: acceptedMappings.length,
      rejectedMappings: rejectedMappings.length,
      currentWinerimWines: cacheRows.length,
      currentWinerimStocks: stockDocument.stocks.length,
      currentAgoraFamilies: master.families.length,
      currentAgoraProducts: master.products.length,
    },
    rejectedByReason: rejectionCounts,
    acceptedMappings,
    rejectedMappings,
    winerimWines: cacheRows,
    providerProducts: providers,
    agoraMasterData: {
      families: master.families,
      productsSummary: providers.map((product) => ({
        provider_product_id: product.providerProductId,
        name: product.name,
        family: product.family,
        price: product.price,
        sale_format: product.saleFormat,
        winerim_wine_id: product.winerimWineId,
        raw_payload: product.rawPayload,
      })),
    },
  };
  return plan;
}

function valuesRows(rows) {
  if (!rows.length) throw new Error("HYDRATION_SQL_EMPTY_VALUES_NOT_ALLOWED");
  return rows.map((row) => `  (${row.join(", ")})`).join(",\n");
}

export function renderHydrationSql(plan) {
  if (plan?.kind !== "disabled-connection-hydration" || !UUID_PATTERN.test(String(plan.connectionId ?? ""))) {
    throw new Error("HYDRATION_PLAN_INVALID");
  }
  if (!plan.acceptedMappings.length || !plan.winerimWines.length || !plan.providerProducts.length) {
    throw new Error("HYDRATION_PLAN_EMPTY_DATASET");
  }
  const connectionId = plan.connectionId;
  const expectedWineIds = plan.winerimWines.map((wine) => sqlText(wine.winerimId));
  const expectedProviderIds = plan.providerProducts.map((product) => sqlText(product.providerProductId));
  const expectedMappingRows = plan.acceptedMappings.map((mapping) => [
    sqlText(mapping.providerProductId),
    sqlText(mapping.winerimWineId),
    sqlText(mapping.formatType),
  ]);

  const wineRows = plan.winerimWines.map((wine) => [
    sqlText(connectionId), sqlText(wine.winerimId), sqlText(wine.name), sqlText(wine.sku), sqlText(wine.ean),
    sqlText(wine.vintage), sqlText(wine.winery), sqlText(wine.region), sqlText(wine.grapeVariety), "NULL",
    sqlNumber(wine.price), sqlNumber(wine.stockQuantity), sqlJson(wine.rawPayload), sqlText(wine.wineType),
    sqlNumber(wine.bottleSalePrice), "NULL", sqlNumber(wine.glassSalePrice), "NULL", sqlNumber(wine.magnumSalePrice), "NULL",
    sqlBoolean(wine.serveByGlass), "true", sqlText(wine.pricingStatus), sqlText(wine.pricingMissingReason),
    sqlNumber(wine.glassStockId), sqlNumber(wine.bottleStockId), sqlNumber(wine.magnumStockId),
  ]);
  const providerRows = plan.providerProducts.map((product) => [
    sqlText(connectionId), sqlText(product.providerProductId), sqlText(product.name), sqlText(product.family),
    sqlNumber(product.vatRate), sqlText(product.saleFormat), sqlNumber(product.price), sqlBoolean(product.isWineCandidate),
    sqlNumber(product.wineScore), sqlTextArray(product.wineReasons), sqlJson(product.rawPayload), sqlText(product.winerimWineId),
  ]);
  const mappingRows = plan.acceptedMappings.map((mapping) => [
    sqlText(connectionId), sqlText(mapping.providerProductId), sqlText(mapping.providerProductName),
    sqlText(mapping.winerimWineId), sqlText(mapping.winerimWineName), sqlText(mapping.matchMethod), "1",
    sqlTextArray(["CURRENT_AGORA_PRODUCT_ID", "CURRENT_WINERIM_WINE_ID", `CURRENT_${mapping.formatType}_STOCK_ID_${mapping.stockId}`]),
    sqlText("CONFIRMED"), sqlText(mapping.formatType), sqlText(mapping.providerProductId),
  ]);

  return `\\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL idle_in_transaction_session_timeout = '60s';

-- Fail closed before taking any catalog/cache action.
DO $hydration_guard$
DECLARE target_count integer;
BEGIN
  SELECT count(*) INTO target_count
  FROM public.pos_connections
  WHERE id = ${sqlText(connectionId)}::uuid
    AND enabled IS FALSE
    AND catalog_sync_enabled IS FALSE
    AND write_mode = 'NONE';
  IF target_count <> 1 THEN
    RAISE EXCEPTION 'HYDRATION_TARGET_NOT_DISABLED_CATALOG_OFF_WRITE_NONE';
  END IF;
END
$hydration_guard$;

CREATE TEMP TABLE hydration_expected_wines (winerim_id text PRIMARY KEY) ON COMMIT DROP;
INSERT INTO hydration_expected_wines (winerim_id) VALUES
${valuesRows(expectedWineIds.map((id) => [id]))};

CREATE TEMP TABLE hydration_expected_products (provider_product_id text PRIMARY KEY) ON COMMIT DROP;
INSERT INTO hydration_expected_products (provider_product_id) VALUES
${valuesRows(expectedProviderIds.map((id) => [id]))};

CREATE TEMP TABLE hydration_expected_mappings (
  provider_product_id text PRIMARY KEY,
  winerim_wine_id text NOT NULL,
  format_type text NOT NULL
) ON COMMIT DROP;
INSERT INTO hydration_expected_mappings (provider_product_id, winerim_wine_id, format_type) VALUES
${valuesRows(expectedMappingRows)};

-- A previous hydration may be replayed, but unexpected cache/mapping rows abort.
DO $hydration_existing_scope$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.winerim_wines row
    WHERE row.connection_id = ${sqlText(connectionId)}::uuid
      AND NOT EXISTS (SELECT 1 FROM hydration_expected_wines expected WHERE expected.winerim_id = row.winerim_id)
  ) THEN RAISE EXCEPTION 'HYDRATION_UNEXPECTED_EXISTING_WINERIM_WINE'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.provider_products row
    WHERE row.connection_id = ${sqlText(connectionId)}::uuid
      AND NOT EXISTS (SELECT 1 FROM hydration_expected_products expected WHERE expected.provider_product_id = row.provider_product_id)
  ) THEN RAISE EXCEPTION 'HYDRATION_UNEXPECTED_EXISTING_PROVIDER_PRODUCT'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.product_mappings row
    WHERE row.connection_id = ${sqlText(connectionId)}::uuid
      AND NOT EXISTS (
        SELECT 1 FROM hydration_expected_mappings expected
        WHERE expected.provider_product_id = row.provider_product_id
          AND expected.winerim_wine_id = row.winerim_wine_id
          AND expected.format_type = row.format_type
          AND row.status = 'CONFIRMED'
      )
  ) THEN RAISE EXCEPTION 'HYDRATION_UNEXPECTED_OR_NONCONFIRMED_EXISTING_MAPPING'; END IF;
END
$hydration_existing_scope$;

INSERT INTO public.winerim_wines (
  connection_id, winerim_id, name, sku, ean, vintage, winery, region, grape_variety, format,
  price, stock_quantity, raw_payload, wine_type, bottle_sale_price, bottle_purchase_price,
  glass_sale_price, glass_cost_price, magnum_sale_price, magnum_purchase_price, serve_by_glass,
  is_active, pricing_status, pricing_missing_reason, glass_stock_id, bottle_stock_id, magnum_stock_id
) VALUES
${valuesRows(wineRows)}
ON CONFLICT (connection_id, winerim_id) DO UPDATE SET
  name = EXCLUDED.name, sku = EXCLUDED.sku, ean = EXCLUDED.ean, vintage = EXCLUDED.vintage,
  winery = EXCLUDED.winery, region = EXCLUDED.region, grape_variety = EXCLUDED.grape_variety,
  format = EXCLUDED.format, price = EXCLUDED.price, stock_quantity = EXCLUDED.stock_quantity,
  raw_payload = EXCLUDED.raw_payload, wine_type = EXCLUDED.wine_type,
  bottle_sale_price = EXCLUDED.bottle_sale_price, bottle_purchase_price = EXCLUDED.bottle_purchase_price,
  glass_sale_price = EXCLUDED.glass_sale_price, glass_cost_price = EXCLUDED.glass_cost_price,
  magnum_sale_price = EXCLUDED.magnum_sale_price, magnum_purchase_price = EXCLUDED.magnum_purchase_price,
  serve_by_glass = EXCLUDED.serve_by_glass, is_active = EXCLUDED.is_active,
  pricing_status = EXCLUDED.pricing_status, pricing_missing_reason = EXCLUDED.pricing_missing_reason,
  glass_stock_id = EXCLUDED.glass_stock_id, bottle_stock_id = EXCLUDED.bottle_stock_id,
  magnum_stock_id = EXCLUDED.magnum_stock_id;

INSERT INTO public.provider_products (
  connection_id, provider_product_id, name, family, vat_rate, sale_format, price,
  is_wine_candidate, wine_score, wine_reasons, raw_payload, winerim_wine_id
) VALUES
${valuesRows(providerRows)}
ON CONFLICT (connection_id, provider_product_id) DO UPDATE SET
  name = EXCLUDED.name, family = EXCLUDED.family, vat_rate = EXCLUDED.vat_rate,
  sale_format = EXCLUDED.sale_format, price = EXCLUDED.price,
  is_wine_candidate = EXCLUDED.is_wine_candidate, wine_score = EXCLUDED.wine_score,
  wine_reasons = EXCLUDED.wine_reasons, raw_payload = EXCLUDED.raw_payload,
  winerim_wine_id = EXCLUDED.winerim_wine_id;

INSERT INTO public.agora_master_data (
  connection_id, families_json, vats_json, price_lists_json, preparation_types_json,
  preparation_orders_json, warehouses_json, products_summary_json, raw_xml_preview,
  fetched_at, sale_points_json, sale_centers_json
) VALUES (
  ${sqlText(connectionId)}::uuid, ${sqlJson(plan.agoraMasterData.families)}, '[]'::jsonb, '[]'::jsonb,
  '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, ${sqlJson(plan.agoraMasterData.productsSummary)},
  NULL, ${sqlText(plan.generatedAt)}::timestamptz, '[]'::jsonb, '[]'::jsonb
)
ON CONFLICT (connection_id) DO UPDATE SET
  families_json = EXCLUDED.families_json, vats_json = EXCLUDED.vats_json,
  price_lists_json = EXCLUDED.price_lists_json, preparation_types_json = EXCLUDED.preparation_types_json,
  preparation_orders_json = EXCLUDED.preparation_orders_json, warehouses_json = EXCLUDED.warehouses_json,
  products_summary_json = EXCLUDED.products_summary_json, raw_xml_preview = NULL,
  fetched_at = EXCLUDED.fetched_at, sale_points_json = EXCLUDED.sale_points_json,
  sale_centers_json = EXCLUDED.sale_centers_json;

INSERT INTO public.product_mappings (
  connection_id, provider_product_id, provider_product_name, winerim_wine_id,
  winerim_wine_name, match_method, match_score, match_reasons, status,
  format_type, agora_product_id
) VALUES
${valuesRows(mappingRows)}
ON CONFLICT (connection_id, provider_product_id) DO UPDATE SET
  provider_product_name = EXCLUDED.provider_product_name,
  winerim_wine_id = EXCLUDED.winerim_wine_id,
  winerim_wine_name = EXCLUDED.winerim_wine_name,
  match_method = EXCLUDED.match_method,
  match_score = EXCLUDED.match_score,
  match_reasons = EXCLUDED.match_reasons,
  status = 'CONFIRMED',
  format_type = EXCLUDED.format_type,
  agora_product_id = EXCLUDED.agora_product_id,
  last_sync_error = NULL;

-- Exact postconditions, including the connection kill switches.
DO $hydration_postcondition$
DECLARE wine_count integer; provider_count integer; mapping_count integer; master_count integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.pos_connections
    WHERE id = ${sqlText(connectionId)}::uuid
      AND enabled IS FALSE AND catalog_sync_enabled IS FALSE AND write_mode = 'NONE'
  ) THEN RAISE EXCEPTION 'HYDRATION_TARGET_STATE_CHANGED'; END IF;
  SELECT count(*) INTO wine_count FROM public.winerim_wines WHERE connection_id = ${sqlText(connectionId)}::uuid;
  SELECT count(*) INTO provider_count FROM public.provider_products WHERE connection_id = ${sqlText(connectionId)}::uuid;
  SELECT count(*) INTO mapping_count FROM public.product_mappings WHERE connection_id = ${sqlText(connectionId)}::uuid AND status = 'CONFIRMED';
  SELECT count(*) INTO master_count FROM public.agora_master_data WHERE connection_id = ${sqlText(connectionId)}::uuid;
  IF wine_count <> ${plan.counts.currentWinerimWines}
    OR provider_count <> ${plan.counts.currentAgoraProducts}
    OR mapping_count <> ${plan.counts.acceptedMappings}
    OR master_count <> 1
  THEN RAISE EXCEPTION 'HYDRATION_POSTCONDITION_COUNT_MISMATCH wines=% providers=% mappings=% master=%', wine_count, provider_count, mapping_count, master_count;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.product_mappings row
    WHERE row.connection_id = ${sqlText(connectionId)}::uuid
      AND (row.status <> 'CONFIRMED' OR NOT EXISTS (
        SELECT 1 FROM hydration_expected_mappings expected
        WHERE expected.provider_product_id = row.provider_product_id
          AND expected.winerim_wine_id = row.winerim_wine_id
          AND expected.format_type = row.format_type
      ))
  ) THEN RAISE EXCEPTION 'HYDRATION_POSTCONDITION_UNEXPECTED_MAPPING'; END IF;
END
$hydration_postcondition$;

COMMIT;
`;
}

function argumentValue(args, name) {
  const equalsPrefix = `--${name}=`;
  const equalsValue = args.find((argument) => argument.startsWith(equalsPrefix));
  if (equalsValue) return equalsValue.slice(equalsPrefix.length);
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function readInput(path, label) {
  const resolved = resolve(path);
  const metadata = lstatSync(resolved);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`HYDRATION_${label}_MUST_BE_REGULAR_FILE`);
  return readFileSync(resolved, "utf8");
}

function atomicWrite(path, content) {
  const temporary = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function runCli(args = process.argv.slice(2)) {
  const connectionId = argumentValue(args, "connection-id");
  const snapshotPath = argumentValue(args, "snapshot");
  const masterPath = argumentValue(args, "master-xml");
  const winesPath = argumentValue(args, "wines-json");
  const stockPath = argumentValue(args, "stock-json");
  const outputDir = argumentValue(args, "output-dir");
  if (!connectionId || !snapshotPath || !masterPath || !winesPath || !stockPath || !outputDir) {
    throw new Error("Usage: node scripts/generate-disabled-connection-hydration.mjs --connection-id <uuid> --snapshot <json> --master-xml <xml> --wines-json <json> --stock-json <json> --output-dir <dir>");
  }

  const snapshotRaw = readInput(snapshotPath, "SNAPSHOT");
  const masterXml = readInput(masterPath, "MASTER_XML");
  const winesRaw = readInput(winesPath, "WINES_JSON");
  const stockRaw = readInput(stockPath, "STOCK_JSON");
  const generatedAt = process.env.SOURCE_DATE_EPOCH
    ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString()
    : new Date().toISOString();
  const plan = buildDisabledConnectionHydration({
    connectionId,
    snapshot: JSON.parse(snapshotRaw),
    masterXml,
    winesDocument: JSON.parse(winesRaw),
    stockDocument: JSON.parse(stockRaw),
    generatedAt,
    sourceDigests: {
      snapshotSha256: sha256(snapshotRaw),
      masterXmlSha256: sha256(masterXml),
      winesJsonSha256: sha256(winesRaw),
      stockJsonSha256: sha256(stockRaw),
    },
  });
  const sql = renderHydrationSql(plan);
  const planJson = `${JSON.stringify(plan, null, 2)}\n`;
  const resolvedOutput = resolve(outputDir);
  mkdirSync(resolvedOutput, { recursive: true, mode: 0o700 });
  if (lstatSync(resolvedOutput).isSymbolicLink() || !lstatSync(resolvedOutput).isDirectory()) {
    throw new Error("HYDRATION_OUTPUT_DIR_MUST_BE_REGULAR_DIRECTORY");
  }
  chmodSync(resolvedOutput, 0o700);
  atomicWrite(join(resolvedOutput, OUTPUT_FILES.plan), planJson);
  atomicWrite(join(resolvedOutput, OUTPUT_FILES.sql), sql);
  const manifest = `${sha256(planJson)}  ${OUTPUT_FILES.plan}\n${sha256(sql)}  ${OUTPUT_FILES.sql}\n`;
  atomicWrite(join(resolvedOutput, OUTPUT_FILES.manifest), manifest);
  return {
    outputDir: resolvedOutput,
    files: OUTPUT_FILES,
    counts: plan.counts,
    rejectedByReason: plan.rejectedByReason,
  };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const result = runCli();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "HYDRATION_UNKNOWN_ERROR"}\n`);
    process.exitCode = 1;
  }
}

export { canonicalJson, FORMAT_TO_STOCK_VARIANT, OUTPUT_FILES, sha256 };
