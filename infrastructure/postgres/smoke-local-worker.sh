#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)

for command_name in initdb pg_ctl createdb psql; do
  command -v "$command_name" >/dev/null 2>&1 || {
    printf 'BLOCKED: %s is not installed\n' "$command_name" >&2
    exit 2
  }
done

TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/winerim-worker-db-smoke.XXXXXX")
DATA_DIR="$TMP_ROOT/data"
PORT=$((56432 + ($$ % 500)))
DB_NAME=winerim_worker_smoke
SERVER_STARTED=0

cleanup() {
  if [ "$SERVER_STARTED" -eq 1 ]; then
    pg_ctl -D "$DATA_DIR" -m fast -w stop >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT INT TERM

initdb -D "$DATA_DIR" --auth=trust --no-locale --encoding=UTF8 >/dev/null
pg_ctl -D "$DATA_DIR" -o "-h 127.0.0.1 -p $PORT" -w start >/dev/null
SERVER_STARTED=1
createdb -h 127.0.0.1 -p "$PORT" "$DB_NAME"
DATABASE_URL="postgresql://127.0.0.1:$PORT/$DB_NAME?sslmode=disable"

"$SCRIPT_DIR/apply-staging.sh" "$DATABASE_URL" >/dev/null
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
INSERT INTO public.pos_connections (
  id, location_name, provider, base_url, api_token, enabled
) VALUES (
  '00000000-0000-4000-8000-000000000001',
  'Staging Restaurant',
  'agora',
  'https://pos.example.test',
  'test-only',
  false
);
SQL

cd "$REPO_ROOT"
MIDDLEWARE_TEST_DATABASE_URL="$DATABASE_URL" npx vitest run src/test/middlewareWorkerDb.integration.test.ts
printf 'LOCAL_WORKER_POSTGRES_SMOKE_OK\n'
