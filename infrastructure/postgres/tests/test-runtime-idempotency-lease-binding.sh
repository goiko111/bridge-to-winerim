#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
POSTGRES_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
for command_name in initdb pg_ctl createdb psql; do
  command -v "$command_name" >/dev/null 2>&1 || {
    printf 'BLOCKED: %s is not installed\n' "$command_name" >&2
    exit 2
  }
done

TMP_ROOT=$(mktemp -d /tmp/wr-idem.XXXXXX)
DATA_DIR="$TMP_ROOT/data"
PORT=$((58432 + ($$ % 400)))
DATABASE_URL="postgresql://$(id -un)@127.0.0.1:$PORT/winerim_runtime_idempotency_test"
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
test "$(psql -h 127.0.0.1 -p "$PORT" -d postgres -XAtq -c "SELECT current_setting('server_version_num')::int / 10000")" = 17
createdb -h 127.0.0.1 -p "$PORT" winerim_runtime_idempotency_test

"$POSTGRES_DIR/build-bootstrap.sh" "$TMP_ROOT/bootstrap.sql" >/dev/null
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -v environment=rescue-production -f "$TMP_ROOT/bootstrap.sql" >/dev/null

columns=$(psql "$DATABASE_URL" -XAtq -c "
  SELECT count(*) FROM information_schema.columns
  WHERE table_schema='public' AND table_name='runtime_idempotency'
    AND column_name IN ('payload_sha256','lease_token')
")
test "$columns" = 2 || { printf 'IDEMPOTENCY_BINDING_COLUMNS_INVALID=%s\n' "$columns" >&2; exit 1; }

psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
INSERT INTO public.pos_connections (
  id, location_name, provider, base_url, api_token, enabled,
  catalog_sync_enabled, sync_mode, write_mode
) VALUES (
  '11111111-1111-4111-8111-111111111111', 'Lease test', 'agora',
  'https://redacted.invalid', '', false, false, 'PULL_ONLY', 'NONE'
);
INSERT INTO public.runtime_idempotency (
  idempotency_key, message_id, connection_id, job, status, attempt,
  payload_sha256, lease_token
) VALUES (
  'idem:test', 'message-a', '11111111-1111-4111-8111-111111111111',
  'winerim.sales-import-live', 'RUNNING', 1,
  repeat('a', 64), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
);
SQL

wrong_owner=$(psql "$DATABASE_URL" -XAtq -c "
  WITH changed AS (
    UPDATE public.runtime_idempotency SET status='SUCCESS'
    WHERE idempotency_key='idem:test'
      AND payload_sha256=repeat('a',64)
      AND lease_token='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    RETURNING 1
  ) SELECT count(*) FROM changed
")
test "$wrong_owner" = 0 || { printf 'STALE_LEASE_OWNER_ACCEPTED=%s\n' "$wrong_owner" >&2; exit 1; }

right_owner=$(psql "$DATABASE_URL" -XAtq -c "
  WITH changed AS (
    UPDATE public.runtime_idempotency SET status='SUCCESS'
    WHERE idempotency_key='idem:test'
      AND message_id='message-a'
      AND connection_id='11111111-1111-4111-8111-111111111111'
      AND job='winerim.sales-import-live'
      AND payload_sha256=repeat('a',64)
      AND lease_token='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    RETURNING 1
  ) SELECT count(*) FROM changed
")
test "$right_owner" = 1 || { printf 'CURRENT_LEASE_OWNER_REJECTED=%s\n' "$right_owner" >&2; exit 1; }

if psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "
  INSERT INTO public.runtime_idempotency (
    idempotency_key, message_id, connection_id, job, status, attempt,
    payload_sha256, lease_token
  ) VALUES (
    'idem:invalid', 'message-b', '11111111-1111-4111-8111-111111111111',
    'winerim.sales-import-live', 'RUNNING', 1, 'not-a-sha',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  )
" >"$TMP_ROOT/invalid.out" 2>&1; then
  printf 'INVALID_PAYLOAD_DIGEST_ACCEPTED\n' >&2
  exit 1
fi
grep -Eiq 'runtime_idempotency_payload_sha256_format|check constraint' "$TMP_ROOT/invalid.out"

printf 'RESULT=RUNTIME_IDEMPOTENCY_LEASE_BINDING_OK postgres_major=17 identity=message_connection_job_payload owner=lease_token\n'
