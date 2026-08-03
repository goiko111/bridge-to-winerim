#!/usr/bin/env bash
set -euo pipefail
set +x

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DATABASE_URL=${RESCUE_PRODUCTION_DATABASE_URL:-}
RUNTIME_DATABASE_URL=${RESCUE_PRODUCTION_RUNTIME_DATABASE_URL:-}
EXPECTED_CONNECTIONS=${RESCUE_PRODUCTION_EXPECTED_CONNECTIONS:-31}
EXPECTED_LOGIN_ROLES=${RESCUE_PRODUCTION_EXPECTED_LOGIN_ROLES:-0}
FAILURES=0

test -n "$DATABASE_URL" || { printf 'RESCUE_PRODUCTION_DATABASE_URL_REQUIRED\n' >&2; exit 2; }
case "$EXPECTED_CONNECTIONS" in ''|*[!0-9]*) printf 'RESCUE_PRODUCTION_EXPECTED_CONNECTIONS_INVALID\n' >&2; exit 2 ;; esac
case "$EXPECTED_LOGIN_ROLES" in 0|3) ;; *) printf 'RESCUE_PRODUCTION_EXPECTED_LOGIN_ROLES_INVALID\n' >&2; exit 2 ;; esac
if [ "$EXPECTED_LOGIN_ROLES" = 3 ] && [ -z "$RUNTIME_DATABASE_URL" ]; then
  printf 'RESCUE_PRODUCTION_RUNTIME_DATABASE_URL_REQUIRED\n' >&2
  exit 2
fi
for command_name in node psql; do
  command -v "$command_name" >/dev/null 2>&1 || { printf 'BLOCKED_MISSING_COMMAND=%s\n' "$command_name" >&2; exit 2; }
done

node "$SCRIPT_DIR/rescue-production-target.mjs" >/dev/null
if [ -n "$RUNTIME_DATABASE_URL" ]; then
  RESCUE_PRODUCTION_DATABASE_URL="$RUNTIME_DATABASE_URL" \
    node "$SCRIPT_DIR/rescue-production-target.mjs" >/dev/null
fi
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/winerim-rescue-production-verify.XXXXXX")
PSQL_ERROR="$TMP_ROOT/psql-error.log"
READ_ONLY_OPTIONS="${PGOPTIONS:+$PGOPTIONS }-c default_transaction_read_only=on -c statement_timeout=15000 -c lock_timeout=1000"
trap 'rm -rf "$TMP_ROOT"' EXIT INT TERM

query_scalar() {
  local check_name=$1
  local sql=$2
  local result
  : >"$PSQL_ERROR"
  if ! result=$(PGOPTIONS="$READ_ONLY_OPTIONS" psql -X -q -A -t -v ON_ERROR_STOP=1 -d "$DATABASE_URL" -c "$sql" 2>"$PSQL_ERROR"); then
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
  if ! actual=$(PGOPTIONS="$READ_ONLY_OPTIONS" psql -X -q -A -t -v ON_ERROR_STOP=1 -d "$target_url" -c "$sql" 2>"$PSQL_ERROR"); then
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
check_equals non_seed_table_rows 0 "SELECT coalesce(sum((xpath('/row/count/text()', query_to_xml(format('SELECT count(*) AS count FROM public.%I', c.relname), false, true, '')))[1]::text::bigint), 0) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relname NOT IN ('infrastructure_metadata','pos_connections')"
check_equals active_runtime_canaries 0 "SELECT count(*) FROM public.runtime_canary_connections WHERE active"
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
