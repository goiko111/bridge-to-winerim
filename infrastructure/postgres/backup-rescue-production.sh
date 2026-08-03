#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/postgres-client-tools.sh"
PHASE=${1:-}
DATABASE_URL=${RESCUE_PRODUCTION_DATABASE_URL:-}
BACKUP_ROOT=${RESCUE_PRODUCTION_BACKUP_ROOT:-}

case "$PHASE" in
  pre-bootstrap|post-bootstrap|pre-rollback|post-rollback) ;;
  *) printf 'Usage: %s <pre-bootstrap|post-bootstrap|pre-rollback|post-rollback>\n' "$0" >&2; exit 2 ;;
esac

for command_name in node; do
  command -v "$command_name" >/dev/null 2>&1 || {
    printf 'BLOCKED_MISSING_COMMAND=%s\n' "$command_name" >&2
    exit 2
  }
done
if command -v sha256sum >/dev/null 2>&1; then
  SHA256=(sha256sum)
elif command -v shasum >/dev/null 2>&1; then
  SHA256=(shasum -a 256)
else
  printf 'BLOCKED_MISSING_COMMAND=sha256sum_or_shasum\n' >&2
  exit 2
fi

test -n "$DATABASE_URL" || { printf 'RESCUE_PRODUCTION_DATABASE_URL_REQUIRED\n' >&2; exit 2; }
test -n "$BACKUP_ROOT" || { printf 'RESCUE_PRODUCTION_BACKUP_ROOT_REQUIRED\n' >&2; exit 2; }
case "$BACKUP_ROOT" in /*) ;; *) printf 'ABSOLUTE_BACKUP_ROOT_REQUIRED\n' >&2; exit 2 ;; esac

target_json=$(node "$SCRIPT_DIR/rescue-production-target.mjs")
project_ref=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).projectRef)' "$target_json")
target_mode=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).mode)' "$target_json")

if [ "$target_mode" != local-disposable ]; then
  test "${GITHUB_ACTIONS:-false}" != true || {
    printf 'DURABLE_BACKUP_HOST_REQUIRED_GITHUB_RUNNER_REJECTED\n' >&2
    exit 3
  }
  case "$BACKUP_ROOT" in
    /tmp|/tmp/*|/private/tmp|/private/tmp/*|/var/tmp|/var/tmp/*|/private/var/tmp|/private/var/tmp/*|/dev/shm|/dev/shm/*|/run|/run/*|/var/folders|/var/folders/*|/private/var/folders|/private/var/folders/*)
      printf 'DURABLE_BACKUP_ROOT_REQUIRED\n' >&2; exit 3 ;;
  esac
  test "${WINERIM_RESCUE_PRODUCTION_BACKUP_CONFIRMED:-}" = YES_ENCRYPTED_DURABLE_VOLUME || {
    printf 'ENCRYPTED_DURABLE_BACKUP_CONFIRMATION_REQUIRED\n' >&2; exit 3;
  }
fi

mkdir -p "$BACKUP_ROOT"
chmod 700 "$BACKUP_ROOT"
backup_root_real=$(CDPATH= cd -- "$BACKUP_ROOT" && pwd -P)
marker="$backup_root_real/.winerim-rescue-production-backup"
test -f "$marker" || { printf 'RESCUE_PRODUCTION_BACKUP_MARKER_REQUIRED\n' >&2; exit 3; }
test "$(cat "$marker")" = "winerim-rescue-production-backup:$project_ref" || {
  printf 'RESCUE_PRODUCTION_BACKUP_MARKER_REJECTED\n' >&2; exit 3;
}
marker_mode=$(stat -c '%a' "$marker" 2>/dev/null || stat -f '%Lp' "$marker")
test "$marker_mode" = 600 || { printf 'RESCUE_PRODUCTION_BACKUP_MARKER_MODE_REJECTED\n' >&2; exit 3; }

READ_ONLY_OPTIONS="${PGOPTIONS:+$PGOPTIONS }-c default_transaction_read_only=on -c statement_timeout=30000 -c lock_timeout=2000"
query() {
  PGOPTIONS="$READ_ONLY_OPTIONS" "$PSQL_CMD" "$DATABASE_URL" -XAtq -v ON_ERROR_STOP=1 -c "$1"
}

configure_postgres_tools "$DATABASE_URL"

connected_database=$(query 'SELECT current_database()')
expected_database=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).database)' "$target_json")
test "$connected_database" = "$expected_database" || { printf 'CONNECTED_DATABASE_IDENTITY_MISMATCH\n' >&2; exit 3; }

metadata_exists=$(query "SELECT (to_regclass('public.infrastructure_metadata') IS NOT NULL)::int")
if [ "$metadata_exists" = 1 ]; then
  environment=$(query "SELECT coalesce((SELECT value FROM public.infrastructure_metadata WHERE key='environment'), 'missing-row')")
else
  environment=absent
fi
case "$PHASE" in
  pre-bootstrap)
    test "$environment" = absent || { printf 'PRE_BOOTSTRAP_ENVIRONMENT_REJECTED\n' >&2; exit 3; }
    ;;
  post-bootstrap|pre-rollback)
    test "$environment" = rescue-production || { printf 'RESCUE_PRODUCTION_SENTINEL_MISMATCH\n' >&2; exit 3; }
    ;;
  post-rollback)
    test "$environment" = absent || { printf 'POST_ROLLBACK_ENVIRONMENT_REJECTED\n' >&2; exit 3; }
    ;;
esac

stamp=$(date -u +%Y%m%dT%H%M%SZ)
artifact_dir="$backup_root_real/$project_ref/$stamp-$PHASE-$$"
mkdir -p "$artifact_dir"
chmod 700 "$artifact_dir"
dump="$artifact_dir/public.dump"
toc="$artifact_dir/public.toc"
roles="$artifact_dir/roles.tsv"
memberships="$artifact_dir/memberships.tsv"
inventory="$artifact_dir/public-tables.tsv"
prerequisites="$artifact_dir/restore-prerequisites.sql"
manifest="$artifact_dir/manifest.txt"
manifest_digest="$artifact_dir/manifest.txt.sha256"

"$PG_DUMP_CMD" "$DATABASE_URL" --schema=public --format=custom --no-owner --file="$dump"
"$PG_RESTORE_CMD" --list "$dump" >"$toc"
query "SELECT rolname, rolcanlogin, rolinherit, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname LIKE 'middleware_%' ORDER BY rolname" >"$roles"
query "SELECT granted.rolname, member.rolname, membership.admin_option FROM pg_auth_members membership JOIN pg_roles granted ON granted.oid=membership.roleid JOIN pg_roles member ON member.oid=membership.member WHERE granted.rolname LIKE 'middleware_%' OR member.rolname LIKE 'middleware_%' ORDER BY granted.rolname, member.rolname" >"$memberships"
query "SELECT c.relname, (xpath('/row/count/text()', query_to_xml(format('SELECT count(*) AS count FROM public.%I', c.relname), false, true, '')))[1]::text::bigint FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' ORDER BY c.relname" >"$inventory"

cat >"$prerequisites" <<'SQL'
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN
    CREATE ROLE supabase_admin NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN
    CREATE ROLE postgres NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'middleware_api') THEN
    CREATE ROLE middleware_api NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'middleware_runtime') THEN
    CREATE ROLE middleware_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'middleware_readonly') THEN
    CREATE ROLE middleware_readonly NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$roles$;
SQL

chmod 600 "$dump" "$toc" "$roles" "$memberships" "$inventory" "$prerequisites"
dump_sha=$("${SHA256[@]}" "$dump" | awk '{print $1}')
toc_sha=$("${SHA256[@]}" "$toc" | awk '{print $1}')
roles_sha=$("${SHA256[@]}" "$roles" | awk '{print $1}')
memberships_sha=$("${SHA256[@]}" "$memberships" | awk '{print $1}')
inventory_sha=$("${SHA256[@]}" "$inventory" | awk '{print $1}')
prerequisites_sha=$("${SHA256[@]}" "$prerequisites" | awk '{print $1}')
table_count=$(wc -l <"$inventory" | tr -d ' ')
printf 'schema_version=2\nproject_ref=%s\nexpected_environment=rescue-production\nobserved_environment=%s\nphase=%s\npublic_table_count=%s\ndump_sha256=%s\ntoc_sha256=%s\nroles_sha256=%s\nmemberships_sha256=%s\ninventory_sha256=%s\nrestore_prerequisites_sha256=%s\n' \
  "$project_ref" "$environment" "$PHASE" "$table_count" "$dump_sha" "$toc_sha" "$roles_sha" "$memberships_sha" "$inventory_sha" "$prerequisites_sha" >"$manifest"
chmod 600 "$manifest"
(cd "$artifact_dir" && "${SHA256[@]}" manifest.txt) >"$manifest_digest"
chmod 600 "$manifest_digest"

printf 'RESCUE_PRODUCTION_BACKUP_OK phase=%s project_ref=%s public_tables=%s artifact_dir=%s manifest_sha256=%s\n' \
  "$PHASE" "$project_ref" "$table_count" "$artifact_dir" "$(awk '{print $1}' "$manifest_digest")"
