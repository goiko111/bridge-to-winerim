#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  printf 'Usage: %s STAGING_DATABASE_URL\n' "$0" >&2
  exit 2
fi

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DATABASE_URL=$1
existing=$(psql "$DATABASE_URL" -XAtqc "select to_regclass('public.pos_connections') is not null")
if [ "$existing" = "t" ]; then
  printf 'Refusing bootstrap: public.pos_connections already exists\n' >&2
  exit 3
fi

artifact_dir=$(mktemp -d "${TMPDIR:-/tmp}/winerim-bootstrap.XXXXXX")
artifact="$artifact_dir/bootstrap.sql"
trap 'rm -rf "$artifact_dir"' EXIT INT TERM
"$SCRIPT_DIR/build-bootstrap.sh" "$artifact"
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -v environment=staging -f "$artifact"

identity=$(psql "$DATABASE_URL" -XAtqc "select value from public.infrastructure_metadata where key='environment'")
test "$identity" = "staging" || {
  printf 'Staging sentinel verification failed\n' >&2
  exit 4
}
printf 'STAGING_BOOTSTRAP_APPLIED_AND_VERIFIED\n'
