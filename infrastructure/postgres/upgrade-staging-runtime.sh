#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DATABASE_URL=${STAGING_DATABASE_URL:-}
BACKUP_DIR=${STAGING_ENCRYPTED_BACKUP_DIR:-}
APPLY=0
CONFIRM_PROJECT_REF=""
CONFIRM_PLAN_SHA=""
CONFIRM_UPGRADE=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --database-url) DATABASE_URL=${2:-}; shift 2 ;;
    --backup-dir) BACKUP_DIR=${2:-}; shift 2 ;;
    --apply) APPLY=1; shift ;;
    --confirm-project-ref) CONFIRM_PROJECT_REF=${2:-}; shift 2 ;;
    --confirm-plan-sha) CONFIRM_PLAN_SHA=${2:-}; shift 2 ;;
    --confirm-upgrade) CONFIRM_UPGRADE=${2:-}; shift 2 ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done

for command_name in node psql pg_dump pg_restore initdb pg_ctl createdb sha256sum; do
  command -v "$command_name" >/dev/null 2>&1 || {
    printf 'BLOCKED_MISSING_COMMAND=%s\n' "$command_name" >&2
    exit 2
  }
done
test -n "$DATABASE_URL" || { printf 'STAGING_DATABASE_URL_REQUIRED\n' >&2; exit 2; }

target_json=$(STAGING_DATABASE_URL="$DATABASE_URL" node "$SCRIPT_DIR/staging-target.mjs")
project_ref=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).projectRef)' "$target_json")
target_mode=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).mode)' "$target_json")

TMP_ROOT=$(mktemp -d /tmp/wru.XXXXXX)
cleanup() { rm -rf "$TMP_ROOT"; }
trap cleanup EXIT INT TERM

query() {
  PGOPTIONS='-c statement_timeout=15000 -c lock_timeout=2000' \
    psql "$DATABASE_URL" -XAtq -v ON_ERROR_STOP=1 -c "$1"
}

write_data_fingerprint() {
  local output=$1
  : >"$output"
  while IFS= read -r table_name; do
    query "SELECT '$table_name' || E'\\t' || count(*) || E'\\t' || coalesce(md5(string_agg(row_json, E'\\n' ORDER BY row_json)), md5('')) FROM (SELECT row_to_json(item)::text AS row_json FROM public.\"$table_name\" item) rows" >>"$output"
  done <"$SCRIPT_DIR/expected-tables-runtime-preupgrade.txt"
}

connected_database=$(query 'select current_database()')
test "$connected_database" = "$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).database)' "$target_json")" || {
  printf 'CONNECTED_DATABASE_IDENTITY_MISMATCH\n' >&2; exit 3;
}
sentinel=$(query "select value from public.infrastructure_metadata where key='environment'")
test "$sentinel" = staging || { printf 'STAGING_SENTINEL_MISMATCH\n' >&2; exit 3; }

query "select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' order by c.relname" >"$TMP_ROOT/actual-tables.txt"
if ! diff -u "$SCRIPT_DIR/expected-tables-runtime-preupgrade.txt" "$TMP_ROOT/actual-tables.txt" >"$TMP_ROOT/inventory.diff"; then
  if diff -u "$SCRIPT_DIR/expected-tables-runtime-postupgrade.txt" "$TMP_ROOT/actual-tables.txt" >/dev/null; then
    printf 'RUNTIME_STAGING_ALREADY_UPGRADED exact_tables=30\n'
    exit 0
  fi
  printf 'RUNTIME_STAGING_PREINVENTORY_REJECTED actual_sha256=%s\n' "$(sha256sum "$TMP_ROOT/actual-tables.txt" | awk '{print $1}')" >&2
  exit 3
fi
pre_contract=$(query "SELECT ((SELECT count(*) FROM pg_policies WHERE schemaname='public' AND policyname='middleware_runtime_all')=28 AND (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND has_table_privilege('middleware_runtime', c.oid, 'SELECT,INSERT,UPDATE,DELETE'))=28 AND has_table_privilege('middleware_runtime','public.stock_sync_log','SELECT,INSERT,UPDATE,DELETE'))::int")
test "$pre_contract" = 1 || {
  printf 'RUNTIME_STAGING_PRECONTRACT_REJECTED possible_partial_0004=1\n' >&2
  exit 3
}

plan_sha=$(cat \
  "$SCRIPT_DIR/0003_runtime_connection_credentials.sql" \
  "$SCRIPT_DIR/0004_runtime_canary_least_privilege.sql" \
  "$SCRIPT_DIR/0005_runtime_canary_connection_scope.sql" \
  "$SCRIPT_DIR/rollback-runtime-upgrade.sql" \
  | sha256sum | awk '{print $1}')
printf 'RUNTIME_STAGING_UPGRADE_PLAN_OK project_ref=%s pre_tables=28 post_tables=30 plan_sha256=%s\n' "$project_ref" "$plan_sha"

if [ "$APPLY" -ne 1 ]; then
  printf 'RESULT=PLAN_ONLY\n'
  exit 0
fi

test "$CONFIRM_PROJECT_REF" = "$project_ref" || { printf 'CONFIRM_PROJECT_REF_REJECTED\n' >&2; exit 4; }
test "$CONFIRM_UPGRADE" = runtime-0003-0005-only || { printf 'CONFIRM_UPGRADE_REJECTED\n' >&2; exit 4; }
test "$CONFIRM_PLAN_SHA" = "$plan_sha" || { printf 'CONFIRM_PLAN_SHA_REJECTED\n' >&2; exit 4; }
test "${WINERIM_ENCRYPTED_BACKUP_DIR_CONFIRMED:-}" = YES_ENCRYPTED_VOLUME || {
  printf 'ENCRYPTED_BACKUP_DIR_CONFIRMATION_REQUIRED\n' >&2; exit 4;
}
test -n "$BACKUP_DIR" || { printf 'STAGING_ENCRYPTED_BACKUP_DIR_REQUIRED\n' >&2; exit 4; }
if [ "$target_mode" != local-disposable ]; then
  test "${GITHUB_ACTIONS:-false}" != true || {
    printf 'DURABLE_BACKUP_HOST_REQUIRED_GITHUB_RUNNER_REJECTED\n' >&2; exit 4;
  }
  case "$BACKUP_DIR" in /*) ;; *) printf 'ABSOLUTE_BACKUP_DIRECTORY_REQUIRED\n' >&2; exit 4 ;; esac
fi
mkdir -p "$BACKUP_DIR"
backup_dir_real=$(CDPATH= cd -- "$BACKUP_DIR" && pwd -P)
if [ "$target_mode" != local-disposable ]; then
  case "$backup_dir_real" in
    /tmp|/tmp/*|/private/tmp|/private/tmp/*|/var/tmp|/var/tmp/*|/private/var/tmp|/private/var/tmp/*|/dev/shm|/dev/shm/*|/run|/run/*|/var/folders|/var/folders/*|/private/var/folders|/private/var/folders/*)
      printf 'DURABLE_BACKUP_DIRECTORY_REQUIRED\n' >&2; exit 4 ;;
  esac
fi
chmod 700 "$BACKUP_DIR"
test "$(stat -c '%a' "$BACKUP_DIR" 2>/dev/null || stat -f '%Lp' "$BACKUP_DIR")" = 700 || {
  printf 'BACKUP_DIRECTORY_MODE_REJECTED\n' >&2; exit 4;
}
backup_volume_marker="$BACKUP_DIR/.winerim-encrypted-durable-volume"
test -f "$backup_volume_marker" || { printf 'DURABLE_BACKUP_VOLUME_MARKER_REQUIRED\n' >&2; exit 4; }
test "$(cat "$backup_volume_marker")" = "winerim-staging-backup:qpbmqvfnunkylvtvnyyx" || {
  printf 'DURABLE_BACKUP_VOLUME_MARKER_REJECTED\n' >&2; exit 4;
}
test "$(stat -c '%a' "$backup_volume_marker" 2>/dev/null || stat -f '%Lp' "$backup_volume_marker")" = 600 || {
  printf 'BACKUP_VOLUME_MARKER_MODE_REJECTED\n' >&2; exit 4;
}

stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup="$BACKUP_DIR/staging-runtime-preupgrade-$stamp.dump"
manifest="$BACKUP_DIR/staging-runtime-preupgrade-$stamp.manifest"
manifest_digest="$BACKUP_DIR/staging-runtime-preupgrade-$stamp.manifest.sha256"
toc="$BACKUP_DIR/staging-runtime-preupgrade-$stamp.toc"
roles="$BACKUP_DIR/staging-runtime-preupgrade-$stamp.roles.tsv"
memberships="$BACKUP_DIR/staging-runtime-preupgrade-$stamp.memberships.tsv"
data_fingerprint="$BACKUP_DIR/staging-runtime-preupgrade-$stamp.data.tsv"
pg_dump "$DATABASE_URL" --schema=public --format=custom --no-owner --file="$backup"
pg_restore --list "$backup" >"$toc"
query "SELECT rolname, rolcanlogin, rolinherit, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname IN ('authenticated','service_role','middleware_api','middleware_api_login','middleware_migrator','middleware_readonly','middleware_runtime','middleware_runtime_login') ORDER BY rolname" >"$roles"
query "SELECT granted.rolname, member.rolname, membership.admin_option FROM pg_auth_members membership JOIN pg_roles granted ON granted.oid=membership.roleid JOIN pg_roles member ON member.oid=membership.member WHERE granted.rolname LIKE 'middleware_%' OR member.rolname LIKE 'middleware_%' ORDER BY granted.rolname, member.rolname" >"$memberships"
write_data_fingerprint "$data_fingerprint"
chmod 600 "$backup" "$toc" "$roles" "$memberships" "$data_fingerprint"
backup_sha=$(sha256sum "$backup" | awk '{print $1}')
toc_sha=$(sha256sum "$toc" | awk '{print $1}')
roles_sha=$(sha256sum "$roles" | awk '{print $1}')
memberships_sha=$(sha256sum "$memberships" | awk '{print $1}')
data_sha=$(sha256sum "$data_fingerprint" | awk '{print $1}')
printf 'schema_version=1\nproject_ref=%s\nenvironment=staging\npre_tables=28\nplan_sha256=%s\nbackup_sha256=%s\ntoc_sha256=%s\nroles_sha256=%s\nmemberships_sha256=%s\ndata_sha256=%s\n' \
  "$project_ref" "$plan_sha" "$backup_sha" "$toc_sha" "$roles_sha" "$memberships_sha" "$data_sha" >"$manifest"
chmod 600 "$manifest"
(cd "$BACKUP_DIR" && sha256sum "$(basename "$manifest")") >"$manifest_digest"
chmod 600 "$manifest_digest"

RESTORE_DATA="$TMP_ROOT/restore-data"
RESTORE_SOCKET="$TMP_ROOT/restore-socket"
mkdir -p "$RESTORE_SOCKET"
initdb -D "$RESTORE_DATA" --auth=trust --no-locale --encoding=UTF8 >/dev/null
RESTORE_PORT=$((56500 + ($$ % 500)))
pg_ctl -D "$RESTORE_DATA" -o "-h '' -k '$RESTORE_SOCKET' -p $RESTORE_PORT" -w start >/dev/null
restore_cleanup() { pg_ctl -D "$RESTORE_DATA" -m fast -w stop >/dev/null 2>&1 || true; }
trap 'restore_cleanup; cleanup' EXIT INT TERM
createdb -h "$RESTORE_SOCKET" -p "$RESTORE_PORT" winerim_restore_test
psql -X -v ON_ERROR_STOP=1 -h "$RESTORE_SOCKET" -p "$RESTORE_PORT" -d winerim_restore_test -f "$SCRIPT_DIR/bootstrap-prelude.sql" >/dev/null
psql -X -v ON_ERROR_STOP=1 -h "$RESTORE_SOCKET" -p "$RESTORE_PORT" -d winerim_restore_test -c \
  'CREATE ROLE postgres NOLOGIN; CREATE ROLE supabase_admin NOLOGIN; CREATE ROLE anon NOLOGIN; CREATE ROLE middleware_api NOLOGIN; CREATE ROLE middleware_readonly NOLOGIN; CREATE ROLE middleware_runtime NOLOGIN; CREATE ROLE middleware_migrator NOLOGIN; CREATE ROLE middleware_api_login NOLOGIN; CREATE ROLE middleware_runtime_login NOLOGIN;' >/dev/null
psql -X -v ON_ERROR_STOP=1 -h "$RESTORE_SOCKET" -p "$RESTORE_PORT" -d winerim_restore_test -c \
  'DROP SCHEMA public CASCADE;' >/dev/null
pg_restore --exit-on-error --no-owner -h "$RESTORE_SOCKET" -p "$RESTORE_PORT" -d winerim_restore_test "$backup" >/dev/null
restored_tables=$(psql -XAtq -h "$RESTORE_SOCKET" -p "$RESTORE_PORT" -d winerim_restore_test -c \
  "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r'")
test "$restored_tables" = 28 || { printf 'BACKUP_RESTORE_TEST_FAILED\n' >&2; exit 5; }
restore_cleanup
trap cleanup EXIT INT TERM

combined_migration="$TMP_ROOT/runtime-upgrade-0003-0005.sql"
{
  printf '\\set ON_ERROR_STOP on\nBEGIN;\n'
  printf "SET LOCAL lock_timeout = '2s';\nSET LOCAL statement_timeout = '30s';\n"
  printf "SELECT pg_advisory_xact_lock(hashtextextended('winerim-runtime-upgrade-qpbmqvfnunkylvtvnyyx', 0));\n"
  for migration in 0003_runtime_connection_credentials.sql 0004_runtime_canary_least_privilege.sql 0005_runtime_canary_connection_scope.sql; do
    printf '\n-- BEGIN %s\n' "$migration"
    awk '!/^\\set / && !/^BEGIN;$/ && !/^COMMIT;$/' "$SCRIPT_DIR/$migration"
    printf '\n-- END %s\n' "$migration"
  done
  printf '\nCOMMIT;\n'
} >"$combined_migration"
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$combined_migration" >/dev/null
query "select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' order by c.relname" >"$TMP_ROOT/post-tables.txt"
diff -u "$SCRIPT_DIR/expected-tables-runtime-postupgrade.txt" "$TMP_ROOT/post-tables.txt" >/dev/null || {
  printf 'RUNTIME_STAGING_POSTINVENTORY_FAILED\n' >&2; exit 6;
}
empty_runtime=$(query 'select ((select count(*) from public.runtime_connection_credentials)=0 and (select count(*) from public.runtime_canary_connections)=0)::int')
post_contract=$(query "SELECT ((SELECT count(*) FROM pg_policies WHERE schemaname='public' AND policyname='middleware_runtime_all')=0 AND NOT has_table_privilege('middleware_runtime','public.stock_sync_log','SELECT,INSERT,UPDATE,DELETE') AND to_regclass('public.runtime_canary_connections_single_active_idx') IS NOT NULL AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='enforce_runtime_canary_connection_window' AND NOT tgisinternal))::int")
write_data_fingerprint "$TMP_ROOT/post-data.tsv"
diff -u "$data_fingerprint" "$TMP_ROOT/post-data.tsv" >/dev/null || { printf 'RUNTIME_STAGING_DATA_CHANGED\n' >&2; exit 6; }
test "$empty_runtime" = 1 && test "$post_contract" = 1 || { printf 'RUNTIME_STAGING_POSTVERIFY_FAILED\n' >&2; exit 6; }
printf 'RESULT=RUNTIME_STAGING_UPGRADED backup_sha256=%s manifest=%s manifest_digest=%s rollback=%s\n' "$backup_sha" "$manifest" "$manifest_digest" "$SCRIPT_DIR/rollback-runtime-upgrade.sql"
