#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
for command_name in initdb pg_ctl createdb psql sha256sum; do
  command -v "$command_name" >/dev/null 2>&1 || { printf 'BLOCKED: %s is not installed\n' "$command_name" >&2; exit 2; }
done

TMP_ROOT=$(mktemp -d /tmp/wrut.XXXXXX)
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
BACKUP_DIR="$TMP_ROOT/encrypted-fixture-volume"
BIN_DIR="$TMP_ROOT/bin"
PG_DUMP_LOG="$TMP_ROOT/pg-dump-args.log"
PORT=$((57432 + ($$ % 500)))
SERVER_STARTED=0
cleanup() {
  if [ "$SERVER_STARTED" -eq 1 ]; then pg_ctl -D "$DATA_DIR" -m fast -w stop >/dev/null 2>&1 || true; fi
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT INT TERM

mkdir -p "$SOCKET_DIR" "$BACKUP_DIR" "$BIN_DIR"
chmod 700 "$BACKUP_DIR"
printf '%s' 'winerim-staging-backup:qpbmqvfnunkylvtvnyyx' >"$BACKUP_DIR/.winerim-encrypted-durable-volume"
chmod 600 "$BACKUP_DIR/.winerim-encrypted-durable-volume"
REAL_PG_DUMP=$(command -v pg_dump)
cat >"$BIN_DIR/pg_dump" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" >>"$PG_DUMP_LOG"
exec "$REAL_PG_DUMP" "$@"
SH
chmod 700 "$BIN_DIR/pg_dump"
export REAL_PG_DUMP PG_DUMP_LOG
initdb -D "$DATA_DIR" --auth=trust --no-locale --encoding=UTF8 >/dev/null
if ! pg_ctl -D "$DATA_DIR" -l "$TMP_ROOT/postgres.log" -o "-h 127.0.0.1 -k '$SOCKET_DIR' -p $PORT" -w start >/dev/null; then
  tail -n 20 "$TMP_ROOT/postgres.log" >&2 || true
  exit 1
fi
SERVER_STARTED=1
createdb -h 127.0.0.1 -p "$PORT" winerim_runtime_upgrade_test

full_bootstrap="$TMP_ROOT/full.sql"
pre_bootstrap="$TMP_ROOT/pre.sql"
"$SCRIPT_DIR/build-bootstrap.sh" "$full_bootstrap" >/dev/null
awk '/-- BEGIN runtime credential vault schema/{exit} {print}' "$full_bootstrap" >"$pre_bootstrap"
psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$PORT" -d winerim_runtime_upgrade_test \
  -v environment=staging -f "$pre_bootstrap" >/dev/null

database_url="postgresql://$(id -un)@127.0.0.1:$PORT/winerim_runtime_upgrade_test"
plan=$(WINERIM_LOCAL_DISPOSABLE_UPGRADE_TEST=1 \
  "$SCRIPT_DIR/upgrade-staging-runtime.sh" --database-url "$database_url")
plan_sha=$(printf '%s\n' "$plan" | sed -n 's/.*plan_sha256=\([0-9a-f]\{64\}\).*/\1/p')
test -n "$plan_sha" || { printf 'LOCAL_UPGRADE_PLAN_DIGEST_MISSING\n' >&2; exit 1; }

WINERIM_LOCAL_DISPOSABLE_UPGRADE_TEST=1 \
WINERIM_ENCRYPTED_BACKUP_DIR_CONFIRMED=YES_ENCRYPTED_VOLUME \
PATH="$BIN_DIR:$PATH" \
  "$SCRIPT_DIR/upgrade-staging-runtime.sh" \
  --database-url "$database_url" \
  --backup-dir "$BACKUP_DIR" \
  --apply \
  --confirm-project-ref local-disposable-test \
  --confirm-upgrade runtime-0003-0005-only \
  --confirm-plan-sha "$plan_sha" >/dev/null

grep -Fxq -- '--schema=public' "$PG_DUMP_LOG" || {
  printf 'LOCAL_UPGRADE_PG_DUMP_PUBLIC_SCHEMA_REQUIRED\n' >&2
  exit 1
}

post_tables=$(psql -XAtq -h 127.0.0.1 -p "$PORT" -d winerim_runtime_upgrade_test -c \
  "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r'")
test "$post_tables" = 30 || { printf 'LOCAL_UPGRADE_POST_TABLES=%s\n' "$post_tables" >&2; exit 1; }

noop=$(WINERIM_LOCAL_DISPOSABLE_UPGRADE_TEST=1 \
  "$SCRIPT_DIR/upgrade-staging-runtime.sh" --database-url "$database_url")
grep -q 'RUNTIME_STAGING_ALREADY_UPGRADED exact_tables=30' <<<"$noop" || {
  printf 'LOCAL_UPGRADE_EXACT_30_NOT_NOOP\n' >&2; exit 1;
}

psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$PORT" -d winerim_runtime_upgrade_test \
  -f "$SCRIPT_DIR/rollback-runtime-upgrade.sql" >/dev/null
psql -XAtq -h 127.0.0.1 -p "$PORT" -d winerim_runtime_upgrade_test -c \
  "select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' order by c.relname" \
  >"$TMP_ROOT/rolled-back-tables.txt"
diff -u "$SCRIPT_DIR/expected-tables-runtime-preupgrade.txt" "$TMP_ROOT/rolled-back-tables.txt"

psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$PORT" -d winerim_runtime_upgrade_test \
  -f "$SCRIPT_DIR/0003_runtime_connection_credentials.sql" >/dev/null
if WINERIM_LOCAL_DISPOSABLE_UPGRADE_TEST=1 \
  "$SCRIPT_DIR/upgrade-staging-runtime.sh" --database-url "$database_url" >"$TMP_ROOT/partial.out" 2>&1; then
  printf 'LOCAL_UPGRADE_PARTIAL_29_UNEXPECTEDLY_ACCEPTED\n' >&2
  exit 1
fi
grep -q 'RUNTIME_STAGING_PREINVENTORY_REJECTED' "$TMP_ROOT/partial.out" || {
  printf 'LOCAL_UPGRADE_PARTIAL_29_FAILURE_NOT_SPECIFIC\n' >&2; exit 1;
}

for suffix in dump manifest manifest.sha256 toc roles.tsv memberships.tsv data.tsv; do
  artifact_count=$(find "$BACKUP_DIR" -type f -name "*.$suffix" | wc -l | tr -d ' ')
  test "$artifact_count" = 1 || { printf 'LOCAL_UPGRADE_BACKUP_ARTIFACT_INVALID=%s\n' "$suffix" >&2; exit 1; }
done
printf 'RESULT=LOCAL_RUNTIME_UPGRADE_RESTORE_ROLLBACK_OK pre_tables=28 post_tables=30 rollback_tables=28\n'
