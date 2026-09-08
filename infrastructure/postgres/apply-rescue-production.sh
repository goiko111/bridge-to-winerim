#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/postgres-client-tools.sh"
DATABASE_URL=${RESCUE_PRODUCTION_DATABASE_URL:-}
SEED_SQL=${RESCUE_PRODUCTION_SEED_SQL:-}
APPLY=0
CONFIRM_PROJECT_REF=''
CONFIRM_ENVIRONMENT=''
CONFIRM_PLAN_SHA=''
CONFIRM_SEED_SHA=''
CONFIRM_ACTION=''

while [ "$#" -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --confirm-project-ref) CONFIRM_PROJECT_REF=${2:-}; shift 2 ;;
    --confirm-environment) CONFIRM_ENVIRONMENT=${2:-}; shift 2 ;;
    --confirm-plan-sha) CONFIRM_PLAN_SHA=${2:-}; shift 2 ;;
    --confirm-seed-sha) CONFIRM_SEED_SHA=${2:-}; shift 2 ;;
    --confirm-action) CONFIRM_ACTION=${2:-}; shift 2 ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done

for command_name in node; do
  command -v "$command_name" >/dev/null 2>&1 || { printf 'BLOCKED_MISSING_COMMAND=%s\n' "$command_name" >&2; exit 2; }
done
if command -v sha256sum >/dev/null 2>&1; then
  SHA256=(sha256sum)
else
  SHA256=(shasum -a 256)
fi
test -n "$DATABASE_URL" || { printf 'RESCUE_PRODUCTION_DATABASE_URL_REQUIRED\n' >&2; exit 2; }
test -n "$SEED_SQL" && test -f "$SEED_SQL" || { printf 'RESCUE_PRODUCTION_SEED_SQL_REQUIRED\n' >&2; exit 2; }
case "$SEED_SQL" in /*) ;; *) printf 'ABSOLUTE_RESCUE_PRODUCTION_SEED_SQL_REQUIRED\n' >&2; exit 2 ;; esac

target_json=$(node "$SCRIPT_DIR/rescue-production-target.mjs")
project_ref=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).projectRef)' "$target_json")
expected_database=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).database)' "$target_json")
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/winerim-rescue-production-apply.XXXXXX")
trap 'rm -rf "$TMP_ROOT"' EXIT INT TERM

query() {
  PGOPTIONS="${PGOPTIONS:+$PGOPTIONS }-c default_transaction_read_only=on -c statement_timeout=15000 -c lock_timeout=1000" \
    "$PSQL_CMD" "$DATABASE_URL" -XAtq -v ON_ERROR_STOP=1 -c "$1"
}

test "$(query 'SELECT current_database()')" = "$expected_database" || { printf 'CONNECTED_DATABASE_IDENTITY_MISMATCH\n' >&2; exit 3; }
metadata_exists=$(query "SELECT (to_regclass('public.infrastructure_metadata') IS NOT NULL)::int")
public_tables=$(query "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'")
middleware_roles=$(query "SELECT count(*) FROM pg_roles WHERE rolname LIKE 'middleware_%'")

if [ "$metadata_exists" = 1 ]; then
  sentinel=$(query "SELECT coalesce((SELECT value FROM public.infrastructure_metadata WHERE key='environment'), 'missing-row')")
  if [ "$sentinel" = rescue-production ] && [ "$public_tables" = 30 ]; then
    printf 'RESCUE_PRODUCTION_ALREADY_BOOTSTRAPPED_VERIFY_ONLY project_ref=%s\n' "$project_ref"
    "$SCRIPT_DIR/verify-rescue-production.sh"
    exit 0
  fi
  printf 'RESCUE_PRODUCTION_PRESTATE_REJECTED metadata=%s tables=%s\n' "$sentinel" "$public_tables" >&2
  exit 3
fi
test "$public_tables" = 0 || { printf 'RESCUE_PRODUCTION_NONEMPTY_TARGET_REJECTED tables=%s\n' "$public_tables" >&2; exit 3; }
test "$middleware_roles" = 0 || { printf 'RESCUE_PRODUCTION_UNKNOWN_ROLE_PRESTATE_REJECTED roles=%s\n' "$middleware_roles" >&2; exit 3; }

bootstrap="$TMP_ROOT/bootstrap.sql"
"$SCRIPT_DIR/build-bootstrap.sh" "$bootstrap" >/dev/null
seed_sha=$("${SHA256[@]}" "$SEED_SQL" | awk '{print $1}')
plan_sha=$(cat "$bootstrap" "$SEED_SQL" "$SCRIPT_DIR/rescue-production-target.mjs" "$SCRIPT_DIR/verify-encrypted-backup-root.mjs" "$SCRIPT_DIR/backup-rescue-production.sh" "$SCRIPT_DIR/verify-rescue-production.sh" "$SCRIPT_DIR/apply-rescue-production.sh" "$SCRIPT_DIR/rollback-rescue-production.sh" | "${SHA256[@]}" | awk '{print $1}')
printf 'RESCUE_PRODUCTION_PLAN_OK project_ref=%s environment=rescue-production pre_tables=0 post_tables=30 connections=31 plan_sha256=%s seed_sha256=%s\n' "$project_ref" "$plan_sha" "$seed_sha"

if [ "$APPLY" -ne 1 ]; then
  printf 'RESULT=PLAN_ONLY\n'
  exit 0
fi

test "$CONFIRM_PROJECT_REF" = "$project_ref" || { printf 'CONFIRM_PROJECT_REF_REJECTED\n' >&2; exit 4; }
test "$CONFIRM_ENVIRONMENT" = rescue-production || { printf 'CONFIRM_ENVIRONMENT_REJECTED\n' >&2; exit 4; }
test "$CONFIRM_PLAN_SHA" = "$plan_sha" || { printf 'CONFIRM_PLAN_SHA_REJECTED\n' >&2; exit 4; }
test "$CONFIRM_SEED_SHA" = "$seed_sha" || { printf 'CONFIRM_SEED_SHA_REJECTED\n' >&2; exit 4; }
test "$CONFIRM_ACTION" = APPLY_EMPTY_RESCUE_PRODUCTION_BOOTSTRAP || { printf 'CONFIRM_ACTION_REJECTED\n' >&2; exit 4; }

pre_backup_output=$("$SCRIPT_DIR/backup-rescue-production.sh" pre-bootstrap)
printf '%s\n' "$pre_backup_output"

if ! "$PSQL_CMD" "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -v environment=rescue-production -f "$bootstrap" >/dev/null; then
  printf 'RESULT=RESCUE_PRODUCTION_BOOTSTRAP_FAILED_ROLLBACK_REQUIRED runbook=%s\n' "$SCRIPT_DIR/rescue-production-runbook.md" >&2
  exit 5
fi
pre_seed_non_connection_rows=$(query "SELECT coalesce(sum((xpath('/row/count/text()', query_to_xml(format('SELECT count(*) AS count FROM public.%I', c.relname), false, true, '')))[1]::text::bigint), 0) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relname NOT IN ('infrastructure_metadata','pos_connections')")
test "$pre_seed_non_connection_rows" = 0 || {
  printf 'RESCUE_PRODUCTION_BOOTSTRAP_UNEXPECTED_DATA_REJECTED rows=%s\n' "$pre_seed_non_connection_rows" >&2
  exit 5
}
if ! "$PSQL_CMD" "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$SEED_SQL" >/dev/null; then
  printf 'RESULT=RESCUE_PRODUCTION_SEED_FAILED_ROLLBACK_REQUIRED runbook=%s\n' "$SCRIPT_DIR/rescue-production-runbook.md" >&2
  exit 5
fi
post_seed_non_connection_rows=$(query "SELECT coalesce(sum((xpath('/row/count/text()', query_to_xml(format('SELECT count(*) AS count FROM public.%I', c.relname), false, true, '')))[1]::text::bigint), 0) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relname NOT IN ('infrastructure_metadata','pos_connections')")
test "$post_seed_non_connection_rows" = 0 || {
  printf 'RESCUE_PRODUCTION_SEED_TOUCHED_NON_CONNECTION_DATA rows=%s\n' "$post_seed_non_connection_rows" >&2
  exit 5
}
if ! "$SCRIPT_DIR/verify-rescue-production.sh"; then
  printf 'RESULT=RESCUE_PRODUCTION_POSTVERIFY_FAILED_ROLLBACK_REQUIRED runbook=%s\n' "$SCRIPT_DIR/rescue-production-runbook.md" >&2
  exit 6
fi
post_backup_output=$("$SCRIPT_DIR/backup-rescue-production.sh" post-bootstrap)
printf '%s\n' "$post_backup_output"
printf 'RESULT=RESCUE_PRODUCTION_BOOTSTRAP_APPLIED project_ref=%s environment=rescue-production tables=30 connections=31 unsafe=0 rollback=%s\n' "$project_ref" "$SCRIPT_DIR/rollback-rescue-production.sh"
