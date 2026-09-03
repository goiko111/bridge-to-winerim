#!/usr/bin/env bash
set -euo pipefail
set +x

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/postgres-client-tools.sh"
DATABASE_URL=${RESCUE_PRODUCTION_DATABASE_URL:-}
RUNTIME_DATABASE_URL=${RESCUE_PRODUCTION_RUNTIME_DATABASE_URL:-}
CANARY_CONNECTION_ID=${RESCUE_PRODUCTION_CANARY_CONNECTION_ID:-}
CANARY_RUN_ID=${RESCUE_PRODUCTION_CANARY_RUN_ID:-}
EXPECTED_CONNECTIONS=${RESCUE_PRODUCTION_EXPECTED_CONNECTIONS:-31}
EXPECTED_CANARY_WINERIM_WINES=${RESCUE_PRODUCTION_EXPECTED_CANARY_WINERIM_WINES:-70}
EXPECTED_CANARY_PROVIDER_PRODUCTS=${RESCUE_PRODUCTION_EXPECTED_CANARY_PROVIDER_PRODUCTS:-409}
EXPECTED_CANARY_PRODUCT_MAPPINGS=${RESCUE_PRODUCTION_EXPECTED_CANARY_PRODUCT_MAPPINGS:-95}
EXPECTED_CANARY_MASTER_ROWS=${RESCUE_PRODUCTION_EXPECTED_CANARY_MASTER_ROWS:-1}
EXPECTED_CANARY_AMBIGUOUS_PRODUCTS=${RESCUE_PRODUCTION_EXPECTED_CANARY_AMBIGUOUS_PRODUCTS:-11}
FAILURES=0

test -n "$DATABASE_URL" || { printf 'RESCUE_PRODUCTION_DATABASE_URL_REQUIRED\n' >&2; exit 2; }
test -n "$RUNTIME_DATABASE_URL" || { printf 'RESCUE_PRODUCTION_RUNTIME_DATABASE_URL_REQUIRED\n' >&2; exit 2; }
case "$EXPECTED_CONNECTIONS" in ''|*[!0-9]*) printf 'RESCUE_PRODUCTION_EXPECTED_CONNECTIONS_INVALID\n' >&2; exit 2 ;; esac
for expected_catalog_count in \
  "$EXPECTED_CANARY_WINERIM_WINES" \
  "$EXPECTED_CANARY_PROVIDER_PRODUCTS" \
  "$EXPECTED_CANARY_PRODUCT_MAPPINGS" \
  "$EXPECTED_CANARY_MASTER_ROWS" \
  "$EXPECTED_CANARY_AMBIGUOUS_PRODUCTS"; do
  case "$expected_catalog_count" in ''|*[!0-9]*) printf 'RESCUE_PRODUCTION_EXPECTED_CANARY_CATALOG_COUNTS_INVALID\n' >&2; exit 2 ;; esac
  [ "$expected_catalog_count" -gt 0 ] || { printf 'RESCUE_PRODUCTION_EXPECTED_CANARY_CATALOG_COUNTS_INVALID\n' >&2; exit 2; }
done
if [[ ! "$CANARY_CONNECTION_ID" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$ ]]; then
  printf 'RESCUE_PRODUCTION_CANARY_CONNECTION_ID_INVALID\n' >&2
  exit 2
fi
if [[ ! "$CANARY_RUN_ID" =~ ^[a-z0-9][a-z0-9-]{2,31}$ ]]; then
  printf 'RESCUE_PRODUCTION_CANARY_RUN_ID_INVALID\n' >&2
  exit 2
fi
for command_name in node psql; do
  command -v "$command_name" >/dev/null 2>&1 || { printf 'BLOCKED_MISSING_COMMAND=%s\n' "$command_name" >&2; exit 2; }
done

target_json=$(node "$SCRIPT_DIR/rescue-production-target.mjs")
expected_database=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).database)' "$target_json")
RESCUE_PRODUCTION_DATABASE_URL="$RUNTIME_DATABASE_URL" \
  node "$SCRIPT_DIR/rescue-production-target.mjs" >/dev/null
configure_postgres_tools "$DATABASE_URL"

TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/winerim-rescue-pre-canary.XXXXXX")
PSQL_ERROR="$TMP_ROOT/psql-error.log"
READ_ONLY_OPTIONS="${PGOPTIONS:+$PGOPTIONS }-c default_transaction_read_only=on -c statement_timeout=15000 -c lock_timeout=1000"
trap 'rm -rf "$TMP_ROOT"' EXIT INT TERM

query_scalar() {
  local target_url=$1
  local check_name=$2
  local sql=$3
  local result
  : >"$PSQL_ERROR"
  if ! result=$(PGOPTIONS="$READ_ONLY_OPTIONS" "$PSQL_CMD" -X -q -A -t -v ON_ERROR_STOP=1 -d "$target_url" -c "$sql" 2>"$PSQL_ERROR"); then
    printf 'FAIL: %s query failed (database error withheld; DSN not shown)\n' "$check_name" >&2
    return 1
  fi
  printf '%s' "$result"
}

check_equals() {
  local target_url=$1
  local check_name=$2
  local expected=$3
  local sql=$4
  local actual
  if ! actual=$(query_scalar "$target_url" "$check_name" "$sql"); then
    FAILURES=$((FAILURES + 1))
    return
  fi
  if [ "$actual" != "$expected" ]; then
    printf 'FAIL: %s expected=%s actual=%s\n' "$check_name" "$expected" "$actual" >&2
    FAILURES=$((FAILURES + 1))
    return
  fi
  printf 'OK: %s=%s\n' "$check_name" "$actual"
}

candidate="'$CANARY_CONNECTION_ID'::uuid"

check_equals "$DATABASE_URL" connected_database "$expected_database" "SELECT current_database()"
check_equals "$DATABASE_URL" postgres_server_major 17 "SELECT current_setting('server_version_num')::int / 10000"
check_equals "$RUNTIME_DATABASE_URL" runtime_postgres_server_major 17 "SELECT current_setting('server_version_num')::int / 10000"
check_equals "$DATABASE_URL" environment_rescue_production 1 "SELECT count(*) FROM public.infrastructure_metadata WHERE key='environment' AND value='rescue-production'"
check_equals "$DATABASE_URL" public_tables 30 "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'"
actual_tables=$(query_scalar "$DATABASE_URL" public_table_inventory "SELECT string_agg(c.relname, E'\\n' ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'") || actual_tables=''
expected_tables=$(cat "$SCRIPT_DIR/expected-tables-runtime-postupgrade.txt")
if [ "$actual_tables" != "$expected_tables" ]; then
  printf 'FAIL: public_table_inventory does not match the reviewed 30-table contract\n' >&2
  FAILURES=$((FAILURES + 1))
else
  printf 'OK: public_table_inventory=exact\n'
fi
check_equals "$DATABASE_URL" public_tables_without_rls 0 "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND NOT c.relrowsecurity"
check_equals "$DATABASE_URL" public_grants_to_browser_roles 0 "SELECT count(*) FROM information_schema.role_table_grants WHERE table_schema='public' AND grantee IN ('anon','authenticated','service_role')"
check_equals "$DATABASE_URL" rescue_connections "$EXPECTED_CONNECTIONS" "SELECT count(*) FROM public.pos_connections"
check_equals "$DATABASE_URL" enabled_connections 1 "SELECT count(*) FROM public.pos_connections WHERE enabled"
check_equals "$DATABASE_URL" enabled_connection_identity "$CANARY_CONNECTION_ID" "SELECT id::text FROM public.pos_connections WHERE enabled"
check_equals "$DATABASE_URL" candidate_safe_mode 'agora|1|0|PULL_ONLY|NONE|0' "SELECT provider || '|' || enabled::int || '|' || catalog_sync_enabled::int || '|' || sync_mode || '|' || write_mode || '|' || backfill_days FROM public.pos_connections WHERE id=$candidate"
check_equals "$DATABASE_URL" noncandidate_control_plane_unsafe 0 "SELECT count(*) FROM public.pos_connections WHERE id<>$candidate AND (enabled OR catalog_sync_enabled OR sync_mode<>'PULL_ONLY' OR write_mode<>'NONE' OR backfill_days<>0)"

check_equals "$DATABASE_URL" active_canary_scopes 1 "SELECT count(*) FROM public.runtime_canary_connections WHERE active"
check_equals "$DATABASE_URL" active_canary_scope_identity "$CANARY_CONNECTION_ID" "SELECT connection_id::text FROM public.runtime_canary_connections WHERE active"
check_equals "$DATABASE_URL" active_canary_scope_run "$CANARY_RUN_ID" "SELECT run_id FROM public.runtime_canary_connections WHERE active AND connection_id=$candidate"
check_equals "$DATABASE_URL" active_canary_scope_valid 1 "SELECT count(*) FROM public.runtime_canary_connections WHERE connection_id=$candidate AND run_id='$CANARY_RUN_ID' AND note='rescue-canary-run:$CANARY_RUN_ID' AND status='ACTIVE' AND active AND approved_at IS NOT NULL AND approved_at<=now() AND expires_at IS NOT NULL AND expires_at>now() AND deployment_manifest_sha256 ~ '^[a-f0-9]{64}$' AND writer_fence_grant_sha256 ~ '^[a-f0-9]{64}$' AND credential_set_sha256 ~ '^[a-f0-9]{64}$' AND activated_at IS NOT NULL AND retired_at IS NULL"
canary_generation_mode=$(query_scalar "$DATABASE_URL" active_canary_generation_mode "SELECT generation_mode FROM public.runtime_canary_connections WHERE connection_id=$candidate AND run_id='$CANARY_RUN_ID' AND active") || canary_generation_mode=''
if [[ ! "$canary_generation_mode" =~ ^(bootstrap|rotate)$ ]]; then
  printf 'FAIL: active_canary_generation_mode invalid=%s\n' "$canary_generation_mode" >&2
  FAILURES=$((FAILURES + 1))
else
  printf 'OK: active_canary_generation_mode=%s\n' "$canary_generation_mode"
fi
check_equals "$DATABASE_URL" active_runtime_credentials 2 "SELECT count(*) FROM public.runtime_connection_credentials WHERE active"
check_equals "$DATABASE_URL" active_runtime_credential_kinds 'agora,winerim' "SELECT string_agg(credential_kind, ',' ORDER BY credential_kind) FROM public.runtime_connection_credentials WHERE active AND connection_id=$candidate AND run_id='$CANARY_RUN_ID' AND activated_at IS NOT NULL AND retired_at IS NULL AND attestation_sha256 ~ '^[a-f0-9]{64}$'"
check_equals "$DATABASE_URL" active_runtime_credentials_outside_candidate 0 "SELECT count(*) FROM public.runtime_connection_credentials WHERE active AND connection_id<>$candidate"

check_equals "$DATABASE_URL" candidate_winerim_wines "$EXPECTED_CANARY_WINERIM_WINES" "SELECT count(*) FROM public.winerim_wines WHERE connection_id=$candidate"
check_equals "$DATABASE_URL" candidate_provider_products "$EXPECTED_CANARY_PROVIDER_PRODUCTS" "SELECT count(*) FROM public.provider_products WHERE connection_id=$candidate"
check_equals "$DATABASE_URL" candidate_product_mappings "$EXPECTED_CANARY_PRODUCT_MAPPINGS" "SELECT count(*) FROM public.product_mappings WHERE connection_id=$candidate"
check_equals "$DATABASE_URL" candidate_master_rows "$EXPECTED_CANARY_MASTER_ROWS" "SELECT count(*) FROM public.agora_master_data WHERE connection_id=$candidate"
check_equals "$DATABASE_URL" candidate_master_hydration_marker "$EXPECTED_CANARY_MASTER_ROWS" "SELECT count(*) FROM public.agora_master_data WHERE connection_id=$candidate AND raw_xml_preview ~ '^WINERIM_RESCUE_HYDRATION_V2_SHA256:[0-9a-f]{64}$'"
check_equals "$DATABASE_URL" noncandidate_winerim_wines 0 "SELECT count(*) FROM public.winerim_wines WHERE connection_id<>$candidate"
check_equals "$DATABASE_URL" noncandidate_provider_products 0 "SELECT count(*) FROM public.provider_products WHERE connection_id<>$candidate"
check_equals "$DATABASE_URL" noncandidate_product_mappings 0 "SELECT count(*) FROM public.product_mappings WHERE connection_id<>$candidate"
check_equals "$DATABASE_URL" noncandidate_master_rows 0 "SELECT count(*) FROM public.agora_master_data WHERE connection_id<>$candidate"
mapping_contract_query="$(cat <<SQL
SELECT count(*)
FROM public.product_mappings pm
LEFT JOIN public.provider_products pp
  ON pp.connection_id=pm.connection_id AND pp.provider_product_id=pm.provider_product_id
LEFT JOIN public.winerim_wines ww
  ON ww.connection_id=pm.connection_id AND ww.winerim_id=pm.winerim_wine_id
LEFT JOIN LATERAL (
  SELECT count(*) AS reason_count,
         min(substring(reason FROM '([1-9][0-9]*)$')::bigint) AS stock_id
  FROM unnest(pm.match_reasons) reason
  WHERE reason ~ ('^CURRENT_' || pm.format_type || '_STOCK_ID_[1-9][0-9]*$')
) stock_reason ON true
LEFT JOIN LATERAL (
  SELECT count(*) AS stock_count,
         bool_or(COALESCE((stock->>'stockActive')::boolean, false)) AS stock_active,
         min(lower(stock->'winePrice'->>'variant')) AS stock_variant
  FROM jsonb_array_elements(
    CASE WHEN jsonb_typeof(ww.raw_payload->'stocks')='array'
      THEN ww.raw_payload->'stocks' ELSE '[]'::jsonb END
  ) stock
  WHERE stock->>'id'=stock_reason.stock_id::text
) stock_contract ON true
WHERE pm.connection_id=$candidate
  AND (
    pm.status<>'CONFIRMED'
    OR pm.match_method NOT IN ('RESCUE_EXACT_ID_WINE_VARIANT','RESCUE_EXACT_ID_WINE_VARIANT_SALES_ONLY')
    OR pm.match_score IS DISTINCT FROM 1
    OR pm.winerim_wine_id IS NULL
    OR pm.format_type NOT IN ('BOTTLE','GLASS','MAGNUM')
    OR cardinality(pm.match_reasons)<>4
    OR NOT (pm.match_reasons @> ARRAY['CURRENT_AGORA_PRODUCT_ID','CURRENT_WINERIM_WINE_ID']::text[])
    OR stock_reason.reason_count<>1
    OR pp.id IS NULL OR pp.is_wine_candidate IS NOT TRUE OR pp.sync_status<>'SYNCED'
    OR pp.sync_error IS NOT NULL OR pp.winerim_wine_id IS DISTINCT FROM pm.winerim_wine_id
    OR pp.sale_format IS DISTINCT FROM pm.format_type
    OR ww.id IS NULL OR stock_reason.stock_id IS NULL
    OR stock_reason.stock_id IS DISTINCT FROM CASE pm.format_type
      WHEN 'BOTTLE' THEN ww.bottle_stock_id WHEN 'GLASS' THEN ww.glass_stock_id
      WHEN 'MAGNUM' THEN ww.magnum_stock_id END
    OR stock_contract.stock_count<>1
    OR stock_contract.stock_variant IS DISTINCT FROM CASE pm.format_type
      WHEN 'BOTTLE' THEN 'botella' WHEN 'GLASS' THEN 'copa' WHEN 'MAGNUM' THEN 'magnum' END
    OR (pm.match_method='RESCUE_EXACT_ID_WINE_VARIANT' AND (
      stock_contract.stock_active IS DISTINCT FROM true
      OR NOT (pm.match_reasons @> ARRAY['CURRENT_' || pm.format_type || '_STOCK_ACTIVE_TRUE']::text[])
    ))
    OR (pm.match_method='RESCUE_EXACT_ID_WINE_VARIANT_SALES_ONLY' AND (
      stock_contract.stock_active IS DISTINCT FROM false
      OR NOT (pm.match_reasons @> ARRAY['CURRENT_' || pm.format_type || '_STOCK_ACTIVE_FALSE_SALES_ONLY']::text[])
    ))
  )
SQL
)"
check_equals "$DATABASE_URL" candidate_confirmed_mapping_contract_invalid 0 "$mapping_contract_query"
check_equals "$DATABASE_URL" candidate_ambiguous_provider_products "$EXPECTED_CANARY_AMBIGUOUS_PRODUCTS" "SELECT count(*) FROM public.provider_products pp WHERE pp.connection_id=$candidate AND pp.is_wine_candidate IS TRUE AND pp.winerim_wine_id IS NULL AND pp.sync_status='BLOCKED' AND pp.sync_error='HYDRATION_WINE_CANDIDATE_AMBIGUOUS' AND pp.classification_override='AUTO'"
check_equals "$DATABASE_URL" candidate_wine_candidate_contract_invalid 0 "SELECT count(*) FROM public.provider_products pp LEFT JOIN public.product_mappings pm ON pm.connection_id=pp.connection_id AND pm.provider_product_id=pp.provider_product_id WHERE pp.connection_id=$candidate AND pp.is_wine_candidate IS TRUE AND ((pm.id IS NOT NULL AND (pm.status<>'CONFIRMED' OR pp.sync_status<>'SYNCED' OR pp.sync_error IS NOT NULL OR pp.winerim_wine_id IS DISTINCT FROM pm.winerim_wine_id)) OR (pm.id IS NULL AND (pp.winerim_wine_id IS NOT NULL OR pp.sync_status<>'BLOCKED' OR pp.sync_error IS DISTINCT FROM 'HYDRATION_WINE_CANDIDATE_AMBIGUOUS' OR pp.classification_override<>'AUTO')))"
check_equals "$DATABASE_URL" candidate_ambiguous_products_with_mapping 0 "SELECT count(*) FROM public.provider_products pp JOIN public.product_mappings pm ON pm.connection_id=pp.connection_id AND pm.provider_product_id=pp.provider_product_id WHERE pp.connection_id=$candidate AND pp.sync_status='BLOCKED' AND pp.sync_error='HYDRATION_WINE_CANDIDATE_AMBIGUOUS'"
check_equals "$DATABASE_URL" candidate_mapped_and_ambiguous_total "$((EXPECTED_CANARY_PRODUCT_MAPPINGS + EXPECTED_CANARY_AMBIGUOUS_PRODUCTS))" "SELECT count(*) FROM public.provider_products WHERE connection_id=$candidate AND is_wine_candidate IS TRUE"

master_hydration_digest=$(query_scalar "$DATABASE_URL" candidate_master_hydration_digest "SELECT substring(raw_xml_preview FROM '^WINERIM_RESCUE_HYDRATION_V2_SHA256:([0-9a-f]{64})$') FROM public.agora_master_data WHERE connection_id=$candidate") || master_hydration_digest=''
if [[ ! "$master_hydration_digest" =~ ^[0-9a-f]{64}$ ]]; then
  printf 'FAIL: candidate_master_hydration_digest is missing or invalid\n' >&2
  FAILURES=$((FAILURES + 1))
elif ! database_hydration_digest=$(hydration_database_fingerprint "$DATABASE_URL" "$CANARY_CONNECTION_ID"); then
  printf 'FAIL: candidate_database_hydration_fingerprint could not be computed\n' >&2
  FAILURES=$((FAILURES + 1))
elif [ "$database_hydration_digest" != "$master_hydration_digest" ]; then
  printf 'FAIL: candidate_database_hydration_digest expected=%s actual=%s\n' "$master_hydration_digest" "$database_hydration_digest" >&2
  FAILURES=$((FAILURES + 1))
else
  printf 'OK: candidate_database_hydration_digest=%s\n' "$database_hydration_digest"
fi

check_equals "$DATABASE_URL" prior_outbound_debt 0 "SELECT count(*) FROM public.outbound_tasks"
check_equals "$DATABASE_URL" noncandidate_runtime_receipts 0 "SELECT (SELECT count(*) FROM public.runtime_idempotency WHERE connection_id<>$candidate) + (SELECT count(*) FROM public.runtime_execution_log WHERE connection_id<>$candidate) + (SELECT count(*) FROM public.sales_events WHERE connection_id<>$candidate) + (SELECT count(*) FROM public.sales_line_items WHERE connection_id<>$candidate) + (SELECT count(*) FROM public.stock_sync_log WHERE connection_id<>$candidate)"
candidate_runtime_idempotency=$(query_scalar "$DATABASE_URL" candidate_runtime_idempotency "SELECT count(*) FROM public.runtime_idempotency WHERE connection_id=$candidate") || candidate_runtime_idempotency=''
candidate_runtime_execution=$(query_scalar "$DATABASE_URL" candidate_runtime_execution "SELECT count(*) FROM public.runtime_execution_log WHERE connection_id=$candidate") || candidate_runtime_execution=''
candidate_sales_events=$(query_scalar "$DATABASE_URL" candidate_sales_events "SELECT count(*) FROM public.sales_events WHERE connection_id=$candidate") || candidate_sales_events=''
candidate_sales_line_items=$(query_scalar "$DATABASE_URL" candidate_sales_line_items "SELECT count(*) FROM public.sales_line_items WHERE connection_id=$candidate") || candidate_sales_line_items=''
candidate_stock_receipts=$(query_scalar "$DATABASE_URL" candidate_stock_receipts "SELECT count(*) FROM public.stock_sync_log WHERE connection_id=$candidate") || candidate_stock_receipts=''
if [ "$canary_generation_mode" = bootstrap ]; then
  for count_value in "$candidate_runtime_idempotency" "$candidate_runtime_execution" "$candidate_sales_events" "$candidate_sales_line_items" "$candidate_stock_receipts"; do
    if [ "$count_value" != 0 ]; then
      printf 'FAIL: bootstrap canary has prior operational rows\n' >&2
      FAILURES=$((FAILURES + 1))
      break
    fi
  done
fi

check_equals "$DATABASE_URL" runtime_sales_claim_identity_trigger_contract 1 "SELECT count(*) FROM pg_trigger trigger_contract JOIN pg_class table_class ON table_class.oid=trigger_contract.tgrelid JOIN pg_namespace table_namespace ON table_namespace.oid=table_class.relnamespace JOIN pg_proc trigger_function ON trigger_function.oid=trigger_contract.tgfoid WHERE table_namespace.nspname='public' AND table_class.relname='runtime_idempotency' AND trigger_contract.tgname='runtime_bind_sales_claim_identity' AND NOT trigger_contract.tgisinternal AND trigger_contract.tgenabled IN ('O','A') AND trigger_contract.tgtype=23 AND trigger_function.proname='runtime_bind_sales_claim_identity' AND position('NEW.sales_claim_identity IS DISTINCT FROM OLD.sales_claim_identity' IN trigger_function.prosrc)>0 AND (SELECT count(*) FROM unnest(trigger_contract.tgattr))=4"
check_equals "$DATABASE_URL" runtime_idempotency_update_privilege_contract 1 "SELECT ((NOT has_table_privilege('middleware_runtime','public.runtime_idempotency','UPDATE')) AND (NOT has_column_privilege('middleware_runtime','public.runtime_idempotency','sales_claim_identity','UPDATE')) AND (SELECT count(DISTINCT column_name)=8 FROM information_schema.column_privileges WHERE table_schema='public' AND table_name='runtime_idempotency' AND grantee='middleware_runtime' AND privilege_type='UPDATE' AND column_name IN ('message_id','status','attempt','lease_expires_at','payload_sha256','lease_token','result','updated_at')))::int"
check_equals "$DATABASE_URL" runtime_stock_privilege_contract 1 "SELECT (has_table_privilege('middleware_runtime','public.stock_sync_log','SELECT,INSERT') AND NOT has_table_privilege('middleware_runtime','public.stock_sync_log','UPDATE,DELETE'))::int"
check_equals "$DATABASE_URL" runtime_sales_privilege_contract '1|1|1|1|1|1|0|1|0|1|0|1|0' "SELECT has_table_privilege('middleware_runtime','public.product_mappings','SELECT')::int || '|' || has_table_privilege('middleware_runtime','public.winerim_wines','SELECT')::int || '|' || has_table_privilege('middleware_runtime','public.sales_events','SELECT,INSERT')::int || '|' || (NOT has_table_privilege('middleware_runtime','public.sales_events','UPDATE'))::int || '|' || (has_column_privilege('middleware_runtime','public.sales_events','business_day','UPDATE') AND has_column_privilege('middleware_runtime','public.sales_events','doc_type','UPDATE') AND has_column_privilege('middleware_runtime','public.sales_events','total_amount','UPDATE') AND has_column_privilege('middleware_runtime','public.sales_events','total_tax','UPDATE') AND has_column_privilege('middleware_runtime','public.sales_events','total_net','UPDATE') AND has_column_privilege('middleware_runtime','public.sales_events','line_count','UPDATE') AND has_column_privilege('middleware_runtime','public.sales_events','raw_json','UPDATE'))::int || '|' || (NOT has_column_privilege('middleware_runtime','public.sales_events','provider_doc_id','UPDATE'))::int || '|' || has_table_privilege('middleware_runtime','public.sales_events','DELETE')::int || '|' || has_table_privilege('middleware_runtime','public.sales_line_items','SELECT,INSERT,DELETE')::int || '|' || has_table_privilege('middleware_runtime','public.sales_line_items','UPDATE')::int || '|' || has_table_privilege('middleware_runtime','public.stock_sync_log','SELECT,INSERT')::int || '|' || has_table_privilege('middleware_runtime','public.stock_sync_log','UPDATE,DELETE')::int || '|' || has_column_privilege('middleware_runtime','public.pos_connections','last_sync_at','UPDATE')::int || '|' || has_column_privilege('middleware_runtime','public.pos_connections','enabled','UPDATE')::int"
check_equals "$DATABASE_URL" runtime_catalog_privilege_contract '1|0|1|0|0|1|1|0|1|0|1|1|0' "SELECT has_table_privilege('middleware_runtime','public.provider_products','SELECT')::int || '|' || has_table_privilege('middleware_runtime','public.provider_products','INSERT,UPDATE,DELETE')::int || '|' || has_table_privilege('middleware_runtime','public.agora_master_data','SELECT')::int || '|' || has_table_privilege('middleware_runtime','public.agora_master_data','INSERT,UPDATE,DELETE')::int || '|' || has_table_privilege('middleware_runtime','public.product_mappings','INSERT,UPDATE,DELETE')::int || '|' || has_column_privilege('middleware_runtime','public.product_mappings','provider_product_name','INSERT')::int || '|' || has_column_privilege('middleware_runtime','public.product_mappings','status','UPDATE')::int || '|' || has_column_privilege('middleware_runtime','public.product_mappings','id','UPDATE')::int || '|' || has_table_privilege('middleware_runtime','public.winerim_push_tracking','SELECT')::int || '|' || has_table_privilege('middleware_runtime','public.winerim_push_tracking','INSERT,UPDATE,DELETE')::int || '|' || has_column_privilege('middleware_runtime','public.winerim_push_tracking','agora_product_id','INSERT')::int || '|' || has_column_privilege('middleware_runtime','public.winerim_push_tracking','sync_status','UPDATE')::int || '|' || has_column_privilege('middleware_runtime','public.winerim_push_tracking','task_id','UPDATE')::int"

check_equals "$RUNTIME_DATABASE_URL" runtime_session_identity middleware_runtime_login "SELECT session_user"
check_equals "$RUNTIME_DATABASE_URL" runtime_login_identity middleware_runtime_login "SELECT current_user"
check_equals "$RUNTIME_DATABASE_URL" runtime_effective_connection_identity "$CANARY_CONNECTION_ID" "SELECT id::text FROM public.pos_connections"
check_equals "$RUNTIME_DATABASE_URL" runtime_effective_scope_identity "$CANARY_CONNECTION_ID|$CANARY_RUN_ID" "SELECT connection_id::text || '|' || run_id FROM public.runtime_canary_connections"
check_equals "$RUNTIME_DATABASE_URL" runtime_effective_credentials 2 "SELECT count(*) FROM public.runtime_connection_credentials"
check_equals "$RUNTIME_DATABASE_URL" runtime_effective_winerim_wines "$EXPECTED_CANARY_WINERIM_WINES" "SELECT count(*) FROM public.winerim_wines"
check_equals "$RUNTIME_DATABASE_URL" runtime_effective_product_mappings "$EXPECTED_CANARY_PRODUCT_MAPPINGS" "SELECT count(*) FROM public.product_mappings"
check_equals "$RUNTIME_DATABASE_URL" runtime_effective_provider_products "$EXPECTED_CANARY_PROVIDER_PRODUCTS" "SELECT count(*) FROM public.provider_products"
check_equals "$RUNTIME_DATABASE_URL" runtime_effective_master_rows "$EXPECTED_CANARY_MASTER_ROWS" "SELECT count(*) FROM public.agora_master_data"
check_equals "$RUNTIME_DATABASE_URL" runtime_effective_tracking_rows 0 "SELECT count(*) FROM public.winerim_push_tracking"
check_equals "$RUNTIME_DATABASE_URL" runtime_effective_catalog_cross_connection_rows 0 "SELECT (SELECT count(*) FROM public.provider_products WHERE connection_id<>$candidate) + (SELECT count(*) FROM public.agora_master_data WHERE connection_id<>$candidate) + (SELECT count(*) FROM public.product_mappings WHERE connection_id<>$candidate) + (SELECT count(*) FROM public.winerim_push_tracking WHERE connection_id<>$candidate)"
check_equals "$RUNTIME_DATABASE_URL" runtime_effective_prior_idempotency "$candidate_runtime_idempotency" "SELECT count(*) FROM public.runtime_idempotency"
check_equals "$RUNTIME_DATABASE_URL" runtime_effective_prior_execution_log "$candidate_runtime_execution" "SELECT count(*) FROM public.runtime_execution_log"
check_equals "$RUNTIME_DATABASE_URL" runtime_effective_prior_sales "$candidate_sales_events" "SELECT count(*) FROM public.sales_events"
check_equals "$RUNTIME_DATABASE_URL" runtime_effective_prior_sales_lines "$candidate_sales_line_items" "SELECT count(*) FROM public.sales_line_items"
check_equals "$RUNTIME_DATABASE_URL" runtime_effective_prior_stock "$candidate_stock_receipts" "SELECT count(*) FROM public.stock_sync_log"

if [ "$FAILURES" -gt 0 ]; then
  printf 'RESULT=RESCUE_PRODUCTION_PRE_CANARY_VERIFY_FAILED failures=%s\n' "$FAILURES" >&2
  exit 1
fi
printf 'RESULT=RESCUE_PRODUCTION_PRE_CANARY_VERIFY_OK connection_id=%s wines=%s provider_products=%s mappings=%s ambiguous=%s master=%s credentials=2 prior_debt_receipts=0\n' \
  "$CANARY_CONNECTION_ID" \
  "$EXPECTED_CANARY_WINERIM_WINES" \
  "$EXPECTED_CANARY_PROVIDER_PRODUCTS" \
  "$EXPECTED_CANARY_PRODUCT_MAPPINGS" \
  "$EXPECTED_CANARY_AMBIGUOUS_PRODUCTS" \
  "$EXPECTED_CANARY_MASTER_ROWS"
