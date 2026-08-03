#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/postgres-client-tools.sh"
DATABASE_URL=${RESCUE_PRODUCTION_DATABASE_URL:-}
ARTIFACT_DIR=${RESCUE_PRODUCTION_ROLLBACK_ARTIFACT_DIR:-}
APPLY=0
CONFIRM_PROJECT_REF=''
CONFIRM_PLAN_SHA=''
CONFIRM_ACTION=''

while [ "$#" -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --confirm-project-ref) CONFIRM_PROJECT_REF=${2:-}; shift 2 ;;
    --confirm-plan-sha) CONFIRM_PLAN_SHA=${2:-}; shift 2 ;;
    --confirm-action) CONFIRM_ACTION=${2:-}; shift 2 ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done

for command_name in node; do
  command -v "$command_name" >/dev/null 2>&1 || { printf 'BLOCKED_MISSING_COMMAND=%s\n' "$command_name" >&2; exit 2; }
done
if command -v sha256sum >/dev/null 2>&1; then SHA256=(sha256sum); else SHA256=(shasum -a 256); fi
test -n "$DATABASE_URL" || { printf 'RESCUE_PRODUCTION_DATABASE_URL_REQUIRED\n' >&2; exit 2; }
configure_postgres_tools "$DATABASE_URL"
test -n "$ARTIFACT_DIR" && test -d "$ARTIFACT_DIR" || { printf 'RESCUE_PRODUCTION_ROLLBACK_ARTIFACT_DIR_REQUIRED\n' >&2; exit 2; }
case "$ARTIFACT_DIR" in /*) ;; *) printf 'ABSOLUTE_ROLLBACK_ARTIFACT_DIR_REQUIRED\n' >&2; exit 2 ;; esac

target_json=$(node "$SCRIPT_DIR/rescue-production-target.mjs")
project_ref=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).projectRef)' "$target_json")
manifest="$ARTIFACT_DIR/manifest.txt"
manifest_digest="$ARTIFACT_DIR/manifest.txt.sha256"
dump="$ARTIFACT_DIR/public.dump"
roles="$ARTIFACT_DIR/roles.tsv"
test -f "$manifest" && test -f "$manifest_digest" && test -f "$dump" && test -f "$roles" || {
  printf 'ROLLBACK_ARTIFACT_INCOMPLETE\n' >&2; exit 3;
}
(cd "$ARTIFACT_DIR" && "${SHA256[@]}" -c "$(basename "$manifest_digest")" >/dev/null) || {
  printf 'ROLLBACK_MANIFEST_DIGEST_REJECTED\n' >&2; exit 3;
}
manifest_value() { awk -F= -v key="$1" '$1 == key {print substr($0, index($0, "=") + 1)}' "$manifest"; }
test "$(manifest_value project_ref)" = "$project_ref" || { printf 'ROLLBACK_PROJECT_REF_MISMATCH\n' >&2; exit 3; }
test "$(manifest_value phase)" = pre-bootstrap || { printf 'ROLLBACK_PHASE_REJECTED\n' >&2; exit 3; }
test "$(manifest_value observed_environment)" = absent || { printf 'ROLLBACK_PRESTATE_REJECTED\n' >&2; exit 3; }
test "$(manifest_value public_table_count)" = 0 || { printf 'ROLLBACK_PRESTATE_TABLES_REJECTED\n' >&2; exit 3; }
test ! -s "$roles" || { printf 'ROLLBACK_PRESTATE_ROLES_REJECTED\n' >&2; exit 3; }
test "$("${SHA256[@]}" "$dump" | awk '{print $1}')" = "$(manifest_value dump_sha256)" || {
  printf 'ROLLBACK_DUMP_DIGEST_REJECTED\n' >&2; exit 3;
}

query() {
  PGOPTIONS="${PGOPTIONS:+$PGOPTIONS }-c default_transaction_read_only=on -c statement_timeout=15000 -c lock_timeout=1000" \
    "$PSQL_CMD" "$DATABASE_URL" -XAtq -v ON_ERROR_STOP=1 -c "$1"
}
actual_tables=$(query "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' ORDER BY c.relname")
if [ -n "$actual_tables" ]; then
  if ! diff -u <(printf '%s\n' "$actual_tables") "$SCRIPT_DIR/expected-tables-runtime-postupgrade.txt" >/dev/null; then
    printf 'ROLLBACK_UNKNOWN_TABLE_INVENTORY_REJECTED\n' >&2
    exit 3
  fi
fi

sentinel=$(query "SELECT CASE WHEN to_regclass('public.infrastructure_metadata') IS NULL THEN 'absent' ELSE (SELECT coalesce(value,'missing-row') FROM public.infrastructure_metadata WHERE key='environment') END")
test "$sentinel" = rescue-production || { printf 'ROLLBACK_ENVIRONMENT_REJECTED\n' >&2; exit 3; }
unsafe=$(query "SELECT count(*) FROM public.pos_connections WHERE enabled OR catalog_sync_enabled OR sync_mode <> 'PULL_ONLY' OR write_mode <> 'NONE' OR backfill_days <> 0 OR last_sync_at IS NOT NULL OR last_catalog_sync_at IS NOT NULL OR last_business_day_synced IS NOT NULL OR circuit_breaker_paused_until IS NOT NULL OR consecutive_failures <> 0 OR base_url <> 'https://redacted.invalid' OR api_token <> '' OR winerim_api_token IS NOT NULL")
connections=$(query 'SELECT count(*) FROM public.pos_connections')
non_seed_rows=$(query "SELECT coalesce(sum((xpath('/row/count/text()', query_to_xml(format('SELECT count(*) AS count FROM public.%I', c.relname), false, true, '')))[1]::text::bigint), 0) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relname NOT IN ('infrastructure_metadata','pos_connections')")
test "$connections" = 31 && test "$unsafe" = 0 && test "$non_seed_rows" = 0 || {
  printf 'ROLLBACK_LIVE_OR_UNKNOWN_DATA_REJECTED connections=%s unsafe=%s non_seed_rows=%s\n' "$connections" "$unsafe" "$non_seed_rows" >&2
  exit 3
}

plan_sha=$(cat "$manifest" "$manifest_digest" "$dump" "$SCRIPT_DIR/rollback-rescue-production.sh" | "${SHA256[@]}" | awk '{print $1}')
printf 'RESCUE_PRODUCTION_ROLLBACK_PLAN_OK project_ref=%s connections=31 unsafe=0 non_seed_rows=0 plan_sha256=%s\n' "$project_ref" "$plan_sha"
if [ "$APPLY" -ne 1 ]; then printf 'RESULT=PLAN_ONLY\n'; exit 0; fi

test "$CONFIRM_PROJECT_REF" = "$project_ref" || { printf 'CONFIRM_PROJECT_REF_REJECTED\n' >&2; exit 4; }
test "$CONFIRM_PLAN_SHA" = "$plan_sha" || { printf 'CONFIRM_PLAN_SHA_REJECTED\n' >&2; exit 4; }
test "$CONFIRM_ACTION" = ROLLBACK_UNUSED_RESCUE_PRODUCTION || { printf 'CONFIRM_ACTION_REJECTED\n' >&2; exit 4; }

"$SCRIPT_DIR/backup-rescue-production.sh" pre-rollback
"$PSQL_CMD" "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -c 'DROP SCHEMA public CASCADE' >/dev/null
"$PG_RESTORE_CMD" --exit-on-error --no-owner --dbname "$DATABASE_URL" "$dump" >/dev/null
"$PSQL_CMD" "$DATABASE_URL" -X -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
DO $cleanup_roles$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['middleware_api', 'middleware_readonly', 'middleware_runtime']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('DROP OWNED BY %I', role_name);
      EXECUTE format('DROP ROLE %I', role_name);
    END IF;
  END LOOP;
END
$cleanup_roles$;
SQL

post_tables=$(query "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'")
post_roles=$(query "SELECT count(*) FROM pg_roles WHERE rolname LIKE 'middleware_%'")
post_metadata=$(query "SELECT (to_regclass('public.infrastructure_metadata') IS NOT NULL)::int")
test "$post_tables" = 0 && test "$post_roles" = 0 && test "$post_metadata" = 0 || {
  printf 'ROLLBACK_POSTVERIFY_FAILED tables=%s roles=%s metadata=%s\n' "$post_tables" "$post_roles" "$post_metadata" >&2
  exit 6
}
"$SCRIPT_DIR/backup-rescue-production.sh" post-rollback
printf 'RESULT=RESCUE_PRODUCTION_ROLLED_BACK_TO_EMPTY project_ref=%s tables=0 middleware_roles=0\n' "$project_ref"
