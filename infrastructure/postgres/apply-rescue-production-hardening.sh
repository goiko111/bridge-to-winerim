#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/postgres-client-tools.sh"
DATABASE_URL=${RESCUE_PRODUCTION_DATABASE_URL:-}
RUNTIME_DATABASE_URL=${RESCUE_PRODUCTION_RUNTIME_DATABASE_URL:-}
ARTIFACT_DIR=${RESCUE_PRODUCTION_HARDENING_BACKUP_ARTIFACT_DIR:-}
HYDRATION_CONNECTION_ID=${RESCUE_PRODUCTION_HYDRATION_CONNECTION_ID:-}
HYDRATION_PLAN_FILE=${RESCUE_PRODUCTION_HYDRATION_PLAN_FILE:-}
EXPECTED_HYDRATION_WINERIM_WINES=${RESCUE_PRODUCTION_EXPECTED_HYDRATION_WINERIM_WINES:-}
EXPECTED_HYDRATION_PROVIDER_PRODUCTS=${RESCUE_PRODUCTION_EXPECTED_HYDRATION_PROVIDER_PRODUCTS:-}
EXPECTED_HYDRATION_PRODUCT_MAPPINGS=${RESCUE_PRODUCTION_EXPECTED_HYDRATION_PRODUCT_MAPPINGS:-}
EXPECTED_HYDRATION_MASTER_ROWS=${RESCUE_PRODUCTION_EXPECTED_HYDRATION_MASTER_ROWS:-}
EXPECTED_LOGIN_ROLES=${RESCUE_PRODUCTION_EXPECTED_LOGIN_ROLES:-3}
MIGRATION="$SCRIPT_DIR/0012_runtime_sales_claim_identity_immutability.sql"
APPLY=0
CONFIRM_PROJECT_REF=''
CONFIRM_PLAN_SHA=''
CONFIRM_BACKUP_MANIFEST_SHA=''
CONFIRM_ACTION=''

while [ "$#" -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --confirm-project-ref) CONFIRM_PROJECT_REF=${2:-}; shift 2 ;;
    --confirm-plan-sha) CONFIRM_PLAN_SHA=${2:-}; shift 2 ;;
    --confirm-backup-manifest-sha) CONFIRM_BACKUP_MANIFEST_SHA=${2:-}; shift 2 ;;
    --confirm-action) CONFIRM_ACTION=${2:-}; shift 2 ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done

for required in "$DATABASE_URL" "$RUNTIME_DATABASE_URL" "$ARTIFACT_DIR" "$HYDRATION_CONNECTION_ID" "$HYDRATION_PLAN_FILE"; do
  test -n "$required" || { printf 'RESCUE_PRODUCTION_HARDENING_INPUT_REQUIRED\n' >&2; exit 2; }
done
for command_name in node; do
  command -v "$command_name" >/dev/null 2>&1 || { printf 'BLOCKED_MISSING_COMMAND=%s\n' "$command_name" >&2; exit 2; }
done
if command -v sha256sum >/dev/null 2>&1; then SHA256=(sha256sum); else SHA256=(shasum -a 256); fi
case "$ARTIFACT_DIR" in /*) ;; *) printf 'ABSOLUTE_HARDENING_BACKUP_ARTIFACT_REQUIRED\n' >&2; exit 2 ;; esac
case "$HYDRATION_PLAN_FILE" in /*) ;; *) printf 'ABSOLUTE_HYDRATION_PLAN_FILE_REQUIRED\n' >&2; exit 2 ;; esac
test -d "$ARTIFACT_DIR" && test ! -L "$ARTIFACT_DIR" || { printf 'HARDENING_BACKUP_ARTIFACT_REJECTED\n' >&2; exit 3; }
test -f "$HYDRATION_PLAN_FILE" && test ! -L "$HYDRATION_PLAN_FILE" || { printf 'HYDRATION_PLAN_FILE_REJECTED\n' >&2; exit 3; }
[[ "$HYDRATION_CONNECTION_ID" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$ ]] || {
  printf 'HYDRATION_CONNECTION_ID_REJECTED\n' >&2
  exit 2
}
for hydration_count in \
  "$EXPECTED_HYDRATION_WINERIM_WINES" \
  "$EXPECTED_HYDRATION_PROVIDER_PRODUCTS" \
  "$EXPECTED_HYDRATION_PRODUCT_MAPPINGS" \
  "$EXPECTED_HYDRATION_MASTER_ROWS"; do
  case "$hydration_count" in ''|*[!0-9]*) printf 'HYDRATION_COUNTS_REJECTED\n' >&2; exit 2 ;; esac
  [ "$hydration_count" -gt 0 ] || { printf 'HYDRATION_COUNTS_REJECTED\n' >&2; exit 2; }
done
test "$EXPECTED_HYDRATION_MASTER_ROWS" = 1 || { printf 'HYDRATION_MASTER_COUNT_REJECTED\n' >&2; exit 2; }

target_json=$(node "$SCRIPT_DIR/rescue-production-target.mjs")
project_ref=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).projectRef)' "$target_json")
expected_database=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).database)' "$target_json")
target_mode=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).mode)' "$target_json")
RESCUE_PRODUCTION_DATABASE_URL="$RUNTIME_DATABASE_URL" node "$SCRIPT_DIR/rescue-production-target.mjs" >/dev/null
configure_postgres_tools "$DATABASE_URL"
test "$EXPECTED_LOGIN_ROLES" = 3 || { printf 'HARDENING_EXPECTED_LOGIN_ROLES_REJECTED\n' >&2; exit 3; }

manifest="$ARTIFACT_DIR/manifest.txt"
manifest_digest="$ARTIFACT_DIR/manifest.txt.sha256"
artifact_plan="$ARTIFACT_DIR/hydration-plan.json"
artifact_dump="$ARTIFACT_DIR/public.dump"
artifact_toc="$ARTIFACT_DIR/public.toc"
artifact_roles="$ARTIFACT_DIR/roles.tsv"
artifact_memberships="$ARTIFACT_DIR/memberships.tsv"
artifact_inventory="$ARTIFACT_DIR/public-tables.tsv"
artifact_prerequisites="$ARTIFACT_DIR/restore-prerequisites.sql"
for required_file in \
  "$manifest" "$manifest_digest" "$artifact_plan" "$artifact_dump" \
  "$artifact_toc" "$artifact_roles" "$artifact_memberships" \
  "$artifact_inventory" "$artifact_prerequisites"; do
  test -f "$required_file" && test ! -L "$required_file" || { printf 'HARDENING_BACKUP_ARTIFACT_INCOMPLETE\n' >&2; exit 3; }
done
file_mode() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }
test "$(file_mode "$ARTIFACT_DIR")" = 700 || { printf 'HARDENING_BACKUP_DIRECTORY_MODE_REJECTED\n' >&2; exit 3; }
for artifact_file in \
  "$manifest" "$manifest_digest" "$artifact_plan" "$artifact_dump" \
  "$artifact_toc" "$artifact_roles" "$artifact_memberships" \
  "$artifact_inventory" "$artifact_prerequisites"; do
  test "$(file_mode "$artifact_file")" = 600 || { printf 'HARDENING_BACKUP_FILE_MODE_REJECTED\n' >&2; exit 3; }
done
(cd "$ARTIFACT_DIR" && "${SHA256[@]}" -c "$(basename "$manifest_digest")" >/dev/null) || {
  printf 'HARDENING_BACKUP_MANIFEST_DIGEST_REJECTED\n' >&2
  exit 3
}
manifest_value() { awk -F= -v key="$1" '$1 == key {print substr($0, index($0, "=") + 1)}' "$manifest"; }
verify_artifact_digest() {
  local path=$1
  local manifest_key=$2
  local expected
  expected=$(manifest_value "$manifest_key")
  [[ "$expected" =~ ^[0-9a-f]{64}$ ]] || { printf 'HARDENING_BACKUP_DIGEST_MISSING key=%s\n' "$manifest_key" >&2; exit 3; }
  test "$("${SHA256[@]}" "$path" | awk '{print $1}')" = "$expected" || {
    printf 'HARDENING_BACKUP_DIGEST_REJECTED key=%s\n' "$manifest_key" >&2
    exit 3
  }
}
verify_artifact_digest "$artifact_dump" dump_sha256
verify_artifact_digest "$artifact_toc" toc_sha256
verify_artifact_digest "$artifact_roles" roles_sha256
verify_artifact_digest "$artifact_memberships" memberships_sha256
verify_artifact_digest "$artifact_inventory" inventory_sha256
verify_artifact_digest "$artifact_prerequisites" restore_prerequisites_sha256
verify_artifact_digest "$artifact_plan" hydration_plan_sha256
test "$(manifest_value schema_version)" = 5 || { printf 'HARDENING_BACKUP_SCHEMA_REJECTED\n' >&2; exit 3; }
test "$(manifest_value phase)" = post-hydration || { printf 'HARDENING_BACKUP_PHASE_REJECTED\n' >&2; exit 3; }
test "$(manifest_value project_ref)" = "$project_ref" || { printf 'HARDENING_BACKUP_PROJECT_REJECTED\n' >&2; exit 3; }
test "$(manifest_value observed_environment)" = rescue-production || { printf 'HARDENING_BACKUP_ENVIRONMENT_REJECTED\n' >&2; exit 3; }
expected_backup_storage=encrypted-disk-image
if [ "$target_mode" = local-disposable ]; then expected_backup_storage=local-disposable; fi
test "$(manifest_value backup_storage)" = "$expected_backup_storage" || { printf 'HARDENING_BACKUP_STORAGE_REJECTED\n' >&2; exit 3; }
test "$(manifest_value hydration_connection_id)" = "$HYDRATION_CONNECTION_ID" || { printf 'HARDENING_BACKUP_CONNECTION_REJECTED\n' >&2; exit 3; }
test "$(manifest_value hydration_winerim_wines)" = "$EXPECTED_HYDRATION_WINERIM_WINES" || { printf 'HARDENING_BACKUP_COUNTS_REJECTED\n' >&2; exit 3; }
test "$(manifest_value hydration_provider_products)" = "$EXPECTED_HYDRATION_PROVIDER_PRODUCTS" || { printf 'HARDENING_BACKUP_COUNTS_REJECTED\n' >&2; exit 3; }
test "$(manifest_value hydration_product_mappings)" = "$EXPECTED_HYDRATION_PRODUCT_MAPPINGS" || { printf 'HARDENING_BACKUP_COUNTS_REJECTED\n' >&2; exit 3; }
test "$(manifest_value hydration_master_rows)" = "$EXPECTED_HYDRATION_MASTER_ROWS" || { printf 'HARDENING_BACKUP_COUNTS_REJECTED\n' >&2; exit 3; }
test "$("${SHA256[@]}" "$artifact_plan" | awk '{print $1}')" = "$(manifest_value hydration_plan_sha256)" || {
  printf 'HARDENING_BACKUP_PLAN_DIGEST_REJECTED\n' >&2
  exit 3
}
test "$("${SHA256[@]}" "$HYDRATION_PLAN_FILE" | awk '{print $1}')" = "$(manifest_value hydration_plan_sha256)" || {
  printf 'HARDENING_SOURCE_PLAN_DIGEST_REJECTED\n' >&2
  exit 3
}
hydration_digest=$(manifest_value hydration_digest)
[[ "$hydration_digest" =~ ^[0-9a-f]{64}$ ]] || { printf 'HARDENING_HYDRATION_DIGEST_REJECTED\n' >&2; exit 3; }
backup_manifest_sha=$(awk '{print $1}' "$manifest_digest")
[[ "$backup_manifest_sha" =~ ^[0-9a-f]{64}$ ]] || { printf 'HARDENING_BACKUP_MANIFEST_SHA_REJECTED\n' >&2; exit 3; }

READ_ONLY_OPTIONS="${PGOPTIONS:+$PGOPTIONS }-c default_transaction_read_only=on -c statement_timeout=30000 -c lock_timeout=2000"
query() {
  PGOPTIONS="$READ_ONLY_OPTIONS" "$PSQL_CMD" "$DATABASE_URL" -XAtq -v ON_ERROR_STOP=1 -c "$1"
}
test "$(query 'SELECT current_database()')" = "$expected_database" || { printf 'CONNECTED_DATABASE_IDENTITY_MISMATCH\n' >&2; exit 3; }
test "$(query "SELECT count(*) FROM public.infrastructure_metadata WHERE key='environment' AND value='rescue-production'")" = 1 || { printf 'HARDENING_ENVIRONMENT_REJECTED\n' >&2; exit 3; }
test "$(query 'SELECT count(*) FROM public.pos_connections')" = 31 || { printf 'HARDENING_CONNECTION_COUNT_REJECTED\n' >&2; exit 3; }
test "$(query "SELECT count(*) FROM public.pos_connections WHERE enabled OR catalog_sync_enabled OR sync_mode<>'PULL_ONLY' OR write_mode<>'NONE' OR backfill_days<>0 OR last_sync_at IS NOT NULL OR last_catalog_sync_at IS NOT NULL OR last_business_day_synced IS NOT NULL OR circuit_breaker_paused_until IS NOT NULL OR consecutive_failures<>0 OR base_url<>'https://redacted.invalid' OR api_token<>'' OR winerim_api_token IS NOT NULL")" = 0 || { printf 'HARDENING_CONNECTIONS_NOT_INERT\n' >&2; exit 3; }
candidate="'$HYDRATION_CONNECTION_ID'::uuid"
expected_counts="$EXPECTED_HYDRATION_WINERIM_WINES|$EXPECTED_HYDRATION_PROVIDER_PRODUCTS|$EXPECTED_HYDRATION_PRODUCT_MAPPINGS|$EXPECTED_HYDRATION_MASTER_ROWS"
actual_counts=$(query "SELECT (SELECT count(*) FROM public.winerim_wines WHERE connection_id=$candidate) || '|' || (SELECT count(*) FROM public.provider_products WHERE connection_id=$candidate) || '|' || (SELECT count(*) FROM public.product_mappings WHERE connection_id=$candidate) || '|' || (SELECT count(*) FROM public.agora_master_data WHERE connection_id=$candidate)")
test "$actual_counts" = "$expected_counts" || { printf 'HARDENING_HYDRATION_COUNTS_REJECTED expected=%s actual=%s\n' "$expected_counts" "$actual_counts" >&2; exit 3; }
test "$(query "SELECT coalesce(sum((xpath('/row/count/text()', query_to_xml(format('SELECT count(*) AS count FROM public.%I', c.relname), false, true, '')))[1]::text::bigint),0) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relname NOT IN ('infrastructure_metadata','pos_connections','winerim_wines','provider_products','product_mappings','agora_master_data')")" = 0 || { printf 'HARDENING_OPERATIONAL_ROWS_REJECTED\n' >&2; exit 3; }
test "$(hydration_database_fingerprint "$DATABASE_URL" "$HYDRATION_CONNECTION_ID")" = "$hydration_digest" || { printf 'HARDENING_DATABASE_DIGEST_REJECTED\n' >&2; exit 3; }

old_contract=$(query "SELECT count(*) FROM pg_trigger trigger_contract JOIN pg_class table_class ON table_class.oid=trigger_contract.tgrelid JOIN pg_proc trigger_function ON trigger_function.oid=trigger_contract.tgfoid WHERE table_class.oid='public.runtime_idempotency'::regclass AND trigger_contract.tgname='runtime_bind_sales_claim_identity' AND NOT trigger_contract.tgisinternal AND position('NEW.sales_claim_identity IS DISTINCT FROM OLD.sales_claim_identity' IN trigger_function.prosrc)=0 AND (SELECT count(*) FROM unnest(trigger_contract.tgattr))=3")
new_contract=$(query "SELECT count(*) FROM pg_trigger trigger_contract JOIN pg_class table_class ON table_class.oid=trigger_contract.tgrelid JOIN pg_proc trigger_function ON trigger_function.oid=trigger_contract.tgfoid WHERE table_class.oid='public.runtime_idempotency'::regclass AND trigger_contract.tgname='runtime_bind_sales_claim_identity' AND NOT trigger_contract.tgisinternal AND position('NEW.sales_claim_identity IS DISTINCT FROM OLD.sales_claim_identity' IN trigger_function.prosrc)>0 AND (SELECT count(*) FROM unnest(trigger_contract.tgattr))=4 AND NOT has_table_privilege('middleware_runtime','public.runtime_idempotency','UPDATE') AND NOT has_column_privilege('middleware_runtime','public.runtime_idempotency','sales_claim_identity','UPDATE')")
test "$old_contract|$new_contract" = '1|0' || test "$old_contract|$new_contract" = '0|1' || {
  printf 'HARDENING_IDEMPOTENCY_PRESTATE_REJECTED old=%s new=%s\n' "$old_contract" "$new_contract" >&2
  exit 3
}

migration_sha=$("${SHA256[@]}" "$MIGRATION" | awk '{print $1}')
plan_sha=$(
  {
    printf 'schema=1\nproject_ref=%s\nenvironment=rescue-production\nconnection_id=%s\nhydration_digest=%s\nbackup_manifest_sha256=%s\nmigration_sha256=%s\nprestate=%s|%s\n' \
      "$project_ref" "$HYDRATION_CONNECTION_ID" "$hydration_digest" "$backup_manifest_sha" "$migration_sha" "$old_contract" "$new_contract"
    cat \
      "$0" \
      "$SCRIPT_DIR/rescue-production-target.mjs" \
      "$SCRIPT_DIR/postgres-client-tools.sh" \
      "$SCRIPT_DIR/verify-rescue-production.sh" \
      "$SCRIPT_DIR/backup-rescue-production.sh" \
      "$MIGRATION" \
      "$manifest" \
      "$manifest_digest"
  } | "${SHA256[@]}" | awk '{print $1}'
)
printf 'RESCUE_PRODUCTION_HARDENING_PLAN_OK project_ref=%s connection_id=%s counts=%s backup_manifest_sha256=%s migration_sha256=%s plan_sha256=%s\n' \
  "$project_ref" "$HYDRATION_CONNECTION_ID" "$actual_counts" "$backup_manifest_sha" "$migration_sha" "$plan_sha"
if [ "$APPLY" -ne 1 ]; then printf 'RESULT=PLAN_ONLY\n'; exit 0; fi

test "$CONFIRM_PROJECT_REF" = "$project_ref" || { printf 'CONFIRM_PROJECT_REF_REJECTED\n' >&2; exit 4; }
test "$CONFIRM_PLAN_SHA" = "$plan_sha" || { printf 'CONFIRM_PLAN_SHA_REJECTED\n' >&2; exit 4; }
test "$CONFIRM_BACKUP_MANIFEST_SHA" = "$backup_manifest_sha" || { printf 'CONFIRM_BACKUP_MANIFEST_SHA_REJECTED\n' >&2; exit 4; }
test "$CONFIRM_ACTION" = APPLY_RESCUE_PRODUCTION_IDEMPOTENCY_0012 || { printf 'CONFIRM_ACTION_REJECTED\n' >&2; exit 4; }

if [ "$new_contract" = 0 ]; then
  PGOPTIONS="${PGOPTIONS:+$PGOPTIONS }-c statement_timeout=30000 -c lock_timeout=2000" \
    "$PSQL_CMD" "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$MIGRATION" >/dev/null
fi

verification_env=(
  RESCUE_PRODUCTION_DATABASE_URL="$DATABASE_URL"
  RESCUE_PRODUCTION_RUNTIME_DATABASE_URL="$RUNTIME_DATABASE_URL"
  RESCUE_PRODUCTION_EXPECTED_LOGIN_ROLES="$EXPECTED_LOGIN_ROLES"
  RESCUE_PRODUCTION_HYDRATION_CONNECTION_ID="$HYDRATION_CONNECTION_ID"
  RESCUE_PRODUCTION_HYDRATION_PLAN_FILE="$HYDRATION_PLAN_FILE"
  RESCUE_PRODUCTION_EXPECTED_HYDRATION_WINERIM_WINES="$EXPECTED_HYDRATION_WINERIM_WINES"
  RESCUE_PRODUCTION_EXPECTED_HYDRATION_PROVIDER_PRODUCTS="$EXPECTED_HYDRATION_PROVIDER_PRODUCTS"
  RESCUE_PRODUCTION_EXPECTED_HYDRATION_PRODUCT_MAPPINGS="$EXPECTED_HYDRATION_PRODUCT_MAPPINGS"
  RESCUE_PRODUCTION_EXPECTED_HYDRATION_MASTER_ROWS="$EXPECTED_HYDRATION_MASTER_ROWS"
)
env "${verification_env[@]}" "$SCRIPT_DIR/verify-rescue-production.sh" >/dev/null
post_backup_output=$(env "${verification_env[@]}" "$SCRIPT_DIR/backup-rescue-production.sh" pre-canary)
printf '%s\n' "$post_backup_output"
printf 'RESULT=RESCUE_PRODUCTION_HARDENING_APPLIED project_ref=%s connection_id=%s migration=0012 hydration_unchanged=%s\n' \
  "$project_ref" "$HYDRATION_CONNECTION_ID" "$hydration_digest"
