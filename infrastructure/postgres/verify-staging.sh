#!/usr/bin/env bash
set -euo pipefail
set +x

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  printf 'Usage: %s STAGING_DATABASE_URL\n' "$0" >&2
  exit 2
fi

if ! command -v psql >/dev/null 2>&1; then
  printf 'BLOCKED: psql is not installed\n' >&2
  exit 2
fi

DATABASE_URL=$1
FAILURES=0
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/winerim-staging-verify.XXXXXX")
PSQL_ERROR="$TMP_ROOT/psql-error.log"
READ_ONLY_OPTIONS="${PGOPTIONS:+$PGOPTIONS }-c default_transaction_read_only=on -c statement_timeout=15000 -c lock_timeout=1000"

cleanup() {
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT INT TERM

query_scalar() {
  local check_name=$1
  local sql=$2
  local result

  : >"$PSQL_ERROR"
  if ! result=$(
    PGOPTIONS="$READ_ONLY_OPTIONS" \
      psql -X -q -A -t -v ON_ERROR_STOP=1 -d "$DATABASE_URL" -c "$sql" 2>"$PSQL_ERROR"
  ); then
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

metadata_query_failed=0
if ! metadata_present=$(query_scalar \
  'infrastructure_metadata_present' \
  "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'infrastructure_metadata' AND c.relkind = 'r'"); then
  FAILURES=$((FAILURES + 1))
  metadata_present=0
  metadata_query_failed=1
fi

if [ "$metadata_present" = "1" ]; then
  printf 'OK: infrastructure_metadata_present=1\n'
  check_equals \
    'environment_staging_rows' \
    '1' \
    "SELECT count(*) FROM public.infrastructure_metadata WHERE key = 'environment' AND value = 'staging'"
elif [ "$metadata_query_failed" -eq 0 ]; then
  printf 'FAIL: infrastructure_metadata_present expected=1 actual=%s\n' "$metadata_present" >&2
  FAILURES=$((FAILURES + 1))
fi

check_equals \
  'public_tables' \
  '30' \
  "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r'"

actual_tables=$(query_scalar \
  'public_table_inventory' \
  "SELECT string_agg(c.relname, E'\\n' ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'") || actual_tables=''
expected_tables=$(cat "$SCRIPT_DIR/expected-tables-runtime-postupgrade.txt")
if [ "$actual_tables" != "$expected_tables" ]; then
  printf 'FAIL: public_table_inventory does not match the reviewed 30-table contract\n' >&2
  FAILURES=$((FAILURES + 1))
else
  printf 'OK: public_table_inventory=exact\n'
fi

check_equals \
  'runtime_upgrade_tables' \
  '2' \
  "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relname IN ('runtime_connection_credentials','runtime_canary_connections')"

check_equals \
  'runtime_canary_function' \
  '1' \
  "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='enforce_runtime_canary_connection_window'"

check_equals \
  'runtime_canary_trigger' \
  '1' \
  "SELECT count(*) FROM pg_trigger trigger JOIN pg_class table_class ON table_class.oid=trigger.tgrelid JOIN pg_namespace n ON n.oid=table_class.relnamespace WHERE n.nspname='public' AND table_class.relname='runtime_canary_connections' AND trigger.tgname='enforce_runtime_canary_connection_window' AND NOT trigger.tgisinternal"

check_equals \
  'runtime_canary_unique_index' \
  '1' \
  "SELECT count(*) FROM pg_class index_class JOIN pg_namespace n ON n.oid=index_class.relnamespace WHERE n.nspname='public' AND index_class.relkind='i' AND index_class.relname='runtime_canary_connections_single_active_idx'"

check_equals \
  'public_tables_without_rls' \
  '0' \
  "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity"

check_equals \
  'base_roles_present' \
  '3' \
  "SELECT count(*) FROM pg_roles WHERE rolname IN ('middleware_api', 'middleware_readonly', 'middleware_runtime')"

check_equals \
  'base_roles_unsafe_attributes' \
  '0' \
  "SELECT count(*) FROM pg_roles WHERE rolname IN ('middleware_api', 'middleware_readonly', 'middleware_runtime') AND (rolcanlogin OR rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication)"

check_equals \
  'base_roles_with_memberships' \
  '0' \
  "SELECT count(*) FROM pg_auth_members membership JOIN pg_roles member_role ON member_role.oid = membership.member WHERE member_role.rolname IN ('middleware_api', 'middleware_readonly', 'middleware_runtime')"

check_equals \
  'api_login_members' \
  '1' \
  "SELECT count(*) FROM pg_auth_members membership JOIN pg_roles granted_role ON granted_role.oid = membership.roleid JOIN pg_roles member_role ON member_role.oid = membership.member WHERE granted_role.rolname = 'middleware_api' AND member_role.rolname = 'middleware_api_login' AND member_role.rolcanlogin"

check_equals \
  'api_login_members_unsafe' \
  '0' \
  "SELECT count(*) FROM pg_auth_members target_membership JOIN pg_roles target_role ON target_role.oid = target_membership.roleid JOIN pg_roles member_role ON member_role.oid = target_membership.member WHERE target_role.rolname = 'middleware_api' AND member_role.rolname = 'middleware_api_login' AND (NOT member_role.rolcanlogin OR member_role.rolsuper OR member_role.rolbypassrls OR member_role.rolcreaterole OR member_role.rolcreatedb OR member_role.rolreplication OR NOT member_role.rolinherit OR target_membership.admin_option OR EXISTS (SELECT 1 FROM pg_auth_members extra_membership WHERE extra_membership.member = member_role.oid AND extra_membership.roleid <> target_role.oid))"

check_equals \
  'runtime_login_members' \
  '1' \
  "SELECT count(*) FROM pg_auth_members membership JOIN pg_roles granted_role ON granted_role.oid = membership.roleid JOIN pg_roles member_role ON member_role.oid = membership.member WHERE granted_role.rolname = 'middleware_runtime' AND member_role.rolname = 'middleware_runtime_login' AND member_role.rolcanlogin"

check_equals \
  'runtime_login_members_unsafe' \
  '0' \
  "SELECT count(*) FROM pg_auth_members target_membership JOIN pg_roles target_role ON target_role.oid = target_membership.roleid JOIN pg_roles member_role ON member_role.oid = target_membership.member WHERE target_role.rolname = 'middleware_runtime' AND member_role.rolname = 'middleware_runtime_login' AND (NOT member_role.rolcanlogin OR member_role.rolsuper OR member_role.rolbypassrls OR member_role.rolcreaterole OR member_role.rolcreatedb OR member_role.rolreplication OR NOT member_role.rolinherit OR target_membership.admin_option OR EXISTS (SELECT 1 FROM pg_auth_members extra_membership WHERE extra_membership.member = member_role.oid AND extra_membership.roleid <> target_role.oid))"

check_equals \
  'shared_api_runtime_login_members' \
  '0' \
  "SELECT count(*) FROM pg_roles member_role WHERE member_role.rolname IN ('middleware_api_login', 'middleware_runtime_login') AND member_role.rolcanlogin AND EXISTS (SELECT 1 FROM pg_auth_members membership JOIN pg_roles granted_role ON granted_role.oid = membership.roleid WHERE membership.member = member_role.oid AND granted_role.rolname = 'middleware_api') AND EXISTS (SELECT 1 FROM pg_auth_members membership JOIN pg_roles granted_role ON granted_role.oid = membership.roleid WHERE membership.member = member_role.oid AND granted_role.rolname = 'middleware_runtime')"

check_equals \
  'public_security_definer_with_public_execute' \
  '0' \
  "SELECT count(*) FROM pg_proc function JOIN pg_namespace namespace ON namespace.oid = function.pronamespace WHERE namespace.nspname = 'public' AND function.prosecdef AND EXISTS (SELECT 1 FROM aclexplode(COALESCE(function.proacl, acldefault('f', function.proowner))) privilege WHERE privilege.grantee = 0 AND privilege.privilege_type = 'EXECUTE')"

if [ "$FAILURES" -gt 0 ]; then
  printf 'RESULT=STAGING_VERIFY_FAILED failures=%s\n' "$FAILURES" >&2
  exit 1
fi

printf 'RESULT=STAGING_VERIFY_OK\n'
