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
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const FORMAT_TO_VARIANT = Object.freeze({ BOTTLE: "botella", GLASS: "copa", MAGNUM: "magnum" });
const OUTPUT_FILES = Object.freeze({
  plan: "hydration-transition-plan.json",
  apply: "apply-hydration-transition.sql",
  rollback: "rollback-hydration-transition.sql",
  manifest: "manifest.sha256",
});

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sqlText(value) {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlNumber(value) {
  if (value === null || value === undefined || value === "") return "NULL";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) throw new Error("HYDRATION_TRANSITION_NON_FINITE_NUMBER");
  return String(numeric);
}

function sqlBoolean(value) {
  return value === true ? "true" : "false";
}

function sqlTextArray(values) {
  return `ARRAY[${values.map(sqlText).join(", ")}]::text[]`;
}

function sqlJson(value) {
  return `${sqlText(canonicalJson(value))}::jsonb`;
}

function valuesRows(rows) {
  if (!rows.length) throw new Error("HYDRATION_TRANSITION_EMPTY_VALUES_NOT_ALLOWED");
  return rows.map((row) => `  (${row.join(", ")})`).join(",\n");
}

function hydrationDigestPayload(plan) {
  return {
    schemaVersion: 2,
    connectionId: plan.connectionId,
    acceptedMappings: plan.acceptedMappings,
    winerimWines: plan.winerimWines,
    providerProducts: plan.providerProducts,
    agoraMasterData: {
      families: plan?.agoraMasterData?.families,
      products: plan.providerProducts.map((product) => ({
        providerProductId: product.providerProductId,
        name: product.name,
        family: product.family,
        price: product.price,
        saleFormat: product.saleFormat,
        classificationStatus: product.classificationStatus,
        winerimWineId: product.winerimWineId,
        rawPayload: product.rawPayload,
      })),
    },
  };
}

function assertHydrationPlan(plan, label) {
  if (plan?.schemaVersion !== 2 || plan?.kind !== "disabled-connection-hydration") {
    throw new Error(`HYDRATION_TRANSITION_${label}_PLAN_CONTRACT_INVALID`);
  }
  if (!UUID_PATTERN.test(String(plan.connectionId ?? ""))) {
    throw new Error(`HYDRATION_TRANSITION_${label}_CONNECTION_INVALID`);
  }
  if (!DIGEST_PATTERN.test(String(plan.hydrationDigest ?? ""))) {
    throw new Error(`HYDRATION_TRANSITION_${label}_DIGEST_INVALID`);
  }
  for (const key of ["acceptedMappings", "winerimWines", "providerProducts"]) {
    if (!Array.isArray(plan[key]) || !plan[key].length) {
      throw new Error(`HYDRATION_TRANSITION_${label}_${key.toUpperCase()}_INVALID`);
    }
  }
  if (!Array.isArray(plan?.agoraMasterData?.families) || !Array.isArray(plan?.agoraMasterData?.productsSummary)) {
    throw new Error(`HYDRATION_TRANSITION_${label}_MASTER_INVALID`);
  }
  const computed = sha256(canonicalJson(hydrationDigestPayload(plan)));
  if (computed !== plan.hydrationDigest) {
    throw new Error(`HYDRATION_TRANSITION_${label}_DIGEST_REJECTED`);
  }
}

function byProviderProductId(rows, label) {
  const result = new Map();
  for (const row of rows) {
    const id = String(row?.providerProductId ?? "").trim();
    if (!/^[1-9][0-9]*$/.test(id) || result.has(id)) {
      throw new Error(`HYDRATION_TRANSITION_${label}_PROVIDER_ID_INVALID`);
    }
    result.set(id, row);
  }
  return result;
}

function stockEntryForMapping(plan, mapping) {
  const wine = plan.winerimWines.find((candidate) => String(candidate.winerimId) === String(mapping.winerimWineId));
  const stocks = Array.isArray(wine?.rawPayload?.stocks) ? wine.rawPayload.stocks : [];
  return stocks.find((stock) => String(stock?.id) === String(mapping.stockId)) ?? null;
}

function assertSalesOnlyAddition(afterPlan, mapping) {
  const formatType = String(mapping?.formatType ?? "").toUpperCase();
  const expectedVariant = FORMAT_TO_VARIANT[formatType];
  if (!expectedVariant
      || mapping.stockActive !== false
      || mapping.matchMethod !== "RESCUE_EXACT_ID_WINE_VARIANT_SALES_ONLY"
      || mapping.status !== "CONFIRMED") {
    throw new Error("HYDRATION_TRANSITION_ADDITION_NOT_EXACT_SALES_ONLY");
  }
  const stock = stockEntryForMapping(afterPlan, mapping);
  if (!stock
      || stock.stockActive !== false
      || String(stock?.winePrice?.variant ?? "").toLowerCase() !== expectedVariant
      || String(stock?.winePrice?.wine?.id ?? "") !== String(mapping.winerimWineId)) {
    throw new Error("HYDRATION_TRANSITION_ADDITION_STOCK_CONTRACT_INVALID");
  }
}

function providerStableProjection(product) {
  return {
    providerProductId: product.providerProductId,
    name: product.name,
    family: product.family,
    vatRate: product.vatRate,
    price: product.price,
    rawPayload: product.rawPayload,
  };
}

function assertProviderPromotion(before, after, mapping) {
  if (canonicalJson(providerStableProjection(before)) !== canonicalJson(providerStableProjection(after))) {
    throw new Error("HYDRATION_TRANSITION_PROVIDER_IDENTITY_CHANGED");
  }
  if (before.classificationStatus !== "AMBIGUOUS"
      || before.isWineCandidate !== true
      || before.winerimWineId !== null
      || before.saleFormat !== null
      || before.syncStatus !== "BLOCKED") {
    throw new Error("HYDRATION_TRANSITION_PROVIDER_BEFORE_NOT_AMBIGUOUS");
  }
  if (after.classificationStatus !== "CONFIRMED"
      || after.isWineCandidate !== true
      || String(after.winerimWineId) !== String(mapping.winerimWineId)
      || after.saleFormat !== mapping.formatType
      || after.syncStatus !== "SYNCED"
      || after.syncError !== null
      || !Array.isArray(after.wineReasons)
      || !after.wineReasons.includes("RESCUE_EXACT_ID_WINE_INACTIVE_VARIANT_SALES_ONLY")) {
    throw new Error("HYDRATION_TRANSITION_PROVIDER_AFTER_NOT_SALES_ONLY");
  }
}

export function buildHydrationTransition(beforePlan, afterPlan, generatedAt = new Date().toISOString()) {
  assertHydrationPlan(beforePlan, "BEFORE");
  assertHydrationPlan(afterPlan, "AFTER");
  if (beforePlan.connectionId !== afterPlan.connectionId) throw new Error("HYDRATION_TRANSITION_CONNECTION_MISMATCH");
  if (canonicalJson(beforePlan.winerimWines) !== canonicalJson(afterPlan.winerimWines)) {
    throw new Error("HYDRATION_TRANSITION_WINERIM_WINES_CHANGED");
  }
  if (canonicalJson(beforePlan.agoraMasterData.families) !== canonicalJson(afterPlan.agoraMasterData.families)) {
    throw new Error("HYDRATION_TRANSITION_FAMILIES_CHANGED");
  }

  const beforeMappings = byProviderProductId(beforePlan.acceptedMappings, "BEFORE_MAPPING");
  const afterMappings = byProviderProductId(afterPlan.acceptedMappings, "AFTER_MAPPING");
  const beforeProviders = byProviderProductId(beforePlan.providerProducts, "BEFORE_PROVIDER");
  const afterProviders = byProviderProductId(afterPlan.providerProducts, "AFTER_PROVIDER");
  if (beforeProviders.size !== afterProviders.size) throw new Error("HYDRATION_TRANSITION_PROVIDER_COUNT_CHANGED");

  for (const [id, beforeMapping] of beforeMappings) {
    const afterMapping = afterMappings.get(id);
    if (!afterMapping || canonicalJson(beforeMapping) !== canonicalJson(afterMapping)) {
      throw new Error("HYDRATION_TRANSITION_EXISTING_MAPPING_CHANGED");
    }
  }

  const additions = [...afterMappings.entries()]
    .filter(([id]) => !beforeMappings.has(id))
    .map(([, mapping]) => mapping)
    .sort((left, right) => Number(left.providerProductId) - Number(right.providerProductId));
  if (!additions.length || afterMappings.size !== beforeMappings.size + additions.length) {
    throw new Error("HYDRATION_TRANSITION_NOT_ADDITIVE");
  }

  const additionIds = new Set(additions.map((mapping) => String(mapping.providerProductId)));
  for (const mapping of additions) {
    assertSalesOnlyAddition(afterPlan, mapping);
    const beforeProvider = beforeProviders.get(String(mapping.providerProductId));
    const afterProvider = afterProviders.get(String(mapping.providerProductId));
    if (!beforeProvider || !afterProvider) throw new Error("HYDRATION_TRANSITION_PROVIDER_MISSING");
    assertProviderPromotion(beforeProvider, afterProvider, mapping);
  }
  for (const [id, beforeProvider] of beforeProviders) {
    if (additionIds.has(id)) continue;
    if (canonicalJson(beforeProvider) !== canonicalJson(afterProviders.get(id))) {
      throw new Error("HYDRATION_TRANSITION_UNRELATED_PROVIDER_CHANGED");
    }
  }

  const plan = {
    schemaVersion: 1,
    kind: "disabled-connection-hydration-transition",
    generatedAt,
    connectionId: beforePlan.connectionId,
    beforeHydrationDigest: beforePlan.hydrationDigest,
    afterHydrationDigest: afterPlan.hydrationDigest,
    beforeCounts: {
      winerimWines: beforePlan.winerimWines.length,
      providerProducts: beforePlan.providerProducts.length,
      mappings: beforePlan.acceptedMappings.length,
      masterRows: 1,
    },
    afterCounts: {
      winerimWines: afterPlan.winerimWines.length,
      providerProducts: afterPlan.providerProducts.length,
      mappings: afterPlan.acceptedMappings.length,
      masterRows: 1,
    },
    additions,
    providerProductsBefore: additions.map((mapping) => beforeProviders.get(String(mapping.providerProductId))),
    providerProductsAfter: additions.map((mapping) => afterProviders.get(String(mapping.providerProductId))),
    masterProductsBefore: beforePlan.agoraMasterData.productsSummary,
    masterProductsAfter: afterPlan.agoraMasterData.productsSummary,
  };
  plan.transitionDigest = sha256(canonicalJson({ ...plan, generatedAt: undefined }));
  return plan;
}

const providerColumns = [
  "connection_id", "provider_product_id", "name", "family", "vat_rate", "sale_format", "price",
  "is_wine_candidate", "wine_score", "wine_reasons", "raw_payload", "winerim_wine_id",
  "classification_override", "last_score", "last_reasons", "sync_status", "sync_error", "last_synced_at", "provider_updated_at",
];
const mappingColumns = [
  "connection_id", "provider_product_id", "provider_product_name", "winerim_wine_id",
  "winerim_wine_name", "match_method", "match_score", "match_reasons", "status",
  "format_type", "agora_product_id", "last_synced_at", "last_sync_error",
];

function providerRow(connectionId, product) {
  return [
    sqlText(connectionId), sqlText(product.providerProductId), sqlText(product.name), sqlText(product.family),
    sqlNumber(product.vatRate), sqlText(product.saleFormat), sqlNumber(product.price), sqlBoolean(product.isWineCandidate),
    sqlNumber(product.wineScore), sqlTextArray(product.wineReasons), sqlJson(product.rawPayload), sqlText(product.winerimWineId),
    sqlText("AUTO"), sqlNumber(product.wineScore), sqlTextArray(product.wineReasons), sqlText(product.syncStatus),
    sqlText(product.syncError), "NULL", "NULL",
  ];
}

function mappingRow(connectionId, mapping) {
  return [
    sqlText(connectionId), sqlText(mapping.providerProductId), sqlText(mapping.providerProductName),
    sqlText(mapping.winerimWineId), sqlText(mapping.winerimWineName), sqlText(mapping.matchMethod), "1",
    sqlTextArray([
      "CURRENT_AGORA_PRODUCT_ID",
      "CURRENT_WINERIM_WINE_ID",
      `CURRENT_${mapping.formatType}_STOCK_ID_${mapping.stockId}`,
      `CURRENT_${mapping.formatType}_STOCK_ACTIVE_FALSE_SALES_ONLY`,
    ]),
    sqlText("CONFIRMED"), sqlText(mapping.formatType), sqlText(mapping.providerProductId), "NULL", "NULL",
  ];
}

function renderTransitionSql(plan, direction) {
  if (plan?.schemaVersion !== 1 || plan?.kind !== "disabled-connection-hydration-transition") {
    throw new Error("HYDRATION_TRANSITION_PLAN_INVALID");
  }
  const applying = direction === "apply";
  if (!applying && direction !== "rollback") throw new Error("HYDRATION_TRANSITION_DIRECTION_INVALID");
  const connectionId = plan.connectionId;
  const fromDigest = applying ? plan.beforeHydrationDigest : plan.afterHydrationDigest;
  const toDigest = applying ? plan.afterHydrationDigest : plan.beforeHydrationDigest;
  const fromCounts = applying ? plan.beforeCounts : plan.afterCounts;
  const toCounts = applying ? plan.afterCounts : plan.beforeCounts;
  const providerFrom = applying ? plan.providerProductsBefore : plan.providerProductsAfter;
  const providerTo = applying ? plan.providerProductsAfter : plan.providerProductsBefore;
  const masterTo = applying ? plan.masterProductsAfter : plan.masterProductsBefore;
  const columns = (items, alias = null) => items.map((item) => alias ? `${alias}.${item}` : item).join(", ");
  const providerIds = plan.additions.map((mapping) => sqlText(mapping.providerProductId)).join(", ");
  const mappingsInsert = applying ? `
INSERT INTO public.product_mappings (${columns(mappingColumns)})
SELECT ${columns(mappingColumns, "expected")}
FROM transition_expected_mappings expected;
` : `
DELETE FROM public.product_mappings
WHERE connection_id = ${sqlText(connectionId)}::uuid
  AND provider_product_id IN (${providerIds});
`;
  const expectedMappingCount = applying ? 0 : plan.additions.length;

  return `\\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL idle_in_transaction_session_timeout = '60s';

DO $transition_guard$
DECLARE target_enabled boolean; target_catalog boolean; target_write_mode text;
BEGIN
  SELECT enabled, catalog_sync_enabled, write_mode
  INTO STRICT target_enabled, target_catalog, target_write_mode
  FROM public.pos_connections
  WHERE id = ${sqlText(connectionId)}::uuid
  FOR UPDATE;
  IF target_enabled IS DISTINCT FROM false OR target_catalog IS DISTINCT FROM false OR target_write_mode IS DISTINCT FROM 'NONE' THEN
    RAISE EXCEPTION 'HYDRATION_TRANSITION_TARGET_NOT_DISABLED';
  END IF;
EXCEPTION WHEN NO_DATA_FOUND THEN
  RAISE EXCEPTION 'HYDRATION_TRANSITION_CONNECTION_NOT_FOUND';
END
$transition_guard$;

LOCK TABLE public.winerim_wines, public.provider_products, public.agora_master_data, public.product_mappings,
  public.sales_events, public.sales_line_items, public.stock_sync_log, public.outbound_tasks,
  public.runtime_idempotency, public.runtime_execution_log, public.runtime_canary_connections
  IN SHARE ROW EXCLUSIVE MODE;

CREATE TEMP TABLE transition_provider_from (LIKE public.provider_products INCLUDING DEFAULTS) ON COMMIT DROP;
INSERT INTO transition_provider_from (${columns(providerColumns)}) VALUES
${valuesRows(providerFrom.map((product) => providerRow(connectionId, product)))};

CREATE TEMP TABLE transition_provider_to (LIKE public.provider_products INCLUDING DEFAULTS) ON COMMIT DROP;
INSERT INTO transition_provider_to (${columns(providerColumns)}) VALUES
${valuesRows(providerTo.map((product) => providerRow(connectionId, product)))};

CREATE TEMP TABLE transition_expected_mappings (LIKE public.product_mappings INCLUDING DEFAULTS) ON COMMIT DROP;
INSERT INTO transition_expected_mappings (${columns(mappingColumns)}) VALUES
${valuesRows(plan.additions.map((mapping) => mappingRow(connectionId, mapping)))};

DO $transition_precondition$
DECLARE wine_count integer; provider_count integer; mapping_count integer; master_count integer; operational_count integer;
BEGIN
  SELECT count(*) INTO wine_count FROM public.winerim_wines WHERE connection_id=${sqlText(connectionId)}::uuid;
  SELECT count(*) INTO provider_count FROM public.provider_products WHERE connection_id=${sqlText(connectionId)}::uuid;
  SELECT count(*) INTO mapping_count FROM public.product_mappings WHERE connection_id=${sqlText(connectionId)}::uuid;
  SELECT count(*) INTO master_count FROM public.agora_master_data WHERE connection_id=${sqlText(connectionId)}::uuid;
  IF wine_count <> ${fromCounts.winerimWines} OR provider_count <> ${fromCounts.providerProducts}
    OR mapping_count <> ${fromCounts.mappings} OR master_count <> ${fromCounts.masterRows}
  THEN RAISE EXCEPTION 'HYDRATION_TRANSITION_FROM_COUNT_MISMATCH wines=% providers=% mappings=% master=%', wine_count, provider_count, mapping_count, master_count; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.agora_master_data
    WHERE connection_id=${sqlText(connectionId)}::uuid
      AND raw_xml_preview=${sqlText(`WINERIM_RESCUE_HYDRATION_V2_SHA256:${fromDigest}`)}
  ) THEN RAISE EXCEPTION 'HYDRATION_TRANSITION_FROM_DIGEST_MISMATCH'; END IF;
  IF EXISTS (
    (SELECT ${columns(providerColumns, "actual")} FROM public.provider_products actual
      WHERE actual.connection_id=${sqlText(connectionId)}::uuid AND actual.provider_product_id IN (${providerIds}))
    EXCEPT
    (SELECT ${columns(providerColumns, "expected")} FROM transition_provider_from expected)
  ) OR EXISTS (
    (SELECT ${columns(providerColumns, "expected")} FROM transition_provider_from expected)
    EXCEPT
    (SELECT ${columns(providerColumns, "actual")} FROM public.provider_products actual
      WHERE actual.connection_id=${sqlText(connectionId)}::uuid AND actual.provider_product_id IN (${providerIds}))
  ) THEN RAISE EXCEPTION 'HYDRATION_TRANSITION_PROVIDER_FROM_MISMATCH'; END IF;
  IF (SELECT count(*) FROM public.product_mappings
      WHERE connection_id=${sqlText(connectionId)}::uuid AND provider_product_id IN (${providerIds})) <> ${expectedMappingCount}
  THEN RAISE EXCEPTION 'HYDRATION_TRANSITION_MAPPING_SCOPE_MISMATCH'; END IF;
  SELECT
    (SELECT count(*) FROM public.sales_events WHERE connection_id=${sqlText(connectionId)}::uuid)
    + (SELECT count(*) FROM public.sales_line_items WHERE connection_id=${sqlText(connectionId)}::uuid)
    + (SELECT count(*) FROM public.stock_sync_log WHERE connection_id=${sqlText(connectionId)}::uuid)
    + (SELECT count(*) FROM public.outbound_tasks WHERE connection_id=${sqlText(connectionId)}::uuid)
    + (SELECT count(*) FROM public.runtime_idempotency WHERE connection_id=${sqlText(connectionId)}::uuid)
    + (SELECT count(*) FROM public.runtime_execution_log WHERE connection_id=${sqlText(connectionId)}::uuid)
    + (SELECT count(*) FROM public.runtime_canary_connections WHERE connection_id=${sqlText(connectionId)}::uuid AND active IS TRUE)
  INTO operational_count;
  IF operational_count <> 0 THEN RAISE EXCEPTION 'HYDRATION_TRANSITION_OPERATIONAL_SCOPE_NOT_EMPTY count=%', operational_count; END IF;
END
$transition_precondition$;

UPDATE public.provider_products target
SET name=expected.name, family=expected.family, vat_rate=expected.vat_rate,
  sale_format=expected.sale_format, price=expected.price, is_wine_candidate=expected.is_wine_candidate,
  wine_score=expected.wine_score, wine_reasons=expected.wine_reasons, raw_payload=expected.raw_payload,
  winerim_wine_id=expected.winerim_wine_id, classification_override=expected.classification_override,
  last_score=expected.last_score, last_reasons=expected.last_reasons, sync_status=expected.sync_status,
  sync_error=expected.sync_error, last_synced_at=expected.last_synced_at, provider_updated_at=expected.provider_updated_at
FROM transition_provider_to expected
WHERE target.connection_id=expected.connection_id AND target.provider_product_id=expected.provider_product_id;
${mappingsInsert}
UPDATE public.agora_master_data
SET products_summary_json=${sqlJson(masterTo)},
  raw_xml_preview=${sqlText(`WINERIM_RESCUE_HYDRATION_V2_SHA256:${toDigest}`)}
WHERE connection_id=${sqlText(connectionId)}::uuid;

DO $transition_postcondition$
DECLARE wine_count integer; provider_count integer; mapping_count integer; master_count integer;
BEGIN
  SELECT count(*) INTO wine_count FROM public.winerim_wines WHERE connection_id=${sqlText(connectionId)}::uuid;
  SELECT count(*) INTO provider_count FROM public.provider_products WHERE connection_id=${sqlText(connectionId)}::uuid;
  SELECT count(*) INTO mapping_count FROM public.product_mappings WHERE connection_id=${sqlText(connectionId)}::uuid;
  SELECT count(*) INTO master_count FROM public.agora_master_data WHERE connection_id=${sqlText(connectionId)}::uuid;
  IF wine_count <> ${toCounts.winerimWines} OR provider_count <> ${toCounts.providerProducts}
    OR mapping_count <> ${toCounts.mappings} OR master_count <> ${toCounts.masterRows}
  THEN RAISE EXCEPTION 'HYDRATION_TRANSITION_TO_COUNT_MISMATCH wines=% providers=% mappings=% master=%', wine_count, provider_count, mapping_count, master_count; END IF;
  IF EXISTS (
    (SELECT ${columns(providerColumns, "actual")} FROM public.provider_products actual
      WHERE actual.connection_id=${sqlText(connectionId)}::uuid AND actual.provider_product_id IN (${providerIds}))
    EXCEPT
    (SELECT ${columns(providerColumns, "expected")} FROM transition_provider_to expected)
  ) OR EXISTS (
    (SELECT ${columns(providerColumns, "expected")} FROM transition_provider_to expected)
    EXCEPT
    (SELECT ${columns(providerColumns, "actual")} FROM public.provider_products actual
      WHERE actual.connection_id=${sqlText(connectionId)}::uuid AND actual.provider_product_id IN (${providerIds}))
  ) THEN RAISE EXCEPTION 'HYDRATION_TRANSITION_PROVIDER_TO_MISMATCH'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.agora_master_data
    WHERE connection_id=${sqlText(connectionId)}::uuid
      AND raw_xml_preview=${sqlText(`WINERIM_RESCUE_HYDRATION_V2_SHA256:${toDigest}`)}
      AND products_summary_json=${sqlJson(masterTo)}
  ) THEN RAISE EXCEPTION 'HYDRATION_TRANSITION_MASTER_TO_MISMATCH'; END IF;
END
$transition_postcondition$;

COMMIT;
`;
}

export function renderApplyHydrationTransitionSql(plan) {
  return renderTransitionSql(plan, "apply");
}

export function renderRollbackHydrationTransitionSql(plan) {
  return renderTransitionSql(plan, "rollback");
}

function argumentValue(args, name) {
  const equalsPrefix = `--${name}=`;
  const equalsValue = args.find((argument) => argument.startsWith(equalsPrefix));
  if (equalsValue) return equalsValue.slice(equalsPrefix.length);
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function readPlan(path, label) {
  const resolved = resolve(path);
  const metadata = lstatSync(resolved);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`HYDRATION_TRANSITION_${label}_MUST_BE_REGULAR_FILE`);
  return JSON.parse(readFileSync(resolved, "utf8"));
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
  const beforePath = argumentValue(args, "before-plan");
  const afterPath = argumentValue(args, "after-plan");
  const outputPath = argumentValue(args, "output-dir");
  if (!beforePath || !afterPath || !outputPath) {
    throw new Error("Usage: node scripts/generate-disabled-connection-hydration-transition.mjs --before-plan <json> --after-plan <json> --output-dir <dir>");
  }
  const outputDir = resolve(outputPath);
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const outputMetadata = lstatSync(outputDir);
  if (!outputMetadata.isDirectory() || outputMetadata.isSymbolicLink()) throw new Error("HYDRATION_TRANSITION_OUTPUT_DIR_INVALID");

  const plan = buildHydrationTransition(readPlan(beforePath, "BEFORE"), readPlan(afterPath, "AFTER"));
  const files = {
    [OUTPUT_FILES.plan]: `${JSON.stringify(plan, null, 2)}\n`,
    [OUTPUT_FILES.apply]: renderApplyHydrationTransitionSql(plan),
    [OUTPUT_FILES.rollback]: renderRollbackHydrationTransitionSql(plan),
  };
  for (const [name, content] of Object.entries(files)) atomicWrite(join(outputDir, name), content);
  const manifest = Object.entries(files)
    .map(([name, content]) => `${sha256(content)}  ${name}`)
    .sort()
    .join("\n") + "\n";
  atomicWrite(join(outputDir, OUTPUT_FILES.manifest), manifest);
  process.stdout.write(`RESULT=HYDRATION_TRANSITION_READY connection_id=${plan.connectionId} additions=${plan.additions.length} transition_digest=${plan.transitionDigest} output_dir=${outputDir}\n`);
  return plan;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
