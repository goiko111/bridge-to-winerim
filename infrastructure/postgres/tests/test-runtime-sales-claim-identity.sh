#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
POSTGRES_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
POSTGRES_BIN=${POSTGRES_BIN:-/opt/homebrew/opt/postgresql@17/bin}
PATH="$POSTGRES_BIN:$PATH"
export PATH

for command_name in initdb pg_ctl createdb psql; do
  command -v "$command_name" >/dev/null 2>&1 || {
    printf 'BLOCKED: PostgreSQL 17 command is not installed: %s\n' "$command_name" >&2
    exit 2
  }
done

TMP_ROOT=$(mktemp -d /tmp/wr-sales-claim.XXXXXX)
DATA_DIR="$TMP_ROOT/data"
PORT=$((58832 + ($$ % 300)))
DATABASE_URL="postgresql://$(id -un)@127.0.0.1:$PORT/winerim_runtime_sales_claim_test"
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
createdb -h 127.0.0.1 -p "$PORT" winerim_runtime_sales_claim_test

"$POSTGRES_DIR/build-bootstrap.sh" "$TMP_ROOT/bootstrap.sql" >/dev/null
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -v environment=rescue-production -f "$TMP_ROOT/bootstrap.sql" >/dev/null

psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
DROP TRIGGER runtime_bind_sales_claim_identity ON public.runtime_idempotency;
DROP INDEX public.uq_runtime_sales_claim_identity;
ALTER TABLE public.runtime_idempotency
  DROP CONSTRAINT runtime_idempotency_sales_claim_identity_scope;
DROP FUNCTION public.runtime_bind_sales_claim_identity();
ALTER TABLE public.runtime_idempotency DROP COLUMN sales_claim_identity;

INSERT INTO public.pos_connections (
  id, location_name, provider, base_url, api_token, enabled,
  catalog_sync_enabled, sync_mode, write_mode
) VALUES (
  '11111111-1111-4111-8111-111111111111', 'Claim identity test', 'agora',
  'https://redacted.invalid', '', false, false, 'PULL_ONLY', 'NONE'
);
INSERT INTO public.runtime_canary_connections (
  connection_id, active, approved_at, expires_at, note
) VALUES (
  '11111111-1111-4111-8111-111111111111', true,
  now() - interval '1 minute', now() + interval '1 hour', 'claim identity test'
);

INSERT INTO public.runtime_idempotency (
  idempotency_key, message_id, connection_id, job, status, attempt,
  payload_sha256, lease_token, result
) VALUES (
  'sales-claim:v1:legacy', 'legacy-order',
  '11111111-1111-4111-8111-111111111111', 'sales.claim', 'SUCCESS', 1,
  repeat('a', 64), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '{"appliedQuantity":1,"lifecycleId":"ticket-100","winerimWineId":"47593","variant":"BOTTLE","sourceDocumentIds":["open-ticket:100"]}'::jsonb
);
SQL

psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -f "$POSTGRES_DIR/0011_runtime_sales_claim_identity.sql" >/dev/null

contract=$(psql "$DATABASE_URL" -XAtq -F '|' -c "
  SELECT
    (SELECT count(*) FROM information_schema.columns
      WHERE table_schema='public' AND table_name='runtime_idempotency'
        AND column_name='sales_claim_identity'),
    (SELECT count(*) FROM pg_indexes
      WHERE schemaname='public' AND tablename='runtime_idempotency'
        AND indexname='uq_runtime_sales_claim_identity'),
    (SELECT count(DISTINCT trigger_name) FROM information_schema.triggers
      WHERE event_object_schema='public' AND event_object_table='runtime_idempotency'
        AND trigger_name='runtime_bind_sales_claim_identity')
")
test "$contract" = "1|1|1" || { printf 'SALES_CLAIM_IDENTITY_CONTRACT_INVALID=%s\n' "$contract" >&2; exit 1; }
backfilled=$(psql "$DATABASE_URL" -XAtq -c "
  SELECT count(*) FROM public.runtime_idempotency
  WHERE idempotency_key='sales-claim:v1:legacy' AND sales_claim_identity IS NOT NULL
")
test "$backfilled" = 1 || { printf 'LEGACY_SALES_CLAIM_NOT_BACKFILLED=%s\n' "$backfilled" >&2; exit 1; }

psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
SET ROLE middleware_runtime;
INSERT INTO public.runtime_idempotency (
  idempotency_key, message_id, connection_id, job, status, attempt,
  payload_sha256, lease_token, result
) VALUES (
  'sales-claim:v2:runtime-role', 'runtime-order',
  '11111111-1111-4111-8111-111111111111', 'sales.claim', 'RUNNING', 1,
  repeat('c', 64), 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  '{"appliedQuantity":0,"lifecycleId":"ticket-runtime","winerimWineId":"47593","variant":"BOTTLE"}'::jsonb
);
RESET ROLE;

INSERT INTO public.runtime_idempotency (
  idempotency_key, message_id, connection_id, job, status, attempt,
  payload_sha256, lease_token, result
) VALUES (
  'sales-claim:v2:current', 'current-order',
  '11111111-1111-4111-8111-111111111111', 'sales.claim', 'RUNNING', 1,
  repeat('b', 64), 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  '{"appliedQuantity":0,"lifecycleId":"ticket-100","winerimWineId":"47593","variant":"BOTTLE","sourceDocumentIds":["invoice:100"]}'::jsonb
)
ON CONFLICT DO NOTHING;
SQL

claim_count=$(psql "$DATABASE_URL" -XAtq -c "
  SELECT count(*) FROM public.runtime_idempotency
  WHERE job='sales.claim' AND sales_claim_identity IS NOT NULL
")
test "$claim_count" = 2 || { printf 'V1_V2_LOGICAL_DUPLICATE_ACCEPTED=%s\n' "$claim_count" >&2; exit 1; }

if psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "
  UPDATE public.runtime_idempotency
  SET result = jsonb_set(result, '{variant}', '\"GLASS\"'::jsonb)
  WHERE idempotency_key='sales-claim:v1:legacy'
" >"$TMP_ROOT/identity-change.out" 2>&1; then
  printf 'SALES_CLAIM_IDENTITY_MUTATION_ACCEPTED\n' >&2
  exit 1
fi
grep -Fq 'RUNTIME_SALES_CLAIM_IDENTITY_IMMUTABLE' "$TMP_ROOT/identity-change.out"

psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
DROP TRIGGER runtime_bind_sales_claim_identity ON public.runtime_idempotency;
DROP INDEX public.uq_runtime_sales_claim_identity;
ALTER TABLE public.runtime_idempotency
  DROP CONSTRAINT runtime_idempotency_sales_claim_identity_scope;
DROP FUNCTION public.runtime_bind_sales_claim_identity();
ALTER TABLE public.runtime_idempotency DROP COLUMN sales_claim_identity;

INSERT INTO public.runtime_idempotency (
  idempotency_key, message_id, connection_id, job, status, attempt,
  payload_sha256, lease_token, result
) VALUES (
  'sales-claim:v2:preexisting-duplicate', 'duplicate-order',
  '11111111-1111-4111-8111-111111111111', 'sales.claim', 'SUCCESS', 1,
  repeat('d', 64), 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  '{"appliedQuantity":1,"lifecycleId":"ticket-100","winerimWineId":"47593","variant":"BOTTLE"}'::jsonb
);
SQL

if psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -f "$POSTGRES_DIR/0011_runtime_sales_claim_identity.sql" \
  >"$TMP_ROOT/duplicate-migration.out" 2>&1; then
  printf 'PREEXISTING_SALES_CLAIM_DUPLICATES_MIGRATED_BLINDLY\n' >&2
  exit 1
fi
grep -Fq 'RUNTIME_SALES_CLAIM_DUPLICATE_RECONCILIATION_REQUIRED' "$TMP_ROOT/duplicate-migration.out"

printf 'RESULT=RUNTIME_SALES_CLAIM_IDENTITY_OK postgres_major=17 v1_v2=unique ambiguous=fail_closed\n'
