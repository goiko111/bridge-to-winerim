#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
POSTGRES_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
for command_name in initdb pg_ctl createdb dropdb psql pg_dump pg_restore node; do
  command -v "$command_name" >/dev/null 2>&1 || { printf 'BLOCKED: %s is not installed\n' "$command_name" >&2; exit 2; }
done

TMP_ROOT=$(mktemp -d /tmp/wrpf.XXXXXX)
DATA_DIR="$TMP_ROOT/data"
BACKUP_ROOT="$TMP_ROOT/backups"
SEED_SQL="$TMP_ROOT/rescue-connections-disabled.sql"
PORT=$((57432 + ($$ % 500)))
PROJECT_REF=piyvadlzagtracciquap
LOCAL_DATABASE_USER=$(id -un)
SERVER_STARTED=0

cleanup() {
  if [ "$SERVER_STARTED" = 1 ]; then pg_ctl -D "$DATA_DIR" -m fast -w stop >/dev/null 2>&1 || true; fi
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT INT TERM

initdb -D "$DATA_DIR" --auth=trust --no-locale --encoding=UTF8 >/dev/null
pg_ctl -D "$DATA_DIR" -l "$TMP_ROOT/postgres.log" -o "-h 127.0.0.1 -p $PORT" -w start >/dev/null
SERVER_STARTED=1
createdb -h 127.0.0.1 -p "$PORT" winerim_rescue_production_test
createdb -h 127.0.0.1 -p "$PORT" winerim_rescue_restore_test

cat >"$SEED_SQL" <<'SQL'
BEGIN;
INSERT INTO public.pos_connections (
  id, location_name, provider, base_url, api_token, winerim_api_token,
  enabled, catalog_sync_enabled, sync_mode, write_mode,
  sync_frequency_minutes, backfill_days, last_sync_at, last_catalog_sync_at,
  last_business_day_synced, circuit_breaker_paused_until, circuit_breaker_reason,
  consecutive_failures
)
SELECT
  ('00000000-0000-4000-8000-' || lpad(item::text, 12, '0'))::uuid,
  'Rescue connection ' || item,
  CASE WHEN item = 31 THEN 'yurest' ELSE 'agora' END,
  'https://redacted.invalid', '', NULL,
  false, false, 'PULL_ONLY', 'NONE', 5, 0,
  NULL, NULL, NULL, NULL, NULL, 0
FROM generate_series(1, 31) item;
COMMIT;
SQL

mkdir -p "$BACKUP_ROOT"
chmod 700 "$BACKUP_ROOT"
printf 'winerim-rescue-production-backup:%s\n' "$PROJECT_REF" >"$BACKUP_ROOT/.winerim-rescue-production-backup"
chmod 600 "$BACKUP_ROOT/.winerim-rescue-production-backup"

export RESCUE_PRODUCTION_PROJECT_REF="$PROJECT_REF"
export RESCUE_PRODUCTION_EXPECTED_ENVIRONMENT=rescue-production
export RESCUE_PRODUCTION_DATABASE_URL="postgresql://$LOCAL_DATABASE_USER@127.0.0.1:$PORT/winerim_rescue_production_test"
export RESCUE_PRODUCTION_SEED_SQL="$SEED_SQL"
export RESCUE_PRODUCTION_BACKUP_ROOT="$BACKUP_ROOT"
export RESCUE_PRODUCTION_EXPECTED_CONNECTIONS=31
export WINERIM_RESCUE_PRODUCTION_LOCAL_TEST=1

plan_output=$("$POSTGRES_DIR/apply-rescue-production.sh")
plan_sha=$(sed -n 's/.*plan_sha256=\([^ ]*\).*/\1/p' <<<"$plan_output")
seed_sha=$(sed -n 's/.*seed_sha256=\([^ ]*\).*/\1/p' <<<"$plan_output")
test -n "$plan_sha" && test -n "$seed_sha" || { printf 'FAIL: plan digests missing\n' >&2; exit 1; }

apply_output=$("$POSTGRES_DIR/apply-rescue-production.sh" \
  --apply \
  --confirm-project-ref "$PROJECT_REF" \
  --confirm-environment rescue-production \
  --confirm-plan-sha "$plan_sha" \
  --confirm-seed-sha "$seed_sha" \
  --confirm-action APPLY_EMPTY_RESCUE_PRODUCTION_BOOTSTRAP)
grep -q 'RESULT=RESCUE_PRODUCTION_BOOTSTRAP_APPLIED' <<<"$apply_output"
"$POSTGRES_DIR/verify-rescue-production.sh" >/dev/null

pre_artifact=$(find "$BACKUP_ROOT/$PROJECT_REF" -mindepth 1 -maxdepth 1 -type d -name '*-pre-bootstrap-*' | head -n 1)
post_artifact=$(find "$BACKUP_ROOT/$PROJECT_REF" -mindepth 1 -maxdepth 1 -type d -name '*-post-bootstrap-*' | head -n 1)
test -n "$pre_artifact" && test -n "$post_artifact"
test "$(stat -c '%a' "$pre_artifact/public.dump" 2>/dev/null || stat -f '%Lp' "$pre_artifact/public.dump")" = 600

# A custom-format schema dump contains CREATE SCHEMA public. A fresh PostgreSQL
# database already has that schema, so the documented restore must remove the
# empty default schema before replaying the exact artifact.
RESTORE_DATABASE_URL="postgresql://$LOCAL_DATABASE_USER@127.0.0.1:$PORT/winerim_rescue_restore_test"
psql "$RESTORE_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c 'DROP SCHEMA public CASCADE' >/dev/null
psql "$RESTORE_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$post_artifact/restore-prerequisites.sql" >/dev/null
pg_restore --dbname="$RESTORE_DATABASE_URL" --no-owner --exit-on-error "$post_artifact/public.dump"
restored_tables=$(psql "$RESTORE_DATABASE_URL" -XAtq -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'")
restored_connections=$(psql "$RESTORE_DATABASE_URL" -XAtq -c "SELECT count(*) FROM public.pos_connections")
restored_unsafe=$(psql "$RESTORE_DATABASE_URL" -XAtq -c "SELECT count(*) FROM public.pos_connections WHERE enabled OR catalog_sync_enabled OR sync_mode <> 'PULL_ONLY' OR write_mode <> 'NONE' OR coalesce(api_token, '') <> '' OR winerim_api_token IS NOT NULL")
test "$restored_tables" = 30 && test "$restored_connections" = 31 && test "$restored_unsafe" = 0
# Roles are cluster-wide. Remove the disposable restored database after its
# assertions so the later rollback can prove that bootstrap roles are unused.
dropdb -h 127.0.0.1 -p "$PORT" winerim_rescue_restore_test

psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "UPDATE public.pos_connections SET enabled=true WHERE id=(SELECT id FROM public.pos_connections ORDER BY id LIMIT 1)" >/dev/null
if "$POSTGRES_DIR/verify-rescue-production.sh" >/dev/null 2>&1; then
  printf 'FAIL: verifier accepted an enabled rescue connection\n' >&2
  exit 1
fi
export RESCUE_PRODUCTION_ROLLBACK_ARTIFACT_DIR="$pre_artifact"
if "$POSTGRES_DIR/rollback-rescue-production.sh" >/dev/null 2>&1; then
  printf 'FAIL: rollback accepted an enabled rescue connection\n' >&2
  exit 1
fi
psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "UPDATE public.pos_connections SET enabled=false" >/dev/null

rollback_plan=$("$POSTGRES_DIR/rollback-rescue-production.sh")
rollback_sha=$(sed -n 's/.*plan_sha256=\([^ ]*\).*/\1/p' <<<"$rollback_plan")
test -n "$rollback_sha" || { printf 'FAIL: rollback digest missing\n' >&2; exit 1; }
rollback_output=$("$POSTGRES_DIR/rollback-rescue-production.sh" \
  --apply \
  --confirm-project-ref "$PROJECT_REF" \
  --confirm-plan-sha "$rollback_sha" \
  --confirm-action ROLLBACK_UNUSED_RESCUE_PRODUCTION)
grep -q 'RESULT=RESCUE_PRODUCTION_ROLLED_BACK_TO_EMPTY' <<<"$rollback_output"

post_tables=$(psql "$RESCUE_PRODUCTION_DATABASE_URL" -XAtq -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'")
post_roles=$(psql "$RESCUE_PRODUCTION_DATABASE_URL" -XAtq -c "SELECT count(*) FROM pg_roles WHERE rolname LIKE 'middleware_%'")
test "$post_tables" = 0 && test "$post_roles" = 0

printf 'RESULT=RESCUE_PRODUCTION_FLOW_TEST_OK plan=fail_closed backups=pre_and_post post_bootstrap_restore=30_tables_31_connections_unsafe_0 seed=31_unsafe_0 rollback=empty\n'
