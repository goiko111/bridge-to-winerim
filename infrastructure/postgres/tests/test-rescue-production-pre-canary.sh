#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
POSTGRES_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
for command_name in initdb pg_ctl createdb psql node; do
  command -v "$command_name" >/dev/null 2>&1 || { printf 'BLOCKED: %s is not installed\n' "$command_name" >&2; exit 2; }
done

TMP_ROOT=$(mktemp -d /tmp/wrpc.XXXXXX)
DATA_DIR="$TMP_ROOT/data"
BACKUP_ROOT="$TMP_ROOT/backups"
SEED_SQL="$TMP_ROOT/rescue-connections-disabled.sql"
PORT=$((57932 + ($$ % 400)))
PROJECT_REF=piyvadlzagtracciquap
LOCAL_DATABASE_USER=$(id -un)
DATABASE_NAME=winerim_rescue_production_test
CANDIDATE_ID=00000000-0000-4000-8000-000000000001
OTHER_ID=00000000-0000-4000-8000-000000000002
SERVER_STARTED=0

cleanup() {
  if [ "$SERVER_STARTED" = 1 ]; then pg_ctl -D "$DATA_DIR" -m fast -w stop >/dev/null 2>&1 || true; fi
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT INT TERM

initdb -D "$DATA_DIR" --auth=trust --no-locale --encoding=UTF8 >/dev/null
pg_ctl -D "$DATA_DIR" -l "$TMP_ROOT/postgres.log" -o "-h 127.0.0.1 -p $PORT" -w start >/dev/null
SERVER_STARTED=1
createdb -h 127.0.0.1 -p "$PORT" "$DATABASE_NAME"

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
export RESCUE_PRODUCTION_DATABASE_URL="postgresql://$LOCAL_DATABASE_USER@127.0.0.1:$PORT/$DATABASE_NAME"
export RESCUE_PRODUCTION_SEED_SQL="$SEED_SQL"
export RESCUE_PRODUCTION_BACKUP_ROOT="$BACKUP_ROOT"
export RESCUE_PRODUCTION_EXPECTED_CONNECTIONS=31
export RESCUE_PRODUCTION_EXPECTED_CANARY_WINERIM_WINES=2
export RESCUE_PRODUCTION_EXPECTED_CANARY_PROVIDER_PRODUCTS=4
export RESCUE_PRODUCTION_EXPECTED_CANARY_PRODUCT_MAPPINGS=2
export RESCUE_PRODUCTION_EXPECTED_CANARY_MASTER_ROWS=1
export RESCUE_PRODUCTION_EXPECTED_CANARY_AMBIGUOUS_PRODUCTS=1
export WINERIM_RESCUE_PRODUCTION_LOCAL_TEST=1

plan_output=$("$POSTGRES_DIR/apply-rescue-production.sh")
plan_sha=$(sed -n 's/.*plan_sha256=\([^ ]*\).*/\1/p' <<<"$plan_output")
seed_sha=$(sed -n 's/.*seed_sha256=\([^ ]*\).*/\1/p' <<<"$plan_output")
"$POSTGRES_DIR/apply-rescue-production.sh" \
  --apply \
  --confirm-project-ref "$PROJECT_REF" \
  --confirm-environment rescue-production \
  --confirm-plan-sha "$plan_sha" \
  --confirm-seed-sha "$seed_sha" \
  --confirm-action APPLY_EMPTY_RESCUE_PRODUCTION_BOOTSTRAP >/dev/null

psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
CREATE ROLE middleware_api_login LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT;
CREATE ROLE middleware_readonly_login LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT;
CREATE ROLE middleware_runtime_login LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT;
GRANT middleware_api TO middleware_api_login;
GRANT middleware_readonly TO middleware_readonly_login;
GRANT middleware_runtime TO middleware_runtime_login;
SQL
export RESCUE_PRODUCTION_EXPECTED_LOGIN_ROLES=3
export RESCUE_PRODUCTION_RUNTIME_DATABASE_URL="postgresql://middleware_runtime_login@127.0.0.1:$PORT/$DATABASE_NAME"
"$POSTGRES_DIR/verify-rescue-production.sh" >/dev/null

pre_canary_output=$("$POSTGRES_DIR/backup-rescue-production.sh" pre-canary)
pre_canary_artifact=$(sed -n 's/.*artifact_dir=\([^ ]*\).*/\1/p' <<<"$pre_canary_output")
test -n "$pre_canary_artifact" && test -d "$pre_canary_artifact"
test "$(awk -F= '$1=="phase" {print $2}' "$pre_canary_artifact/manifest.txt")" = pre-canary

export RESCUE_PRODUCTION_ROLLBACK_ARTIFACT_DIR="$pre_canary_artifact"
pre_hydration_plan=$("$POSTGRES_DIR/rollback-rescue-production.sh")
grep -q 'scope=pre-hydration-inert' <<<"$pre_hydration_plan"
pre_hydration_sha=$(sed -n 's/.*plan_sha256=\([^ ]*\).*/\1/p' <<<"$pre_hydration_plan")
psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "INSERT INTO public.winerim_wines (connection_id, winerim_id, name) VALUES ('$CANDIDATE_ID', 'hydrated-1', 'Hydrated canary wine')" >/dev/null
hydration_plan=$("$POSTGRES_DIR/rollback-rescue-production.sh")
grep -q "scope=hydration-only:$CANDIDATE_ID" <<<"$hydration_plan"
hydration_sha=$(sed -n 's/.*plan_sha256=\([^ ]*\).*/\1/p' <<<"$hydration_plan")
test -n "$pre_hydration_sha" && test -n "$hydration_sha" && test "$pre_hydration_sha" != "$hydration_sha" || {
  printf 'FAIL: rollback plan SHA did not bind the changed scope/state\n' >&2
  exit 1
}
psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "UPDATE public.winerim_wines SET name='Hydrated canary wine changed' WHERE connection_id='$CANDIDATE_ID' AND winerim_id='hydrated-1'" >/dev/null
hydration_changed_plan=$("$POSTGRES_DIR/rollback-rescue-production.sh")
hydration_changed_sha=$(sed -n 's/.*plan_sha256=\([^ ]*\).*/\1/p' <<<"$hydration_changed_plan")
test -n "$hydration_changed_sha" && test "$hydration_sha" != "$hydration_changed_sha" || {
  printf 'FAIL: rollback plan SHA did not bind a semantic state mutation at equal counts/scope\n' >&2
  exit 1
}
psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "UPDATE public.winerim_wines SET name='Hydrated canary wine' WHERE connection_id='$CANDIDATE_ID' AND winerim_id='hydrated-1'" >/dev/null
psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "INSERT INTO public.winerim_wines (connection_id, winerim_id, name) VALUES ('$OTHER_ID', 'hydrated-2', 'Other connection wine')" >/dev/null
if "$POSTGRES_DIR/rollback-rescue-production.sh" >/dev/null 2>&1; then
  printf 'FAIL: rollback accepted hydration across two connections\n' >&2
  exit 1
fi
psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "DELETE FROM public.winerim_wines WHERE connection_id='$OTHER_ID'" >/dev/null
psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "INSERT INTO public.sales_events (connection_id, provider_doc_id, business_day) VALUES ('$CANDIDATE_ID', 'prior-sale', current_date)" >/dev/null
if "$POSTGRES_DIR/rollback-rescue-production.sh" >/dev/null 2>&1; then
  printf 'FAIL: hydration-only rollback accepted prior sales\n' >&2
  exit 1
fi
psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "DELETE FROM public.sales_events WHERE provider_doc_id='prior-sale'" >/dev/null

psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 >/dev/null <<SQL
DELETE FROM public.winerim_wines WHERE connection_id='$CANDIDATE_ID';
INSERT INTO public.winerim_wines (
  connection_id, winerim_id, name, raw_payload, bottle_stock_id, glass_stock_id, magnum_stock_id
)
VALUES
  ('$CANDIDATE_ID', '101', 'Canary bottle wine', '{"stocks":[{"id":1001,"stockActive":true,"winePrice":{"variant":"botella"}},{"id":1099,"stockActive":true,"winePrice":{"variant":"magnum"}}]}'::jsonb, 1001, NULL, 1099),
  ('$CANDIDATE_ID', '102', 'Canary glass wine', '{"stocks":[{"id":1002,"stockActive":true,"winePrice":{"variant":"copa"}}]}'::jsonb, NULL, 1002, NULL);
INSERT INTO public.provider_products (
  connection_id, provider_product_id, name, sale_format, is_wine_candidate,
  wine_score, wine_reasons, classification_override, last_score, last_reasons,
  sync_status, sync_error, winerim_wine_id
)
VALUES
  ('$CANDIDATE_ID', '500101', 'B Canary bottle', 'BOTTLE', true, 100, ARRAY['RESCUE_EXACT_ID_WINE_ACTIVE_VARIANT'], 'AUTO', 100, ARRAY['RESCUE_EXACT_ID_WINE_ACTIVE_VARIANT'], 'SYNCED', NULL, '101'),
  ('$CANDIDATE_ID', '700102', 'C Canary glass', 'GLASS', true, 100, ARRAY['RESCUE_EXACT_ID_WINE_ACTIVE_VARIANT'], 'AUTO', 100, ARRAY['RESCUE_EXACT_ID_WINE_ACTIVE_VARIANT'], 'SYNCED', NULL, '102'),
  ('$CANDIDATE_ID', '500103', 'B Ambiguous candidate', NULL, true, 50, ARRAY['REJECTED_STOCK_VARIANT_INACTIVE'], 'AUTO', 50, ARRAY['REJECTED_STOCK_VARIANT_INACTIVE'], 'BLOCKED', 'HYDRATION_WINE_CANDIDATE_AMBIGUOUS', NULL),
  ('$CANDIDATE_ID', '900001', 'Non wine', NULL, false, 0, ARRAY[]::text[], 'AUTO', 0, ARRAY[]::text[], 'NOT_SYNCED', NULL, NULL);
INSERT INTO public.product_mappings (
  connection_id, provider_product_id, provider_product_name, winerim_wine_id,
  winerim_wine_name, match_method, match_score, match_reasons, status, format_type,
  agora_product_id, last_synced_at, last_sync_error
)
VALUES
  ('$CANDIDATE_ID', '500101', 'B Canary bottle', '101', 'Canary bottle wine', 'RESCUE_EXACT_ID_WINE_VARIANT', 1, ARRAY['CURRENT_AGORA_PRODUCT_ID','CURRENT_WINERIM_WINE_ID','CURRENT_BOTTLE_STOCK_ID_1001','CURRENT_BOTTLE_STOCK_ACTIVE_TRUE'], 'CONFIRMED', 'BOTTLE', '500101', NULL, NULL),
  ('$CANDIDATE_ID', '700102', 'C Canary glass', '102', 'Canary glass wine', 'RESCUE_EXACT_ID_WINE_VARIANT', 1, ARRAY['CURRENT_AGORA_PRODUCT_ID','CURRENT_WINERIM_WINE_ID','CURRENT_GLASS_STOCK_ID_1002','CURRENT_GLASS_STOCK_ACTIVE_TRUE'], 'CONFIRMED', 'GLASS', '700102', NULL, NULL);
INSERT INTO public.agora_master_data (connection_id, families_json, products_summary_json, raw_xml_preview)
SELECT
  '$CANDIDATE_ID'::uuid,
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
  'WINERIM_RESCUE_HYDRATION_V2_SHA256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
FROM public.provider_products
WHERE connection_id='$CANDIDATE_ID'::uuid;
SQL

. "$POSTGRES_DIR/postgres-client-tools.sh"
configure_postgres_tools "$RESCUE_PRODUCTION_DATABASE_URL"
if PRECANARY_HYDRATION_DIGEST=$(hydration_database_fingerprint "$RESCUE_PRODUCTION_DATABASE_URL" "$CANDIDATE_ID" 2>/dev/null); then
  printf 'FAIL: hydration fingerprint accepted a mismatched master digest marker\n' >&2
  exit 1
fi
[[ "$PRECANARY_HYDRATION_DIGEST" =~ ^[0-9a-f]{64}$ ]]
psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -c "UPDATE public.agora_master_data SET raw_xml_preview='WINERIM_RESCUE_HYDRATION_V2_SHA256:$PRECANARY_HYDRATION_DIGEST' WHERE connection_id='$CANDIDATE_ID'::uuid" >/dev/null
test "$(hydration_database_fingerprint "$RESCUE_PRODUCTION_DATABASE_URL" "$CANDIDATE_ID")" = "$PRECANARY_HYDRATION_DIGEST"

psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 >/dev/null <<SQL
UPDATE public.pos_connections
SET enabled=true, base_url='https://canary.invalid'
WHERE id='$CANDIDATE_ID';
INSERT INTO public.runtime_canary_connections (connection_id, active, approved_at, expires_at, note)
VALUES ('$CANDIDATE_ID', true, now() - interval '1 minute', now() + interval '1 hour', 'local test');
INSERT INTO public.runtime_connection_credentials (
  connection_id, provider, credential_kind, key_version, ciphertext, nonce, active
)
VALUES
  ('$CANDIDATE_ID', 'agora', 'agora', 'test-v1', decode(repeat('11', 17), 'hex'), decode(repeat('22', 12), 'hex'), true),
  ('$CANDIDATE_ID', 'agora', 'winerim', 'test-v1', decode(repeat('33', 17), 'hex'), decode(repeat('44', 12), 'hex'), true);
SQL
export RESCUE_PRODUCTION_CANARY_CONNECTION_ID="$CANDIDATE_ID"
"$POSTGRES_DIR/verify-rescue-production-pre-canary.sh" >/dev/null

psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "UPDATE public.provider_products SET price=999 WHERE connection_id='$CANDIDATE_ID' AND provider_product_id='900001'" >/dev/null
if "$POSTGRES_DIR/verify-rescue-production-pre-canary.sh" >/dev/null 2>&1; then
  printf 'FAIL: pre-canary verifier accepted a same-count provider mutation\n' >&2
  exit 1
fi
psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "UPDATE public.provider_products SET price=0 WHERE connection_id='$CANDIDATE_ID' AND provider_product_id='900001'" >/dev/null

psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "UPDATE public.winerim_wines SET region='MUTATED' WHERE connection_id='$CANDIDATE_ID' AND winerim_id='102'" >/dev/null
if "$POSTGRES_DIR/verify-rescue-production-pre-canary.sh" >/dev/null 2>&1; then
  printf 'FAIL: pre-canary verifier accepted a same-count wine mutation\n' >&2
  exit 1
fi
psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "UPDATE public.winerim_wines SET region=NULL WHERE connection_id='$CANDIDATE_ID' AND winerim_id='102'" >/dev/null

psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "UPDATE public.agora_master_data SET families_json='[{\"Id\":\"mutated\"}]'::jsonb WHERE connection_id='$CANDIDATE_ID'" >/dev/null
if "$POSTGRES_DIR/verify-rescue-production-pre-canary.sh" >/dev/null 2>&1; then
  printf 'FAIL: pre-canary verifier accepted a same-count master mutation\n' >&2
  exit 1
fi
psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "UPDATE public.agora_master_data SET families_json='[]'::jsonb WHERE connection_id='$CANDIDATE_ID'" >/dev/null

psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "UPDATE public.winerim_wines SET is_active=false WHERE connection_id='$CANDIDATE_ID' AND winerim_id='102'" >/dev/null
if fixed_wine_error=$("$POSTGRES_DIR/verify-rescue-production-pre-canary.sh" 2>&1); then
  printf 'FAIL: pre-canary verifier accepted same-count winerim_wines.is_active mutation\n' >&2
  exit 1
fi
grep -q 'candidate_database_hydration_fingerprint could not be computed' <<<"$fixed_wine_error"
psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "UPDATE public.winerim_wines SET is_active=true WHERE connection_id='$CANDIDATE_ID' AND winerim_id='102'" >/dev/null

psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "UPDATE public.provider_products SET last_score=777 WHERE connection_id='$CANDIDATE_ID' AND provider_product_id='900001'" >/dev/null
if fixed_product_error=$("$POSTGRES_DIR/verify-rescue-production-pre-canary.sh" 2>&1); then
  printf 'FAIL: pre-canary verifier accepted same-count provider_products.last_score mutation\n' >&2
  exit 1
fi
grep -q 'candidate_database_hydration_fingerprint could not be computed' <<<"$fixed_product_error"
psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "UPDATE public.provider_products SET last_score=0 WHERE connection_id='$CANDIDATE_ID' AND provider_product_id='900001'" >/dev/null

psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "UPDATE public.agora_master_data SET vats_json='[1]'::jsonb WHERE connection_id='$CANDIDATE_ID'" >/dev/null
if fixed_master_error=$("$POSTGRES_DIR/verify-rescue-production-pre-canary.sh" 2>&1); then
  printf 'FAIL: pre-canary verifier accepted same-count agora_master_data.vats_json mutation\n' >&2
  exit 1
fi
grep -q 'candidate_database_hydration_fingerprint could not be computed' <<<"$fixed_master_error"
psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "UPDATE public.agora_master_data SET vats_json='[]'::jsonb WHERE connection_id='$CANDIDATE_ID'" >/dev/null

psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "UPDATE public.product_mappings SET agora_product_id='mutated' WHERE connection_id='$CANDIDATE_ID' AND provider_product_id='500101'" >/dev/null
if fixed_mapping_error=$("$POSTGRES_DIR/verify-rescue-production-pre-canary.sh" 2>&1); then
  printf 'FAIL: pre-canary verifier accepted same-count product_mappings.agora_product_id mutation\n' >&2
  exit 1
fi
grep -q 'candidate_database_hydration_fingerprint could not be computed' <<<"$fixed_mapping_error"
psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "UPDATE public.product_mappings SET agora_product_id=provider_product_id WHERE connection_id='$CANDIDATE_ID' AND provider_product_id='500101'" >/dev/null

export RESCUE_PRODUCTION_RUNTIME_DATABASE_URL="$RESCUE_PRODUCTION_DATABASE_URL"
if operator_error=$("$POSTGRES_DIR/verify-rescue-production-pre-canary.sh" 2>&1); then
  printf 'FAIL: pre-canary verifier accepted operator DSN as runtime DSN\n' >&2
  exit 1
fi
grep -q 'runtime_login_identity expected=middleware_runtime_login' <<<"$operator_error"
export RESCUE_PRODUCTION_RUNTIME_DATABASE_URL="postgresql://middleware_runtime_login@127.0.0.1:$PORT/$DATABASE_NAME"

psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "REVOKE SELECT ON public.provider_products FROM middleware_runtime" >/dev/null
if catalog_permission_error=$("$POSTGRES_DIR/verify-rescue-production-pre-canary.sh" 2>&1); then
  printf 'FAIL: pre-canary verifier accepted missing runtime catalog permission\n' >&2
  exit 1
fi
grep -Eq 'runtime_catalog_privilege_contract|runtime_effective_provider_products' <<<"$catalog_permission_error"
psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$POSTGRES_DIR/0009_runtime_catalog_permissions.sql" >/dev/null
"$POSTGRES_DIR/verify-rescue-production-pre-canary.sh" >/dev/null

psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "UPDATE public.product_mappings SET match_reasons=array_remove(match_reasons, 'CURRENT_BOTTLE_STOCK_ACTIVE_TRUE') WHERE connection_id='$CANDIDATE_ID' AND provider_product_id='500101'" >/dev/null
if "$POSTGRES_DIR/verify-rescue-production-pre-canary.sh" >/dev/null 2>&1; then
  printf 'FAIL: pre-canary verifier accepted mapping without stockActive evidence\n' >&2
  exit 1
fi
psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "UPDATE public.product_mappings SET match_reasons=array_append(match_reasons, 'CURRENT_BOTTLE_STOCK_ACTIVE_TRUE') WHERE connection_id='$CANDIDATE_ID' AND provider_product_id='500101'" >/dev/null

psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "UPDATE public.winerim_wines SET raw_payload=jsonb_set(raw_payload, '{stocks,0,stockActive}', 'false'::jsonb) WHERE connection_id='$CANDIDATE_ID' AND winerim_id='101'" >/dev/null
if "$POSTGRES_DIR/verify-rescue-production-pre-canary.sh" >/dev/null 2>&1; then
  printf 'FAIL: pre-canary verifier accepted stockActive marker without active source-stock evidence\n' >&2
  exit 1
fi
psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "UPDATE public.winerim_wines SET raw_payload=jsonb_set(raw_payload, '{stocks,0,stockActive}', 'true'::jsonb) WHERE connection_id='$CANDIDATE_ID' AND winerim_id='101'" >/dev/null

psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 >/dev/null <<SQL
UPDATE public.winerim_wines
SET bottle_stock_id=1099
WHERE connection_id='$CANDIDATE_ID' AND winerim_id='101';
UPDATE public.product_mappings
SET match_reasons=array_replace(match_reasons, 'CURRENT_BOTTLE_STOCK_ID_1001', 'CURRENT_BOTTLE_STOCK_ID_1099')
WHERE connection_id='$CANDIDATE_ID' AND provider_product_id='500101';
SQL
if "$POSTGRES_DIR/verify-rescue-production-pre-canary.sh" >/dev/null 2>&1; then
  printf 'FAIL: pre-canary verifier accepted a MAGNUM stock as the BOTTLE source\n' >&2
  exit 1
fi
psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 >/dev/null <<SQL
UPDATE public.winerim_wines
SET bottle_stock_id=1001
WHERE connection_id='$CANDIDATE_ID' AND winerim_id='101';
UPDATE public.product_mappings
SET match_reasons=array_replace(match_reasons, 'CURRENT_BOTTLE_STOCK_ID_1099', 'CURRENT_BOTTLE_STOCK_ID_1001')
WHERE connection_id='$CANDIDATE_ID' AND provider_product_id='500101';
SQL

psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "UPDATE public.provider_products SET sync_status='NOT_SYNCED', sync_error=NULL WHERE connection_id='$CANDIDATE_ID' AND provider_product_id='500103'" >/dev/null
if "$POSTGRES_DIR/verify-rescue-production-pre-canary.sh" >/dev/null 2>&1; then
  printf 'FAIL: pre-canary verifier accepted an ambiguous candidate that was not blocked\n' >&2
  exit 1
fi
psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "UPDATE public.provider_products SET sync_status='BLOCKED', sync_error='HYDRATION_WINE_CANDIDATE_AMBIGUOUS' WHERE connection_id='$CANDIDATE_ID' AND provider_product_id='500103'" >/dev/null

psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "INSERT INTO public.provider_products (connection_id, provider_product_id, name) VALUES ('$OTHER_ID', 'outside-1', 'Outside candidate')" >/dev/null
if "$POSTGRES_DIR/verify-rescue-production-pre-canary.sh" >/dev/null 2>&1; then
  printf 'FAIL: pre-canary verifier accepted hydrated catalog outside candidate\n' >&2
  exit 1
fi
psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "DELETE FROM public.provider_products WHERE connection_id='$OTHER_ID' AND provider_product_id='outside-1'" >/dev/null

psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "INSERT INTO public.winerim_wines (connection_id, winerim_id, name) VALUES ('$OTHER_ID', 'outside-1', 'Outside candidate')" >/dev/null
if "$POSTGRES_DIR/verify-rescue-production-pre-canary.sh" >/dev/null 2>&1; then
  printf 'FAIL: pre-canary verifier accepted Winerim cache outside candidate\n' >&2
  exit 1
fi
psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "DELETE FROM public.winerim_wines WHERE connection_id='$OTHER_ID' AND winerim_id='outside-1'" >/dev/null

psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "INSERT INTO public.product_mappings (connection_id, provider_product_id, provider_product_name, status) VALUES ('$OTHER_ID', 'outside-1', 'Outside candidate', 'CONFIRMED')" >/dev/null
if "$POSTGRES_DIR/verify-rescue-production-pre-canary.sh" >/dev/null 2>&1; then
  printf 'FAIL: pre-canary verifier accepted product mapping outside candidate\n' >&2
  exit 1
fi
psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "DELETE FROM public.product_mappings WHERE connection_id='$OTHER_ID' AND provider_product_id='outside-1'" >/dev/null

psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "INSERT INTO public.agora_master_data (connection_id) VALUES ('$OTHER_ID')" >/dev/null
if "$POSTGRES_DIR/verify-rescue-production-pre-canary.sh" >/dev/null 2>&1; then
  printf 'FAIL: pre-canary verifier accepted Agora master outside candidate\n' >&2
  exit 1
fi
psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "DELETE FROM public.agora_master_data WHERE connection_id='$OTHER_ID'" >/dev/null

psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "UPDATE public.pos_connections SET enabled=true WHERE id='$OTHER_ID'" >/dev/null
if "$POSTGRES_DIR/verify-rescue-production-pre-canary.sh" >/dev/null 2>&1; then
  printf 'FAIL: pre-canary verifier accepted two enabled connections\n' >&2
  exit 1
fi
psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "UPDATE public.pos_connections SET enabled=false WHERE id='$OTHER_ID'" >/dev/null

psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "UPDATE public.pos_connections SET catalog_sync_enabled=true WHERE id='$OTHER_ID'" >/dev/null
if "$POSTGRES_DIR/verify-rescue-production-pre-canary.sh" >/dev/null 2>&1; then
  printf 'FAIL: pre-canary verifier accepted active catalog outside candidate\n' >&2
  exit 1
fi
psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "UPDATE public.pos_connections SET catalog_sync_enabled=false WHERE id='$OTHER_ID'" >/dev/null

psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "UPDATE public.runtime_connection_credentials SET active=false WHERE connection_id='$CANDIDATE_ID' AND credential_kind='winerim'" >/dev/null
if "$POSTGRES_DIR/verify-rescue-production-pre-canary.sh" >/dev/null 2>&1; then
  printf 'FAIL: pre-canary verifier accepted one active credential\n' >&2
  exit 1
fi
psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "UPDATE public.runtime_connection_credentials SET active=true WHERE connection_id='$CANDIDATE_ID' AND credential_kind='winerim'" >/dev/null

psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "INSERT INTO public.outbound_tasks (connection_id) VALUES ('$CANDIDATE_ID')" >/dev/null
if "$POSTGRES_DIR/verify-rescue-production-pre-canary.sh" >/dev/null 2>&1; then
  printf 'FAIL: pre-canary verifier accepted prior outbound debt\n' >&2
  exit 1
fi
psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c 'TRUNCATE public.outbound_tasks' >/dev/null

psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "INSERT INTO public.stock_sync_log (connection_id, product_name, quantity, status, idempotency_key) VALUES ('$CANDIDATE_ID', 'Canary fixture', 1, 'SUCCESS', 'existing-receipt')" >/dev/null
if "$POSTGRES_DIR/verify-rescue-production-pre-canary.sh" >/dev/null 2>&1; then
  printf 'FAIL: pre-canary verifier accepted a prior stock receipt\n' >&2
  exit 1
fi

rollback_plan=$("$POSTGRES_DIR/rollback-rescue-production.sh")
rollback_sha=$(sed -n 's/.*plan_sha256=\([^ ]*\).*/\1/p' <<<"$rollback_plan")
test -n "$rollback_sha"
rollback_output=$("$POSTGRES_DIR/rollback-rescue-production.sh" \
  --apply \
  --confirm-project-ref "$PROJECT_REF" \
  --confirm-plan-sha "$rollback_sha" \
  --confirm-action ROLLBACK_RESCUE_PRODUCTION_TO_PRE_CANARY)
grep -q 'RESULT=RESCUE_PRODUCTION_ROLLED_BACK_TO_PRE_CANARY' <<<"$rollback_output"
"$POSTGRES_DIR/verify-rescue-production.sh" >/dev/null

printf 'RESULT=RESCUE_PRODUCTION_PRE_CANARY_TEST_OK runtime_identity=exact scope=single catalog=exact_isolated mappings=confirmed_stock_active ambiguous=blocked credentials=agora,winerim debt_receipts=zero rollback=pre-canary\n'
