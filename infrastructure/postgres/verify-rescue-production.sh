#!/usr/bin/env bash
set -euo pipefail
set +x

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/postgres-client-tools.sh"
DATABASE_URL=${RESCUE_PRODUCTION_DATABASE_URL:-}
RUNTIME_DATABASE_URL=${RESCUE_PRODUCTION_RUNTIME_DATABASE_URL:-}
EXPECTED_CONNECTIONS=${RESCUE_PRODUCTION_EXPECTED_CONNECTIONS:-31}
EXPECTED_LOGIN_ROLES=${RESCUE_PRODUCTION_EXPECTED_LOGIN_ROLES:-0}
HYDRATION_CONNECTION_ID=${RESCUE_PRODUCTION_HYDRATION_CONNECTION_ID:-}
HYDRATION_PLAN_FILE=${RESCUE_PRODUCTION_HYDRATION_PLAN_FILE:-}
EXPECTED_HYDRATION_WINERIM_WINES=${RESCUE_PRODUCTION_EXPECTED_HYDRATION_WINERIM_WINES:-}
EXPECTED_HYDRATION_PROVIDER_PRODUCTS=${RESCUE_PRODUCTION_EXPECTED_HYDRATION_PROVIDER_PRODUCTS:-}
EXPECTED_HYDRATION_PRODUCT_MAPPINGS=${RESCUE_PRODUCTION_EXPECTED_HYDRATION_PRODUCT_MAPPINGS:-}
EXPECTED_HYDRATION_MASTER_ROWS=${RESCUE_PRODUCTION_EXPECTED_HYDRATION_MASTER_ROWS:-}
HYDRATION_AWARE=0
HYDRATION_DIGEST=''
FAILURES=0

test -n "$DATABASE_URL" || { printf 'RESCUE_PRODUCTION_DATABASE_URL_REQUIRED\n' >&2; exit 2; }
case "$EXPECTED_CONNECTIONS" in ''|*[!0-9]*) printf 'RESCUE_PRODUCTION_EXPECTED_CONNECTIONS_INVALID\n' >&2; exit 2 ;; esac
case "$EXPECTED_LOGIN_ROLES" in 0|3) ;; *) printf 'RESCUE_PRODUCTION_EXPECTED_LOGIN_ROLES_INVALID\n' >&2; exit 2 ;; esac
if [ "$EXPECTED_LOGIN_ROLES" = 3 ] && [ -z "$RUNTIME_DATABASE_URL" ]; then
  printf 'RESCUE_PRODUCTION_RUNTIME_DATABASE_URL_REQUIRED\n' >&2
  exit 2
fi
command -v node >/dev/null 2>&1 || { printf 'BLOCKED_MISSING_COMMAND=node\n' >&2; exit 2; }
if [ -n "$HYDRATION_CONNECTION_ID" ]; then
  HYDRATION_AWARE=1
  if [[ ! "$HYDRATION_CONNECTION_ID" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$ ]]; then
    printf 'RESCUE_PRODUCTION_HYDRATION_CONNECTION_ID_INVALID\n' >&2
    exit 2
  fi
  for expected_hydration_count in \
    "$EXPECTED_HYDRATION_WINERIM_WINES" \
    "$EXPECTED_HYDRATION_PROVIDER_PRODUCTS" \
    "$EXPECTED_HYDRATION_PRODUCT_MAPPINGS" \
    "$EXPECTED_HYDRATION_MASTER_ROWS"; do
    case "$expected_hydration_count" in
      ''|*[!0-9]*) printf 'RESCUE_PRODUCTION_EXPECTED_HYDRATION_COUNTS_INVALID\n' >&2; exit 2 ;;
    esac
    [ "$expected_hydration_count" -gt 0 ] || {
      printf 'RESCUE_PRODUCTION_EXPECTED_HYDRATION_COUNTS_INVALID\n' >&2
      exit 2
    }
  done
  test -n "$HYDRATION_PLAN_FILE" || {
    printf 'RESCUE_PRODUCTION_HYDRATION_PLAN_FILE_REQUIRED\n' >&2
    exit 2
  }
  case "$HYDRATION_PLAN_FILE" in /*) ;; *) printf 'ABSOLUTE_HYDRATION_PLAN_FILE_REQUIRED\n' >&2; exit 2 ;; esac
  test -f "$HYDRATION_PLAN_FILE" && test ! -L "$HYDRATION_PLAN_FILE" || {
    printf 'RESCUE_PRODUCTION_HYDRATION_PLAN_FILE_REJECTED\n' >&2
    exit 2
  }
  if ! HYDRATION_DIGEST=$(node - "$HYDRATION_PLAN_FILE" "$HYDRATION_CONNECTION_ID" \
    "$EXPECTED_HYDRATION_WINERIM_WINES" "$EXPECTED_HYDRATION_PROVIDER_PRODUCTS" \
    "$EXPECTED_HYDRATION_PRODUCT_MAPPINGS" "$EXPECTED_HYDRATION_MASTER_ROWS" <<'NODE'
const { readFileSync } = require("node:fs");
const [path, connectionId, wines, products, mappings, masters] = process.argv.slice(2);
const plan = JSON.parse(readFileSync(path, "utf8"));
const fail = (message) => { throw new Error(message); };
if (plan?.schemaVersion !== 2 || plan?.kind !== "disabled-connection-hydration") fail("HYDRATION_PLAN_CONTRACT_INVALID");
if (plan.connectionId !== connectionId) fail("HYDRATION_PLAN_CONNECTION_MISMATCH");
if (!/^[0-9a-f]{64}$/.test(String(plan.hydrationDigest ?? ""))) fail("HYDRATION_PLAN_DIGEST_INVALID");
if (plan?.counts?.currentWinerimWines !== Number(wines)) fail("HYDRATION_PLAN_WINES_COUNT_MISMATCH");
if (plan?.counts?.currentAgoraProducts !== Number(products)) fail("HYDRATION_PLAN_PRODUCTS_COUNT_MISMATCH");
if (plan?.counts?.acceptedMappings !== Number(mappings)) fail("HYDRATION_PLAN_MAPPINGS_COUNT_MISMATCH");
if (Number(masters) !== 1) fail("HYDRATION_PLAN_MASTER_COUNT_INVALID");
process.stdout.write(plan.hydrationDigest);
NODE
  ); then
    printf 'RESCUE_PRODUCTION_HYDRATION_PLAN_VALIDATION_REJECTED\n' >&2
    exit 2
  fi
fi
for command_name in node psql; do
  command -v "$command_name" >/dev/null 2>&1 || { printf 'BLOCKED_MISSING_COMMAND=%s\n' "$command_name" >&2; exit 2; }
done

node "$SCRIPT_DIR/rescue-production-target.mjs" >/dev/null
if [ -n "$RUNTIME_DATABASE_URL" ]; then
  RESCUE_PRODUCTION_DATABASE_URL="$RUNTIME_DATABASE_URL" \
    node "$SCRIPT_DIR/rescue-production-target.mjs" >/dev/null
fi
configure_postgres_tools "$DATABASE_URL"
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/winerim-rescue-production-verify.XXXXXX")
PSQL_ERROR="$TMP_ROOT/psql-error.log"
READ_ONLY_OPTIONS="${PGOPTIONS:+$PGOPTIONS }-c default_transaction_read_only=on -c statement_timeout=15000 -c lock_timeout=1000"
trap 'rm -rf "$TMP_ROOT"' EXIT INT TERM

query_scalar() {
  local check_name=$1
  local sql=$2
  local result
  : >"$PSQL_ERROR"
  if ! result=$(PGOPTIONS="$READ_ONLY_OPTIONS" "$PSQL_CMD" -X -q -A -t -v ON_ERROR_STOP=1 -d "$DATABASE_URL" -c "$sql" 2>"$PSQL_ERROR"); then
    printf 'FAIL: %s query failed (database error withheld; DSN not shown)\n' "$check_name" >&2
    return 1
  fi
  printf '%s' "$result"
}

check_equals() {
  local check_name=$1
  local expected=$2
  local sql=$3
  local actual
  if ! actual=$(query_scalar "$check_name" "$sql"); then
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

check_runtime_equals() {
  local check_name=$1
  local expected=$2
  local sql=$3
  local target_url=$DATABASE_URL
  local actual
  if [ -n "$RUNTIME_DATABASE_URL" ]; then target_url=$RUNTIME_DATABASE_URL; fi
  : >"$PSQL_ERROR"
  if ! actual=$(PGOPTIONS="$READ_ONLY_OPTIONS" "$PSQL_CMD" -X -q -A -t -v ON_ERROR_STOP=1 -d "$target_url" -c "$sql" 2>"$PSQL_ERROR"); then
    printf 'FAIL: %s query failed (database error withheld; DSN not shown)\n' "$check_name" >&2
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

check_equals environment_rescue_production 1 "SELECT count(*) FROM public.infrastructure_metadata WHERE key='environment' AND value='rescue-production'"
check_equals infrastructure_metadata_rows 1 "SELECT count(*) FROM public.infrastructure_metadata"
check_equals public_tables 30 "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'"

actual_tables=$(query_scalar public_table_inventory "SELECT string_agg(c.relname, E'\\n' ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'") || actual_tables=''
expected_tables=$(cat "$SCRIPT_DIR/expected-tables-runtime-postupgrade.txt")
if [ "$actual_tables" != "$expected_tables" ]; then
  printf 'FAIL: public_table_inventory does not match the reviewed 30-table contract\n' >&2
  FAILURES=$((FAILURES + 1))
else
  printf 'OK: public_table_inventory=exact\n'
fi

check_equals public_tables_without_rls 0 "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND NOT c.relrowsecurity"
check_equals base_roles_present 3 "SELECT count(*) FROM pg_roles WHERE rolname IN ('middleware_api','middleware_readonly','middleware_runtime')"
check_equals base_roles_unsafe 0 "SELECT count(*) FROM pg_roles WHERE rolname IN ('middleware_api','middleware_readonly','middleware_runtime') AND (rolcanlogin OR rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication)"
check_equals middleware_login_roles "$EXPECTED_LOGIN_ROLES" "SELECT count(*) FROM pg_roles WHERE rolname IN ('middleware_api_login','middleware_readonly_login','middleware_runtime_login') AND rolcanlogin"
check_equals middleware_login_roles_unsafe 0 "SELECT count(*) FROM pg_roles WHERE rolname LIKE 'middleware_%' AND rolcanlogin AND (rolname NOT IN ('middleware_api_login','middleware_readonly_login','middleware_runtime_login') OR rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication OR NOT rolinherit)"
check_equals middleware_role_memberships "$EXPECTED_LOGIN_ROLES" "SELECT count(*) FROM pg_auth_members membership JOIN pg_roles granted ON granted.oid=membership.roleid JOIN pg_roles member ON member.oid=membership.member WHERE (granted.rolname, member.rolname) IN (('middleware_api','middleware_api_login'),('middleware_readonly','middleware_readonly_login'),('middleware_runtime','middleware_runtime_login')) AND NOT membership.admin_option"
check_equals middleware_role_memberships_unapproved 0 "SELECT count(*) FROM pg_auth_members membership JOIN pg_roles granted ON granted.oid=membership.roleid JOIN pg_roles member ON member.oid=membership.member WHERE (granted.rolname LIKE 'middleware_%' OR member.rolname LIKE 'middleware_%') AND NOT ((granted.rolname, member.rolname) IN (('middleware_api','middleware_api_login'),('middleware_readonly','middleware_readonly_login'),('middleware_runtime','middleware_runtime_login')) AND NOT membership.admin_option) AND NOT (member.rolname='postgres' AND membership.admin_option AND NOT membership.inherit_option AND NOT membership.set_option)"
check_equals public_security_definer_with_public_execute 0 "SELECT count(*) FROM pg_proc function JOIN pg_namespace namespace ON namespace.oid=function.pronamespace WHERE namespace.nspname='public' AND function.prosecdef AND EXISTS (SELECT 1 FROM aclexplode(COALESCE(function.proacl, acldefault('f', function.proowner))) privilege WHERE privilege.grantee=0 AND privilege.privilege_type='EXECUTE')"
check_equals public_grants_to_browser_roles 0 "SELECT count(*) FROM information_schema.role_table_grants WHERE table_schema='public' AND grantee IN ('anon','authenticated','service_role')"
check_equals public_function_grants_to_browser_roles 0 "SELECT count(*) FROM information_schema.routine_privileges WHERE specific_schema='public' AND grantee IN ('anon','authenticated','service_role')"

check_equals rescue_connections "$EXPECTED_CONNECTIONS" "SELECT count(*) FROM public.pos_connections"
check_equals rescue_provider_split '30|1' "SELECT count(*) FILTER (WHERE provider='agora') || '|' || count(*) FILTER (WHERE provider='yurest') FROM public.pos_connections"
check_equals rescue_connections_unsafe 0 "SELECT count(*) FROM public.pos_connections WHERE enabled OR catalog_sync_enabled OR sync_mode <> 'PULL_ONLY' OR write_mode <> 'NONE' OR backfill_days <> 0 OR last_sync_at IS NOT NULL OR last_catalog_sync_at IS NOT NULL OR last_business_day_synced IS NOT NULL OR circuit_breaker_paused_until IS NOT NULL OR consecutive_failures <> 0 OR base_url <> 'https://redacted.invalid' OR api_token <> '' OR winerim_api_token IS NOT NULL"
if [ "$HYDRATION_AWARE" = 1 ]; then
  candidate="'$HYDRATION_CONNECTION_ID'::uuid"
  expected_hydration_counts="$EXPECTED_HYDRATION_WINERIM_WINES|$EXPECTED_HYDRATION_PROVIDER_PRODUCTS|$EXPECTED_HYDRATION_PRODUCT_MAPPINGS|$EXPECTED_HYDRATION_MASTER_ROWS"
  check_equals hydration_connection_exists 1 "SELECT count(*) FROM public.pos_connections WHERE id=$candidate"
  check_equals hydration_exact_counts "$expected_hydration_counts" "SELECT (SELECT count(*) FROM public.winerim_wines WHERE connection_id=$candidate) || '|' || (SELECT count(*) FROM public.provider_products WHERE connection_id=$candidate) || '|' || (SELECT count(*) FROM public.product_mappings WHERE connection_id=$candidate) || '|' || (SELECT count(*) FROM public.agora_master_data WHERE connection_id=$candidate)"
  check_equals hydration_rows_outside_candidate 0 "SELECT (SELECT count(*) FROM public.winerim_wines WHERE connection_id<>$candidate) + (SELECT count(*) FROM public.provider_products WHERE connection_id<>$candidate) + (SELECT count(*) FROM public.product_mappings WHERE connection_id<>$candidate) + (SELECT count(*) FROM public.agora_master_data WHERE connection_id<>$candidate)"
  check_equals hydration_disallowed_table_rows 0 "SELECT coalesce(sum((xpath('/row/count/text()', query_to_xml(format('SELECT count(*) AS count FROM public.%I', c.relname), false, true, '')))[1]::text::bigint), 0) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relname NOT IN ('infrastructure_metadata','pos_connections','winerim_wines','provider_products','product_mappings','agora_master_data')"
  if actual_hydration_digest=$(hydration_database_fingerprint "$DATABASE_URL" "$HYDRATION_CONNECTION_ID" 2>/dev/null); then
    if [ "$actual_hydration_digest" = "$HYDRATION_DIGEST" ]; then
      printf 'OK: hydration_database_fingerprint=%s\n' "$actual_hydration_digest"
    else
      printf 'FAIL: hydration_database_fingerprint expected=%s actual=%s\n' "$HYDRATION_DIGEST" "$actual_hydration_digest" >&2
      FAILURES=$((FAILURES + 1))
    fi
  else
    printf 'FAIL: hydration_database_fingerprint could not be computed\n' >&2
    FAILURES=$((FAILURES + 1))
  fi
else
  check_equals non_seed_table_rows 0 "SELECT coalesce(sum((xpath('/row/count/text()', query_to_xml(format('SELECT count(*) AS count FROM public.%I', c.relname), false, true, '')))[1]::text::bigint), 0) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relname NOT IN ('infrastructure_metadata','pos_connections')"
fi
check_equals active_runtime_canaries 0 "SELECT count(*) FROM public.runtime_canary_connections WHERE active"
check_equals runtime_sales_claim_identity_index_contract 1 "SELECT count(*) FROM pg_index index_contract JOIN pg_class index_class ON index_class.oid=index_contract.indexrelid JOIN pg_namespace index_namespace ON index_namespace.oid=index_class.relnamespace JOIN pg_class table_class ON table_class.oid=index_contract.indrelid JOIN pg_attribute identity_column ON identity_column.attrelid=table_class.oid AND identity_column.attname='sales_claim_identity' AND identity_column.attnum>0 AND NOT identity_column.attisdropped WHERE index_namespace.nspname='public' AND table_class.relname='runtime_idempotency' AND index_class.relname='uq_runtime_sales_claim_identity' AND index_contract.indisunique AND index_contract.indisvalid AND index_contract.indisready AND index_contract.indnkeyatts=1 AND index_contract.indnatts=1 AND index_contract.indkey::text=identity_column.attnum::text AND pg_get_expr(index_contract.indpred,index_contract.indrelid)='((job = ''sales.claim''::text) AND (sales_claim_identity IS NOT NULL))'"
check_equals runtime_sales_claim_identity_scope_contract 1 "SELECT count(*) FROM pg_constraint constraint_contract WHERE constraint_contract.conrelid='public.runtime_idempotency'::regclass AND constraint_contract.conname='runtime_idempotency_sales_claim_identity_scope' AND constraint_contract.contype='c' AND constraint_contract.convalidated AND pg_get_constraintdef(constraint_contract.oid)='CHECK (((job = ''sales.claim''::text) OR (sales_claim_identity IS NULL)))'"
check_equals runtime_sales_claim_identity_trigger_contract 1 "SELECT count(*) FROM pg_trigger trigger_contract JOIN pg_class table_class ON table_class.oid=trigger_contract.tgrelid JOIN pg_namespace table_namespace ON table_namespace.oid=table_class.relnamespace JOIN pg_proc trigger_function ON trigger_function.oid=trigger_contract.tgfoid WHERE table_namespace.nspname='public' AND table_class.relname='runtime_idempotency' AND trigger_contract.tgname='runtime_bind_sales_claim_identity' AND NOT trigger_contract.tgisinternal AND trigger_contract.tgenabled IN ('O','A') AND trigger_contract.tgtype=23 AND trigger_function.proname='runtime_bind_sales_claim_identity' AND position('NEW.sales_claim_identity IS DISTINCT FROM OLD.sales_claim_identity' IN trigger_function.prosrc)>0 AND (SELECT count(*) FROM unnest(trigger_contract.tgattr))=4"
check_equals runtime_idempotency_update_privilege_contract 1 "SELECT ((NOT has_table_privilege('middleware_runtime','public.runtime_idempotency','UPDATE')) AND (NOT has_column_privilege('middleware_runtime','public.runtime_idempotency','sales_claim_identity','UPDATE')) AND (SELECT count(*)=8 AND count(DISTINCT column_name)=8 AND array_agg(column_name::text ORDER BY column_name)=ARRAY['attempt','lease_expires_at','lease_token','message_id','payload_sha256','result','status','updated_at']::text[] FROM information_schema.column_privileges WHERE table_schema='public' AND table_name='runtime_idempotency' AND grantee='middleware_runtime' AND privilege_type='UPDATE') AND NOT EXISTS (SELECT 1 FROM information_schema.table_privileges WHERE table_schema='public' AND table_name='runtime_idempotency' AND grantee='middleware_runtime_login' AND privilege_type='UPDATE') AND NOT EXISTS (SELECT 1 FROM information_schema.column_privileges WHERE table_schema='public' AND table_name='runtime_idempotency' AND grantee='middleware_runtime_login' AND privilege_type='UPDATE'))::int"
check_equals runtime_stock_privilege_contract 1 "SELECT (has_table_privilege('middleware_runtime','public.stock_sync_log','SELECT,INSERT') AND NOT has_table_privilege('middleware_runtime','public.stock_sync_log','UPDATE,DELETE'))::int"
check_equals runtime_sales_privilege_contract '1|1|1|1|1|1|0|1|0|1|0|1|0' "SELECT has_table_privilege('middleware_runtime','public.product_mappings','SELECT')::int || '|' || has_table_privilege('middleware_runtime','public.winerim_wines','SELECT')::int || '|' || has_table_privilege('middleware_runtime','public.sales_events','SELECT,INSERT')::int || '|' || (NOT has_table_privilege('middleware_runtime','public.sales_events','UPDATE'))::int || '|' || (has_column_privilege('middleware_runtime','public.sales_events','business_day','UPDATE') AND has_column_privilege('middleware_runtime','public.sales_events','doc_type','UPDATE') AND has_column_privilege('middleware_runtime','public.sales_events','total_amount','UPDATE') AND has_column_privilege('middleware_runtime','public.sales_events','total_tax','UPDATE') AND has_column_privilege('middleware_runtime','public.sales_events','total_net','UPDATE') AND has_column_privilege('middleware_runtime','public.sales_events','line_count','UPDATE') AND has_column_privilege('middleware_runtime','public.sales_events','raw_json','UPDATE'))::int || '|' || (NOT has_column_privilege('middleware_runtime','public.sales_events','provider_doc_id','UPDATE'))::int || '|' || has_table_privilege('middleware_runtime','public.sales_events','DELETE')::int || '|' || has_table_privilege('middleware_runtime','public.sales_line_items','SELECT,INSERT,DELETE')::int || '|' || has_table_privilege('middleware_runtime','public.sales_line_items','UPDATE')::int || '|' || has_table_privilege('middleware_runtime','public.stock_sync_log','SELECT,INSERT')::int || '|' || has_table_privilege('middleware_runtime','public.stock_sync_log','UPDATE,DELETE')::int || '|' || has_column_privilege('middleware_runtime','public.pos_connections','last_sync_at','UPDATE')::int || '|' || has_column_privilege('middleware_runtime','public.pos_connections','enabled','UPDATE')::int"
if [ -n "$RUNTIME_DATABASE_URL" ]; then
  check_runtime_equals runtime_session_identity middleware_runtime_login "SELECT session_user"
  check_runtime_equals runtime_login_identity middleware_runtime_login "SELECT current_user"
fi
check_runtime_equals runtime_effective_scope_without_canary 0 "SELECT count(*) FROM public.runtime_canary_connections"

if [ "$FAILURES" -gt 0 ]; then
  printf 'RESULT=RESCUE_PRODUCTION_VERIFY_FAILED failures=%s\n' "$FAILURES" >&2
  exit 1
fi
printf 'RESULT=RESCUE_PRODUCTION_VERIFY_OK connections=%s unsafe=0\n' "$EXPECTED_CONNECTIONS"
