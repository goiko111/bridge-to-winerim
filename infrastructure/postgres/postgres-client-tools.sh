#!/usr/bin/env bash

PSQL_CMD=$(command -v psql 2>/dev/null || true)
test -n "$PSQL_CMD" || {
  printf 'BLOCKED_MISSING_COMMAND=psql\n' >&2
  return 1 2>/dev/null || exit 1
}

postgres_tool_major() {
  "$1" --version | sed -E 's/.* ([0-9]+)(\.[0-9]+)?.*/\1/'
}

configure_postgres_tools() {
  database_url=$1
  server_major=$(PGOPTIONS="${PGOPTIONS:+$PGOPTIONS }-c default_transaction_read_only=on -c statement_timeout=15000" \
    "$PSQL_CMD" "$database_url" -XAtq -v ON_ERROR_STOP=1 -c "SELECT current_setting('server_version_num')::int / 10000")
  case "$server_major" in *[!0-9]*|'') printf 'POSTGRES_SERVER_VERSION_DETECTION_FAILED=%s\n' "$server_major" >&2; return 1 ;; esac
  test "$server_major" = 17 || {
    printf 'POSTGRES_17_REQUIRED server_major=%s\n' "$server_major" >&2
    return 1
  }

  if [ -n "${RESCUE_PRODUCTION_PG_BIN_DIR:-}" ]; then
    selected_bin=${RESCUE_PRODUCTION_PG_BIN_DIR%/}
  else
    selected_bin=''
    for candidate_dir in "/opt/homebrew/opt/postgresql@17/bin" "/usr/local/opt/postgresql@17/bin"; do
      if [ -x "$candidate_dir/psql" ] && [ -x "$candidate_dir/pg_dump" ] && [ -x "$candidate_dir/pg_restore" ]; then
        selected_bin=$candidate_dir
        break
      fi
    done
    if [ -z "$selected_bin" ]; then
      path_dump=$(command -v pg_dump 2>/dev/null || true)
      path_restore=$(command -v pg_restore 2>/dev/null || true)
      if [ -n "$path_dump" ] && [ -n "$path_restore" ] \
        && [ "$(postgres_tool_major "$PSQL_CMD")" = 17 ] \
        && [ "$(postgres_tool_major "$path_dump")" = 17 ] \
        && [ "$(postgres_tool_major "$path_restore")" = 17 ]; then
        selected_bin=$(dirname "$path_dump")
      fi
    fi
  fi

  test -n "$selected_bin" || {
    printf 'BLOCKED_MISSING_MATCHING_POSTGRES_CLIENTS server_major=%s\n' "$server_major" >&2
    return 1
  }
  PSQL_CMD="$selected_bin/psql"
  PG_DUMP_CMD="$selected_bin/pg_dump"
  PG_RESTORE_CMD="$selected_bin/pg_restore"
  test -x "$PSQL_CMD" && test -x "$PG_DUMP_CMD" && test -x "$PG_RESTORE_CMD" || {
    printf 'BLOCKED_MISSING_POSTGRES_CLIENTS bin=%s\n' "$selected_bin" >&2
    return 1
  }
  psql_major=$(postgres_tool_major "$PSQL_CMD")
  dump_major=$(postgres_tool_major "$PG_DUMP_CMD")
  restore_major=$(postgres_tool_major "$PG_RESTORE_CMD")
  if [ "$psql_major" != 17 ] || [ "$dump_major" != 17 ] || [ "$restore_major" != 17 ]; then
    printf 'POSTGRES_17_CLIENTS_REQUIRED psql=%s dump=%s restore=%s\n' "$psql_major" "$dump_major" "$restore_major" >&2
    return 1
  fi
  POSTGRES_SERVER_MAJOR=$server_major
  POSTGRES_PSQL_MAJOR=$psql_major
  POSTGRES_DUMP_MAJOR=$dump_major
  POSTGRES_RESTORE_MAJOR=$restore_major
}

hydration_database_fingerprint() {
  local database_url=$1
  local connection_id=$2
  local read_only_options

  [[ "$connection_id" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$ ]] || {
    printf 'HYDRATION_DATABASE_CONNECTION_ID_INVALID\n' >&2
    return 1
  }
  command -v node >/dev/null 2>&1 || {
    printf 'BLOCKED_MISSING_COMMAND=node\n' >&2
    return 1
  }

  read_only_options="${PGOPTIONS:+$PGOPTIONS }-c default_transaction_read_only=on -c statement_timeout=30000 -c lock_timeout=2000"
  PGOPTIONS="$read_only_options" "$PSQL_CMD" "$database_url" -XAtq -v ON_ERROR_STOP=1 -c "
WITH candidate_wines AS (
  SELECT
    ww.*,
    jsonb_build_object(
      'winerimId', ww.winerim_id,
      'name', ww.name,
      'sku', ww.sku,
      'ean', ww.ean,
      'vintage', ww.vintage,
      'winery', ww.winery,
      'region', ww.region,
      'grapeVariety', ww.grape_variety,
      'wineType', ww.wine_type,
      'price', ww.price,
      'stockQuantity', ww.stock_quantity,
      'bottleSalePrice', ww.bottle_sale_price,
      'glassSalePrice', ww.glass_sale_price,
      'magnumSalePrice', ww.magnum_sale_price,
      'bottleStockId', ww.bottle_stock_id,
      'glassStockId', ww.glass_stock_id,
      'magnumStockId', ww.magnum_stock_id,
      'serveByGlass', ww.serve_by_glass,
      'pricingStatus', ww.pricing_status,
      'pricingMissingReason', ww.pricing_missing_reason,
      'rawPayload', ww.raw_payload,
      'databaseContract', jsonb_build_object(
        'format', ww.format,
        'bottlePurchasePrice', ww.bottle_purchase_price,
        'glassCostPrice', ww.glass_cost_price,
        'magnumPurchasePrice', ww.magnum_purchase_price,
        'isActive', ww.is_active
      )
    ) AS semantic
  FROM public.winerim_wines ww
  WHERE ww.connection_id='$connection_id'::uuid
),
candidate_products AS (
  SELECT
    pp.*,
    CASE
      WHEN pp.is_wine_candidate IS TRUE AND pp.winerim_wine_id IS NOT NULL THEN 'CONFIRMED'
      WHEN pp.is_wine_candidate IS TRUE THEN 'AMBIGUOUS'
      ELSE 'NOT_WINE'
    END AS classification_status
  FROM public.provider_products pp
  WHERE pp.connection_id='$connection_id'::uuid
),
semantic_products AS (
  SELECT
    provider_product_id,
    jsonb_build_object(
      'providerProductId', provider_product_id,
      'name', name,
      'family', family,
      'vatRate', vat_rate,
      'saleFormat', sale_format,
      'price', price,
      'isWineCandidate', is_wine_candidate,
      'classificationStatus', classification_status,
      'wineScore', wine_score,
      'wineReasons', to_jsonb(wine_reasons),
      'syncStatus', sync_status,
      'syncError', sync_error,
      'winerimWineId', winerim_wine_id,
      'rawPayload', raw_payload,
      'databaseContract', jsonb_build_object(
        'classificationOverride', classification_override,
        'lastScore', last_score,
        'lastReasons', to_jsonb(last_reasons),
        'lastSyncedAt', last_synced_at,
        'providerUpdatedAt', provider_updated_at
      )
    ) AS semantic
  FROM candidate_products
),
semantic_mappings AS (
  SELECT
    pm.provider_product_id,
    jsonb_build_object(
      'providerProductId', pm.provider_product_id,
      'providerProductName', pm.provider_product_name,
      'winerimWineId', pm.winerim_wine_id,
      'winerimWineName', pm.winerim_wine_name,
      'formatType', pm.format_type,
      'stockVariant', lower(stock_source.stock->'winePrice'->>'variant'),
      'stockId', stock_reason.stock_id,
      'stockActive', coalesce((stock_source.stock->>'stockActive')::boolean, false),
      'status', pm.status,
      'matchMethod', pm.match_method,
      'databaseContract', jsonb_build_object(
        'matchScore', pm.match_score,
        'matchReasons', to_jsonb(pm.match_reasons),
        'agoraProductId', pm.agora_product_id,
        'lastSyncedAt', pm.last_synced_at,
        'lastSyncError', pm.last_sync_error
      )
    ) AS semantic
  FROM public.product_mappings pm
  LEFT JOIN candidate_wines ww ON ww.winerim_id=pm.winerim_wine_id
  LEFT JOIN LATERAL (
    SELECT substring(reason FROM '([1-9][0-9]*)$')::bigint AS stock_id
    FROM unnest(pm.match_reasons) reason
    WHERE reason ~ ('^CURRENT_' || pm.format_type || '_STOCK_ID_[1-9][0-9]*$')
    ORDER BY reason
    LIMIT 1
  ) stock_reason ON true
  LEFT JOIN LATERAL (
    SELECT stock
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(ww.raw_payload->'stocks')='array' THEN ww.raw_payload->'stocks' ELSE '[]'::jsonb END
    ) WITH ORDINALITY source(stock, ordinal)
    WHERE stock->>'id'=stock_reason.stock_id::text
    ORDER BY ordinal
    LIMIT 1
  ) stock_source ON true
  WHERE pm.connection_id='$connection_id'::uuid
),
semantic_master AS (
  SELECT jsonb_build_object(
    'families', master.families_json,
    'products', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'providerProductId', product->>'provider_product_id',
        'name', product->>'name',
        'family', product->>'family',
        'price', product->'price',
        'saleFormat', product->>'sale_format',
        'classificationStatus', product->>'classification_status',
        'winerimWineId', product->>'winerim_wine_id',
        'rawPayload', product->'raw_payload'
      ) ORDER BY (product->>'provider_product_id')::numeric)
      FROM jsonb_array_elements(master.products_summary_json) product
    ), '[]'::jsonb),
    'databaseContract', jsonb_build_object(
      'vatsJson', master.vats_json,
      'priceListsJson', master.price_lists_json,
      'preparationTypesJson', master.preparation_types_json,
      'preparationOrdersJson', master.preparation_orders_json,
      'warehousesJson', master.warehouses_json,
      'productsSummaryJson', master.products_summary_json,
      'rawXmlPreview', master.raw_xml_preview,
      'fetchedAt', master.fetched_at,
      'salePointsJson', master.sale_points_json,
      'saleCentersJson', master.sale_centers_json
    )
  ) AS semantic
  FROM public.agora_master_data master
  WHERE master.connection_id='$connection_id'::uuid
)
SELECT jsonb_build_object(
  'schemaVersion', 2,
  'connectionId', '$connection_id',
  'acceptedMappings', coalesce((SELECT jsonb_agg(semantic ORDER BY provider_product_id::numeric) FROM semantic_mappings), '[]'::jsonb),
  'winerimWines', coalesce((SELECT jsonb_agg(semantic ORDER BY winerim_id::numeric) FROM candidate_wines), '[]'::jsonb),
  'providerProducts', coalesce((SELECT jsonb_agg(semantic ORDER BY provider_product_id::numeric) FROM semantic_products), '[]'::jsonb),
  'agoraMasterData', (SELECT semantic FROM semantic_master)
)::text
" | node -e '
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");

const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};
const fail = (message) => { throw new Error(message); };
const sameJson = (left, right) => canonicalJson(left) === canonicalJson(right);
const takeDatabaseContract = (row, label) => {
  if (!row || typeof row !== "object" || Array.isArray(row)
      || !row.databaseContract || typeof row.databaseContract !== "object"
      || Array.isArray(row.databaseContract)) {
    fail(`HYDRATION_DATABASE_${label}_CONTRACT_MISSING`);
  }
  const { databaseContract, ...semantic } = row;
  return { databaseContract, semantic };
};
const payload = JSON.parse(readFileSync(0, "utf8"));
if (!payload.agoraMasterData || !Array.isArray(payload.agoraMasterData.families)
    || !Array.isArray(payload.agoraMasterData.products)) fail("HYDRATION_DATABASE_MASTER_INVALID");

payload.winerimWines = payload.winerimWines.map((row) => {
  const { databaseContract, semantic } = takeDatabaseContract(row, "WINES");
  if (databaseContract.format !== null
      || databaseContract.bottlePurchasePrice !== null
      || databaseContract.glassCostPrice !== null
      || databaseContract.magnumPurchasePrice !== null
      || databaseContract.isActive !== true) {
    fail("HYDRATION_DATABASE_WINES_FIXED_COLUMNS_MISMATCH");
  }
  return semantic;
});

payload.providerProducts = payload.providerProducts.map((row) => {
  const { databaseContract, semantic } = takeDatabaseContract(row, "PRODUCTS");
  if (databaseContract.classificationOverride !== "AUTO"
      || databaseContract.lastScore !== semantic.wineScore
      || !sameJson(databaseContract.lastReasons, semantic.wineReasons)
      || databaseContract.lastSyncedAt !== null
      || databaseContract.providerUpdatedAt !== null) {
    fail("HYDRATION_DATABASE_PRODUCTS_FIXED_COLUMNS_MISMATCH");
  }
  return semantic;
});

payload.acceptedMappings = payload.acceptedMappings.map((row) => {
  const { databaseContract, semantic } = takeDatabaseContract(row, "MAPPINGS");
  const formatType = String(semantic.formatType ?? "").toUpperCase();
  const expectedReasons = [
    "CURRENT_AGORA_PRODUCT_ID",
    "CURRENT_WINERIM_WINE_ID",
    `CURRENT_${formatType}_STOCK_ID_${semantic.stockId}`,
    `CURRENT_${formatType}_STOCK_ACTIVE_TRUE`,
  ];
  if (databaseContract.matchScore !== 1
      || !sameJson(databaseContract.matchReasons, expectedReasons)
      || databaseContract.agoraProductId !== String(semantic.providerProductId)
      || databaseContract.lastSyncedAt !== null
      || databaseContract.lastSyncError !== null) {
    fail("HYDRATION_DATABASE_MAPPINGS_FIXED_COLUMNS_MISMATCH");
  }
  return semantic;
});

const { databaseContract: masterDatabaseContract, semantic: semanticMaster } =
  takeDatabaseContract(payload.agoraMasterData, "MASTER");
for (const key of [
  "vatsJson",
  "priceListsJson",
  "preparationTypesJson",
  "preparationOrdersJson",
  "warehousesJson",
  "salePointsJson",
  "saleCentersJson",
]) {
  if (!Array.isArray(masterDatabaseContract[key]) || masterDatabaseContract[key].length !== 0) {
    fail("HYDRATION_DATABASE_MASTER_FIXED_COLUMNS_MISMATCH");
  }
}
if (masterDatabaseContract.fetchedAt !== null
    || !/^WINERIM_RESCUE_HYDRATION_V2_SHA256:[0-9a-f]{64}$/.test(String(masterDatabaseContract.rawXmlPreview ?? ""))) {
  fail("HYDRATION_DATABASE_MASTER_FIXED_COLUMNS_MISMATCH");
}
payload.agoraMasterData = semanticMaster;

const uniqueMap = (rows, key, label) => {
  if (!Array.isArray(rows) || rows.length === 0) fail(`HYDRATION_DATABASE_${label}_EMPTY`);
  const result = new Map();
  for (const row of rows) {
    const id = String(row?.[key] ?? "");
    if (!/^[1-9][0-9]*$/.test(id) || result.has(id)) fail(`HYDRATION_DATABASE_${label}_IDENTITY_INVALID`);
    result.set(id, row);
  }
  return result;
};
const wines = uniqueMap(payload.winerimWines, "winerimId", "WINES");
const products = uniqueMap(payload.providerProducts, "providerProductId", "PRODUCTS");
const masterProducts = uniqueMap(payload.agoraMasterData.products, "providerProductId", "MASTER_PRODUCTS");
uniqueMap(payload.acceptedMappings, "providerProductId", "MAPPINGS");
if (products.size !== masterProducts.size) fail("HYDRATION_DATABASE_MASTER_PRODUCT_COUNT_MISMATCH");
const expectedProductsSummary = payload.agoraMasterData.products.map((product) => ({
  provider_product_id: product.providerProductId,
  name: product.name,
  family: product.family,
  price: product.price,
  sale_format: product.saleFormat,
  classification_status: product.classificationStatus,
  winerim_wine_id: product.winerimWineId,
  raw_payload: product.rawPayload,
}));
if (!sameJson(masterDatabaseContract.productsSummaryJson, expectedProductsSummary)) {
  fail("HYDRATION_DATABASE_MASTER_PRODUCTS_SUMMARY_MISMATCH");
}

const variants = {
  BOTTLE: { name: "botella", column: "bottleStockId" },
  GLASS: { name: "copa", column: "glassStockId" },
  MAGNUM: { name: "magnum", column: "magnumStockId" },
};
for (const mapping of payload.acceptedMappings) {
  const variant = variants[String(mapping.formatType ?? "").toUpperCase()];
  const stockId = Number(mapping.stockId);
  const wine = wines.get(String(mapping.winerimWineId));
  const product = products.get(String(mapping.providerProductId));
  if (!variant || !Number.isInteger(stockId) || stockId <= 0 || !wine || !product) {
    fail("HYDRATION_DATABASE_MAPPING_BINDING_INVALID");
  }
  const matchingStocks = Array.isArray(wine.rawPayload?.stocks)
    ? wine.rawPayload.stocks.filter((stock) => Number(stock?.id) === stockId)
    : [];
  if (Number(wine[variant.column]) !== stockId || matchingStocks.length !== 1
      || matchingStocks[0]?.stockActive !== true
      || String(matchingStocks[0]?.winePrice?.variant ?? "").toLowerCase() !== variant.name
      || mapping.stockVariant !== variant.name || mapping.stockActive !== true
      || product.name !== mapping.providerProductName
      || product.winerimWineId !== mapping.winerimWineId
      || product.saleFormat !== mapping.formatType) {
    fail("HYDRATION_DATABASE_MAPPING_STOCK_OR_PRODUCT_MISMATCH");
  }
}

const hydrationDigest = createHash("sha256").update(canonicalJson(payload)).digest("hex");
process.stdout.write(hydrationDigest);
if (masterDatabaseContract.rawXmlPreview !== `WINERIM_RESCUE_HYDRATION_V2_SHA256:${hydrationDigest}`) {
  console.error("HYDRATION_DATABASE_MASTER_DIGEST_MARKER_MISMATCH");
  process.exitCode = 1;
}
' || return 1
}
