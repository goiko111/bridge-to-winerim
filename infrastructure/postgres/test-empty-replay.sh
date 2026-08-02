#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
MIGRATIONS_DIR="$REPO_ROOT/supabase/migrations"
MANIFEST="$SCRIPT_DIR/migration-manifest.tsv"
EXPECTED="$SCRIPT_DIR/expected-schema.txt"

for command_name in initdb pg_ctl createdb psql; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'BLOCKED: %s is not installed\n' "$command_name" >&2
    exit 2
  fi
done

TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/winerim-postgres-replay.XXXXXX")
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
PORT=$((55432 + ($$ % 1000)))
DB_NAME=winerim_schema_replay
SERVER_STARTED=0

cleanup() {
  if [ "$SERVER_STARTED" -eq 1 ]; then
    pg_ctl -D "$DATA_DIR" -m fast -w stop >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT INT TERM

mkdir -p "$SOCKET_DIR"
initdb -D "$DATA_DIR" --auth=trust --no-locale --encoding=UTF8 >/dev/null
pg_ctl -D "$DATA_DIR" -o "-h '' -k '$SOCKET_DIR' -p $PORT" -w start >/dev/null
SERVER_STARTED=1

PSQL=(psql -X -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT")

createdb -h "$SOCKET_DIR" -p "$PORT" "$DB_NAME"

BOOTSTRAP_SQL="$TMP_ROOT/bootstrap.sql"
"$SCRIPT_DIR/build-bootstrap.sh" "$BOOTSTRAP_SQL" >/dev/null
"${PSQL[@]}" -d "$DB_NAME" -v environment=staging -f "$BOOTSTRAP_SQL" >/dev/null

applied=$(awk -F '\t' 'NR > 1 && ($5 == "INCLUDE" || $5 == "INCLUDE_SECURITY_GATE" || $5 == "INCLUDE_WITH_REVIEW") { count++ } END { print count + 0 }' "$MANIFEST")

missing=0
while read -r object_type object_name _; do
  case "$object_type" in
    TABLE)
      present=$("${PSQL[@]}" -d "$DB_NAME" -Atc "SELECT (to_regclass('public.$object_name') IS NOT NULL)::int")
      ;;
    FUNCTION)
      present=$("${PSQL[@]}" -d "$DB_NAME" -Atc "SELECT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='$object_name')::int")
      ;;
    COLUMN)
      table_name=${object_name%%.*}
      column_name=${object_name#*.}
      present=$("${PSQL[@]}" -d "$DB_NAME" -Atc "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='$table_name' AND column_name='$column_name')::int")
      ;;
    INDEX)
      present=$("${PSQL[@]}" -d "$DB_NAME" -Atc "SELECT (to_regclass('public.$object_name') IS NOT NULL)::int")
      ;;
    FOREIGN_KEY_SET_NULL)
      present=$("${PSQL[@]}" -d "$DB_NAME" -Atc "SELECT EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public' AND c.conname='$object_name' AND c.contype='f' AND c.confdeltype='n')::int")
      ;;
    \#*|'')
      continue
      ;;
    *)
      printf 'BLOCKED: unknown expected object type %s\n' "$object_type" >&2
      exit 2
      ;;
  esac

  if [ "$present" != "1" ]; then
    printf 'MISSING: %s %s\n' "$object_type" "$object_name" >&2
    missing=$((missing + 1))
  fi
done < "$EXPECTED"

# Parse and execute the reusable catalog audit in an enforced read-only
# transaction. Output is suppressed here because the focused counts below are
# the replay gate; operators can run validate.sh to inspect the full matrix.
"${PSQL[@]}" -d "$DB_NAME" -f "$SCRIPT_DIR/validate-readonly.sql" >/dev/null

rls_missing=$("${PSQL[@]}" -d "$DB_NAME" -Atc "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND NOT c.relrowsecurity")
security_definer_public=$("${PSQL[@]}" -d "$DB_NAME" -Atc "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prosecdef AND EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE')")
table_count=$("${PSQL[@]}" -d "$DB_NAME" -Atc "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'")
function_count=$("${PSQL[@]}" -d "$DB_NAME" -Atc "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'")

printf 'INFO: replayed_migrations=%s\n' "$applied"
printf 'INFO: public_tables=%s\n' "$table_count"
printf 'INFO: public_functions=%s\n' "$function_count"
printf 'INFO: public_tables_without_rls=%s\n' "$rls_missing"
printf 'INFO: security_definer_functions_executable_by_public=%s\n' "$security_definer_public"

public_policies=$("${PSQL[@]}" -d "$DB_NAME" -Atc "SELECT count(*) FROM pg_policies WHERE schemaname='public' AND ('public'=ANY(roles) OR 'authenticated'=ANY(roles) OR 'service_role'=ANY(roles))")
runtime_lock_table=$("${PSQL[@]}" -d "$DB_NAME" -Atc "SELECT has_table_privilege('middleware_runtime', 'public.agora_dispatch_locks', 'SELECT,INSERT,UPDATE,DELETE')::int")
runtime_lock_functions=$("${PSQL[@]}" -d "$DB_NAME" -Atc "SELECT (has_function_privilege('middleware_runtime', 'public.acquire_agora_dispatch_lock(uuid,text,text,integer)', 'EXECUTE') AND has_function_privilege('middleware_runtime', 'public.release_agora_dispatch_lock(uuid,text,text)', 'EXECUTE'))::int")
runtime_vault_privileges=$("${PSQL[@]}" -d "$DB_NAME" -Atc "SELECT (has_table_privilege('middleware_runtime', 'public.runtime_connection_credentials', 'SELECT') AND NOT has_table_privilege('middleware_runtime', 'public.runtime_connection_credentials', 'INSERT,UPDATE,DELETE') AND NOT has_table_privilege('middleware_api', 'public.runtime_connection_credentials', 'SELECT,INSERT,UPDATE,DELETE') AND NOT has_table_privilege('middleware_readonly', 'public.runtime_connection_credentials', 'SELECT,INSERT,UPDATE,DELETE'))::int")
api_minimum_privileges=$("${PSQL[@]}" -d "$DB_NAME" -Atc "SELECT (has_table_privilege('middleware_api', 'public.infrastructure_metadata', 'SELECT') AND has_table_privilege('middleware_api', 'public.pos_connections', 'SELECT') AND has_table_privilege('middleware_api', 'public.integration_onboarding_requests', 'SELECT,INSERT') AND NOT has_table_privilege('middleware_api', 'public.stock_sync_log', 'INSERT,UPDATE,DELETE') AND NOT has_table_privilege('middleware_api', 'public.outbound_tasks', 'INSERT,UPDATE,DELETE'))::int")
legacy_lock_functions=$("${PSQL[@]}" -d "$DB_NAME" -Atc "SELECT (has_function_privilege('service_role', 'public.acquire_agora_dispatch_lock(uuid,text,text,integer)', 'EXECUTE') OR has_function_privilege('service_role', 'public.release_agora_dispatch_lock(uuid,text,text)', 'EXECUTE'))::int")
platform_helpers=$("${PSQL[@]}" -d "$DB_NAME" -Atc "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('invoke_connection_health_monitor','invoke_connection_health_monitor_secure')")
legacy_contact_columns=$("${PSQL[@]}" -d "$DB_NAME" -Atc "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='connection_notification_contacts' AND column_name IN ('label','channel','target','notify_client','notify_recovery','min_severity','alert_types')")
secure_contact_columns=$("${PSQL[@]}" -d "$DB_NAME" -Atc "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='connection_notification_contacts' AND column_name IN ('contact_type','display_name','email','phone')")

if [ "$missing" -gt 0 ] || [ "$rls_missing" -gt 0 ] || [ "$security_definer_public" -gt 0 ] || [ "$public_policies" -gt 0 ] || [ "$runtime_lock_table" != "1" ] || [ "$runtime_lock_functions" != "1" ] || [ "$runtime_vault_privileges" != "1" ] || [ "$api_minimum_privileges" != "1" ] || [ "$legacy_lock_functions" != "0" ] || [ "$platform_helpers" -gt 0 ] || [ "$legacy_contact_columns" -gt 0 ] || [ "$secure_contact_columns" != "4" ]; then
  printf 'RESULT=EMPTY_REPLAY_FAILED missing=%s rls_missing=%s public_security_definer=%s public_policies=%s runtime_lock_table=%s runtime_lock_functions=%s runtime_vault_privileges=%s api_minimum_privileges=%s legacy_lock_functions=%s platform_helpers=%s legacy_contact_columns=%s secure_contact_columns=%s\n' "$missing" "$rls_missing" "$security_definer_public" "$public_policies" "$runtime_lock_table" "$runtime_lock_functions" "$runtime_vault_privileges" "$api_minimum_privileges" "$legacy_lock_functions" "$platform_helpers" "$legacy_contact_columns" "$secure_contact_columns" >&2
  exit 1
fi

printf 'INFO: public_or_legacy_role_policies=%s\n' "$public_policies"
printf 'INFO: runtime_lock_table_privileges=%s\n' "$runtime_lock_table"
printf 'INFO: runtime_lock_function_privileges=%s\n' "$runtime_lock_functions"
printf 'INFO: runtime_vault_minimum_privileges=%s\n' "$runtime_vault_privileges"
printf 'INFO: api_minimum_privileges=%s\n' "$api_minimum_privileges"
printf 'INFO: legacy_lock_function_privileges=%s\n' "$legacy_lock_functions"
printf 'INFO: excluded_platform_health_helpers=%s\n' "$platform_helpers"
printf 'INFO: legacy_contact_columns=%s\n' "$legacy_contact_columns"
printf 'INFO: secure_contact_columns=%s\n' "$secure_contact_columns"
printf 'RESULT=EMPTY_REPLAY_HARDENED_OK\n'
