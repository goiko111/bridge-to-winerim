#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
POSTGRES_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
REPO_ROOT=$(CDPATH= cd -- "$POSTGRES_DIR/../.." && pwd)
POSTGRES_BIN=${POSTGRES_BIN:-/opt/homebrew/opt/postgresql@17/bin}
PATH="$POSTGRES_BIN:$PATH"
export PATH

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
writeFileSync(join(output, "abort-a.sql"), renderRescueCanaryRetirementSql({
  connectionId,
  runId: "elbejeque-control-a",
  approvedAt,
  deploymentManifestSha256: "a".repeat(64),
}).replaceAll("status = 'RETIRED'", "status = 'ABORTED'"));
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
writeFileSync(join(output, "retire-b.sql"), renderRescueCanaryRetirementSql({
  connectionId,
  runId: "elbejeque-control-b",
  approvedAt,
  deploymentManifestSha256: "c".repeat(64),
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

if psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$TMP_ROOT/activate-a.sql" >"$TMP_ROOT/replay.out" 2>&1; then
  printf 'ACTIVATION_REPLAY_WAS_ACCEPTED\n' >&2
  exit 1
fi
grep -Eq 'activation candidate is missing or not inert|another canary scope or credential is active|exact prepared canary run is missing or already consumed' "$TMP_ROOT/replay.out"

psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$TMP_ROOT/abort-a.sql" >/dev/null
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "
  INSERT INTO public.runtime_execution_log (
    message_id, idempotency_key, connection_id, job, outcome, attempt
  ) VALUES (
    'prior-canary-message', 'prior-canary-key', '$CONNECTION_ID'::uuid,
    'sales.auto-sync', 'SUCCESS', 1
  )
" >/dev/null
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$TMP_ROOT/provision-v2.sql" >/dev/null
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$TMP_ROOT/activate-b.sql" >/dev/null

active_b=$(psql "$DATABASE_URL" -XAtq -F '|' -c "
  SELECT
    (SELECT count(*) FROM public.runtime_connection_credentials),
    (SELECT count(*) FROM public.runtime_connection_credentials WHERE active),
    (SELECT count(*) FROM public.runtime_canary_connections),
    (SELECT count(*) FROM public.runtime_canary_connections WHERE active),
    (SELECT string_agg(key_version, ',' ORDER BY key_version) FROM public.runtime_connection_credentials WHERE active),
    (SELECT count(*) FROM public.runtime_execution_log)
")
test "$active_b" = "4|2|2|1|elbejeque-v2,elbejeque-v2|1" || {
  printf 'VERSIONED_ROTATION_INVALID=%s\n' "$active_b" >&2
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
grep -Eq 'RUNTIME_CREDENTIAL_REACTIVATION_REJECTED|idx_runtime_connection_credentials_active' "$TMP_ROOT/second-active.out"

psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$TMP_ROOT/retire-b.sql" >/dev/null
retired=$(psql "$DATABASE_URL" -XAtq -F '|' -c "
  SELECT
    (SELECT count(*) FROM public.runtime_connection_credentials),
    (SELECT count(*) FROM public.runtime_connection_credentials WHERE active),
    (SELECT count(*) FROM public.runtime_canary_connections),
    (SELECT count(*) FROM public.runtime_canary_connections WHERE active),
    (SELECT count(*) FROM public.pos_connections WHERE enabled)
")
test "$retired" = "4|0|2|0|0" || { printf 'RETIREMENT_HISTORY_INVALID=%s\n' "$retired" >&2; exit 1; }

printf 'RESULT=RUNTIME_CANARY_CONTROL_PLANE_OK postgres_major=17 generations=2 terminal=aborted,retired active=0 replay=blocked\n'
