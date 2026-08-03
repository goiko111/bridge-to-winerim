#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
POSTGRES_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
for command_name in initdb pg_ctl createdb dropdb psql pg_dump pg_restore node; do
  command -v "$command_name" >/dev/null 2>&1 || { printf 'BLOCKED: %s is not installed\n' "$command_name" >&2; exit 2; }
done

TMP_ROOT=$(mktemp -d /tmp/wrpf.XXXXXX)
DATA_DIR="$TMP_ROOT/data"
BACKUP_ROOT="$TMP_ROOT/backups"
SEED_SQL="$TMP_ROOT/rescue-connections-disabled.sql"
PORT=$((57432 + ($$ % 500)))
PROJECT_REF=piyvadlzagtracciquap
HYDRATION_CONNECTION_ID=00000000-0000-4000-8000-000000000001
LOCAL_DATABASE_USER=$(id -un)
SERVER_STARTED=0

cleanup() {
  if [ "$SERVER_STARTED" = 1 ]; then pg_ctl -D "$DATA_DIR" -m fast -w stop >/dev/null 2>&1 || true; fi
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT INT TERM

initdb -D "$DATA_DIR" --auth=trust --no-locale --encoding=UTF8 >/dev/null
pg_ctl -D "$DATA_DIR" -l "$TMP_ROOT/postgres.log" -o "-h 127.0.0.1 -p $PORT" -w start >/dev/null
SERVER_STARTED=1
server_major=$(psql -h 127.0.0.1 -p "$PORT" -d postgres -XAtq -c "SELECT current_setting('server_version_num')::int / 10000")
test "$server_major" = 17 || { printf 'FAIL: PostgreSQL 17 required, found major=%s\n' "$server_major" >&2; exit 1; }
createdb -h 127.0.0.1 -p "$PORT" winerim_rescue_production_test
createdb -h 127.0.0.1 -p "$PORT" winerim_rescue_restore_test

cat >"$SEED_SQL" <<'SQL'
BEGIN;
INSERT INTO public.pos_connections (
  id, location_name, provider, base_url, api_token, winerim_api_token,
  enabled, catalog_sync_enabled, sync_mode, write_mode,
  sync_frequency_minutes, backfill_days, last_sync_at, last_catalog_sync_at,
  last_business_day_synced, circuit_breaker_paused_until, circuit_breaker_reason,
  consecutive_failures
)
SELECT
  ('00000000-0000-4000-8000-' || lpad(item::text, 12, '0'))::uuid,
  'Rescue connection ' || item,
  CASE WHEN item = 31 THEN 'yurest' ELSE 'agora' END,
  'https://redacted.invalid', '', NULL,
  false, false, 'PULL_ONLY', 'NONE', 5, 0,
  NULL, NULL, NULL, NULL, NULL, 0
FROM generate_series(1, 31) item;
COMMIT;
SQL

mkdir -p "$BACKUP_ROOT"
chmod 700 "$BACKUP_ROOT"
printf 'winerim-rescue-production-backup:%s\n' "$PROJECT_REF" >"$BACKUP_ROOT/.winerim-rescue-production-backup"
chmod 600 "$BACKUP_ROOT/.winerim-rescue-production-backup"

export RESCUE_PRODUCTION_PROJECT_REF="$PROJECT_REF"
export RESCUE_PRODUCTION_EXPECTED_ENVIRONMENT=rescue-production
export RESCUE_PRODUCTION_DATABASE_URL="postgresql://$LOCAL_DATABASE_USER@127.0.0.1:$PORT/winerim_rescue_production_test"
export RESCUE_PRODUCTION_SEED_SQL="$SEED_SQL"
export RESCUE_PRODUCTION_BACKUP_ROOT="$BACKUP_ROOT"
export RESCUE_PRODUCTION_EXPECTED_CONNECTIONS=31
export WINERIM_RESCUE_PRODUCTION_LOCAL_TEST=1

plan_output=$("$POSTGRES_DIR/apply-rescue-production.sh")
plan_sha=$(sed -n 's/.*plan_sha256=\([^ ]*\).*/\1/p' <<<"$plan_output")
seed_sha=$(sed -n 's/.*seed_sha256=\([^ ]*\).*/\1/p' <<<"$plan_output")
test -n "$plan_sha" && test -n "$seed_sha" || { printf 'FAIL: plan digests missing\n' >&2; exit 1; }

apply_output=$("$POSTGRES_DIR/apply-rescue-production.sh" \
  --apply \
  --confirm-project-ref "$PROJECT_REF" \
  --confirm-environment rescue-production \
  --confirm-plan-sha "$plan_sha" \
  --confirm-seed-sha "$seed_sha" \
  --confirm-action APPLY_EMPTY_RESCUE_PRODUCTION_BOOTSTRAP)
grep -q 'RESULT=RESCUE_PRODUCTION_BOOTSTRAP_APPLIED' <<<"$apply_output"
"$POSTGRES_DIR/verify-rescue-production.sh" >/dev/null

psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
CREATE ROLE middleware_api_login LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT;
CREATE ROLE middleware_readonly_login LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT;
CREATE ROLE middleware_runtime_login LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT;
GRANT middleware_api TO middleware_api_login;
GRANT middleware_readonly TO middleware_readonly_login;
GRANT middleware_runtime TO middleware_runtime_login;
SQL
export RESCUE_PRODUCTION_EXPECTED_LOGIN_ROLES=3
export RESCUE_PRODUCTION_RUNTIME_DATABASE_URL="$RESCUE_PRODUCTION_DATABASE_URL"
if operator_error=$("$POSTGRES_DIR/verify-rescue-production.sh" 2>&1); then
  printf 'FAIL: verifier accepted the operator DSN as the runtime DSN\n' >&2
  exit 1
fi
grep -q 'runtime_login_identity expected=middleware_runtime_login' <<<"$operator_error"
export RESCUE_PRODUCTION_RUNTIME_DATABASE_URL="postgresql://middleware_runtime_login@127.0.0.1:$PORT/winerim_rescue_production_test"
RESCUE_PRODUCTION_EXPECTED_LOGIN_ROLES=3 "$POSTGRES_DIR/verify-rescue-production.sh" >/dev/null
psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c 'DROP ROLE middleware_api_login, middleware_readonly_login, middleware_runtime_login' >/dev/null
unset RESCUE_PRODUCTION_RUNTIME_DATABASE_URL
export RESCUE_PRODUCTION_EXPECTED_LOGIN_ROLES=0

pre_artifact=$(find "$BACKUP_ROOT/$PROJECT_REF" -mindepth 1 -maxdepth 1 -type d -name '*-pre-bootstrap-*' | head -n 1)
post_artifact=$(find "$BACKUP_ROOT/$PROJECT_REF" -mindepth 1 -maxdepth 1 -type d -name '*-post-bootstrap-*' | head -n 1)
test -n "$pre_artifact" && test -n "$post_artifact"
test "$(stat -c '%a' "$pre_artifact/public.dump" 2>/dev/null || stat -f '%Lp' "$pre_artifact/public.dump")" = 600

# A custom-format schema dump contains CREATE SCHEMA public. A fresh PostgreSQL
# database already has that schema, so the documented restore must remove the
# empty default schema before replaying the exact artifact.
RESTORE_DATABASE_URL="postgresql://$LOCAL_DATABASE_USER@127.0.0.1:$PORT/winerim_rescue_restore_test"
psql "$RESTORE_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c 'DROP SCHEMA public CASCADE' >/dev/null
psql "$RESTORE_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$post_artifact/restore-prerequisites.sql" >/dev/null
pg_restore --dbname="$RESTORE_DATABASE_URL" --no-owner --exit-on-error "$post_artifact/public.dump"
restored_tables=$(psql "$RESTORE_DATABASE_URL" -XAtq -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'")
restored_connections=$(psql "$RESTORE_DATABASE_URL" -XAtq -c "SELECT count(*) FROM public.pos_connections")
restored_unsafe=$(psql "$RESTORE_DATABASE_URL" -XAtq -c "SELECT count(*) FROM public.pos_connections WHERE enabled OR catalog_sync_enabled OR sync_mode <> 'PULL_ONLY' OR write_mode <> 'NONE' OR coalesce(api_token, '') <> '' OR winerim_api_token IS NOT NULL")
test "$restored_tables" = 30 && test "$restored_connections" = 31 && test "$restored_unsafe" = 0
# Roles are cluster-wide. Remove the disposable restored database after its
# assertions so the later rollback can prove that bootstrap roles are unused.
dropdb -h 127.0.0.1 -p "$PORT" winerim_rescue_restore_test

export RESCUE_PRODUCTION_HYDRATION_CONNECTION_ID="$HYDRATION_CONNECTION_ID"
export RESCUE_PRODUCTION_EXPECTED_HYDRATION_WINERIM_WINES=70
export RESCUE_PRODUCTION_EXPECTED_HYDRATION_PROVIDER_PRODUCTS=409
export RESCUE_PRODUCTION_EXPECTED_HYDRATION_PRODUCT_MAPPINGS=72
export RESCUE_PRODUCTION_EXPECTED_HYDRATION_MASTER_ROWS=1
export RESCUE_PRODUCTION_HYDRATION_PLAN_FILE="$TMP_ROOT/hydration-plan.json"

node - "$RESCUE_PRODUCTION_HYDRATION_PLAN_FILE" "$HYDRATION_CONNECTION_ID" <<'NODE'
const { createHash } = require("node:crypto");
const { writeFileSync } = require("node:fs");
const [path, connectionId] = process.argv.slice(2);
const canonicalJson = (value) => Array.isArray(value)
  ? `[${value.map(canonicalJson).join(",")}]`
  : value && typeof value === "object"
    ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`
    : JSON.stringify(value);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const winerimWines = Array.from({ length: 70 }, (_, index) => ({
  winerimId: String(index + 1),
  name: `Wine ${index + 1}`,
  sku: null,
  ean: null,
  vintage: null,
  winery: null,
  region: null,
  grapeVariety: null,
  wineType: null,
  price: null,
  stockQuantity: null,
  bottleSalePrice: null,
  glassSalePrice: null,
  magnumSalePrice: null,
  rawPayload: { stocks: [{ id: 100001 + index, stockActive: true, winePrice: { variant: "botella" } }] },
  bottleStockId: 100001 + index,
  glassStockId: null,
  magnumStockId: null,
  serveByGlass: false,
  pricingStatus: "MISSING",
  pricingMissingReason: null,
}));
const providerProducts = Array.from({ length: 409 }, (_, index) => ({
  providerProductId: String(index + 1),
  name: `Provider product ${index + 1}`,
  family: null,
  vatRate: 0,
  saleFormat: index < 72 ? "BOTTLE" : null,
  price: 0,
  isWineCandidate: index < 72,
  classificationStatus: index < 72 ? "CONFIRMED" : "NOT_WINE",
  wineScore: index < 72 ? 100 : 0,
  wineReasons: index < 72 ? ["RESCUE_EXACT_ID_WINE_ACTIVE_VARIANT"] : [],
  syncStatus: index < 72 ? "SYNCED" : "NOT_SYNCED",
  syncError: null,
  winerimWineId: index < 72 ? String((index % 70) + 1) : null,
  rawPayload: {},
}));
const acceptedMappings = Array.from({ length: 72 }, (_, index) => {
  const wineIndex = index % 70;
  return {
    providerProductId: String(index + 1),
    providerProductName: `Provider product ${index + 1}`,
    winerimWineId: String(wineIndex + 1),
    winerimWineName: `Wine ${wineIndex + 1}`,
    formatType: "BOTTLE",
    stockVariant: "botella",
    stockId: 100001 + wineIndex,
    stockActive: true,
    status: "CONFIRMED",
    matchMethod: "RESCUE_EXACT_ID_WINE_VARIANT",
  };
});
const digestPayload = {
  schemaVersion: 2,
  connectionId,
  acceptedMappings,
  winerimWines,
  providerProducts,
  agoraMasterData: {
    families: [],
    products: providerProducts.map((product) => ({
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
const plan = {
  schemaVersion: 2,
  kind: "disabled-connection-hydration",
  connectionId,
  hydrationDigest: sha256(canonicalJson(digestPayload)),
  counts: { currentWinerimWines: 70, currentAgoraProducts: 409, acceptedMappings: 72 },
  acceptedMappings,
  winerimWines,
  providerProducts,
  agoraMasterData: {
    families: [],
    productsSummary: providerProducts.map((product) => ({
      provider_product_id: product.providerProductId,
      name: product.name,
      family: product.family,
      price: product.price,
      sale_format: product.saleFormat,
      classification_status: product.classificationStatus,
      winerim_wine_id: product.winerimWineId,
      raw_payload: product.rawPayload,
    })),
  },
};
writeFileSync(path, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
NODE
HYDRATION_DIGEST=$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).hydrationDigest)' "$RESCUE_PRODUCTION_HYDRATION_PLAN_FILE")

psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -v hydration_connection_id="$HYDRATION_CONNECTION_ID" >/dev/null <<'SQL'
INSERT INTO public.winerim_wines (connection_id, winerim_id, name, raw_payload, bottle_stock_id)
SELECT :'hydration_connection_id'::uuid, item::text, 'Wine ' || item,
  jsonb_build_object('stocks', jsonb_build_array(jsonb_build_object('id', 100000 + item, 'stockActive', true, 'winePrice', jsonb_build_object('variant', 'botella')))),
  100000 + item
FROM generate_series(1, 70) item;

INSERT INTO public.provider_products (
  connection_id, provider_product_id, name, sale_format, price,
  is_wine_candidate, wine_score, wine_reasons, raw_payload,
  winerim_wine_id, classification_override, last_score, last_reasons,
  sync_status, sync_error, last_synced_at, provider_updated_at
)
SELECT
  :'hydration_connection_id'::uuid,
  item::text,
  'Provider product ' || item,
  CASE WHEN item <= 72 THEN 'BOTTLE' ELSE NULL END,
  0,
  item <= 72,
  CASE WHEN item <= 72 THEN 100 ELSE 0 END,
  CASE WHEN item <= 72 THEN ARRAY['RESCUE_EXACT_ID_WINE_ACTIVE_VARIANT'] ELSE ARRAY[]::text[] END,
  '{}'::jsonb,
  CASE WHEN item <= 72 THEN (((item - 1) % 70) + 1)::text ELSE NULL END,
  'AUTO',
  CASE WHEN item <= 72 THEN 100 ELSE 0 END,
  CASE WHEN item <= 72 THEN ARRAY['RESCUE_EXACT_ID_WINE_ACTIVE_VARIANT'] ELSE ARRAY[]::text[] END,
  CASE WHEN item <= 72 THEN 'SYNCED' ELSE 'NOT_SYNCED' END,
  NULL,
  NULL,
  NULL
FROM generate_series(1, 409) item;

INSERT INTO public.product_mappings (
  connection_id, provider_product_id, provider_product_name,
  winerim_wine_id, winerim_wine_name, match_method, match_score,
  match_reasons, status, format_type, agora_product_id,
  last_synced_at, last_sync_error
)
SELECT
  :'hydration_connection_id'::uuid,
  item::text,
  'Provider product ' || item,
  (((item - 1) % 70) + 1)::text,
  'Wine ' || (((item - 1) % 70) + 1),
  'RESCUE_EXACT_ID_WINE_VARIANT',
  1,
  ARRAY['CURRENT_AGORA_PRODUCT_ID','CURRENT_WINERIM_WINE_ID','CURRENT_BOTTLE_STOCK_ID_' || (100001 + ((item - 1) % 70)),'CURRENT_BOTTLE_STOCK_ACTIVE_TRUE'],
  'CONFIRMED',
  'BOTTLE',
  item::text,
  NULL,
  NULL
FROM generate_series(1, 72) item;
SQL
psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -v hydration_connection_id="$HYDRATION_CONNECTION_ID" -v hydration_digest="$HYDRATION_DIGEST" >/dev/null <<'SQL'
INSERT INTO public.agora_master_data (connection_id, families_json, products_summary_json, raw_xml_preview)
SELECT
  :'hydration_connection_id'::uuid,
  '[]'::jsonb,
  jsonb_agg(jsonb_build_object(
    'provider_product_id', provider_product_id,
    'name', name,
    'family', family,
    'price', price,
    'sale_format', sale_format,
    'classification_status', CASE WHEN is_wine_candidate AND winerim_wine_id IS NOT NULL THEN 'CONFIRMED' WHEN is_wine_candidate THEN 'AMBIGUOUS' ELSE 'NOT_WINE' END,
    'winerim_wine_id', winerim_wine_id,
    'raw_payload', raw_payload
  ) ORDER BY provider_product_id::numeric),
  'WINERIM_RESCUE_HYDRATION_V2_SHA256:' || :'hydration_digest'
FROM public.provider_products
WHERE connection_id=:'hydration_connection_id'::uuid;
SQL

if count_error=$(RESCUE_PRODUCTION_EXPECTED_HYDRATION_WINERIM_WINES=71 \
  "$POSTGRES_DIR/backup-rescue-production.sh" post-hydration 2>&1); then
  printf 'FAIL: post-hydration backup accepted the wrong exact counts\n' >&2
  exit 1
fi
grep -q 'POST_HYDRATION_PLAN_VALIDATION_REJECTED' <<<"$count_error"

psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -c "UPDATE public.pos_connections SET enabled=true WHERE id='$HYDRATION_CONNECTION_ID'::uuid" >/dev/null
if inert_error=$("$POSTGRES_DIR/backup-rescue-production.sh" post-hydration 2>&1); then
  printf 'FAIL: post-hydration backup accepted an enabled connection\n' >&2
  exit 1
fi
grep -q 'POST_HYDRATION_CONNECTIONS_NOT_FULLY_INERT' <<<"$inert_error"
psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -c "UPDATE public.pos_connections SET enabled=false WHERE id='$HYDRATION_CONNECTION_ID'::uuid" >/dev/null

psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 >/dev/null <<SQL
UPDATE public.provider_products
SET connection_id='00000000-0000-4000-8000-000000000002'::uuid
WHERE provider_product_id='409';
INSERT INTO public.provider_products (connection_id, provider_product_id, name)
VALUES ('$HYDRATION_CONNECTION_ID'::uuid, '410', 'Replacement count guard');
SQL
if owner_error=$("$POSTGRES_DIR/backup-rescue-production.sh" post-hydration 2>&1); then
  printf 'FAIL: post-hydration backup accepted catalog rows owned by another connection\n' >&2
  exit 1
fi
grep -q 'POST_HYDRATION_ROWS_OUTSIDE_EXPECTED_CONNECTION' <<<"$owner_error"
psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 >/dev/null <<SQL
DELETE FROM public.provider_products WHERE provider_product_id='410';
UPDATE public.provider_products
SET connection_id='$HYDRATION_CONNECTION_ID'::uuid
WHERE provider_product_id='409';
SQL

psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -c "INSERT INTO public.outbound_tasks (connection_id) VALUES ('$HYDRATION_CONNECTION_ID'::uuid)" >/dev/null
if operational_error=$("$POSTGRES_DIR/backup-rescue-production.sh" post-hydration 2>&1); then
  printf 'FAIL: post-hydration backup accepted outbound work\n' >&2
  exit 1
fi
grep -q 'POST_HYDRATION_OPERATIONAL_ROWS_REJECTED' <<<"$operational_error"
psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c 'TRUNCATE public.outbound_tasks' >/dev/null

psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -c "INSERT INTO public.winerim_push_tracking (connection_id, winerim_wine_id) VALUES ('$HYDRATION_CONNECTION_ID'::uuid, '1')" >/dev/null
if other_table_error=$("$POSTGRES_DIR/backup-rescue-production.sh" post-hydration 2>&1); then
  printf 'FAIL: post-hydration backup accepted rows in a disallowed table\n' >&2
  exit 1
fi
grep -q 'POST_HYDRATION_ROWS_IN_DISALLOWED_TABLES' <<<"$other_table_error"
psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c 'TRUNCATE public.winerim_push_tracking' >/dev/null

psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -c "UPDATE public.product_mappings SET match_method='MANUAL' WHERE connection_id='$HYDRATION_CONNECTION_ID'::uuid AND provider_product_id='1'" >/dev/null
if semantic_error=$("$POSTGRES_DIR/backup-rescue-production.sh" post-hydration 2>&1); then
  printf 'FAIL: post-hydration backup accepted a semantic mapping mutation\n' >&2
  exit 1
fi
grep -q 'POST_HYDRATION_MAPPING_SEMANTIC_FINGERPRINT_REJECTED' <<<"$semantic_error"
psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -c "UPDATE public.product_mappings SET match_method='RESCUE_EXACT_ID_WINE_VARIANT' WHERE connection_id='$HYDRATION_CONNECTION_ID'::uuid AND provider_product_id='1'" >/dev/null

psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -c "UPDATE public.provider_products SET price=999 WHERE connection_id='$HYDRATION_CONNECTION_ID'::uuid AND provider_product_id='409'" >/dev/null
if "$POSTGRES_DIR/backup-rescue-production.sh" post-hydration >/dev/null 2>&1; then
  printf 'FAIL: post-hydration backup accepted a same-count provider mutation\n' >&2
  exit 1
fi
psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -c "UPDATE public.provider_products SET price=0 WHERE connection_id='$HYDRATION_CONNECTION_ID'::uuid AND provider_product_id='409'" >/dev/null

psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -c "UPDATE public.winerim_wines SET region='MUTATED' WHERE connection_id='$HYDRATION_CONNECTION_ID'::uuid AND winerim_id='70'" >/dev/null
if "$POSTGRES_DIR/backup-rescue-production.sh" post-hydration >/dev/null 2>&1; then
  printf 'FAIL: post-hydration backup accepted a same-count wine mutation\n' >&2
  exit 1
fi
psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -c "UPDATE public.winerim_wines SET region=NULL WHERE connection_id='$HYDRATION_CONNECTION_ID'::uuid AND winerim_id='70'" >/dev/null

psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -c "UPDATE public.agora_master_data SET families_json='[{\"Id\":\"mutated\"}]'::jsonb WHERE connection_id='$HYDRATION_CONNECTION_ID'::uuid" >/dev/null
if "$POSTGRES_DIR/backup-rescue-production.sh" post-hydration >/dev/null 2>&1; then
  printf 'FAIL: post-hydration backup accepted a same-count master mutation\n' >&2
  exit 1
fi
psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -c "UPDATE public.agora_master_data SET families_json='[]'::jsonb WHERE connection_id='$HYDRATION_CONNECTION_ID'::uuid" >/dev/null

psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -c "UPDATE public.winerim_wines SET is_active=false WHERE connection_id='$HYDRATION_CONNECTION_ID'::uuid AND winerim_id='70'" >/dev/null
if fixed_wine_error=$("$POSTGRES_DIR/backup-rescue-production.sh" post-hydration 2>&1); then
  printf 'FAIL: post-hydration backup accepted same-count winerim_wines.is_active mutation\n' >&2
  exit 1
fi
grep -q 'POST_HYDRATION_DATABASE_FINGERPRINT_REJECTED' <<<"$fixed_wine_error"
psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -c "UPDATE public.winerim_wines SET is_active=true WHERE connection_id='$HYDRATION_CONNECTION_ID'::uuid AND winerim_id='70'" >/dev/null

psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -c "UPDATE public.provider_products SET last_score=777 WHERE connection_id='$HYDRATION_CONNECTION_ID'::uuid AND provider_product_id='409'" >/dev/null
if fixed_product_error=$("$POSTGRES_DIR/backup-rescue-production.sh" post-hydration 2>&1); then
  printf 'FAIL: post-hydration backup accepted same-count provider_products.last_score mutation\n' >&2
  exit 1
fi
grep -q 'POST_HYDRATION_DATABASE_FINGERPRINT_REJECTED' <<<"$fixed_product_error"
psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -c "UPDATE public.provider_products SET last_score=0 WHERE connection_id='$HYDRATION_CONNECTION_ID'::uuid AND provider_product_id='409'" >/dev/null

psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -c "UPDATE public.agora_master_data SET vats_json='[1]'::jsonb WHERE connection_id='$HYDRATION_CONNECTION_ID'::uuid" >/dev/null
if fixed_master_error=$("$POSTGRES_DIR/backup-rescue-production.sh" post-hydration 2>&1); then
  printf 'FAIL: post-hydration backup accepted same-count agora_master_data.vats_json mutation\n' >&2
  exit 1
fi
grep -q 'POST_HYDRATION_DATABASE_FINGERPRINT_REJECTED' <<<"$fixed_master_error"
psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -c "UPDATE public.agora_master_data SET vats_json='[]'::jsonb WHERE connection_id='$HYDRATION_CONNECTION_ID'::uuid" >/dev/null

psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -c "UPDATE public.product_mappings SET agora_product_id='mutated' WHERE connection_id='$HYDRATION_CONNECTION_ID'::uuid AND provider_product_id='1'" >/dev/null
if fixed_mapping_error=$("$POSTGRES_DIR/backup-rescue-production.sh" post-hydration 2>&1); then
  printf 'FAIL: post-hydration backup accepted same-count product_mappings.agora_product_id mutation\n' >&2
  exit 1
fi
grep -q 'POST_HYDRATION_DATABASE_FINGERPRINT_REJECTED' <<<"$fixed_mapping_error"
psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -c "UPDATE public.product_mappings SET agora_product_id=provider_product_id WHERE connection_id='$HYDRATION_CONNECTION_ID'::uuid AND provider_product_id='1'" >/dev/null

post_hydration_output=$("$POSTGRES_DIR/backup-rescue-production.sh" post-hydration)
grep -q 'RESCUE_PRODUCTION_BACKUP_OK phase=post-hydration' <<<"$post_hydration_output"
post_hydration_artifact=$(find "$BACKUP_ROOT/$PROJECT_REF" -mindepth 1 -maxdepth 1 -type d -name '*-post-hydration-*' | head -n 1)
test -n "$post_hydration_artifact"
test "$(awk -F= '$1=="schema_version" {print $2}' "$post_hydration_artifact/manifest.txt")" = 5
test "$(awk -F= '$1=="postgres_server_major" {print $2}' "$post_hydration_artifact/manifest.txt")" = 17
test "$(awk -F= '$1=="psql_major" {print $2}' "$post_hydration_artifact/manifest.txt")" = 17
test "$(awk -F= '$1=="pg_dump_major" {print $2}' "$post_hydration_artifact/manifest.txt")" = 17
test "$(awk -F= '$1=="pg_restore_major" {print $2}' "$post_hydration_artifact/manifest.txt")" = 17
test "$(awk -F= '$1=="phase" {print $2}' "$post_hydration_artifact/manifest.txt")" = post-hydration
test "$(awk -F= '$1=="hydration_connection_id" {print $2}' "$post_hydration_artifact/manifest.txt")" = "$HYDRATION_CONNECTION_ID"
test "$(awk -F= '$1=="hydration_winerim_wines" {print $2}' "$post_hydration_artifact/manifest.txt")" = 70
test "$(awk -F= '$1=="hydration_provider_products" {print $2}' "$post_hydration_artifact/manifest.txt")" = 409
test "$(awk -F= '$1=="hydration_product_mappings" {print $2}' "$post_hydration_artifact/manifest.txt")" = 72
test "$(awk -F= '$1=="hydration_master_rows" {print $2}' "$post_hydration_artifact/manifest.txt")" = 1
test "$(awk -F= '$1=="hydration_digest" {print $2}' "$post_hydration_artifact/manifest.txt")" = "$HYDRATION_DIGEST"
test "$(awk -F= '$1=="hydration_plan_sha256" {print $2}' "$post_hydration_artifact/manifest.txt")" = "$(sha256sum "$RESCUE_PRODUCTION_HYDRATION_PLAN_FILE" | awk '{print $1}')"
test -n "$(awk -F= '$1=="hydration_mappings_semantic_sha256" {print $2}' "$post_hydration_artifact/manifest.txt")"
test "$(sha256sum "$post_hydration_artifact/hydration-plan.json" | awk '{print $1}')" = "$(awk -F= '$1=="hydration_plan_sha256" {print $2}' "$post_hydration_artifact/manifest.txt")"
(cd "$post_hydration_artifact" && { sha256sum -c manifest.txt.sha256 >/dev/null 2>&1 || shasum -a 256 -c manifest.txt.sha256 >/dev/null; })

psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
CREATE ROLE middleware_api_login LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT;
CREATE ROLE middleware_readonly_login LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT;
CREATE ROLE middleware_runtime_login LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT;
GRANT middleware_api TO middleware_api_login;
GRANT middleware_readonly TO middleware_readonly_login;
GRANT middleware_runtime TO middleware_runtime_login;
SQL
export RESCUE_PRODUCTION_RUNTIME_DATABASE_URL="postgresql://middleware_runtime_login@127.0.0.1:$PORT/winerim_rescue_production_test"
export RESCUE_PRODUCTION_EXPECTED_LOGIN_ROLES=3

# Reconstruct the exact pre-0012 weakness and prove the target-bound hardening
# path can upgrade it without changing the hydrated data fingerprint.
psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -f "$POSTGRES_DIR/0011_runtime_sales_claim_identity.sql" >/dev/null
psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -c 'GRANT UPDATE ON public.runtime_idempotency TO middleware_runtime' >/dev/null
pre_hardening_backup_output=$("$POSTGRES_DIR/backup-rescue-production.sh" post-hydration)
pre_hardening_artifact=$(sed -n 's/.*artifact_dir=\([^ ]*\).*/\1/p' <<<"$pre_hardening_backup_output")
test -n "$pre_hardening_artifact" && test -d "$pre_hardening_artifact"
export RESCUE_PRODUCTION_HARDENING_BACKUP_ARTIFACT_DIR="$pre_hardening_artifact"
cp "$pre_hardening_artifact/public.toc" "$TMP_ROOT/public.toc.clean"
printf 'tampered\n' >>"$pre_hardening_artifact/public.toc"
if tampered_artifact_error=$("$POSTGRES_DIR/apply-rescue-production-hardening.sh" 2>&1); then
  printf 'FAIL: hardening plan accepted a tampered rollback artifact\n' >&2
  exit 1
fi
grep -q 'HARDENING_BACKUP_DIGEST_REJECTED key=toc_sha256' <<<"$tampered_artifact_error"
mv "$TMP_ROOT/public.toc.clean" "$pre_hardening_artifact/public.toc"
chmod 600 "$pre_hardening_artifact/public.toc"
hardening_plan_output=$("$POSTGRES_DIR/apply-rescue-production-hardening.sh")
grep -q 'RESULT=PLAN_ONLY' <<<"$hardening_plan_output"
hardening_plan_sha=$(sed -n 's/.*plan_sha256=\([^ ]*\).*/\1/p' <<<"$hardening_plan_output")
hardening_manifest_sha=$(sed -n 's/.*backup_manifest_sha256=\([^ ]*\).*/\1/p' <<<"$hardening_plan_output")
test -n "$hardening_plan_sha" && test -n "$hardening_manifest_sha"
hardening_apply_output=$("$POSTGRES_DIR/apply-rescue-production-hardening.sh" \
  --apply \
  --confirm-project-ref "$PROJECT_REF" \
  --confirm-plan-sha "$hardening_plan_sha" \
  --confirm-backup-manifest-sha "$hardening_manifest_sha" \
  --confirm-action APPLY_RESCUE_PRODUCTION_IDEMPOTENCY_0012)
grep -q 'RESULT=RESCUE_PRODUCTION_HARDENING_APPLIED' <<<"$hardening_apply_output"
grep -q 'RESCUE_PRODUCTION_BACKUP_OK phase=pre-canary' <<<"$hardening_apply_output"
test "$(psql "$RESCUE_PRODUCTION_DATABASE_URL" -XAtq -c "SELECT count(*) FROM pg_trigger trigger_contract JOIN pg_class table_class ON table_class.oid=trigger_contract.tgrelid JOIN pg_proc trigger_function ON trigger_function.oid=trigger_contract.tgfoid WHERE table_class.oid='public.runtime_idempotency'::regclass AND trigger_contract.tgname='runtime_bind_sales_claim_identity' AND NOT trigger_contract.tgisinternal AND position('NEW.sales_claim_identity IS DISTINCT FROM OLD.sales_claim_identity' IN trigger_function.prosrc)>0 AND (SELECT count(*) FROM unnest(trigger_contract.tgattr))=4 AND NOT has_table_privilege('middleware_runtime','public.runtime_idempotency','UPDATE') AND NOT has_column_privilege('middleware_runtime','public.runtime_idempotency','sales_claim_identity','UPDATE')")" = 1
. "$POSTGRES_DIR/postgres-client-tools.sh"
configure_postgres_tools "$RESCUE_PRODUCTION_DATABASE_URL"
test "$(hydration_database_fingerprint "$RESCUE_PRODUCTION_DATABASE_URL" "$HYDRATION_CONNECTION_ID")" = "$HYDRATION_DIGEST"
unset RESCUE_PRODUCTION_HARDENING_BACKUP_ARTIFACT_DIR

psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -c 'GRANT UPDATE (idempotency_key) ON public.runtime_idempotency TO middleware_runtime' >/dev/null
if excessive_role_grant_error=$("$POSTGRES_DIR/verify-rescue-production.sh" 2>&1); then
  printf 'FAIL: verifier accepted an extra runtime role UPDATE column\n' >&2
  exit 1
fi
grep -q 'runtime_idempotency_update_privilege_contract' <<<"$excessive_role_grant_error"
psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -c 'REVOKE UPDATE (idempotency_key) ON public.runtime_idempotency FROM middleware_runtime' >/dev/null
psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -c 'GRANT UPDATE (sales_claim_identity) ON public.runtime_idempotency TO middleware_runtime_login' >/dev/null
if direct_login_grant_error=$("$POSTGRES_DIR/verify-rescue-production.sh" 2>&1); then
  printf 'FAIL: verifier accepted a direct runtime login UPDATE grant\n' >&2
  exit 1
fi
grep -q 'runtime_idempotency_update_privilege_contract' <<<"$direct_login_grant_error"
psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -c 'REVOKE UPDATE (sales_claim_identity) ON public.runtime_idempotency FROM middleware_runtime_login' >/dev/null

if empty_contract_error=$(env \
  -u RESCUE_PRODUCTION_HYDRATION_CONNECTION_ID \
  -u RESCUE_PRODUCTION_HYDRATION_PLAN_FILE \
  -u RESCUE_PRODUCTION_EXPECTED_HYDRATION_WINERIM_WINES \
  -u RESCUE_PRODUCTION_EXPECTED_HYDRATION_PROVIDER_PRODUCTS \
  -u RESCUE_PRODUCTION_EXPECTED_HYDRATION_PRODUCT_MAPPINGS \
  -u RESCUE_PRODUCTION_EXPECTED_HYDRATION_MASTER_ROWS \
  "$POSTGRES_DIR/backup-rescue-production.sh" pre-canary 2>&1); then
  printf 'FAIL: pre-canary backup accepted hydrated rows without the exact hydration contract\n' >&2
  exit 1
fi
grep -q 'PRE_CANARY_INERT_STATE_VERIFICATION_FAILED' <<<"$empty_contract_error"

RESCUE_PRODUCTION_EXPECTED_LOGIN_ROLES=3 "$POSTGRES_DIR/verify-rescue-production.sh" >/dev/null
hydrated_pre_canary_output=$("$POSTGRES_DIR/backup-rescue-production.sh" pre-canary)
grep -q 'RESCUE_PRODUCTION_BACKUP_OK phase=pre-canary' <<<"$hydrated_pre_canary_output"
hydrated_pre_canary_artifact=$(sed -n 's/.*artifact_dir=\([^ ]*\).*/\1/p' <<<"$hydrated_pre_canary_output")
test -n "$hydrated_pre_canary_artifact" && test -d "$hydrated_pre_canary_artifact"
test "$(awk -F= '$1=="schema_version" {print $2}' "$hydrated_pre_canary_artifact/manifest.txt")" = 5
test "$(awk -F= '$1=="phase" {print $2}' "$hydrated_pre_canary_artifact/manifest.txt")" = pre-canary
test "$(awk -F= '$1=="hydration_connection_id" {print $2}' "$hydrated_pre_canary_artifact/manifest.txt")" = "$HYDRATION_CONNECTION_ID"
test "$(awk -F= '$1=="hydration_digest" {print $2}' "$hydrated_pre_canary_artifact/manifest.txt")" = "$HYDRATION_DIGEST"
test "$(sha256sum "$hydrated_pre_canary_artifact/hydration-plan.json" | awk '{print $1}')" = "$(awk -F= '$1=="hydration_plan_sha256" {print $2}' "$hydrated_pre_canary_artifact/manifest.txt")"
(cd "$hydrated_pre_canary_artifact" && { sha256sum -c manifest.txt.sha256 >/dev/null 2>&1 || shasum -a 256 -c manifest.txt.sha256 >/dev/null; })

export RESCUE_PRODUCTION_ROLLBACK_ARTIFACT_DIR="$hydrated_pre_canary_artifact"
hydrated_rollback_plan=$("$POSTGRES_DIR/rollback-rescue-production.sh")
grep -q "scope=hydration-only:$HYDRATION_CONNECTION_ID" <<<"$hydrated_rollback_plan"
hydrated_rollback_sha=$(sed -n 's/.*plan_sha256=\([^ ]*\).*/\1/p' <<<"$hydrated_rollback_plan")
test -n "$hydrated_rollback_sha"
hydrated_rollback_output=$("$POSTGRES_DIR/rollback-rescue-production.sh" \
  --apply \
  --confirm-project-ref "$PROJECT_REF" \
  --confirm-plan-sha "$hydrated_rollback_sha" \
  --confirm-action ROLLBACK_RESCUE_PRODUCTION_TO_PRE_CANARY)
grep -q 'RESULT=RESCUE_PRODUCTION_ROLLED_BACK_TO_PRE_CANARY' <<<"$hydrated_rollback_output"
hydrated_rollback_counts=$(psql "$RESCUE_PRODUCTION_DATABASE_URL" -XAtq -c "SELECT (SELECT count(*) FROM public.pos_connections) || '|' || (SELECT count(*) FROM public.pos_connections WHERE enabled OR catalog_sync_enabled OR sync_mode<>'PULL_ONLY' OR write_mode<>'NONE') || '|' || (SELECT count(*) FROM public.winerim_wines WHERE connection_id='$HYDRATION_CONNECTION_ID'::uuid) || '|' || (SELECT count(*) FROM public.provider_products WHERE connection_id='$HYDRATION_CONNECTION_ID'::uuid) || '|' || (SELECT count(*) FROM public.product_mappings WHERE connection_id='$HYDRATION_CONNECTION_ID'::uuid) || '|' || (SELECT count(*) FROM public.agora_master_data WHERE connection_id='$HYDRATION_CONNECTION_ID'::uuid)")
test "$hydrated_rollback_counts" = '31|0|70|409|72|1'
configure_postgres_tools "$RESCUE_PRODUCTION_DATABASE_URL"
test "$(hydration_database_fingerprint "$RESCUE_PRODUCTION_DATABASE_URL" "$HYDRATION_CONNECTION_ID")" = "$HYDRATION_DIGEST"
unset RESCUE_PRODUCTION_ROLLBACK_ARTIFACT_DIR

psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c 'DROP ROLE middleware_api_login, middleware_readonly_login, middleware_runtime_login' >/dev/null
unset RESCUE_PRODUCTION_RUNTIME_DATABASE_URL
export RESCUE_PRODUCTION_EXPECTED_LOGIN_ROLES=0

createdb -h 127.0.0.1 -p "$PORT" winerim_rescue_restore_test
psql "$RESTORE_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c 'DROP SCHEMA public CASCADE' >/dev/null
psql "$RESTORE_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$post_hydration_artifact/restore-prerequisites.sql" >/dev/null
pg_restore --dbname="$RESTORE_DATABASE_URL" --no-owner --exit-on-error "$post_hydration_artifact/public.dump"
restored_post_hydration=$(psql "$RESTORE_DATABASE_URL" -XAtq -c "SELECT (SELECT count(*) FROM public.pos_connections) || '|' || (SELECT count(*) FROM public.pos_connections WHERE enabled OR catalog_sync_enabled OR sync_mode<>'PULL_ONLY' OR write_mode<>'NONE' OR backfill_days<>0 OR last_sync_at IS NOT NULL OR last_catalog_sync_at IS NOT NULL OR last_business_day_synced IS NOT NULL OR circuit_breaker_paused_until IS NOT NULL OR consecutive_failures<>0 OR base_url<>'https://redacted.invalid' OR api_token<>'' OR winerim_api_token IS NOT NULL) || '|' || (SELECT count(*) FROM public.winerim_wines WHERE connection_id='$HYDRATION_CONNECTION_ID'::uuid) || '|' || (SELECT count(*) FROM public.provider_products WHERE connection_id='$HYDRATION_CONNECTION_ID'::uuid) || '|' || (SELECT count(*) FROM public.product_mappings WHERE connection_id='$HYDRATION_CONNECTION_ID'::uuid) || '|' || (SELECT count(*) FROM public.agora_master_data WHERE connection_id='$HYDRATION_CONNECTION_ID'::uuid)")
test "$restored_post_hydration" = '31|0|70|409|72|1'
restored_disallowed_rows=$(psql "$RESTORE_DATABASE_URL" -XAtq -c "SELECT coalesce(sum((xpath('/row/count/text()', query_to_xml(format('SELECT count(*) AS count FROM public.%I', c.relname), false, true, '')))[1]::text::bigint), 0) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relname NOT IN ('infrastructure_metadata','pos_connections','winerim_wines','provider_products','product_mappings','agora_master_data')")
test "$restored_disallowed_rows" = 0
dropdb -h 127.0.0.1 -p "$PORT" winerim_rescue_restore_test

psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -c 'TRUNCATE public.product_mappings, public.provider_products, public.agora_master_data, public.winerim_wines' >/dev/null

psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "UPDATE public.pos_connections SET enabled=true WHERE id=(SELECT id FROM public.pos_connections ORDER BY id LIMIT 1)" >/dev/null
if "$POSTGRES_DIR/verify-rescue-production.sh" >/dev/null 2>&1; then
  printf 'FAIL: verifier accepted an enabled rescue connection\n' >&2
  exit 1
fi
export RESCUE_PRODUCTION_ROLLBACK_ARTIFACT_DIR="$pre_artifact"
if "$POSTGRES_DIR/rollback-rescue-production.sh" >/dev/null 2>&1; then
  printf 'FAIL: rollback accepted an enabled rescue connection\n' >&2
  exit 1
fi
psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "UPDATE public.pos_connections SET enabled=false" >/dev/null

rollback_plan=$("$POSTGRES_DIR/rollback-rescue-production.sh")
rollback_sha=$(sed -n 's/.*plan_sha256=\([^ ]*\).*/\1/p' <<<"$rollback_plan")
test -n "$rollback_sha" || { printf 'FAIL: rollback digest missing\n' >&2; exit 1; }
rollback_output=$("$POSTGRES_DIR/rollback-rescue-production.sh" \
  --apply \
  --confirm-project-ref "$PROJECT_REF" \
  --confirm-plan-sha "$rollback_sha" \
  --confirm-action ROLLBACK_UNUSED_RESCUE_PRODUCTION)
grep -q 'RESULT=RESCUE_PRODUCTION_ROLLED_BACK_TO_EMPTY' <<<"$rollback_output"

post_tables=$(psql "$RESCUE_PRODUCTION_DATABASE_URL" -XAtq -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'")
post_roles=$(psql "$RESCUE_PRODUCTION_DATABASE_URL" -XAtq -c "SELECT count(*) FROM pg_roles WHERE rolname LIKE 'middleware_%'")
test "$post_tables" = 0 && test "$post_roles" = 0

printf 'RESULT=RESCUE_PRODUCTION_FLOW_TEST_OK postgres_major=17 plan=fail_closed backups=pre_post_and_post_hydration post_bootstrap_restore=30_tables_31_connections_unsafe_0 post_hydration_restore=31_unsafe_0_wines_70_products_409_mappings_72_master_1 seed=31_unsafe_0 rollback=empty\n'
