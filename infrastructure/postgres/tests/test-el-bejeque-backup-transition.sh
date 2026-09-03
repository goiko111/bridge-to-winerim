#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
POSTGRES_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
ARTIFACT_DIR=${EL_BEJEQUE_BACKUP_ARTIFACT_DIR:-}
TRANSITION_DIR=${EL_BEJEQUE_TRANSITION_DIR:-}
CONNECTION_ID=ba44c13a-5f48-4a49-8b3f-04049b244d94
OLD_DIGEST=080a42f7d80b4cd6841bb25214eb7e4bcf3a55bdde923d89740afe57b6998c9d
NEW_DIGEST=ea2d2a7b52dfaa63fe409afdcbb1d7ac69b6df5140454bfc1db22294b2922993

case "$ARTIFACT_DIR" in /*) ;; *) printf 'EL_BEJEQUE_BACKUP_ARTIFACT_DIR_REQUIRED\n' >&2; exit 2 ;; esac
case "$TRANSITION_DIR" in /*) ;; *) printf 'EL_BEJEQUE_TRANSITION_DIR_REQUIRED\n' >&2; exit 2 ;; esac
for required in manifest.txt manifest.txt.sha256 public.dump restore-prerequisites.sql; do
  test -f "$ARTIFACT_DIR/$required" && test ! -L "$ARTIFACT_DIR/$required" || {
    printf 'BACKUP_ARTIFACT_FILE_REJECTED=%s\n' "$required" >&2
    exit 2
  }
done
for required in apply-hydration-transition.sql rollback-hydration-transition.sql; do
  test -f "$TRANSITION_DIR/$required" && test ! -L "$TRANSITION_DIR/$required" || {
    printf 'TRANSITION_FILE_REJECTED=%s\n' "$required" >&2
    exit 2
  }
done

PG_BIN=${EL_BEJEQUE_PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}
for command_name in initdb pg_ctl createdb psql pg_restore; do
  test -x "$PG_BIN/$command_name" || { printf 'POSTGRES_17_COMMAND_REQUIRED=%s\n' "$command_name" >&2; exit 2; }
done
test "$($PG_BIN/psql --version | sed -E 's/.* ([0-9]+)(\.[0-9]+)?.*/\1/')" = 17 || {
  printf 'POSTGRES_17_CLIENT_REQUIRED\n' >&2
  exit 2
}

expected_manifest_sha=$(awk '{print $1}' "$ARTIFACT_DIR/manifest.txt.sha256")
observed_manifest_sha=$(shasum -a 256 "$ARTIFACT_DIR/manifest.txt" | awk '{print $1}')
test "$observed_manifest_sha" = "$expected_manifest_sha" || { printf 'MANIFEST_SHA_MISMATCH\n' >&2; exit 3; }
for field in dump_sha256 restore_prerequisites_sha256; do
  expected=$(awk -F= -v key="$field" '$1==key {print $2}' "$ARTIFACT_DIR/manifest.txt")
  case "$field" in
    dump_sha256) file=public.dump ;;
    restore_prerequisites_sha256) file=restore-prerequisites.sql ;;
  esac
  observed=$(shasum -a 256 "$ARTIFACT_DIR/$file" | awk '{print $1}')
  test -n "$expected" && test "$observed" = "$expected" || { printf 'BACKUP_FILE_SHA_MISMATCH=%s\n' "$file" >&2; exit 3; }
done
test "$(awk -F= '$1=="hydration_digest" {print $2}' "$ARTIFACT_DIR/manifest.txt")" = "$OLD_DIGEST" || {
  printf 'BACKUP_HYDRATION_DIGEST_MISMATCH\n' >&2
  exit 3
}

TMP_ROOT=$(mktemp -d /tmp/wrbejeque.XXXXXX)
DATA_DIR="$TMP_ROOT/data"
PORT=$((58632 + ($$ % 200)))
DATABASE=winerim_el_bejeque_restore_test
SERVER_STARTED=0
cleanup() {
  if [ "$SERVER_STARTED" = 1 ]; then "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m fast -w stop >/dev/null 2>&1 || true; fi
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT INT TERM

"$PG_BIN/initdb" -D "$DATA_DIR" --auth=trust --no-locale --encoding=UTF8 >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA_DIR" -l "$TMP_ROOT/postgres.log" -o "-h 127.0.0.1 -p $PORT" -w start >/dev/null
SERVER_STARTED=1
"$PG_BIN/createdb" -h 127.0.0.1 -p "$PORT" "$DATABASE"
DATABASE_URL="postgresql://$(id -un)@127.0.0.1:$PORT/$DATABASE"

"$PG_BIN/psql" "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -c 'DROP SCHEMA public CASCADE' >/dev/null
"$PG_BIN/psql" "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$ARTIFACT_DIR/restore-prerequisites.sql" >/dev/null
"$PG_BIN/pg_restore" --dbname="$DATABASE_URL" --no-owner --exit-on-error "$ARTIFACT_DIR/public.dump" >/dev/null

readback() {
  "$PG_BIN/psql" "$DATABASE_URL" -XAtq -v ON_ERROR_STOP=1 -F $'\t' -c "
    SELECT
      (SELECT count(*) FROM public.pos_connections),
      (SELECT count(*) FROM public.pos_connections WHERE enabled OR catalog_sync_enabled OR write_mode <> 'NONE'),
      (SELECT count(*) FROM public.winerim_wines WHERE connection_id='$CONNECTION_ID'::uuid),
      (SELECT count(*) FROM public.provider_products WHERE connection_id='$CONNECTION_ID'::uuid),
      (SELECT count(*) FROM public.product_mappings WHERE connection_id='$CONNECTION_ID'::uuid),
      (SELECT count(*) FROM public.agora_master_data WHERE connection_id='$CONNECTION_ID'::uuid),
      (SELECT replace(raw_xml_preview, 'WINERIM_RESCUE_HYDRATION_V2_SHA256:', '') FROM public.agora_master_data WHERE connection_id='$CONNECTION_ID'::uuid),
      (SELECT count(*) FROM public.sales_events WHERE connection_id='$CONNECTION_ID'::uuid),
      (SELECT count(*) FROM public.stock_sync_log WHERE connection_id='$CONNECTION_ID'::uuid),
      (SELECT count(*) FROM public.outbound_tasks WHERE connection_id='$CONNECTION_ID'::uuid)
  "
}

test "$(readback)" = $'31\t0\t70\t409\t72\t1\t'"$OLD_DIGEST"$'\t0\t0\t0' || {
  printf 'RESTORED_OLD_STATE_MISMATCH\n' >&2
  exit 4
}

"$PG_BIN/psql" "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$TRANSITION_DIR/apply-hydration-transition.sql" >/dev/null
test "$(readback)" = $'31\t0\t70\t409\t95\t1\t'"$NEW_DIGEST"$'\t0\t0\t0' || {
  printf 'RESTORED_NEW_STATE_MISMATCH\n' >&2
  exit 4
}

"$PG_BIN/psql" "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$TRANSITION_DIR/rollback-hydration-transition.sql" >/dev/null
test "$(readback)" = $'31\t0\t70\t409\t72\t1\t'"$OLD_DIGEST"$'\t0\t0\t0' || {
  printf 'RESTORED_ROLLBACK_STATE_MISMATCH\n' >&2
  exit 4
}

printf 'EL_BEJEQUE_BACKUP_TRANSITION_TEST_OK\n'
