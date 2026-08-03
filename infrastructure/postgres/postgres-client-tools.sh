#!/usr/bin/env bash

PSQL_CMD=$(command -v psql 2>/dev/null || true)
test -n "$PSQL_CMD" || {
  printf 'BLOCKED_MISSING_COMMAND=psql\n' >&2
  return 1 2>/dev/null || exit 1
}

postgres_tool_major() {
  "$1" --version | sed -E 's/.* ([0-9]+)(\.[0-9]+)?.*/\1/'
}

configure_postgres_tools() {
  database_url=$1
  server_major=$(PGOPTIONS="${PGOPTIONS:+$PGOPTIONS }-c default_transaction_read_only=on -c statement_timeout=15000" \
    "$PSQL_CMD" "$database_url" -XAtq -v ON_ERROR_STOP=1 -c "SELECT current_setting('server_version_num')::int / 10000")
  case "$server_major" in *[!0-9]*|'') printf 'POSTGRES_SERVER_VERSION_DETECTION_FAILED=%s\n' "$server_major" >&2; return 1 ;; esac

  if [ -n "${RESCUE_PRODUCTION_PG_BIN_DIR:-}" ]; then
    selected_bin=${RESCUE_PRODUCTION_PG_BIN_DIR%/}
  else
    selected_bin=''
    for candidate_dir in "/opt/homebrew/opt/postgresql@$server_major/bin" "/usr/local/opt/postgresql@$server_major/bin"; do
      if [ -x "$candidate_dir/pg_dump" ] && [ -x "$candidate_dir/pg_restore" ]; then
        selected_bin=$candidate_dir
        break
      fi
    done
    if [ -z "$selected_bin" ]; then
      path_dump=$(command -v pg_dump 2>/dev/null || true)
      path_restore=$(command -v pg_restore 2>/dev/null || true)
      if [ -n "$path_dump" ] && [ -n "$path_restore" ] && [ "$(postgres_tool_major "$path_dump")" = "$server_major" ]; then
        selected_bin=$(dirname "$path_dump")
      fi
    fi
  fi

  test -n "$selected_bin" || {
    printf 'BLOCKED_MISSING_MATCHING_POSTGRES_CLIENTS server_major=%s\n' "$server_major" >&2
    return 1
  }
  PG_DUMP_CMD="$selected_bin/pg_dump"
  PG_RESTORE_CMD="$selected_bin/pg_restore"
  test -x "$PG_DUMP_CMD" && test -x "$PG_RESTORE_CMD" || {
    printf 'BLOCKED_MISSING_POSTGRES_CLIENTS bin=%s\n' "$selected_bin" >&2
    return 1
  }
  dump_major=$(postgres_tool_major "$PG_DUMP_CMD")
  restore_major=$(postgres_tool_major "$PG_RESTORE_CMD")
  if [ "$dump_major" != "$server_major" ] || [ "$restore_major" != "$server_major" ]; then
    printf 'POSTGRES_CLIENT_SERVER_VERSION_MISMATCH server=%s dump=%s restore=%s\n' "$server_major" "$dump_major" "$restore_major" >&2
    return 1
  fi
}
