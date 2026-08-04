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

# The official Lovable copy predates these own-infrastructure control-plane
# tables. The independently bootstrapped target intentionally keeps them.
psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$PORT" -U postgres -d "$SOURCE_DB" <<SQL
DROP TABLE public.middleware_incident_email_attempts;
DROP TABLE public.middleware_incident_events;
DROP TABLE public.middleware_incidents;
DROP TABLE public.integration_onboarding_requests;
SQL

SOURCE_URL="postgresql://postgres@127.0.0.1:$PORT/$SOURCE_DB"
TARGET_URL="postgresql://postgres@127.0.0.1:$PORT/$TARGET_DB"
CONNECTION_ID=11111111-1111-4111-8111-111111111111
EVENT_ID=22222222-2222-4222-8222-222222222222
LINE_ID=33333333-3333-4333-8333-333333333333

psql "$SOURCE_URL" -X -q -v ON_ERROR_STOP=1 <<SQL
INSERT INTO public.pos_connections
  (id, location_name, provider, base_url, api_token, winerim_api_token, catalog_endpoint, provider_config, restaurant_guid, enabled)
VALUES
  ('$CONNECTION_ID', 'Local source fixture', 'agora', 'https://source.invalid?token=FAKE_SOURCE_URL_SECRET_P1', 'FAKE_SOURCE_API_SECRET_P1',
   'FAKE_SOURCE_WINERIM_SECRET_P1', 'https://catalog.invalid?key=FAKE_SOURCE_CATALOG_SECRET_P1',
   '{"password":"FAKE_SOURCE_CONFIG_SECRET_P1"}'::jsonb, 'FAKE_SOURCE_RESTAURANT_CREDENTIAL_P1', false);

INSERT INTO public.provider_credentials
  (connection_id, merchant_id, access_token_enc, refresh_token_enc, toast_client_secret, toast_access_token, toast_refresh_token)
VALUES
  ('$CONNECTION_ID', 'fixture-merchant', 'FAKE_PROVIDER_ACCESS_SECRET_P1', 'FAKE_PROVIDER_REFRESH_SECRET_P1',
   'FAKE_TOAST_CLIENT_SECRET_P1', 'FAKE_TOAST_ACCESS_SECRET_P1', 'FAKE_TOAST_REFRESH_SECRET_P1');

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
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Must be replaced', 'agora', 'https://old.invalid?token=FAKE_TARGET_URL_SECRET_P1', 'FAKE_TARGET_API_SECRET_P1', false);
SQL

SOURCE_ARTIFACT="$TMP_ROOT/source-artifact"
TARGET_BACKUP="$TMP_ROOT/target-backup"
RACE_BACKUP="$TMP_ROOT/target-backup-race"
RACE_CONNECTION_ID=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb

LOVABLE_DATABASE_URL="$SOURCE_URL" \
  node "$REPO_ROOT/scripts/lovable-export-reconcile.mjs" export \
    --artifact-dir "$SOURCE_ARTIFACT" \
    --apply \
    --confirm-source lovable-production >/dev/null

MANIFEST_SHA=$(node -e "const m=require(process.argv[1]); process.stdout.write(m.manifestSha256)" "$SOURCE_ARTIFACT/manifest.json")

if grep -R -a -E 'FAKE_(SOURCE|PROVIDER|TOAST)_[A-Z_]+_P1' "$SOURCE_ARTIFACT" >/dev/null; then
  printf 'FAIL: source artifact contains a credential marker\n' >&2
  exit 1
fi

# Prove that a write committed after the target backup but before the atomic
# restore is detected before TRUNCATE. The test-only pause is accepted only
# behind the local-test gate.
set +e
LOVABLE_DATABASE_URL="$SOURCE_URL" \
STAGING_DATABASE_URL="$TARGET_URL" \
WINERIM_DATA_TRANSFER_ALLOW_LOCAL_TEST=1 \
WINERIM_DATA_TRANSFER_TEST_PAUSE_AFTER_BACKUP_MS=4000 \
  node "$REPO_ROOT/scripts/lovable-export-reconcile.mjs" import \
    --artifact-dir "$SOURCE_ARTIFACT" \
    --backup-dir "$RACE_BACKUP" \
    --confirm-manifest "$MANIFEST_SHA" \
    --confirm-target-ref local-test \
    --local-test \
    --apply >"$TMP_ROOT/race-import.stdout" 2>"$TMP_ROOT/race-import.stderr" &
RACE_IMPORT_PID=$!
set -e

for _ in $(seq 1 100); do
  if [ -f "$RACE_BACKUP/import-state.json" ] && \
     grep -q '"phase": "TARGET_SNAPSHOT_READY"' "$RACE_BACKUP/import-state.json"; then
    break
  fi
  sleep 0.05
done
if [ ! -f "$RACE_BACKUP/import-state.json" ]; then
  set +e
  wait "$RACE_IMPORT_PID"
  set -e
  cat "$TMP_ROOT/race-import.stderr" >&2
  printf 'FAIL: race import exited before creating target snapshot state\n' >&2
  exit 1
fi
grep -q '"phase": "TARGET_SNAPSHOT_READY"' "$RACE_BACKUP/import-state.json"

psql "$TARGET_URL" -X -q -v ON_ERROR_STOP=1 <<SQL
INSERT INTO public.pos_connections
  (id, location_name, provider, base_url, api_token, enabled)
VALUES
  ('$RACE_CONNECTION_ID', 'Concurrent writer fixture', 'agora', 'https://race.invalid', '', false);
SQL

set +e
wait "$RACE_IMPORT_PID"
race_exit=$?
set -e
if [ "$race_exit" -eq 0 ]; then
  printf 'FAIL: concurrent target write was silently overwritten\n' >&2
  exit 1
fi

race_preserved=$(
  psql "$TARGET_URL" -X -q -A -t -v ON_ERROR_STOP=1 \
    -c "SELECT count(*) FROM public.pos_connections WHERE id IN ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '$RACE_CONNECTION_ID')"
)
race_phase=$(node -e "const s=require(process.argv[1]); process.stdout.write(s.phase)" "$RACE_BACKUP/import-state.json")
test "$race_preserved" = "2"
test "$race_phase" = "TARGET_SNAPSHOT_READY"

# The stale backup stays invalid even if the concurrent row is later removed;
# its WAL evidence cannot be reused with --resume.
psql "$TARGET_URL" -X -q -v ON_ERROR_STOP=1 \
  -c "DELETE FROM public.pos_connections WHERE id='$RACE_CONNECTION_ID'"
if LOVABLE_DATABASE_URL="$SOURCE_URL" \
  STAGING_DATABASE_URL="$TARGET_URL" \
  WINERIM_DATA_TRANSFER_ALLOW_LOCAL_TEST=1 \
    node "$REPO_ROOT/scripts/lovable-export-reconcile.mjs" import \
      --artifact-dir "$SOURCE_ARTIFACT" \
      --backup-dir "$RACE_BACKUP" \
      --confirm-manifest "$MANIFEST_SHA" \
      --confirm-target-ref local-test \
      --local-test \
      --resume \
      --apply >/dev/null 2>&1; then
  printf 'FAIL: stale pre-race backup was accepted on resume\n' >&2
  exit 1
fi

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

if grep -R -a -E 'FAKE_TARGET_[A-Z_]+_P1' "$TARGET_BACKUP/target-before" >/dev/null; then
  printf 'FAIL: target backup contains a credential marker\n' >&2
  exit 1
fi

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
sanitized_connection=$(
  psql "$TARGET_URL" -X -q -A -t -v ON_ERROR_STOP=1 \
    -c "SELECT count(*) FROM public.pos_connections WHERE id='$CONNECTION_ID' AND api_token='' AND winerim_api_token IS NULL AND base_url='https://redacted.invalid' AND catalog_endpoint IS NULL AND provider_config='{}'::jsonb AND restaurant_guid IS NULL"
)
provider_credentials_count=$(
  psql "$TARGET_URL" -X -q -A -t -v ON_ERROR_STOP=1 \
    -c "SELECT count(*) FROM public.provider_credentials"
)
own_only_count=$(
  psql "$TARGET_URL" -X -q -A -t -v ON_ERROR_STOP=1 \
    -c "SELECT (SELECT count(*) FROM public.integration_onboarding_requests) + (SELECT count(*) FROM public.middleware_incident_email_attempts) + (SELECT count(*) FROM public.middleware_incident_events) + (SELECT count(*) FROM public.middleware_incidents)"
)
manifest_table_count=$(node -e "const m=require(process.argv[1]); process.stdout.write(String(m.tables.length))" "$SOURCE_ARTIFACT/manifest.json")

test "$source_connection" = "1"
test "$old_connection" = "0"
test "$line_count" = "1"
test "$sentinel" = "staging"
test "$phase" = "RECONCILED"
test "$sanitized_connection" = "1"
test "$provider_credentials_count" = "0"
test "$own_only_count" = "0"
test "$manifest_table_count" = "20"

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
rolled_back_sanitized=$(
  psql "$TARGET_URL" -X -q -A -t -v ON_ERROR_STOP=1 \
    -c "SELECT count(*) FROM public.pos_connections WHERE id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' AND api_token='' AND base_url='https://redacted.invalid'"
)
rolled_back_phase=$(node -e "const s=require(process.argv[1]); process.stdout.write(s.phase)" "$TARGET_BACKUP/import-state.json")
test "$rolled_back_sanitized" = "1"
test "$rolled_back_phase" = "ROLLED_BACK"

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

# Required-empty tables are part of every post-import reconciliation result.
psql "$TARGET_URL" -X -q -v ON_ERROR_STOP=1 <<SQL
INSERT INTO public.provider_credentials
  (connection_id, merchant_id, access_token_enc)
VALUES
  ('$CONNECTION_ID', 'runtime-empty-gate', 'FAKE_RUNTIME_EMPTY_GATE_SECRET_P1');
SQL
if STAGING_DATABASE_URL="$TARGET_URL" \
  WINERIM_DATA_TRANSFER_ALLOW_LOCAL_TEST=1 \
  node "$REPO_ROOT/scripts/lovable-export-reconcile.mjs" reconcile \
    --artifact-dir "$SOURCE_ARTIFACT" \
    --confirm-target-ref local-test \
    --local-test \
    --read-live >/dev/null; then
  printf 'FAIL: reconciliation accepted a non-empty provider_credentials table\n' >&2
  exit 1
fi
psql "$TARGET_URL" -X -q -v ON_ERROR_STOP=1 \
  -c "DELETE FROM public.provider_credentials WHERE merchant_id='runtime-empty-gate'"

printf 'RESULT=LOCAL_TRANSFER_ROUNDTRIP_OK source_tables=20 target_tables=30 own_only=empty credentials=sanitized provider_credentials=empty sentinel=staging phase=RECONCILED concurrent_write_abort=1 idempotent=1 rollback=1 resume=1\n'
