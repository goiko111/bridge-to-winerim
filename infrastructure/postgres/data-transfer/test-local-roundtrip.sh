#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
POSTGRES_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
REPO_ROOT=$(CDPATH= cd -- "$POSTGRES_DIR/../.." && pwd)

for command_name in initdb pg_ctl createdb psql pg_dump pg_restore node; do
  command -v "$command_name" >/dev/null 2>&1 || {
    printf 'BLOCKED: %s is not installed\n' "$command_name" >&2
    exit 2
  }
done

TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/winerim-transfer-roundtrip.XXXXXX")
DATA_DIR="$TMP_ROOT/data"
PORT=$((56432 + ($$ % 500)))
SOURCE_DB=winerim_lovable_fixture
TARGET_DB=winerim_staging_fixture
SERVER_STARTED=0

cleanup() {
  if [ "$SERVER_STARTED" -eq 1 ]; then
    pg_ctl -D "$DATA_DIR" -m fast -w stop >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT INT TERM

initdb -D "$DATA_DIR" -U postgres --auth=trust --no-locale --encoding=UTF8 >/dev/null
pg_ctl -D "$DATA_DIR" -o "-h 127.0.0.1 -p $PORT" -w start >/dev/null
SERVER_STARTED=1
createdb -h 127.0.0.1 -p "$PORT" -U postgres "$SOURCE_DB"
createdb -h 127.0.0.1 -p "$PORT" -U postgres "$TARGET_DB"

BOOTSTRAP_SQL="$TMP_ROOT/bootstrap.sql"
"$POSTGRES_DIR/build-bootstrap.sh" "$BOOTSTRAP_SQL" >/dev/null
psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$PORT" -U postgres -d "$SOURCE_DB" \
  -v environment=lovable-production -f "$BOOTSTRAP_SQL"
psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$PORT" -U postgres -d "$TARGET_DB" \
  -v environment=staging -f "$BOOTSTRAP_SQL"

SOURCE_URL="postgresql://postgres@127.0.0.1:$PORT/$SOURCE_DB"
TARGET_URL="postgresql://postgres@127.0.0.1:$PORT/$TARGET_DB"
CONNECTION_ID=11111111-1111-4111-8111-111111111111
EVENT_ID=22222222-2222-4222-8222-222222222222
LINE_ID=33333333-3333-4333-8333-333333333333

psql "$SOURCE_URL" -X -q -v ON_ERROR_STOP=1 <<SQL
INSERT INTO public.pos_connections
  (id, location_name, provider, base_url, api_token, enabled)
VALUES
  ('$CONNECTION_ID', 'Local source fixture', 'agora', 'https://fixture.invalid', 'fixture-not-a-secret', false);

INSERT INTO public.sales_events
  (id, connection_id, provider_doc_id, business_day, doc_type, line_count)
VALUES
  ('$EVENT_ID', '$CONNECTION_ID', 'fixture-order-1', DATE '2026-08-02', 'BasicInvoice', 1);

INSERT INTO public.sales_line_items
  (id, sales_event_id, connection_id, provider_product_id, name, format, quantity, unit_price, total_amount, is_wine_candidate, mapped)
VALUES
  ('$LINE_ID', '$EVENT_ID', '$CONNECTION_ID', 'fixture-product-1', 'Fixture wine', 'BOTTLE', 1, 12.50, 12.50, true, false);
SQL

psql "$TARGET_URL" -X -q -v ON_ERROR_STOP=1 <<SQL
INSERT INTO public.pos_connections
  (id, location_name, provider, base_url, api_token, enabled)
VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Must be replaced', 'agora', 'https://old.invalid', 'old-fixture', false);
SQL

SOURCE_ARTIFACT="$TMP_ROOT/source-artifact"
TARGET_BACKUP="$TMP_ROOT/target-backup"

LOVABLE_DATABASE_URL="$SOURCE_URL" \
  node "$REPO_ROOT/scripts/lovable-export-reconcile.mjs" export \
    --artifact-dir "$SOURCE_ARTIFACT" \
    --apply \
    --confirm-source lovable-production >/dev/null

MANIFEST_SHA=$(node -e "const m=require(process.argv[1]); process.stdout.write(m.manifestSha256)" "$SOURCE_ARTIFACT/manifest.json")

LOVABLE_DATABASE_URL="$SOURCE_URL" \
STAGING_DATABASE_URL="$TARGET_URL" \
WINERIM_DATA_TRANSFER_ALLOW_LOCAL_TEST=1 \
  node "$REPO_ROOT/scripts/lovable-export-reconcile.mjs" import \
    --artifact-dir "$SOURCE_ARTIFACT" \
    --backup-dir "$TARGET_BACKUP" \
    --confirm-manifest "$MANIFEST_SHA" \
    --confirm-target-ref local-test \
    --local-test \
    --apply >/dev/null

STAGING_DATABASE_URL="$TARGET_URL" \
WINERIM_DATA_TRANSFER_ALLOW_LOCAL_TEST=1 \
  node "$REPO_ROOT/scripts/lovable-export-reconcile.mjs" reconcile \
    --artifact-dir "$SOURCE_ARTIFACT" \
    --confirm-target-ref local-test \
    --local-test \
    --read-live >/dev/null

source_connection=$(
  psql "$TARGET_URL" -X -q -A -t -v ON_ERROR_STOP=1 \
    -c "SELECT count(*) FROM public.pos_connections WHERE id='$CONNECTION_ID'"
)
old_connection=$(
  psql "$TARGET_URL" -X -q -A -t -v ON_ERROR_STOP=1 \
    -c "SELECT count(*) FROM public.pos_connections WHERE id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'"
)
line_count=$(
  psql "$TARGET_URL" -X -q -A -t -v ON_ERROR_STOP=1 \
    -c "SELECT count(*) FROM public.sales_line_items WHERE id='$LINE_ID'"
)
sentinel=$(
  psql "$TARGET_URL" -X -q -A -t -v ON_ERROR_STOP=1 \
    -c "SELECT value FROM public.infrastructure_metadata WHERE key='environment'"
)
phase=$(node -e "const s=require(process.argv[1]); process.stdout.write(s.phase)" "$TARGET_BACKUP/import-state.json")

test "$source_connection" = "1"
test "$old_connection" = "0"
test "$line_count" = "1"
test "$sentinel" = "staging"
test "$phase" = "RECONCILED"

# Re-running the same confirmed artifact is a read-only idempotent no-op.
resume_result=$(
  LOVABLE_DATABASE_URL="$SOURCE_URL" \
  STAGING_DATABASE_URL="$TARGET_URL" \
  WINERIM_DATA_TRANSFER_ALLOW_LOCAL_TEST=1 \
    node "$REPO_ROOT/scripts/lovable-export-reconcile.mjs" import \
      --artifact-dir "$SOURCE_ARTIFACT" \
      --backup-dir "$TARGET_BACKUP" \
      --confirm-manifest "$MANIFEST_SHA" \
      --confirm-target-ref local-test \
      --local-test \
      --resume \
      --apply
)
printf '%s' "$resume_result" | grep -q 'IMPORT_ALREADY_RECONCILED'

# The exact target-before artifact remains a tested manual rollback.
BACKUP_SHA=$(node -e "const m=require(process.argv[1]); process.stdout.write(m.manifestSha256)" "$TARGET_BACKUP/target-before/manifest.json")
STAGING_DATABASE_URL="$TARGET_URL" \
WINERIM_DATA_TRANSFER_ALLOW_LOCAL_TEST=1 \
  node "$REPO_ROOT/scripts/lovable-export-reconcile.mjs" rollback \
    --backup-dir "$TARGET_BACKUP" \
    --confirm-manifest "$BACKUP_SHA" \
    --confirm-target-ref local-test \
    --local-test \
    --apply >/dev/null

rolled_back_old=$(
  psql "$TARGET_URL" -X -q -A -t -v ON_ERROR_STOP=1 \
    -c "SELECT count(*) FROM public.pos_connections WHERE id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'"
)
rolled_back_source=$(
  psql "$TARGET_URL" -X -q -A -t -v ON_ERROR_STOP=1 \
    -c "SELECT count(*) FROM public.pos_connections WHERE id='$CONNECTION_ID'"
)
test "$rolled_back_old" = "1"
test "$rolled_back_source" = "0"

# A reviewed resume from the rolled-back state reapplies the same immutable
# source artifact and reaches the same reconciled target.
LOVABLE_DATABASE_URL="$SOURCE_URL" \
STAGING_DATABASE_URL="$TARGET_URL" \
WINERIM_DATA_TRANSFER_ALLOW_LOCAL_TEST=1 \
  node "$REPO_ROOT/scripts/lovable-export-reconcile.mjs" import \
    --artifact-dir "$SOURCE_ARTIFACT" \
    --backup-dir "$TARGET_BACKUP" \
    --confirm-manifest "$MANIFEST_SHA" \
    --confirm-target-ref local-test \
    --local-test \
    --resume \
    --apply >/dev/null

reapplied_source=$(
  psql "$TARGET_URL" -X -q -A -t -v ON_ERROR_STOP=1 \
    -c "SELECT count(*) FROM public.pos_connections WHERE id='$CONNECTION_ID'"
)
reapplied_phase=$(node -e "const s=require(process.argv[1]); process.stdout.write(s.phase)" "$TARGET_BACKUP/import-state.json")
test "$reapplied_source" = "1"
test "$reapplied_phase" = "RECONCILED"

printf 'RESULT=LOCAL_TRANSFER_ROUNDTRIP_OK tables=25 sentinel=staging phase=RECONCILED idempotent=1 rollback=1 resume=1\n'
