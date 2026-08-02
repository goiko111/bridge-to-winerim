#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
POSTGRES_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
VERIFY="$POSTGRES_DIR/verify-staging.sh"

for command_name in initdb pg_ctl createdb psql; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'BLOCKED: %s is not installed\n' "$command_name" >&2
    exit 2
  fi
done

# Keep the Unix socket path below PostgreSQL's platform limit on macOS.
TMP_ROOT=$(mktemp -d /tmp/wvs.XXXXXX)
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
WRAPPER_DIR="$TMP_ROOT/bin"
QUERY_LOG="$TMP_ROOT/queries.log"
WRAPPER_ERROR="$TMP_ROOT/psql-wrapper-error.log"
PORT=$((56432 + ($$ % 1000)))
DB_NAME=winerim_verify_staging_test
REAL_PSQL=$(command -v psql)
SERVER_STARTED=0

cleanup() {
  if [ "$SERVER_STARTED" -eq 1 ]; then
    pg_ctl -D "$DATA_DIR" -m fast -w stop >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT INT TERM

mkdir -p "$SOCKET_DIR" "$WRAPPER_DIR"
initdb -D "$DATA_DIR" --auth=trust --no-locale --encoding=UTF8 >/dev/null
if ! pg_ctl -D "$DATA_DIR" -l "$TMP_ROOT/postgres.log" -o "-h '' -k '$SOCKET_DIR' -p $PORT" -w start >/dev/null; then
  printf 'FAIL: disposable PostgreSQL did not start\n' >&2
  tail -n 20 "$TMP_ROOT/postgres.log" >&2 || true
  exit 1
fi
SERVER_STARTED=1
createdb -h "$SOCKET_DIR" -p "$PORT" "$DB_NAME"

"$REAL_PSQL" -X -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -d "$DB_NAME" >/dev/null <<'SQL'
CREATE TABLE public.infrastructure_metadata (
  key text PRIMARY KEY,
  value text NOT NULL
);
INSERT INTO public.infrastructure_metadata (key, value)
VALUES ('environment', 'staging');

DO $tables$
BEGIN
  FOR number IN 1..27 LOOP
    EXECUTE format('CREATE TABLE public.verify_table_%s (id bigint PRIMARY KEY)', number);
  END LOOP;
END
$tables$;

DO $rls$
DECLARE
  table_record record;
BEGIN
  FOR table_record IN
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_record.tablename);
  END LOOP;
END
$rls$;

CREATE ROLE middleware_api NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE middleware_readonly NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE middleware_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE middleware_api_login LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT;
CREATE ROLE middleware_runtime_login LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT;
GRANT middleware_api TO middleware_api_login;
GRANT middleware_runtime TO middleware_runtime_login;

CREATE FUNCTION public.verify_security_definer()
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
AS 'SELECT 1';
REVOKE ALL ON FUNCTION public.verify_security_definer() FROM PUBLIC;
SQL

cat >"$WRAPPER_DIR/psql" <<'WRAPPER'
#!/usr/bin/env bash
set -euo pipefail

arguments=("$@")
sql=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    -c)
      shift
      sql=${1:-}
      ;;
  esac
  shift || true
done

if [[ ! "$sql" =~ ^[[:space:]]*SELECT[[:space:]] ]]; then
  printf 'Verifier issued a non-SELECT statement\n' >&2
  exit 90
fi

printf '%s\n' "$sql" >>"$VERIFY_QUERY_LOG"
if "$REAL_PSQL" "${arguments[@]}" 2>"$PSQL_WRAPPER_ERROR"; then
  exit 0
else
  status=$?
fi
cat "$PSQL_WRAPPER_ERROR" >&2
exit "$status"
WRAPPER
chmod +x "$WRAPPER_DIR/psql"

DSN="host=$SOCKET_DIR port=$PORT dbname=$DB_NAME application_name=verify-staging-secret-sentinel"

run_verify() {
  PATH="$WRAPPER_DIR:$PATH" \
    REAL_PSQL="$REAL_PSQL" \
    PSQL_WRAPPER_ERROR="$WRAPPER_ERROR" \
    VERIFY_QUERY_LOG="$QUERY_LOG" \
    "$VERIFY" "$DSN" 2>&1
}

assert_dsn_hidden() {
  local output=$1
  local scenario=$2

  if grep -Fq "$DSN" <<<"$output"; then
    printf 'FAIL: verifier printed its DSN during %s\n' "$scenario" >&2
    exit 1
  fi
}

if ! success_output=$(run_verify); then
  printf 'FAIL: valid staging verifier execution failed\n%s\n' "$success_output" >&2
  sed 's/verify-staging-secret-sentinel/[REDACTED_TEST_SENTINEL]/g' "$WRAPPER_ERROR" >&2 || true
  exit 1
fi
assert_dsn_hidden "$success_output" 'success'
if ! grep -q '^RESULT=STAGING_VERIFY_OK$' <<<"$success_output"; then
  printf 'FAIL: valid staging did not pass\n%s\n' "$success_output" >&2
  exit 1
fi
if [ ! -s "$QUERY_LOG" ]; then
  printf 'FAIL: verifier did not issue any catalog queries\n' >&2
  exit 1
fi

"$REAL_PSQL" -X -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -d "$DB_NAME" \
  -c "UPDATE public.infrastructure_metadata SET value = 'production' WHERE key = 'environment'" >/dev/null
if environment_output=$(run_verify); then
  printf 'FAIL: non-staging environment unexpectedly passed\n' >&2
  exit 1
fi
assert_dsn_hidden "$environment_output" 'environment failure'
if ! grep -q 'environment_staging_rows expected=1 actual=0' <<<"$environment_output"; then
  printf 'FAIL: non-staging environment failure was not specific\n%s\n' "$environment_output" >&2
  exit 1
fi

"$REAL_PSQL" -X -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -d "$DB_NAME" >/dev/null <<'SQL'
UPDATE public.infrastructure_metadata SET value = 'staging' WHERE key = 'environment';
GRANT EXECUTE ON FUNCTION public.verify_security_definer() TO PUBLIC;
SQL
if public_execute_output=$(run_verify); then
  printf 'FAIL: PUBLIC EXECUTE on SECURITY DEFINER unexpectedly passed\n' >&2
  exit 1
fi
assert_dsn_hidden "$public_execute_output" 'PUBLIC EXECUTE failure'
if ! grep -q 'public_security_definer_with_public_execute expected=0 actual=1' <<<"$public_execute_output"; then
  printf 'FAIL: PUBLIC EXECUTE failure was not specific\n%s\n' "$public_execute_output" >&2
  exit 1
fi

"$REAL_PSQL" -X -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -d "$DB_NAME" >/dev/null <<'SQL'
REVOKE EXECUTE ON FUNCTION public.verify_security_definer() FROM PUBLIC;
GRANT middleware_readonly TO middleware_api_login;
SQL
if membership_output=$(run_verify); then
  printf 'FAIL: API LOGIN with an extra membership unexpectedly passed\n' >&2
  exit 1
fi
assert_dsn_hidden "$membership_output" 'membership failure'
if ! grep -q 'api_login_members_unsafe expected=0 actual=1' <<<"$membership_output"; then
  printf 'FAIL: LOGIN membership failure was not specific\n%s\n' "$membership_output" >&2
  exit 1
fi

printf 'RESULT=VERIFY_STAGING_TEST_OK\n'
