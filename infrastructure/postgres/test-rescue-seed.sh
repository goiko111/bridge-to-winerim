#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RESCUE_SQL=${1:-}
EXPECTED_CONNECTIONS=${2:-30}

if [ -z "$RESCUE_SQL" ] || [ ! -f "$RESCUE_SQL" ]; then
  printf 'USAGE: %s /absolute/path/rescue-connections-disabled.sql [expected-count]\n' "$0" >&2
  exit 2
fi

case "$EXPECTED_CONNECTIONS" in
  ''|*[!0-9]*)
    printf 'BLOCKED: expected-count must be numeric\n' >&2
    exit 2
    ;;
esac

for command_name in initdb pg_ctl createdb psql; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'BLOCKED: %s is not installed\n' "$command_name" >&2
    exit 2
  fi
done

TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/winerim-rescue-seed.XXXXXX")
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
PORT=$((56432 + ($$ % 800)))
DB_NAME=winerim_rescue_seed
SERVER_STARTED=0

cleanup() {
  if [ "$SERVER_STARTED" -eq 1 ]; then
    pg_ctl -D "$DATA_DIR" -m fast -w stop >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT INT TERM

mkdir -p "$SOCKET_DIR"
initdb -D "$DATA_DIR" --auth=trust --no-locale --encoding=UTF8 >/dev/null
pg_ctl -D "$DATA_DIR" -o "-h '' -k '$SOCKET_DIR' -p $PORT" -w start >/dev/null
SERVER_STARTED=1

PSQL=(psql -X -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -d "$DB_NAME")
createdb -h "$SOCKET_DIR" -p "$PORT" "$DB_NAME"

BOOTSTRAP_SQL="$TMP_ROOT/bootstrap.sql"
"$SCRIPT_DIR/build-bootstrap.sh" "$BOOTSTRAP_SQL" >/dev/null
"${PSQL[@]}" -v environment=staging -f "$BOOTSTRAP_SQL" >/dev/null
"${PSQL[@]}" -f "$RESCUE_SQL" >/dev/null
"${PSQL[@]}" -f "$RESCUE_SQL" >/dev/null

connection_count=$("${PSQL[@]}" -Atc 'SELECT count(*) FROM public.pos_connections')
unsafe_count=$("${PSQL[@]}" -Atc "SELECT count(*) FROM public.pos_connections WHERE enabled OR catalog_sync_enabled OR sync_mode <> 'PULL_ONLY' OR write_mode <> 'NONE' OR backfill_days <> 0 OR last_sync_at IS NOT NULL OR last_catalog_sync_at IS NOT NULL OR last_business_day_synced IS NOT NULL OR circuit_breaker_paused_until IS NOT NULL OR consecutive_failures <> 0 OR base_url <> 'https://redacted.invalid' OR api_token <> '' OR winerim_api_token IS NOT NULL")
runtime_rows=$("${PSQL[@]}" -Atc 'SELECT (SELECT count(*) FROM public.runtime_connection_credentials) + (SELECT count(*) FROM public.runtime_canary_connections) + (SELECT count(*) FROM public.runtime_execution_log) + (SELECT count(*) FROM public.runtime_idempotency) + (SELECT count(*) FROM public.outbound_tasks)')

if [ "$connection_count" != "$EXPECTED_CONNECTIONS" ] || [ "$unsafe_count" != "0" ] || [ "$runtime_rows" != "0" ]; then
  printf 'RESCUE_SEED_LOCAL_REPLAY_FAILED connections=%s unsafe=%s runtime_rows=%s\n' "$connection_count" "$unsafe_count" "$runtime_rows" >&2
  exit 1
fi

first_id=$("${PSQL[@]}" -Atc 'SELECT id FROM public.pos_connections ORDER BY id LIMIT 1')
"${PSQL[@]}" -c "UPDATE public.pos_connections SET enabled=true WHERE id='$first_id'" >/dev/null
if "${PSQL[@]}" -f "$RESCUE_SQL" >/dev/null 2>&1; then
  printf 'RESCUE_SEED_LOCAL_REPLAY_FAILED active-row gate did not reject\n' >&2
  exit 1
fi

printf 'RESCUE_SEED_LOCAL_REPLAY_OK connections=%s unsafe=0 runtime_rows=0 replay=idempotent active_row_gate=rejected\n' "$connection_count"
