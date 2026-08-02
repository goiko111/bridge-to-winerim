#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
MANIFEST="$SCRIPT_DIR/migration-manifest.tsv"
MIGRATIONS_DIR="$REPO_ROOT/supabase/migrations"
PORTABLE_ADDENDUM="$SCRIPT_DIR/0002_release_schema_addendum.sql"
RUNTIME_CREDENTIALS_ADDENDUM="$SCRIPT_DIR/0003_runtime_connection_credentials.sql"
RUNTIME_CANARY_PRIVILEGES="$SCRIPT_DIR/0004_runtime_canary_least_privilege.sql"
OUTPUT=${1:-"$SCRIPT_DIR/bootstrap-staging.generated.sql"}

{
  printf '%s\n' '-- Generated from reviewed migration-manifest.tsv. Do not edit by hand.'
  printf '%s\n' '\set ON_ERROR_STOP on'
  cat "$SCRIPT_DIR/bootstrap-prelude.sql"
  while IFS=$'\t' read -r order file expected_sha phase action dependency note; do
    if [ "$order" = "order" ] || [ -z "$order" ]; then
      continue
    fi
    case "$action" in
      INCLUDE|INCLUDE_SECURITY_GATE|INCLUDE_WITH_REVIEW)
        actual_sha=$(shasum -a 256 "$MIGRATIONS_DIR/$file" | awk '{print $1}')
        test "$actual_sha" = "$expected_sha" || {
          printf 'Checksum mismatch for %s\n' "$file" >&2
          exit 1
        }
        printf '\n-- BEGIN %s\n' "$file"
        cat "$MIGRATIONS_DIR/$file"
        printf '\n-- END %s\n' "$file"
        ;;
    esac
  done < "$MANIFEST"
  printf '\n-- BEGIN infrastructure hardening\n'
  cat "$SCRIPT_DIR/0001_harden_runtime_roles.sql"
  printf '\n-- END infrastructure hardening\n'
  printf '\n-- BEGIN release schema addendum\n'
  cat "$PORTABLE_ADDENDUM"
  printf '\n-- END release schema addendum\n'
  printf '\n-- BEGIN runtime credential vault schema\n'
  cat "$RUNTIME_CREDENTIALS_ADDENDUM"
  printf '\n-- END runtime credential vault schema\n'
  printf '\n-- BEGIN runtime canary least privilege\n'
  cat "$RUNTIME_CANARY_PRIVILEGES"
  printf '\n-- END runtime canary least privilege\n'
} > "$OUTPUT"

printf 'BOOTSTRAP_BUILT=%s\n' "$OUTPUT"
