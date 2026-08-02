#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
MIGRATIONS_DIR="$REPO_ROOT/supabase/migrations"
MANIFEST="$SCRIPT_DIR/migration-manifest.tsv"
EXPECTED="$SCRIPT_DIR/expected-schema.txt"
READONLY_SQL="$SCRIPT_DIR/validate-readonly.sql"
PORTABLE_ADDENDUM="$SCRIPT_DIR/0002_release_schema_addendum.sql"
RUNTIME_CREDENTIALS_ADDENDUM="$SCRIPT_DIR/0003_runtime_connection_credentials.sql"
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
  "$PORTABLE_ADDENDUM" \
  "$RUNTIME_CREDENTIALS_ADDENDUM" \
  "$RELEASE_ADDENDUM" \
  "$EXPECTED_RELEASE_ADDENDUM" \
  "$RELEASE_VALIDATOR"
do
  if [ ! -f "$required_file" ]; then
    fail "missing artifact $required_file"
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
required_foreign_keys=$(awk '$1 == "FOREIGN_KEY_SET_NULL" { count++ } END { print count + 0 }' "$EXPECTED")
ok "expected contract declares $required_tables tables, $required_functions functions, $required_columns columns, $required_indexes indexes and $required_foreign_keys SET NULL foreign keys"

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
    if psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -f "$READONLY_SQL"; then
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
