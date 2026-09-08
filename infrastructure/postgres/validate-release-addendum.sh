#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
SOURCE_ROOT=${1:-$REPO_ROOT}
MIGRATIONS_DIR="$SOURCE_ROOT/supabase/migrations"
ADDENDUM="$SCRIPT_DIR/release-migration-manifest-addendum.tsv"
EXPECTED_ADDENDUM="$SCRIPT_DIR/expected-schema-release-addendum.txt"

failures=0

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  failures=$((failures + 1))
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

for required in "$ADDENDUM" "$EXPECTED_ADDENDUM"; do
  [ -f "$required" ] || fail "missing artifact $required"
done
[ -d "$MIGRATIONS_DIR" ] || fail "release migrations not found at $MIGRATIONS_DIR"

if [ "$failures" -gt 0 ]; then
  exit 1
fi

row_count=$(awk -F '\t' 'NR > 1 && NF { count++ } END { print count + 0 }' "$ADDENDUM")
[ "$row_count" -eq 13 ] || fail "release addendum must contain 13 rows, found $row_count"

previous_order=0
while IFS=$'\t' read -r order file expected_sha phase action dependency reason; do
  if [ "$order" = "order" ] || [ -z "$order" ]; then
    continue
  fi

  case "$action" in
    SPLIT_PORTABLE_SCHEMA|EXCLUDE_NOOP|EXCLUDE_CLOUDFLARE_TARGET|INCLUDE|EXCLUDE_DUPLICATE|EXCLUDE_OPERATIONAL|POST_IMPORT_REVIEW|INCLUDE_SECURITY_GATE)
      ;;
    *) fail "$file has unknown action $action" ;;
  esac

  if [ "$order" -le "$previous_order" ]; then
    fail "$file is out of addendum order"
  fi
  previous_order=$order

  path="$MIGRATIONS_DIR/$file"
  if [ ! -f "$path" ]; then
    fail "release migration missing: $file"
    continue
  fi
  actual_sha=$(sha256_file "$path")
  [ "$actual_sha" = "$expected_sha" ] || fail "$file checksum changed: expected $expected_sha got $actual_sha"
done < "$ADDENDUM"

if [ "$failures" -gt 0 ]; then
  printf 'RESULT=RELEASE_ADDENDUM_FAILED failures=%s\n' "$failures" >&2
  exit 1
fi

printf 'INFO: source_root=%s\n' "$SOURCE_ROOT"
printf 'INFO: classified_release_migrations=%s\n' "$row_count"
printf 'RESULT=RELEASE_ADDENDUM_OK_NO_DATABASE_WRITES\n'
