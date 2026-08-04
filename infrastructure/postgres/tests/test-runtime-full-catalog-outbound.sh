#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
POSTGRES_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
POSTGRES_BIN=${POSTGRES_BIN:-/opt/homebrew/opt/postgresql@17/bin}
PATH="$POSTGRES_BIN:$PATH"
export PATH

for command_name in initdb pg_ctl createdb psql; do
  command -v "$command_name" >/dev/null 2>&1 || {
    printf 'BLOCKED: required command is not installed: %s\n' "$command_name" >&2
    exit 2
  }
done

TMP_ROOT=$(mktemp -d /tmp/wr-runtime-full-catalog.XXXXXX)
DATA_DIR="$TMP_ROOT/data"
PORT=$((59632 + ($$ % 200)))
DATABASE_NAME=winerim_runtime_full_catalog_test
DATABASE_URL="postgresql://$(id -un)@127.0.0.1:$PORT/$DATABASE_NAME"
SERVER_STARTED=0

cleanup() {
  if [ "$SERVER_STARTED" = 1 ]; then
    pg_ctl -D "$DATA_DIR" -m fast -w stop >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT INT TERM

initdb -D "$DATA_DIR" --auth=trust --no-locale --encoding=UTF8 >/dev/null
pg_ctl -D "$DATA_DIR" -l "$TMP_ROOT/postgres.log" -o "-h 127.0.0.1 -p $PORT" -w start >/dev/null
SERVER_STARTED=1
createdb -h 127.0.0.1 -p "$PORT" "$DATABASE_NAME"
"$POSTGRES_DIR/build-bootstrap.sh" "$TMP_ROOT/bootstrap.sql" >/dev/null
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -v environment=rescue-production \
  -f "$TMP_ROOT/bootstrap.sql" >/dev/null

CONNECTION_ID=10000000-0000-4000-8000-000000000016
RUN_ID=full-catalog-test-001

psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 >/dev/null <<SQL
INSERT INTO public.pos_connections (
  id, location_name, provider, base_url, api_token, enabled,
  catalog_sync_enabled, sync_mode, write_mode, backfill_days, provider_config
) VALUES (
  '$CONNECTION_ID', 'Full lanes fixture', 'agora', 'https://redacted.invalid', '', true,
  true, 'BIDIRECTIONAL', 'XML_IMPORT', 0,
  '{
    "runtime_fleet_profile":"full-lanes-v1",
    "runtime_fleet_job_allowlist":["sales.auto-sync","sales.sync-intraday","catalog.fetch-winerim","catalog.sync-master","outbound.process"],
    "runtime_sales_job_allowlist":["sales.auto-sync","sales.sync-intraday"],
    "intraday_sales_sync_enabled":true,
    "open_tickets_sync_enabled":false,
    "open_tickets_stock_sync_enabled":false,
    "runtime_catalog_enabled":true,
    "runtime_stock_enabled":true,
    "runtime_outbound_enabled":true,
    "runtime_maintenance_enabled":false
  }'::jsonb
);
INSERT INTO public.runtime_canary_connections (
  connection_id, run_id, generation_mode, status, active, note
) VALUES (
  '$CONNECTION_ID', '$RUN_ID', 'bootstrap', 'PREPARED', false, 'full-catalog-test'
);
INSERT INTO public.runtime_connection_credentials (
  connection_id, provider, credential_kind, run_id, key_version,
  ciphertext, nonce, attestation_sha256, active
) VALUES
  ('$CONNECTION_ID', 'agora', 'agora', '$RUN_ID', 'test-key', decode(repeat('11',32),'hex'), decode(repeat('22',12),'hex'), repeat('a',64), false),
  ('$CONNECTION_ID', 'agora', 'winerim', '$RUN_ID', 'test-key', decode(repeat('33',32),'hex'), decode(repeat('44',12),'hex'), repeat('b',64), false);
BEGIN;
UPDATE public.runtime_connection_credentials
SET active=true, activated_at=transaction_timestamp()
WHERE connection_id='$CONNECTION_ID'::uuid AND run_id='$RUN_ID';
UPDATE public.runtime_canary_connections
SET active=true, status='ACTIVE', approved_at=statement_timestamp()-interval '1 minute',
    expires_at=statement_timestamp()+interval '1 hour',
    deployment_manifest_sha256=repeat('c',64), writer_fence_grant_sha256=repeat('d',64),
    credential_set_sha256=repeat('e',64), activated_at=transaction_timestamp()
WHERE connection_id='$CONNECTION_ID'::uuid AND run_id='$RUN_ID';
COMMIT;
SQL

test "$(psql "$DATABASE_URL" -XAtq -c "SELECT public.runtime_full_catalog_scope('$CONNECTION_ID')")" = t

psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 >/dev/null <<SQL
SET ROLE middleware_runtime;
INSERT INTO public.winerim_wines (
  connection_id, winerim_id, name, is_active, price, bottle_sale_price,
  serve_by_glass, pricing_status, raw_payload
) VALUES ('$CONNECTION_ID', '42', 'Fixture', true, 12, 12, false, 'READY', '{}'::jsonb);
INSERT INTO public.runtime_catalog_changes (
  connection_id, winerim_wine_id, format, source_fingerprint, source_message_id
) VALUES ('$CONNECTION_ID', '42', 'BOTTLE', repeat('a',64), 'fixture-message');
RESET ROLE;
SQL

test "$(psql "$DATABASE_URL" -XAtq -c "SELECT count(*) FROM public.runtime_catalog_changes WHERE connection_id='$CONNECTION_ID'")" = 1

psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -c \
  "UPDATE public.pos_connections SET provider_config=jsonb_set(provider_config,'{runtime_stock_enabled}','false'::jsonb) WHERE id='$CONNECTION_ID'" >/dev/null
test "$(psql "$DATABASE_URL" -XAtq -c "SELECT public.runtime_full_catalog_scope('$CONNECTION_ID')")" = f

psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 >/dev/null <<SQL
SET ROLE middleware_runtime;
UPDATE public.winerim_wines SET name='must fail' WHERE connection_id='$CONNECTION_ID' AND winerim_id='42';
SQL
if [ "$(psql "$DATABASE_URL" -XAtq -c "SELECT name FROM public.winerim_wines WHERE connection_id='$CONNECTION_ID' AND winerim_id='42'")" != Fixture ]; then
  printf 'FAIL: runtime catalog write escaped the exact full-lanes RLS profile\n' >&2
  exit 1
fi

printf 'RUNTIME_FULL_CATALOG_OUTBOUND_TEST=PASS\n'
