#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
MIGRATIONS_DIR="$REPO_ROOT/supabase/migrations"
MANIFEST="$SCRIPT_DIR/migration-manifest.tsv"
EXPECTED="$SCRIPT_DIR/expected-schema.txt"
READONLY_SQL="$SCRIPT_DIR/validate-readonly.sql"
STAGING_VERIFIER="$SCRIPT_DIR/verify-staging.sh"
PORTABLE_ADDENDUM="$SCRIPT_DIR/0002_release_schema_addendum.sql"
RUNTIME_CREDENTIALS_ADDENDUM="$SCRIPT_DIR/0003_runtime_connection_credentials.sql"
RUNTIME_CANARY_PRIVILEGES="$SCRIPT_DIR/0004_runtime_canary_least_privilege.sql"
RUNTIME_CANARY_SCOPE="$SCRIPT_DIR/0005_runtime_canary_connection_scope.sql"
RUNTIME_CATALOG_PERMISSIONS="$SCRIPT_DIR/0009_runtime_catalog_permissions.sql"
RUNTIME_IDEMPOTENCY_LEASE_BINDING="$SCRIPT_DIR/0010_runtime_idempotency_lease_binding.sql"
RUNTIME_SALES_CLAIM_IDENTITY="$SCRIPT_DIR/0011_runtime_sales_claim_identity.sql"
RUNTIME_SALES_CLAIM_IDENTITY_IMMUTABILITY="$SCRIPT_DIR/0012_runtime_sales_claim_identity_immutability.sql"
RUNTIME_CANARY_CONTROL_PLANE_HISTORY="$SCRIPT_DIR/0013_runtime_canary_control_plane_history.sql"
RUNTIME_CATALOG_SOURCE_SCOPE="$SCRIPT_DIR/0014_runtime_catalog_source_scope.sql"
RUNTIME_FLEET_CONNECTION_SCOPE="$SCRIPT_DIR/0015_runtime_fleet_connection_scope.sql"
RUNTIME_FULL_CATALOG_OUTBOUND="$SCRIPT_DIR/0016_runtime_full_catalog_outbound.sql"
RESCUE_PRODUCTION_HARDENING_APPLIER="$SCRIPT_DIR/apply-rescue-production-hardening.sh"
RELEASE_ADDENDUM="$SCRIPT_DIR/release-migration-manifest-addendum.tsv"
EXPECTED_RELEASE_ADDENDUM="$SCRIPT_DIR/expected-schema-release-addendum.txt"
RELEASE_VALIDATOR="$SCRIPT_DIR/validate-release-addendum.sh"

failures=0

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  failures=$((failures + 1))
}

ok() {
  printf 'OK: %s\n' "$*"
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

for required_file in \
  "$MANIFEST" \
  "$EXPECTED" \
  "$READONLY_SQL" \
  "$STAGING_VERIFIER" \
  "$PORTABLE_ADDENDUM" \
  "$RUNTIME_CREDENTIALS_ADDENDUM" \
  "$RUNTIME_CANARY_PRIVILEGES" \
  "$RUNTIME_CANARY_SCOPE" \
  "$RUNTIME_CATALOG_PERMISSIONS" \
  "$RUNTIME_IDEMPOTENCY_LEASE_BINDING" \
  "$RUNTIME_SALES_CLAIM_IDENTITY" \
  "$RUNTIME_SALES_CLAIM_IDENTITY_IMMUTABILITY" \
  "$RUNTIME_CANARY_CONTROL_PLANE_HISTORY" \
  "$RUNTIME_CATALOG_SOURCE_SCOPE" \
  "$RUNTIME_FLEET_CONNECTION_SCOPE" \
  "$RUNTIME_FULL_CATALOG_OUTBOUND" \
  "$RESCUE_PRODUCTION_HARDENING_APPLIER" \
  "$RELEASE_ADDENDUM" \
  "$EXPECTED_RELEASE_ADDENDUM" \
  "$RELEASE_VALIDATOR"
do
  if [ ! -f "$required_file" ]; then
    fail "missing artifact $required_file"
  fi
done

for required_pattern in \
  'CREATE TABLE public.runtime_catalog_changes' \
  'runtime_full_catalog_scope' \
  'middleware_runtime_full_catalog_changes' \
  'RUNTIME_CATALOG_SOURCE_INSERT_SCOPE_REJECTED' \
  'GRANT INSERT ('
do
  if ! rg -F "$required_pattern" "$RUNTIME_FULL_CATALOG_OUTBOUND" >/dev/null; then
    fail "runtime full catalog/outbound addendum is missing: $required_pattern"
  fi
done

for required_pattern in \
  'runtime_canary_connections_one_active_per_connection_idx' \
  'RUNTIME_FLEET_SCOPE_PREFLIGHT_INCOMPLETE_CREDENTIALS' \
  'RUNTIME_FLEET_SCOPE_CREDENTIALS_INVALID' \
  'CREATE CONSTRAINT TRIGGER validate_runtime_fleet_scope_transition' \
  'CREATE CONSTRAINT TRIGGER validate_runtime_fleet_credential_transition' \
  'DEFERRABLE INITIALLY DEFERRED'
do
  if ! rg -F "$required_pattern" "$RUNTIME_FLEET_CONNECTION_SCOPE" >/dev/null; then
    fail "runtime fleet connection scope addendum is missing: $required_pattern"
  fi
done

for required_pattern in \
  'CREATE TABLE public.runtime_catalog_source_scope' \
  'PRIMARY KEY (connection_id, run_id)' \
  'RUNTIME_CATALOG_SOURCE_SCOPE_REQUIRES_PREPARED_RUN' \
  'RUNTIME_CATALOG_SOURCE_FORMAT_SCOPE_REJECTED' \
  'GRANT UPDATE (' \
  'middleware_runtime_catalog_source_update'
do
  if ! rg -F "$required_pattern" "$RUNTIME_CATALOG_SOURCE_SCOPE" >/dev/null; then
    fail "runtime catalog source scope addendum is missing: $required_pattern"
  fi
done

for required_pattern in \
  'PRIMARY KEY (connection_id, credential_kind, run_id)' \
  'CREATE UNIQUE INDEX idx_runtime_connection_credentials_active' \
  'PRIMARY KEY (connection_id, run_id)' \
  'generation_mode IN (' \
  'scope.run_id = runtime_connection_credentials.run_id' \
  'RUNTIME_CANARY_SCOPE_TERMINAL' \
  'RUNTIME_CREDENTIAL_REACTIVATION_REJECTED'
do
  if ! rg -F "$required_pattern" "$RUNTIME_CANARY_CONTROL_PLANE_HISTORY" >/dev/null; then
    fail "runtime canary control-plane history addendum is missing: $required_pattern"
  fi
done

for required_pattern in \
  'APPLY_RESCUE_PRODUCTION_IDEMPOTENCY_0012' \
  'RESCUE_PRODUCTION_HARDENING_BACKUP_ARTIFACT_DIR' \
  'HARDENING_DATABASE_DIGEST_REJECTED' \
  'verify-rescue-production.sh' \
  'backup-rescue-production.sh" pre-canary'
do
  if ! rg -F "$required_pattern" "$RESCUE_PRODUCTION_HARDENING_APPLIER" >/dev/null; then
    fail "rescue production hardening applier is missing: $required_pattern"
  fi
done

for required_pattern in \
  'UPDATE OF connection_id, job, result, sales_claim_identity' \
  'NEW.sales_claim_identity IS DISTINCT FROM OLD.sales_claim_identity' \
  'REVOKE UPDATE ON public.runtime_idempotency FROM middleware_runtime' \
  'GRANT UPDATE (' \
  'uq_runtime_sales_claim_identity' \
  'runtime_idempotency_sales_claim_identity_scope'
do
  if ! rg -F "$required_pattern" "$RUNTIME_SALES_CLAIM_IDENTITY_IMMUTABILITY" >/dev/null; then
    fail "runtime sales claim immutability addendum is missing: $required_pattern"
  fi
done

for required_pattern in \
  'ADD COLUMN IF NOT EXISTS sales_claim_identity text' \
  'RUNTIME_SALES_CLAIM_DUPLICATE_RECONCILIATION_REQUIRED' \
  'CREATE UNIQUE INDEX IF NOT EXISTS uq_runtime_sales_claim_identity' \
  'CREATE TRIGGER runtime_bind_sales_claim_identity'
do
  if ! rg -F "$required_pattern" "$RUNTIME_SALES_CLAIM_IDENTITY" >/dev/null; then
    fail "runtime sales claim identity addendum is missing: $required_pattern"
  fi
done

for required_pattern in \
  'ADD COLUMN IF NOT EXISTS payload_sha256 text' \
  'ADD COLUMN IF NOT EXISTS lease_token uuid' \
  'runtime_idempotency_payload_sha256_format'
do
  if ! rg -F "$required_pattern" "$RUNTIME_IDEMPOTENCY_LEASE_BINDING" >/dev/null; then
    fail "runtime idempotency lease binding addendum is missing: $required_pattern"
  fi
done

for required_pattern in \
  'GRANT SELECT ON' \
  'public.provider_products' \
  'public.agora_master_data' \
  'public.winerim_push_tracking' \
  'middleware_runtime_canary_insert_product_mappings' \
  'middleware_runtime_canary_update_product_mappings' \
  'middleware_runtime_canary_insert_tracking' \
  'middleware_runtime_canary_update_tracking'
do
  if ! rg -F "$required_pattern" "$RUNTIME_CATALOG_PERMISSIONS" >/dev/null; then
    fail "runtime catalog permission addendum is missing: $required_pattern"
  fi
done

for required_pattern in \
  'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM middleware_runtime' \
  'GRANT INSERT, UPDATE ON public.runtime_idempotency TO middleware_runtime' \
  'GRANT INSERT ON public.runtime_execution_log TO middleware_runtime' \
  'DROP POLICY middleware_runtime_all'
do
  if ! rg -F "$required_pattern" "$RUNTIME_CANARY_PRIVILEGES" >/dev/null; then
    fail "runtime canary privilege addendum is missing: $required_pattern"
  fi
done

for required_pattern in \
  'CREATE TABLE IF NOT EXISTS public.runtime_canary_connections' \
  'RUNTIME_CANARY_CONNECTION_REJECTED' \
  'REVOKE ALL ON public.stock_sync_log FROM middleware_runtime'
do
  if [ "$required_pattern" = 'RUNTIME_CANARY_CONNECTION_REJECTED' ]; then
    if ! rg -F "$required_pattern" "$REPO_ROOT/cloudflare/workers/middleware-runtime/src/executor/composition.ts" >/dev/null; then
      fail "runtime canary code gate is missing: $required_pattern"
    fi
  elif ! rg -F "$required_pattern" "$RUNTIME_CANARY_SCOPE" >/dev/null; then
    fail "runtime canary scope addendum is missing: $required_pattern"
  fi
done

for required_pattern in \
  'CREATE TABLE IF NOT EXISTS public.runtime_connection_credentials' \
  "algorithm text NOT NULL DEFAULT 'AES-256-GCM'" \
  'GRANT SELECT ON public.runtime_connection_credentials TO middleware_runtime' \
  'FROM PUBLIC, authenticated, service_role, middleware_api, middleware_readonly, middleware_runtime'
do
  if ! rg -F "$required_pattern" "$RUNTIME_CREDENTIALS_ADDENDUM" >/dev/null; then
    fail "runtime credential addendum is missing: $required_pattern"
  fi
done

if [ ! -d "$MIGRATIONS_DIR" ]; then
  fail "missing migrations directory $MIGRATIONS_DIR"
fi

if [ "$failures" -gt 0 ]; then
  exit 1
fi

manifest_count=$(awk -F '\t' 'NR > 1 && NF { count++ } END { print count + 0 }' "$MANIFEST")
disk_count=$(find "$MIGRATIONS_DIR" -type f -name '*.sql' | wc -l | tr -d ' ')

if [ "$manifest_count" -ne "$disk_count" ]; then
  fail "manifest has $manifest_count migrations but disk has $disk_count"
else
  ok "all $disk_count migration files are classified"
fi

previous_order=0
while IFS=$'\t' read -r order file expected_sha phase action dependency note; do
  if [ "$order" = "order" ] || [ -z "$order" ]; then
    continue
  fi

  case "$action" in
    INCLUDE|INCLUDE_SECURITY_GATE|INCLUDE_WITH_REVIEW|CONDITIONAL_PLATFORM|POST_IMPORT_REVIEW|EXCLUDE_OPERATIONAL|EXCLUDE_CLOUDFLARE_TARGET|MATERIALIZED_PORTABLE|EXCLUDE_NOOP|EXCLUDE_DUPLICATE)
      ;;
    *)
      fail "$file has unknown action $action"
      ;;
  esac

  if [ "$order" -le "$previous_order" ]; then
    fail "$file is out of manifest order"
  fi
  previous_order=$order

  path="$MIGRATIONS_DIR/$file"
  if [ ! -f "$path" ]; then
    fail "manifest entry missing on disk: $file"
    continue
  fi

  actual_sha=$(sha256_file "$path")
  if [ "$actual_sha" != "$expected_sha" ]; then
    fail "$file checksum changed: expected $expected_sha got $actual_sha"
  fi
done < "$MANIFEST"

while IFS= read -r path; do
  file=$(basename "$path")
  if ! awk -F '\t' -v target="$file" 'NR > 1 && $2 == target { found=1 } END { exit found ? 0 : 1 }' "$MANIFEST"; then
    fail "unclassified migration on disk: $file"
  fi
done < <(find "$MIGRATIONS_DIR" -type f -name '*.sql' | sort)

if [ "$failures" -eq 0 ]; then
  ok "manifest order, actions and checksums are stable"
fi

required_tables=$(awk '$1 == "TABLE" { count++ } END { print count + 0 }' "$EXPECTED")
required_functions=$(awk '$1 == "FUNCTION" { count++ } END { print count + 0 }' "$EXPECTED")
required_columns=$(awk '$1 == "COLUMN" { count++ } END { print count + 0 }' "$EXPECTED")
required_indexes=$(awk '$1 == "INDEX" { count++ } END { print count + 0 }' "$EXPECTED")
required_triggers=$(awk '$1 == "TRIGGER" { count++ } END { print count + 0 }' "$EXPECTED")
required_foreign_keys=$(awk '$1 == "FOREIGN_KEY_SET_NULL" { count++ } END { print count + 0 }' "$EXPECTED")
ok "expected contract declares $required_tables tables, $required_functions functions, $required_columns columns, $required_indexes indexes, $required_triggers triggers and $required_foreign_keys SET NULL foreign keys"

if rg -n -i 'pg_net|net\.http|invoke_connection_health_monitor|CREATE[[:space:]]+TABLE[[:space:]]+(IF[[:space:]]+NOT[[:space:]]+EXISTS[[:space:]]+)?public\.connection_notification_contacts' "$PORTABLE_ADDENDUM" >/dev/null; then
  fail "portable addendum contains a forbidden platform helper or legacy contacts table"
else
  ok "portable addendum excludes pg_net helpers and the legacy contacts schema"
fi

for required_pattern in \
  'CREATE TABLE IF NOT EXISTS public.connection_health_checks' \
  'CREATE TABLE IF NOT EXISTS public.connection_alerts' \
  'ADD COLUMN IF NOT EXISTS provider_sold_at' \
  'CREATE TABLE IF NOT EXISTS public.agora_dispatch_locks' \
  'TO middleware_runtime' \
  'ON DELETE SET NULL'
do
  if ! rg -F "$required_pattern" "$PORTABLE_ADDENDUM" >/dev/null; then
    fail "portable addendum is missing: $required_pattern"
  fi
done

if "$RELEASE_VALIDATOR" "$REPO_ROOT" >/dev/null; then
  ok "release addendum checksums and classifications are stable"
else
  fail "release addendum validation failed"
fi

permissive_policy_count=$(rg -i -l 'CREATE POLICY.*|USING \(true\)|WITH CHECK \(true\)' "$MIGRATIONS_DIR"/*.sql | wc -l | tr -d ' ')
security_definer_count=$(rg -i -l 'SECURITY DEFINER' "$MIGRATIONS_DIR"/*.sql | wc -l | tr -d ' ')
operational_count=$(awk -F '\t' 'NR > 1 && ($5 == "EXCLUDE_OPERATIONAL" || $5 == "POST_IMPORT_REVIEW") { count++ } END { print count + 0 }' "$MANIFEST")
platform_count=$(awk -F '\t' 'NR > 1 && ($5 == "CONDITIONAL_PLATFORM" || $5 == "EXCLUDE_CLOUDFLARE_TARGET") { count++ } END { print count + 0 }' "$MANIFEST")
materialized_count=$(awk -F '\t' 'NR > 1 && $5 == "MATERIALIZED_PORTABLE" { count++ } END { print count + 0 }' "$MANIFEST")

printf 'INFO: %s migration files contain permissive policy syntax\n' "$permissive_policy_count"
printf 'INFO: %s migration files contain SECURITY DEFINER functions\n' "$security_definer_count"
printf 'INFO: %s migrations are operational/post-import and excluded from empty bootstrap\n' "$operational_count"
printf 'INFO: %s migrations are platform-conditional or excluded from the Cloudflare target\n' "$platform_count"
printf 'INFO: %s source migrations are represented by the reviewed portable addendum\n' "$materialized_count"

if [ -n "${DATABASE_URL:-}" ]; then
  if ! command -v psql >/dev/null 2>&1; then
    fail "DATABASE_URL is set but psql is not installed"
  else
    printf 'INFO: running catalog inspection inside a READ ONLY transaction\n'
    if psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -f "$READONLY_SQL" \
      && "$STAGING_VERIFIER" "$DATABASE_URL"; then
      ok "read-only catalog inspection completed"
    else
      fail "read-only catalog inspection failed"
    fi
  fi
else
  printf 'INFO: DATABASE_URL not set; remote/database catalog inspection skipped\n'
fi

if [ "$failures" -gt 0 ]; then
  printf 'RESULT=FAILED failures=%s\n' "$failures" >&2
  exit 1
fi

printf 'RESULT=STATIC_MANIFEST_OK_DATABASE_READONLY_%s\n' "$(if [ -n "${DATABASE_URL:-}" ]; then printf 'RUN'; else printf 'SKIPPED'; fi)"
