#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
POSTGRES_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
REPO_ROOT=$(CDPATH= cd -- "$POSTGRES_DIR/../.." && pwd)
POSTGRES_BIN=${POSTGRES_BIN:-/opt/homebrew/opt/postgresql@17/bin}
PATH="$POSTGRES_BIN:$PATH"
export PATH

PREPARED_ABORT_MIGRATIONS=("$REPO_ROOT"/supabase/migrations/*_runtime_canary_prepared_abort.sql)
if [ "${#PREPARED_ABORT_MIGRATIONS[@]}" -ne 1 ] || [ ! -f "${PREPARED_ABORT_MIGRATIONS[0]}" ]; then
  printf 'BLOCKED: expected exactly one runtime_canary_prepared_abort migration\n' >&2
  exit 2
fi
PREPARED_ABORT_MIGRATION=${PREPARED_ABORT_MIGRATIONS[0]}

for command_name in initdb pg_ctl createdb psql node; do
  command -v "$command_name" >/dev/null 2>&1 || {
    printf 'BLOCKED: required command is not installed: %s\n' "$command_name" >&2
    exit 2
  }
done

TMP_ROOT=$(mktemp -d /tmp/wr-canary-control-plane.XXXXXX)
DATA_DIR="$TMP_ROOT/data"
PORT=$((59132 + ($$ % 300)))
DATABASE_URL="postgresql://$(id -un)@127.0.0.1:$PORT/winerim_canary_control_plane_test"
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
test "$(psql -h 127.0.0.1 -p "$PORT" -d postgres -XAtq -c "SELECT current_setting('server_version_num')::int / 10000")" = 17
createdb -h 127.0.0.1 -p "$PORT" winerim_canary_control_plane_test

"$POSTGRES_DIR/build-bootstrap.sh" "$TMP_ROOT/bootstrap.sql" >/dev/null
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -v environment=rescue-production -f "$TMP_ROOT/bootstrap.sql" >/dev/null
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$PREPARED_ABORT_MIGRATION" >/dev/null

CONNECTION_ID=ba44c13a-5f48-4a49-8b3f-04049b244d94
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 >/dev/null <<SQL
INSERT INTO public.pos_connections (
  id, location_name, provider, base_url, api_token, enabled,
  catalog_sync_enabled, sync_mode, write_mode, backfill_days
) VALUES (
  '$CONNECTION_ID', 'El Bejeque control plane test', 'agora',
  'https://redacted.invalid', '', false, false, 'PULL_ONLY', 'NONE', 0
);
SQL

REPO_ROOT="$REPO_ROOT" TMP_ROOT="$TMP_ROOT" CONNECTION_ID="$CONNECTION_ID" \
  node --input-type=module <<'NODE'
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.env.REPO_ROOT;
const output = process.env.TMP_ROOT;
const connectionId = process.env.CONNECTION_ID;
const {
  renderCredentialProvisioningSql,
  runtimeCredentialSetSha256,
} = await import(`${root}/infrastructure/runtime/prepare-runtime-credential-provisioning.mjs`);
const {
  renderRescueCanaryActivationSql,
} = await import(`${root}/infrastructure/runtime/prepare-rescue-canary-activation.mjs`);
const {
  renderRescueCanaryPreparedAbortSql,
} = await import(`${root}/infrastructure/runtime/prepare-rescue-canary-prepared-abort.mjs`);
const {
  renderRescueCanaryRetirementSql,
} = await import(`${root}/infrastructure/runtime/prepare-rescue-canary-retirement.mjs`);

const credentialFixture = (seed) => ["agora", "winerim"].map((kind, index) => ({
  kind,
  nonceHex: Buffer.alloc(12, seed + index).toString("hex"),
  ciphertextHex: Buffer.alloc(32, seed + index + 4).toString("hex"),
  attestationSha256: "a".repeat(64),
}));
const now = Date.now();
const approvedAt = new Date(now - 60_000).toISOString();
const expiresAt = new Date(now + 60 * 60_000).toISOString();
const legacyWriterRevokedAt = new Date(now - 10 * 60_000).toISOString();

const credentialsV1 = credentialFixture(1);
const credentialsV2 = credentialFixture(7);
const credentialsV3 = credentialFixture(13);
const setV1 = runtimeCredentialSetSha256({
  connectionId, runId: "elbejeque-control-a", keyVersion: "elbejeque-v1", credentials: credentialsV1,
});
const setV2 = runtimeCredentialSetSha256({
  connectionId, runId: "elbejeque-control-b", keyVersion: "elbejeque-v2", credentials: credentialsV2,
});
writeFileSync(join(output, "provision-v1.sql"), renderCredentialProvisioningSql({
  connectionId,
  runId: "elbejeque-control-a",
  keyVersion: "elbejeque-v1",
  credentials: credentialsV1,
}));
writeFileSync(join(output, "activate-a.sql"), renderRescueCanaryActivationSql({
  connectionId,
  runId: "elbejeque-control-a",
  approvedAt,
  expiresAt,
  keyVersion: "elbejeque-v1",
  legacyWriterRevokedAt,
  credentialAttestations: Object.fromEntries(credentialsV1.map(({ kind, attestationSha256 }) => [kind, attestationSha256])),
  credentialSetSha256: setV1,
  deploymentManifestSha256: "a".repeat(64),
  writerFenceGrantSha256: "b".repeat(64),
}));
writeFileSync(join(output, "retire-a.sql"), renderRescueCanaryRetirementSql({
  connectionId,
  runId: "elbejeque-control-a",
  approvedAt,
  deploymentManifestSha256: "a".repeat(64),
}));
writeFileSync(join(output, "provision-v2.sql"), renderCredentialProvisioningSql({
  connectionId,
  runId: "elbejeque-control-b",
  keyVersion: "elbejeque-v2",
  credentials: credentialsV2,
  mode: "rotate",
}));
writeFileSync(join(output, "activate-b.sql"), renderRescueCanaryActivationSql({
  connectionId,
  runId: "elbejeque-control-b",
  approvedAt,
  expiresAt,
  keyVersion: "elbejeque-v2",
  mode: "rotate",
  legacyWriterRevokedAt,
  credentialAttestations: Object.fromEntries(credentialsV2.map(({ kind, attestationSha256 }) => [kind, attestationSha256])),
  credentialSetSha256: setV2,
  deploymentManifestSha256: "c".repeat(64),
  writerFenceGrantSha256: "d".repeat(64),
}));
writeFileSync(join(output, "abort-prepared-b.sql"), renderRescueCanaryPreparedAbortSql({
  connectionId,
  runId: "elbejeque-control-b",
}));
writeFileSync(join(output, "provision-v3.sql"), renderCredentialProvisioningSql({
  connectionId,
  runId: "elbejeque-control-c",
  keyVersion: "elbejeque-v3",
  credentials: credentialsV3,
  mode: "rotate",
}));
NODE

psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$TMP_ROOT/provision-v1.sql" >/dev/null
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$TMP_ROOT/activate-a.sql" >/dev/null

active_a=$(psql "$DATABASE_URL" -XAtq -F '|' -c "
  SELECT
    (SELECT count(*) FROM public.runtime_connection_credentials WHERE active),
    (SELECT count(*) FROM public.runtime_canary_connections WHERE active),
    (SELECT count(*) FROM public.pos_connections WHERE enabled)
")
test "$active_a" = "2|1|1" || { printf 'FIRST_ACTIVATION_INVALID=%s\n' "$active_a" >&2; exit 1; }

if psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$TMP_ROOT/activate-a.sql" >"$TMP_ROOT/activation-replay.out" 2>&1; then
  printf 'ACTIVATION_REPLAY_WAS_ACCEPTED\n' >&2
  exit 1
fi
grep -Eq 'activation candidate is missing or not inert|another canary scope or credential is active|exact prepared canary run is missing or already consumed' "$TMP_ROOT/activation-replay.out"

psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$TMP_ROOT/retire-a.sql" >/dev/null
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "
  INSERT INTO public.runtime_execution_log (
    message_id, idempotency_key, connection_id, job, outcome, attempt
  ) VALUES (
    'prior-canary-message', 'prior-canary-key', '$CONNECTION_ID'::uuid,
    'sales.auto-sync', 'SUCCESS', 1
  )
" >/dev/null
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$TMP_ROOT/provision-v2.sql" >/dev/null

prepared_b=$(psql "$DATABASE_URL" -XAtq -F '|' -c "
  SELECT
    (SELECT count(*) FROM public.runtime_connection_credentials WHERE connection_id='$CONNECTION_ID'::uuid AND run_id='elbejeque-control-b' AND NOT active AND activated_at IS NULL AND retired_at IS NULL),
    (SELECT count(*) FROM public.runtime_canary_connections WHERE connection_id='$CONNECTION_ID'::uuid AND run_id='elbejeque-control-b' AND status='PREPARED' AND NOT active AND activated_at IS NULL AND retired_at IS NULL),
    (SELECT count(*) FROM public.pos_connections WHERE id='$CONNECTION_ID'::uuid AND NOT enabled AND NOT catalog_sync_enabled AND sync_mode='PULL_ONLY' AND write_mode='NONE' AND backfill_days=0)
")
test "$prepared_b" = "2|1|1" || { printf 'PREPARED_GENERATION_INVALID=%s\n' "$prepared_b" >&2; exit 1; }

psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$TMP_ROOT/abort-prepared-b.sql" >/dev/null

aborted_b=$(psql "$DATABASE_URL" -XAtq -F '|' -c "
  SELECT
    (SELECT count(*) FROM public.runtime_connection_credentials WHERE connection_id='$CONNECTION_ID'::uuid AND run_id='elbejeque-control-b' AND NOT active AND activated_at IS NULL AND retired_at IS NOT NULL),
    (SELECT count(*) FROM public.runtime_canary_connections WHERE connection_id='$CONNECTION_ID'::uuid AND run_id='elbejeque-control-b' AND status='ABORTED' AND NOT active AND approved_at IS NULL AND expires_at IS NULL AND deployment_manifest_sha256 IS NULL AND writer_fence_grant_sha256 IS NULL AND credential_set_sha256 IS NULL AND activated_at IS NULL AND retired_at IS NOT NULL),
    (SELECT count(*) FROM public.pos_connections WHERE id='$CONNECTION_ID'::uuid AND NOT enabled AND NOT catalog_sync_enabled AND sync_mode='PULL_ONLY' AND write_mode='NONE' AND backfill_days=0)
")
test "$aborted_b" = "2|1|1" || { printf 'PREPARED_ABORT_INVALID=%s\n' "$aborted_b" >&2; exit 1; }

aborted_runtime_visibility=$(psql "$DATABASE_URL" -XAtq -F '|' -c "
  SET ROLE middleware_runtime;
  SELECT
    (SELECT count(*) FROM public.runtime_canary_connections WHERE connection_id='$CONNECTION_ID'::uuid AND run_id='elbejeque-control-b'),
    (SELECT count(*) FROM public.runtime_connection_credentials WHERE connection_id='$CONNECTION_ID'::uuid AND run_id='elbejeque-control-b');
  RESET ROLE;
")
test "$aborted_runtime_visibility" = "0|0" || {
  printf 'ABORTED_GENERATION_VISIBLE_TO_RUNTIME=%s\n' "$aborted_runtime_visibility" >&2
  exit 1
}

if psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$TMP_ROOT/abort-prepared-b.sql" >"$TMP_ROOT/abort-replay.out" 2>&1; then
  printf 'PREPARED_ABORT_REPLAY_WAS_ACCEPTED\n' >&2
  exit 1
fi
grep -Eq 'exact prepared canary scope is missing or already consumed|RUNTIME_CANARY_SCOPE_TERMINAL' "$TMP_ROOT/abort-replay.out"

if psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$TMP_ROOT/activate-b.sql" >"$TMP_ROOT/activation-after-abort.out" 2>&1; then
  printf 'TERMINAL_GENERATION_ACTIVATION_WAS_ACCEPTED\n' >&2
  exit 1
fi
grep -Eq 'exact prepared canary run is missing or already consumed|exact inactive credential generation does not match' "$TMP_ROOT/activation-after-abort.out"

preserved_after_abort=$(psql "$DATABASE_URL" -XAtq -F '|' -c "
  SELECT
    (SELECT count(*) FROM public.runtime_connection_credentials WHERE connection_id='$CONNECTION_ID'::uuid AND run_id='elbejeque-control-b'),
    (SELECT count(*) FROM public.runtime_canary_connections WHERE connection_id='$CONNECTION_ID'::uuid AND run_id='elbejeque-control-b')
")
test "$preserved_after_abort" = "2|1" || { printf 'PREPARED_ABORT_DELETED_HISTORY=%s\n' "$preserved_after_abort" >&2; exit 1; }

psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$TMP_ROOT/provision-v3.sql" >/dev/null

rotated_c=$(psql "$DATABASE_URL" -XAtq -F '|' -c "
  SELECT
    (SELECT count(*) FROM public.runtime_connection_credentials),
    (SELECT count(*) FROM public.runtime_connection_credentials WHERE active),
    (SELECT count(*) FROM public.runtime_canary_connections),
    (SELECT count(*) FROM public.runtime_canary_connections WHERE active),
    (SELECT string_agg(key_version, ',' ORDER BY credential_kind) FROM public.runtime_connection_credentials WHERE run_id='elbejeque-control-c' AND NOT active AND activated_at IS NULL AND retired_at IS NULL),
    (SELECT count(*) FROM public.runtime_execution_log)
")
test "$rotated_c" = "6|0|3|0|elbejeque-v3,elbejeque-v3|1" || {
  printf 'ROTATION_AFTER_PREPARED_ABORT_INVALID=%s\n' "$rotated_c" >&2
  exit 1
}

if psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "
  UPDATE public.runtime_connection_credentials
  SET active=true
  WHERE connection_id='$CONNECTION_ID'::uuid AND key_version='elbejeque-v1'
" >"$TMP_ROOT/second-active.out" 2>&1; then
  printf 'MULTIPLE_ACTIVE_CREDENTIAL_VERSIONS_ACCEPTED\n' >&2
  exit 1
fi
grep -Eq 'RUNTIME_CREDENTIAL_TERMINAL|RUNTIME_CREDENTIAL_REACTIVATION_REJECTED|idx_runtime_connection_credentials_active' "$TMP_ROOT/second-active.out"

retired=$(psql "$DATABASE_URL" -XAtq -F '|' -c "
  SELECT
    (SELECT count(*) FROM public.runtime_connection_credentials),
    (SELECT count(*) FROM public.runtime_connection_credentials WHERE active),
    (SELECT count(*) FROM public.runtime_canary_connections),
    (SELECT count(*) FROM public.runtime_canary_connections WHERE active),
    (SELECT count(*) FROM public.pos_connections WHERE enabled)
")
test "$retired" = "6|0|3|0|0" || { printf 'RETIREMENT_HISTORY_INVALID=%s\n' "$retired" >&2; exit 1; }

printf 'RESULT=RUNTIME_CANARY_CONTROL_PLANE_OK postgres_major=17 generations=3 prepared_abort=append-only terminal=aborted,retired active=0 replay=blocked rotation_after_abort=allowed\n'
