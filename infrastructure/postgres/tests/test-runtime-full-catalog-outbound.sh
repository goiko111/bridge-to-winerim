#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
POSTGRES_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
POSTGRES_BIN=${POSTGRES_BIN:-/opt/homebrew/opt/postgresql@17/bin}
PATH="$POSTGRES_BIN:$PATH"
export PATH

for command_name in initdb pg_ctl createdb psql sed grep cmp; do
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
PREFLIGHT_DATABASE_NAME=winerim_runtime_full_catalog_preflight_test
PREFLIGHT_DATABASE_URL="postgresql://$(id -un)@127.0.0.1:$PORT/$PREFLIGHT_DATABASE_NAME"
PARTIAL_DATABASE_NAME=winerim_runtime_full_catalog_partial_test
PARTIAL_DATABASE_URL="postgresql://$(id -un)@127.0.0.1:$PORT/$PARTIAL_DATABASE_NAME"
ROLLBACK_DATABASE_NAME=winerim_runtime_full_catalog_rollback_test
ROLLBACK_DATABASE_URL="postgresql://$(id -un)@127.0.0.1:$PORT/$ROLLBACK_DATABASE_NAME"
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
createdb -h 127.0.0.1 -p "$PORT" "$PREFLIGHT_DATABASE_NAME"
createdb -h 127.0.0.1 -p "$PORT" "$PARTIAL_DATABASE_NAME"
createdb -h 127.0.0.1 -p "$PORT" "$ROLLBACK_DATABASE_NAME"
"$POSTGRES_DIR/build-bootstrap.sh" "$TMP_ROOT/bootstrap.sql" >/dev/null
sed '/^-- BEGIN runtime full catalog and outbound lanes$/,$d' \
  "$TMP_ROOT/bootstrap.sql" > "$TMP_ROOT/bootstrap-before-0016.sql"
psql "$PREFLIGHT_DATABASE_URL" -X -v ON_ERROR_STOP=1 -v environment=rescue-production \
  -f "$TMP_ROOT/bootstrap-before-0016.sql" >/dev/null
psql "$PREFLIGHT_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c \
  'DROP TRIGGER enforce_runtime_catalog_wine_refresh_scope ON public.winerim_wines' >/dev/null
if psql "$PREFLIGHT_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -f "$POSTGRES_DIR/0016_runtime_full_catalog_outbound.sql" \
  >"$TMP_ROOT/preflight.out" 2>"$TMP_ROOT/preflight.err"; then
  printf 'FAIL: migration 0016 accepted a database without the migration 0014 wine trigger\n' >&2
  exit 1
fi
grep -q 'RUNTIME_FULL_CATALOG_MIGRATION_0014_REQUIRED' "$TMP_ROOT/preflight.err" || {
  printf 'FAIL: migration 0016 did not expose the expected dependency failure\n' >&2
  cat "$TMP_ROOT/preflight.err" >&2
  exit 1
}

psql "$PREFLIGHT_DATABASE_URL" -X -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
CREATE FUNCTION public.test_noop_catalog_scope() RETURNS trigger
LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$;
REVOKE ALL ON FUNCTION public.test_noop_catalog_scope() FROM PUBLIC;
CREATE TRIGGER enforce_runtime_catalog_wine_refresh_scope
  BEFORE UPDATE ON public.winerim_wines
  FOR EACH ROW EXECUTE FUNCTION public.test_noop_catalog_scope();
SQL
if psql "$PREFLIGHT_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -f "$POSTGRES_DIR/0016_runtime_full_catalog_outbound.sql" \
  >"$TMP_ROOT/preflight-wrong-function.out" 2>"$TMP_ROOT/preflight-wrong-function.err"; then
  printf 'FAIL: migration 0016 accepted a homonymous trigger bound to the wrong function\n' >&2
  exit 1
fi
grep -q 'RUNTIME_FULL_CATALOG_MIGRATION_0014_REQUIRED' "$TMP_ROOT/preflight-wrong-function.err" || {
  printf 'FAIL: migration 0016 did not reject the wrong 0014 trigger function\n' >&2
  cat "$TMP_ROOT/preflight-wrong-function.err" >&2
  exit 1
}

psql "$PREFLIGHT_DATABASE_URL" -X -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
DROP TRIGGER enforce_runtime_catalog_wine_refresh_scope ON public.winerim_wines;
CREATE TRIGGER enforce_runtime_catalog_wine_refresh_scope
  AFTER UPDATE ON public.winerim_wines
  FOR EACH ROW EXECUTE FUNCTION public.enforce_runtime_catalog_wine_refresh_scope();
SQL
if psql "$PREFLIGHT_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -f "$POSTGRES_DIR/0016_runtime_full_catalog_outbound.sql" \
  >"$TMP_ROOT/preflight-wrong-timing.out" 2>"$TMP_ROOT/preflight-wrong-timing.err"; then
  printf 'FAIL: migration 0016 accepted an AFTER trigger for migration 0014\n' >&2
  exit 1
fi
grep -q 'RUNTIME_FULL_CATALOG_MIGRATION_0014_REQUIRED' "$TMP_ROOT/preflight-wrong-timing.err" || {
  printf 'FAIL: migration 0016 did not reject the wrong 0014 trigger timing\n' >&2
  cat "$TMP_ROOT/preflight-wrong-timing.err" >&2
  exit 1
}

psql "$PREFLIGHT_DATABASE_URL" -X -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
DROP TRIGGER enforce_runtime_catalog_wine_refresh_scope ON public.winerim_wines;
CREATE TRIGGER enforce_runtime_catalog_wine_refresh_scope
  BEFORE UPDATE ON public.winerim_wines
  FOR EACH ROW EXECUTE FUNCTION public.enforce_runtime_catalog_wine_refresh_scope();
GRANT CREATE ON SCHEMA public TO middleware_runtime;
ALTER TABLE public.winerim_wines OWNER TO middleware_runtime;
REVOKE CREATE ON SCHEMA public FROM middleware_runtime;
SQL
if psql "$PREFLIGHT_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -f "$POSTGRES_DIR/0016_runtime_full_catalog_outbound.sql" \
  >"$TMP_ROOT/preflight-owner.out" 2>"$TMP_ROOT/preflight-owner.err"; then
  printf 'FAIL: migration 0016 accepted a dependency owned by middleware_runtime\n' >&2
  exit 1
fi
grep -q 'RUNTIME_FULL_CATALOG_DEPENDENCY_RUNTIME_OWNER_REJECTED' "$TMP_ROOT/preflight-owner.err" || {
  printf 'FAIL: migration 0016 did not expose the expected ownership failure\n' >&2
  cat "$TMP_ROOT/preflight-owner.err" >&2
  exit 1
}

psql "$PARTIAL_DATABASE_URL" -X -v ON_ERROR_STOP=1 -v environment=rescue-production \
  -f "$TMP_ROOT/bootstrap-before-0016.sql" >/dev/null
psql "$PARTIAL_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c \
  'CREATE POLICY middleware_runtime_full_catalog_tracking_certified_insert ON public.winerim_push_tracking FOR SELECT USING (true)' >/dev/null
if psql "$PARTIAL_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -f "$POSTGRES_DIR/0016_runtime_full_catalog_outbound.sql" \
  >"$TMP_ROOT/partial.out" 2>"$TMP_ROOT/partial.err"; then
  printf 'FAIL: migration 0016 unexpectedly ignored a mid-migration policy collision\n' >&2
  exit 1
fi
test "$(psql "$PARTIAL_DATABASE_URL" -XAtq -c "SELECT to_regclass('public.runtime_catalog_changes') IS NULL")" = t
test "$(psql "$PARTIAL_DATABASE_URL" -XAtq -c "SELECT to_regprocedure('public.runtime_full_catalog_scope(uuid)') IS NULL")" = t

capture_0016_preimage() {
  target_url=$1
  output_file=$2
  psql "$target_url" -XAtq >"$output_file" <<'SQL'
SELECT 'FUNCTION|' || pg_get_functiondef('public.enforce_runtime_catalog_wine_refresh_scope()'::regprocedure);
SELECT 'TRIGGER|' || pg_get_triggerdef(trigger_row.oid, true)
FROM pg_trigger trigger_row
WHERE trigger_row.tgrelid = 'public.winerim_wines'::regclass
  AND trigger_row.tgname = 'enforce_runtime_catalog_wine_refresh_scope';
SELECT 'POLICY|' || tablename || '|' || policyname || '|' || permissive || '|' || roles::text || '|' || cmd || '|' || COALESCE(qual, '') || '|' || COALESCE(with_check, '')
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('product_mappings', 'winerim_push_tracking', 'winerim_wines')
ORDER BY tablename, policyname;
SELECT 'TABLE_ACL|' || table_name || '|' || privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND table_name IN ('product_mappings', 'winerim_push_tracking', 'winerim_wines')
  AND grantee = 'middleware_runtime'
ORDER BY table_name, privilege_type;
SELECT 'COLUMN_ACL|' || table_name || '|' || column_name || '|' || privilege_type
FROM information_schema.column_privileges
WHERE table_schema = 'public'
  AND table_name IN ('product_mappings', 'winerim_push_tracking', 'winerim_wines')
  AND grantee = 'middleware_runtime'
ORDER BY table_name, column_name, privilege_type;
SQL
}

psql "$ROLLBACK_DATABASE_URL" -X -v ON_ERROR_STOP=1 -v environment=rescue-production \
  -f "$TMP_ROOT/bootstrap-before-0016.sql" >/dev/null
capture_0016_preimage "$ROLLBACK_DATABASE_URL" "$TMP_ROOT/preimage.out"
psql "$ROLLBACK_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -f "$POSTGRES_DIR/0016_runtime_full_catalog_outbound.sql" >/dev/null
psql "$ROLLBACK_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c \
  'ALTER TRIGGER validate_runtime_catalog_change_transition ON public.runtime_catalog_changes RENAME TO drifted_runtime_catalog_change_transition' >/dev/null
if psql "$ROLLBACK_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -f "$POSTGRES_DIR/0016_runtime_full_catalog_outbound.rollback.sql" \
  >"$TMP_ROOT/rollback-drift.out" 2>"$TMP_ROOT/rollback-drift.err"; then
  printf 'FAIL: rollback 0016 accepted a drifted transition trigger\n' >&2
  exit 1
fi
grep -q 'RUNTIME_FULL_CATALOG_ROLLBACK_TRIGGER_DRIFT' "$TMP_ROOT/rollback-drift.err" || {
  printf 'FAIL: rollback 0016 did not expose the expected drift failure\n' >&2
  cat "$TMP_ROOT/rollback-drift.err" >&2
  exit 1
}
test "$(psql "$ROLLBACK_DATABASE_URL" -XAtq -c "SELECT to_regclass('public.runtime_catalog_changes') IS NOT NULL")" = t
psql "$ROLLBACK_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c \
  'ALTER TRIGGER drifted_runtime_catalog_change_transition ON public.runtime_catalog_changes RENAME TO validate_runtime_catalog_change_transition' >/dev/null
if psql "$ROLLBACK_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  >"$TMP_ROOT/rollback-policy-drift.out" 2>"$TMP_ROOT/rollback-policy-drift.err" <<SQL
BEGIN;
ALTER POLICY middleware_runtime_full_catalog_mapping_exact_insert
  ON public.product_mappings WITH CHECK (true);
\i $POSTGRES_DIR/0016_runtime_full_catalog_outbound.rollback.sql
SQL
then
  printf 'FAIL: rollback 0016 accepted a drifted exact mapping policy\n' >&2
  exit 1
fi
grep -q 'RUNTIME_FULL_CATALOG_ROLLBACK_MAPPING_POLICY_DRIFT' "$TMP_ROOT/rollback-policy-drift.err" || {
  printf 'FAIL: rollback 0016 did not expose the expected mapping policy drift\n' >&2
  cat "$TMP_ROOT/rollback-policy-drift.err" >&2
  exit 1
}
test "$(psql "$ROLLBACK_DATABASE_URL" -XAtq -c "SELECT with_check LIKE '%EXACT_PROVIDER_READBACK%' FROM pg_policies WHERE schemaname='public' AND tablename='product_mappings' AND policyname='middleware_runtime_full_catalog_mapping_exact_insert'")" = t
psql "$ROLLBACK_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -f "$POSTGRES_DIR/0016_runtime_full_catalog_outbound.rollback.sql" >/dev/null
capture_0016_preimage "$ROLLBACK_DATABASE_URL" "$TMP_ROOT/postimage.out"
cmp "$TMP_ROOT/preimage.out" "$TMP_ROOT/postimage.out"
test "$(psql "$ROLLBACK_DATABASE_URL" -XAtq -c "SELECT to_regclass('public.runtime_catalog_changes') IS NULL")" = t
test "$(psql "$ROLLBACK_DATABASE_URL" -XAtq -c "SELECT to_regprocedure('public.runtime_full_catalog_scope(uuid)') IS NULL")" = t
test "$(psql "$ROLLBACK_DATABASE_URL" -XAtq -c "SELECT to_regprocedure('public.validate_runtime_catalog_change_transition()') IS NULL")" = t
if psql "$ROLLBACK_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -f "$POSTGRES_DIR/0016_runtime_full_catalog_outbound.rollback.sql" \
  >"$TMP_ROOT/rollback-replay.out" 2>"$TMP_ROOT/rollback-replay.err"; then
  printf 'FAIL: rollback 0016 replay unexpectedly succeeded\n' >&2
  exit 1
fi
grep -q 'RUNTIME_FULL_CATALOG_ROLLBACK_ARTIFACTS_REQUIRED' "$TMP_ROOT/rollback-replay.err" || {
  printf 'FAIL: rollback 0016 replay did not fail with the explicit marker\n' >&2
  cat "$TMP_ROOT/rollback-replay.err" >&2
  exit 1
}

psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -v environment=rescue-production \
  -f "$TMP_ROOT/bootstrap.sql" >/dev/null

if psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -f "$POSTGRES_DIR/0016_runtime_full_catalog_outbound.sql" \
  >"$TMP_ROOT/replay.out" 2>"$TMP_ROOT/replay.err"; then
  printf 'FAIL: migration 0016 replay unexpectedly succeeded\n' >&2
  exit 1
fi
grep -q 'RUNTIME_FULL_CATALOG_OUTBOUND_ALREADY_APPLIED' "$TMP_ROOT/replay.err" || {
  printf 'FAIL: migration 0016 replay did not fail with the explicit marker\n' >&2
  cat "$TMP_ROOT/replay.err" >&2
  exit 1
}

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
INSERT INTO public.runtime_catalog_changes (
  connection_id, winerim_wine_id, format, source_fingerprint, source_message_id
) VALUES ('$CONNECTION_ID', '42', 'MAGNUM', repeat('b',64), 'blocked-fixture-message');
RESET ROLE;

SQL

if psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 >/dev/null 2>"$TMP_ROOT/false-terminal.err" <<SQL
SET ROLE middleware_runtime;
INSERT INTO public.runtime_catalog_changes (
  connection_id, winerim_wine_id, format, source_fingerprint, source_message_id,
  status, attempt, claimed_at, completed_at, last_error
) VALUES (
  '$CONNECTION_ID', '42', 'GLASS', repeat('b',64), 'forged-terminal',
  'SUCCESS', 0, now(), now(), NULL
);
SQL
then
  printf 'FAIL: runtime inserted a forged terminal catalog change\n' >&2
  exit 1
fi
grep -Eq 'RUNTIME_CATALOG_CHANGE_INITIAL_STATE_REJECTED|runtime_catalog_changes_lifecycle_check' "$TMP_ROOT/false-terminal.err" || {
  printf 'FAIL: forged terminal did not fail through the lifecycle guard\n' >&2
  cat "$TMP_ROOT/false-terminal.err" >&2
  exit 1
}

if psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 >/dev/null 2>"$TMP_ROOT/arbitrary-lease.err" <<SQL
SET ROLE middleware_runtime;
UPDATE public.runtime_catalog_changes
SET status='RUNNING', attempt=1, claimed_at=now(),
    lease_expires_at=now()+interval '1 day', completed_at=NULL,
    last_error=NULL, updated_at=now()
WHERE connection_id='$CONNECTION_ID' AND winerim_wine_id='42' AND format='BOTTLE';
SQL
then
  printf 'FAIL: runtime created an arbitrary catalog lease\n' >&2
  exit 1
fi
grep -Eq 'RUNTIME_CATALOG_CHANGE_CLAIM_TRANSITION_REJECTED|runtime_catalog_changes_lifecycle_check' "$TMP_ROOT/arbitrary-lease.err" || {
  printf 'FAIL: arbitrary lease did not fail through the lifecycle guard\n' >&2
  cat "$TMP_ROOT/arbitrary-lease.err" >&2
  exit 1
}

psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 >/dev/null <<SQL
SET ROLE middleware_runtime;
UPDATE public.runtime_catalog_changes
SET status='RUNNING', attempt=1, claimed_at=now(),
    lease_expires_at=now()+interval '120 seconds', completed_at=NULL,
    last_error=NULL, updated_at=now()
WHERE connection_id='$CONNECTION_ID' AND winerim_wine_id='42' AND format='BOTTLE';
UPDATE public.runtime_catalog_changes
SET status='SUCCESS', lease_expires_at=NULL, completed_at=now(),
    last_error=NULL, updated_at=now()
WHERE connection_id='$CONNECTION_ID' AND winerim_wine_id='42' AND format='BOTTLE';

UPDATE public.runtime_catalog_changes
SET status='RUNNING', attempt=1, claimed_at=now(),
    lease_expires_at=now()+interval '120 seconds', completed_at=NULL,
    last_error=NULL, updated_at=now()
WHERE connection_id='$CONNECTION_ID' AND winerim_wine_id='42' AND format='MAGNUM';
UPDATE public.runtime_catalog_changes
SET status='BLOCKED', lease_expires_at=NULL, completed_at=now(),
    last_error='PROVIDER_READBACK_FAILED', updated_at=now()
WHERE connection_id='$CONNECTION_ID' AND winerim_wine_id='42' AND format='MAGNUM';
RESET ROLE;
SQL

if psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 >/dev/null 2>"$TMP_ROOT/same-fingerprint-reopen.err" <<SQL
SET ROLE middleware_runtime;
UPDATE public.runtime_catalog_changes
SET status='PENDING', claimed_at=NULL, lease_expires_at=NULL, completed_at=NULL,
    last_error=NULL, available_at=now(), updated_at=now()
WHERE connection_id='$CONNECTION_ID' AND winerim_wine_id='42' AND format='MAGNUM';
SQL
then
  printf 'FAIL: runtime reopened BLOCKED catalog work with the same fingerprint\n' >&2
  exit 1
fi
grep -q 'RUNTIME_CATALOG_CHANGE_PENDING_TRANSITION_REJECTED' "$TMP_ROOT/same-fingerprint-reopen.err" || {
  printf 'FAIL: same-fingerprint BLOCKED reopen did not fail through the transition guard\n' >&2
  cat "$TMP_ROOT/same-fingerprint-reopen.err" >&2
  exit 1
}

psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 >/dev/null <<SQL
SET ROLE middleware_runtime;
UPDATE public.runtime_catalog_changes
SET status='PENDING', source_fingerprint=repeat('c',64),
    source_message_id='new-evidence-message', attempt=0,
    claimed_at=NULL, lease_expires_at=NULL, completed_at=NULL,
    last_error=NULL, available_at=now(), updated_at=now()
WHERE connection_id='$CONNECTION_ID' AND winerim_wine_id='42' AND format='MAGNUM';
RESET ROLE;

SET ROLE middleware_runtime;
INSERT INTO public.product_mappings (
  connection_id, provider_product_id, provider_product_name,
  winerim_wine_id, winerim_wine_name, match_method, match_score,
  match_reasons, status, format_type, agora_product_id, last_synced_at, last_sync_error
) VALUES (
  '$CONNECTION_ID', '500042', 'B Fixture',
  '42', 'Fixture', 'RESCUE_EXACT_ID_WINE_VARIANT', 1,
  ARRAY['EXACT_PROVIDER_READBACK', 'plan:fixture-bottle'],
  'CONFIRMED', 'BOTTLE', '500042', now(), NULL
);
RESET ROLE;

INSERT INTO public.product_mappings (
  connection_id, provider_product_id, provider_product_name,
  winerim_wine_id, winerim_wine_name, match_method, match_score,
  match_reasons, status, format_type, agora_product_id
) VALUES (
  '$CONNECTION_ID', '700042', 'C Fixture',
  '42', 'Fixture', 'RUNTIME_CATALOG_PLAN', 1,
  ARRAY['DB_PLAN_PREPARED', 'plan:fixture'], 'PENDING', 'GLASS', '700042'
);

SET ROLE middleware_runtime;
INSERT INTO public.product_mappings (
  connection_id, provider_product_id, provider_product_name,
  winerim_wine_id, winerim_wine_name, match_method, match_score,
  match_reasons, status, format_type, agora_product_id, last_synced_at, last_sync_error
) VALUES (
  '$CONNECTION_ID', '700042', 'C Fixture',
  '42', 'Fixture', 'RESCUE_EXACT_ID_WINE_VARIANT_SALES_ONLY', 1,
  ARRAY['EXACT_PROVIDER_READBACK', 'plan:fixture-glass'],
  'CONFIRMED', 'GLASS', '700042', now(), NULL
)
ON CONFLICT (connection_id, provider_product_id) DO UPDATE SET
  provider_product_name=EXCLUDED.provider_product_name,
  winerim_wine_id=EXCLUDED.winerim_wine_id,
  winerim_wine_name=EXCLUDED.winerim_wine_name,
  match_method=EXCLUDED.match_method,
  match_score=EXCLUDED.match_score,
  match_reasons=EXCLUDED.match_reasons,
  status='CONFIRMED',
  format_type=EXCLUDED.format_type,
  agora_product_id=EXCLUDED.agora_product_id,
  last_synced_at=now(), last_sync_error=NULL, updated_at=now()
WHERE product_mappings.status IN ('PENDING', 'CONFIRMED');
INSERT INTO public.winerim_push_tracking (
  connection_id, winerim_wine_id, format, agora_product_id,
  source, sync_status, last_error, pushed_at, verified_at
) VALUES (
  '$CONNECTION_ID', '42', 'BOTTLE', '500042',
  'WINERIM', 'NOT_PUSHED', NULL, NULL, NULL
);
INSERT INTO public.winerim_push_tracking (
  connection_id, winerim_wine_id, format, agora_product_id,
  source, sync_status, last_error, pushed_at, verified_at
) VALUES (
  '$CONNECTION_ID', '42', 'BOTTLE', '500042',
  'WINERIM', 'HIDDEN', NULL, now(), now()
)
ON CONFLICT (connection_id, winerim_wine_id, format) DO UPDATE SET
  agora_product_id=EXCLUDED.agora_product_id,
  source=EXCLUDED.source,
  sync_status=EXCLUDED.sync_status,
  last_error=NULL, pushed_at=now(), verified_at=now(), updated_at=now();
INSERT INTO public.winerim_push_tracking (
  connection_id, winerim_wine_id, format, agora_product_id,
  source, sync_status, last_error, pushed_at, verified_at
) VALUES (
  '$CONNECTION_ID', '42', 'GLASS', '700042',
  'WINERIM', 'VERIFIED', NULL, now(), now()
);
RESET ROLE;
SQL

psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 >/dev/null <<SQL
SET ROLE middleware_runtime;
INSERT INTO public.winerim_wines (
  connection_id, winerim_id, name, is_active, price, bottle_sale_price,
  serve_by_glass, pricing_status, raw_payload
) VALUES ('$CONNECTION_ID', '43', 'Unmapped fixture', true, 14, 14, false, 'READY', '{}'::jsonb);
RESET ROLE;
SQL

if psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 >/dev/null 2>"$TMP_ROOT/pending-mapping.err" <<SQL
SET ROLE middleware_runtime;
INSERT INTO public.product_mappings (
  connection_id, provider_product_id, provider_product_name,
  winerim_wine_id, winerim_wine_name, match_method, match_score,
  match_reasons, status, format_type, agora_product_id
) VALUES (
  '$CONNECTION_ID', '599999', 'Pending fixture',
  '43', 'Unmapped fixture', 'RUNTIME_CATALOG_PLAN', 1,
  ARRAY['DB_PLAN_PREPARED', 'plan:pending-fixture'], 'PENDING', 'BOTTLE', '599999'
);
SQL
then
  printf 'FAIL: runtime inserted a PENDING mapping through the full-lanes policy\n' >&2
  exit 1
fi
grep -Eq 'row-level security policy|new row violates row-level security' "$TMP_ROOT/pending-mapping.err" || {
  printf 'FAIL: PENDING mapping did not fail through RLS\n' >&2
  cat "$TMP_ROOT/pending-mapping.err" >&2
  exit 1
}

psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 >/dev/null <<SQL
INSERT INTO public.product_mappings (
  connection_id, provider_product_id, provider_product_name,
  winerim_wine_id, winerim_wine_name, match_method, match_score,
  match_reasons, status, format_type, agora_product_id
) VALUES (
  '$CONNECTION_ID', '599999', 'Pending fixture',
  '43', 'Unmapped fixture', 'RUNTIME_CATALOG_PLAN', 1,
  ARRAY['DB_PLAN_PREPARED', 'plan:pending-fixture'], 'PENDING', 'BOTTLE', '599999'
);
SET ROLE middleware_runtime;
INSERT INTO public.winerim_push_tracking (
  connection_id, winerim_wine_id, format, agora_product_id,
  source, sync_status, last_error, pushed_at, verified_at
) VALUES (
  '$CONNECTION_ID', '43', 'BOTTLE', '599999',
  'WINERIM', 'NOT_PUSHED', NULL, NULL, NULL
);
RESET ROLE;
SQL
if psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 >/dev/null 2>"$TMP_ROOT/false-verified.err" <<SQL
SET ROLE middleware_runtime;
UPDATE public.winerim_push_tracking
SET sync_status='VERIFIED', pushed_at=now(), verified_at=now(), last_error=NULL
WHERE connection_id='$CONNECTION_ID' AND winerim_wine_id='43' AND format='BOTTLE';
SQL
then
  printf 'FAIL: inherited tracking policy certified VERIFIED without an exact mapping\n' >&2
  exit 1
fi
test "$(psql "$DATABASE_URL" -XAtq -c "SELECT sync_status FROM public.winerim_push_tracking WHERE connection_id='$CONNECTION_ID' AND winerim_wine_id='43' AND format='BOTTLE'")" = NOT_PUSHED

test "$(psql "$DATABASE_URL" -XAtq -c "SELECT count(*) FROM public.runtime_catalog_changes WHERE connection_id='$CONNECTION_ID'")" = 2
test "$(psql "$DATABASE_URL" -XAtq -c "SELECT count(*) FROM public.runtime_catalog_changes WHERE connection_id='$CONNECTION_ID' AND status='SUCCESS' AND attempt=1")" = 1
test "$(psql "$DATABASE_URL" -XAtq -c "SELECT count(*) FROM public.runtime_catalog_changes WHERE connection_id='$CONNECTION_ID' AND format='MAGNUM' AND status='PENDING' AND attempt=0 AND source_fingerprint=repeat('c',64)")" = 1
test "$(psql "$DATABASE_URL" -XAtq -c "SELECT count(*) FROM public.product_mappings WHERE connection_id='$CONNECTION_ID' AND status='CONFIRMED' AND match_method IN ('RESCUE_EXACT_ID_WINE_VARIANT','RESCUE_EXACT_ID_WINE_VARIANT_SALES_ONLY') AND match_score=1 AND cardinality(match_reasons)=2 AND match_reasons @> ARRAY['EXACT_PROVIDER_READBACK']::text[]")" = 2
test "$(psql "$DATABASE_URL" -XAtq -c "SELECT count(*) FROM public.winerim_push_tracking WHERE connection_id='$CONNECTION_ID' AND winerim_wine_id='42' AND format='BOTTLE' AND sync_status='HIDDEN'")" = 1
test "$(psql "$DATABASE_URL" -XAtq -c "SELECT count(*) FROM public.winerim_push_tracking WHERE connection_id='$CONNECTION_ID' AND winerim_wine_id='42' AND format='GLASS' AND sync_status='VERIFIED'")" = 1
test "$(psql "$DATABASE_URL" -XAtq -c "SELECT relforcerowsecurity FROM pg_class WHERE oid='public.runtime_catalog_changes'::regclass")" = t
test "$(psql "$DATABASE_URL" -XAtq -c "SELECT NOT has_function_privilege('public','public.runtime_full_catalog_scope(uuid)','EXECUTE')")" = t
test "$(psql "$DATABASE_URL" -XAtq -c "SELECT NOT has_function_privilege('public','public.validate_runtime_catalog_change_transition()','EXECUTE')")" = t

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
