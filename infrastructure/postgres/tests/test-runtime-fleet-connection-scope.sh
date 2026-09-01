#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
POSTGRES_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
REPO_ROOT=$(CDPATH= cd -- "$POSTGRES_DIR/../.." && pwd)
POSTGRES_BIN=${POSTGRES_BIN:-/opt/homebrew/opt/postgresql@17/bin}
PATH="$POSTGRES_BIN:$PATH"
export PATH

for command_name in initdb pg_ctl createdb psql shasum; do
  command -v "$command_name" >/dev/null 2>&1 || {
    printf 'BLOCKED: required command is not installed: %s\n' "$command_name" >&2
    exit 2
  }
done

MIGRATION="$POSTGRES_DIR/0015_runtime_fleet_connection_scope.sql"
test -f "$MIGRATION" || {
  printf 'BLOCKED: migration is missing: %s\n' "$MIGRATION" >&2
  exit 2
}

TMP_ROOT=$(mktemp -d /tmp/wr-runtime-fleet-scope.XXXXXX)
DATA_DIR="$TMP_ROOT/data"
PORT=$((59432 + ($$ % 200)))
DATABASE_NAME=winerim_runtime_fleet_scope_test
DATABASE_URL="postgresql://$(id -un)@127.0.0.1:$PORT/$DATABASE_NAME"
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
createdb -h 127.0.0.1 -p "$PORT" "$DATABASE_NAME"

# Build the reviewed baseline in dependency order. The prepared-abort migration
# depends on the local runtime tables, so this fixture applies it after 0013/0014.
{
  printf '%s\n' '\set ON_ERROR_STOP on'
  cat "$POSTGRES_DIR/bootstrap-prelude.sql"
  while IFS=$'\t' read -r order file expected_sha phase action dependency note; do
    if [ "$order" = order ] || [ -z "$order" ] || [ "$file" = 20260803203800_runtime_canary_prepared_abort.sql ]; then
      continue
    fi
    case "$action" in
      INCLUDE|INCLUDE_SECURITY_GATE|INCLUDE_WITH_REVIEW)
        actual_sha=$(shasum -a 256 "$REPO_ROOT/supabase/migrations/$file" | awk '{print $1}')
        test "$actual_sha" = "$expected_sha"
        cat "$REPO_ROOT/supabase/migrations/$file"
        ;;
    esac
  done < "$POSTGRES_DIR/migration-manifest.tsv"
  for addendum in \
    0001_harden_runtime_roles.sql \
    0002_release_schema_addendum.sql \
    0003_runtime_connection_credentials.sql \
    0004_runtime_canary_least_privilege.sql \
    0005_runtime_canary_connection_scope.sql \
    0006_revoke_supabase_platform_roles.sql \
    0007_runtime_sales_canary_permissions.sql \
    0008_runtime_sales_column_privileges.sql \
    0009_runtime_catalog_permissions.sql \
    0010_runtime_idempotency_lease_binding.sql \
    0011_runtime_sales_claim_identity.sql \
    0012_runtime_sales_claim_identity_immutability.sql \
    0013_runtime_canary_control_plane_history.sql \
    0014_runtime_catalog_source_scope.sql; do
    cat "$POSTGRES_DIR/$addendum"
  done
} > "$TMP_ROOT/bootstrap.sql"

psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -v environment=rescue-production -f "$TMP_ROOT/bootstrap.sql" >/dev/null
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -f "$REPO_ROOT/supabase/migrations/20260803203800_runtime_canary_prepared_abort.sql" >/dev/null

CONNECTION_A=10000000-0000-4000-8000-000000000001
CONNECTION_B=10000000-0000-4000-8000-000000000002
CONNECTION_C=10000000-0000-4000-8000-000000000003
CONNECTION_D=10000000-0000-4000-8000-000000000004

# Prove the migration can be applied while the existing single-canary contract
# has one complete active generation.
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 >/dev/null <<SQL
INSERT INTO public.pos_connections (
  id, location_name, provider, base_url, api_token, enabled,
  catalog_sync_enabled, sync_mode, write_mode, backfill_days
) VALUES (
  '$CONNECTION_A', 'Fleet A', 'agora', 'https://redacted.invalid', '', false,
  false, 'PULL_ONLY', 'NONE', 0
);
INSERT INTO public.runtime_canary_connections (
  connection_id, run_id, generation_mode, status, active, note
) VALUES (
  '$CONNECTION_A', 'fleet-a-001', 'bootstrap', 'PREPARED', false,
  'fleet-test:fleet-a-001'
);
INSERT INTO public.runtime_connection_credentials (
  connection_id, provider, credential_kind, run_id, key_version,
  ciphertext, nonce, attestation_sha256, active
) VALUES
  ('$CONNECTION_A', 'agora', 'agora', 'fleet-a-001', 'fleet-key-a',
    decode(repeat('11', 32), 'hex'), decode(repeat('11', 12), 'hex'), repeat('a', 64), false),
  ('$CONNECTION_A', 'agora', 'winerim', 'fleet-a-001', 'fleet-key-a',
    decode(repeat('11', 33), 'hex'), decode(repeat('11', 12), 'hex'), repeat('b', 64), false);
BEGIN;
UPDATE public.runtime_connection_credentials
SET active = true, activated_at = transaction_timestamp()
WHERE connection_id = '$CONNECTION_A'::uuid AND run_id = 'fleet-a-001';
UPDATE public.runtime_canary_connections
SET active = true,
    status = 'ACTIVE',
    approved_at = statement_timestamp() - interval '1 minute',
    expires_at = statement_timestamp() + interval '1 hour',
    deployment_manifest_sha256 = repeat('c', 64),
    writer_fence_grant_sha256 = repeat('d', 64),
    credential_set_sha256 = repeat('e', 64),
    activated_at = transaction_timestamp()
WHERE connection_id = '$CONNECTION_A'::uuid AND run_id = 'fleet-a-001';
COMMIT;
SQL

security_fingerprint() {
  psql "$DATABASE_URL" -XAtq <<'SQL'
WITH security_contract AS (
  SELECT 'rls|' || c.relname || '|' || c.relrowsecurity::text AS item
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname IN ('runtime_canary_connections', 'runtime_connection_credentials')
  UNION ALL
  SELECT 'policy|' || tablename || '|' || policyname || '|' || cmd || '|'
    || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, '')
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename IN ('runtime_canary_connections', 'runtime_connection_credentials')
  UNION ALL
  SELECT 'grant|' || table_name || '|' || grantee || '|' || privilege_type
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public'
    AND table_name IN ('runtime_canary_connections', 'runtime_connection_credentials')
)
SELECT md5(string_agg(item, E'\n' ORDER BY item)) FROM security_contract;
SQL
}

security_before=$(security_fingerprint)
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$MIGRATION" >/dev/null
security_after=$(security_fingerprint)
test "$security_before" = "$security_after" || {
  printf 'SECURITY_CONTRACT_CHANGED before=%s after=%s\n' "$security_before" "$security_after" >&2
  exit 1
}

index_contract=$(psql "$DATABASE_URL" -XAtq -F '|' -c "
  SELECT
    to_regclass('public.runtime_canary_connections_single_active_idx') IS NULL,
    pg_get_indexdef('public.runtime_canary_connections_one_active_per_connection_idx'::regclass)
")
case "$index_contract" in
  "t|"*"UNIQUE INDEX runtime_canary_connections_one_active_per_connection_idx"*"(connection_id) WHERE (active = true)"*) ;;
  *) printf 'FLEET_INDEX_CONTRACT_INVALID=%s\n' "$index_contract" >&2; exit 1 ;;
esac

function_security=$(psql "$DATABASE_URL" -XAtq -F '|' -c "
  SELECT
    has_function_privilege('middleware_runtime', 'public.assert_runtime_fleet_connection_scope_generation(uuid,text)', 'EXECUTE')::int,
    has_function_privilege('middleware_runtime', 'public.validate_runtime_fleet_scope_transition()', 'EXECUTE')::int,
    has_function_privilege('middleware_runtime', 'public.validate_runtime_fleet_credential_transition()', 'EXECUTE')::int,
    (SELECT count(*) FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
      WHERE p.pronamespace = 'public'::regnamespace
        AND p.proname IN ('assert_runtime_fleet_connection_scope_generation', 'validate_runtime_fleet_scope_transition', 'validate_runtime_fleet_credential_transition')
        AND acl.grantee = 0
        AND acl.privilege_type = 'EXECUTE')
")
test "$function_security" = '0|0|0|0' || {
  printf 'FLEET_FUNCTION_PRIVILEGES_TOO_BROAD=%s\n' "$function_security" >&2
  exit 1
}

psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 >/dev/null <<SQL
INSERT INTO public.pos_connections (
  id, location_name, provider, base_url, api_token, enabled,
  catalog_sync_enabled, sync_mode, write_mode, backfill_days
) VALUES
  ('$CONNECTION_B', 'Fleet B', 'agora', 'https://redacted.invalid', '', false, false, 'PULL_ONLY', 'NONE', 0),
  ('$CONNECTION_C', 'Fleet C', 'agora', 'https://redacted.invalid', '', false, false, 'PULL_ONLY', 'NONE', 0),
  ('$CONNECTION_D', 'Fleet D', 'agora', 'https://redacted.invalid', '', false, false, 'PULL_ONLY', 'NONE', 0);
SQL

prepare_generation() {
  local connection_id=$1
  local run_id=$2
  local key_version=$3
  local seed=$4
  psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 >/dev/null <<SQL
BEGIN;
INSERT INTO public.runtime_canary_connections (
  connection_id, run_id, generation_mode, status, active, note
) VALUES (
  '$connection_id', '$run_id', 'bootstrap', 'PREPARED', false, 'fleet-test:$run_id'
);
INSERT INTO public.runtime_connection_credentials (
  connection_id, provider, credential_kind, run_id, key_version,
  ciphertext, nonce, attestation_sha256, active
) VALUES
  ('$connection_id', 'agora', 'agora', '$run_id', '$key_version',
    decode(repeat('$seed', 32), 'hex'), decode(repeat('$seed', 12), 'hex'), repeat('a', 64), false),
  ('$connection_id', 'agora', 'winerim', '$run_id', '$key_version',
    decode(repeat('$seed', 33), 'hex'), decode(repeat('$seed', 12), 'hex'), repeat('b', 64), false);
COMMIT;
SQL
}

activate_generation() {
  local connection_id=$1
  local run_id=$2
  psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 >/dev/null <<SQL
BEGIN;
UPDATE public.runtime_connection_credentials
SET active = true, activated_at = transaction_timestamp()
WHERE connection_id = '$connection_id'::uuid AND run_id = '$run_id';
UPDATE public.runtime_canary_connections
SET active = true,
    status = 'ACTIVE',
    approved_at = statement_timestamp() - interval '1 minute',
    expires_at = statement_timestamp() + interval '1 hour',
    deployment_manifest_sha256 = repeat('c', 64),
    writer_fence_grant_sha256 = repeat('d', 64),
    credential_set_sha256 = repeat('e', 64),
    activated_at = transaction_timestamp()
WHERE connection_id = '$connection_id'::uuid AND run_id = '$run_id';
SET CONSTRAINTS ALL IMMEDIATE;
COMMIT;
SQL
}

expect_failure() {
  local label=$1
  local pattern=$2
  local sql_file=$3
  if psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$sql_file" >"$TMP_ROOT/$label.out" 2>&1; then
    printf '%s_WAS_ACCEPTED\n' "$label" >&2
    exit 1
  fi
  grep -Eq "$pattern" "$TMP_ROOT/$label.out" || {
    printf '%s_FAILED_WITH_UNEXPECTED_ERROR\n' "$label" >&2
    cat "$TMP_ROOT/$label.out" >&2
    exit 1
  }
}

prepare_generation "$CONNECTION_B" fleet-b-001 fleet-key-b 22

canary_compatibility=$(psql "$DATABASE_URL" -XAtq -F '|' -c "
  SET ROLE middleware_runtime;
  SELECT
    (SELECT count(*) FROM public.runtime_canary_connections),
    (SELECT count(*) FROM public.runtime_connection_credentials),
    (SELECT count(*) FROM public.pos_connections);
  RESET ROLE;
")
test "$canary_compatibility" = '1|2|1' || {
  printf 'SINGLE_CANARY_COMPATIBILITY_INVALID=%s\n' "$canary_compatibility" >&2
  exit 1
}

activate_generation "$CONNECTION_B" fleet-b-001
fleet_visibility=$(psql "$DATABASE_URL" -XAtq -F '|' -c "
  SET ROLE middleware_runtime;
  SELECT
    (SELECT count(*) FROM public.runtime_canary_connections),
    (SELECT count(*) FROM public.runtime_connection_credentials),
    (SELECT count(*) FROM public.pos_connections);
  RESET ROLE;
")
test "$fleet_visibility" = '2|4|2' || {
  printf 'MULTI_CONNECTION_FLEET_VISIBILITY_INVALID=%s\n' "$fleet_visibility" >&2
  exit 1
}

prepare_generation "$CONNECTION_A" fleet-a-002 fleet-key-a2 33
cat > "$TMP_ROOT/duplicate-scope.sql" <<SQL
BEGIN;
UPDATE public.runtime_canary_connections
SET active = true, status = 'ACTIVE',
    approved_at = statement_timestamp() - interval '1 minute',
    expires_at = statement_timestamp() + interval '1 hour',
    deployment_manifest_sha256 = repeat('1', 64),
    writer_fence_grant_sha256 = repeat('2', 64),
    credential_set_sha256 = repeat('3', 64),
    activated_at = transaction_timestamp()
WHERE connection_id = '$CONNECTION_A'::uuid AND run_id = 'fleet-a-002';
COMMIT;
SQL
expect_failure duplicate_scope 'runtime_canary_connections_one_active_per_connection_idx' "$TMP_ROOT/duplicate-scope.sql"

prepare_generation "$CONNECTION_C" fleet-c-001 fleet-key-c 44
cat > "$TMP_ROOT/incomplete-credentials.sql" <<SQL
BEGIN;
UPDATE public.runtime_connection_credentials
SET active = true, activated_at = transaction_timestamp()
WHERE connection_id = '$CONNECTION_C'::uuid
  AND run_id = 'fleet-c-001'
  AND credential_kind = 'agora';
UPDATE public.runtime_canary_connections
SET active = true, status = 'ACTIVE',
    approved_at = statement_timestamp() - interval '1 minute',
    expires_at = statement_timestamp() + interval '1 hour',
    deployment_manifest_sha256 = repeat('4', 64),
    writer_fence_grant_sha256 = repeat('5', 64),
    credential_set_sha256 = repeat('6', 64),
    activated_at = transaction_timestamp()
WHERE connection_id = '$CONNECTION_C'::uuid AND run_id = 'fleet-c-001';
SET CONSTRAINTS ALL IMMEDIATE;
COMMIT;
SQL
expect_failure incomplete_credentials 'RUNTIME_FLEET_SCOPE_CREDENTIALS_INVALID' "$TMP_ROOT/incomplete-credentials.sql"

prepare_generation "$CONNECTION_D" fleet-d-001 fleet-key-d1 55
prepare_generation "$CONNECTION_D" fleet-d-002 fleet-key-d2 66
cat > "$TMP_ROOT/crossed-credentials.sql" <<SQL
BEGIN;
UPDATE public.runtime_connection_credentials
SET active = true, activated_at = transaction_timestamp()
WHERE connection_id = '$CONNECTION_D'::uuid
  AND (
    (run_id = 'fleet-d-001' AND credential_kind = 'agora')
    OR (run_id = 'fleet-d-002' AND credential_kind = 'winerim')
  );
UPDATE public.runtime_canary_connections
SET active = true, status = 'ACTIVE',
    approved_at = statement_timestamp() - interval '1 minute',
    expires_at = statement_timestamp() + interval '1 hour',
    deployment_manifest_sha256 = repeat('7', 64),
    writer_fence_grant_sha256 = repeat('8', 64),
    credential_set_sha256 = repeat('9', 64),
    activated_at = transaction_timestamp()
WHERE connection_id = '$CONNECTION_D'::uuid AND run_id = 'fleet-d-001';
SET CONSTRAINTS ALL IMMEDIATE;
COMMIT;
SQL
expect_failure crossed_credentials 'RUNTIME_FLEET_SCOPE_CREDENTIALS_INVALID|RUNTIME_FLEET_SCOPE_ACTIVE_CREDENTIAL_WITHOUT_SCOPE' "$TMP_ROOT/crossed-credentials.sql"

psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 >/dev/null <<SQL
BEGIN;
UPDATE public.runtime_connection_credentials
SET active = false, retired_at = transaction_timestamp()
WHERE connection_id = '$CONNECTION_B'::uuid AND run_id = 'fleet-b-001' AND active;
UPDATE public.runtime_canary_connections
SET active = false, status = 'RETIRED', retired_at = transaction_timestamp()
WHERE connection_id = '$CONNECTION_B'::uuid AND run_id = 'fleet-b-001' AND active;
SET CONSTRAINTS ALL IMMEDIATE;
COMMIT;
SQL

cat > "$TMP_ROOT/terminal-scope.sql" <<SQL
UPDATE public.runtime_canary_connections
SET note = 'terminal-mutation-must-fail'
WHERE connection_id = '$CONNECTION_B'::uuid AND run_id = 'fleet-b-001';
SQL
expect_failure terminal_scope 'RUNTIME_CANARY_SCOPE_TERMINAL' "$TMP_ROOT/terminal-scope.sql"

cat > "$TMP_ROOT/terminal-credential.sql" <<SQL
UPDATE public.runtime_connection_credentials
SET active = true
WHERE connection_id = '$CONNECTION_B'::uuid AND run_id = 'fleet-b-001';
SQL
expect_failure terminal_credential 'RUNTIME_CREDENTIAL_TERMINAL|RUNTIME_CREDENTIAL_REACTIVATION_REJECTED' "$TMP_ROOT/terminal-credential.sql"

psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 >/dev/null <<SQL
BEGIN;
UPDATE public.runtime_connection_credentials
SET active = false, retired_at = transaction_timestamp()
WHERE connection_id = '$CONNECTION_A'::uuid AND run_id = 'fleet-a-001' AND active;
UPDATE public.runtime_canary_connections
SET active = false, status = 'RETIRED', retired_at = transaction_timestamp()
WHERE connection_id = '$CONNECTION_A'::uuid AND run_id = 'fleet-a-001' AND active;
SET CONSTRAINTS ALL IMMEDIATE;
COMMIT;
SQL

# Prove a complete activation can be rolled back without leaving an active scope.
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 >/dev/null <<SQL
BEGIN;
UPDATE public.runtime_connection_credentials
SET active = true, activated_at = transaction_timestamp()
WHERE connection_id = '$CONNECTION_C'::uuid AND run_id = 'fleet-c-001';
UPDATE public.runtime_canary_connections
SET active = true, status = 'ACTIVE',
    approved_at = statement_timestamp() - interval '1 minute',
    expires_at = statement_timestamp() + interval '1 hour',
    deployment_manifest_sha256 = repeat('a', 64),
    writer_fence_grant_sha256 = repeat('b', 64),
    credential_set_sha256 = repeat('c', 64),
    activated_at = transaction_timestamp()
WHERE connection_id = '$CONNECTION_C'::uuid AND run_id = 'fleet-c-001';
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;
SQL

final_state=$(psql "$DATABASE_URL" -XAtq -F '|' -c "
  SELECT
    (SELECT count(*) FROM public.runtime_canary_connections WHERE active),
    (SELECT count(*) FROM public.runtime_connection_credentials WHERE active),
    (SELECT count(*) FROM public.runtime_canary_connections WHERE status = 'RETIRED'),
    (SELECT count(*) FROM public.runtime_connection_credentials WHERE retired_at IS NOT NULL)
")
test "$final_state" = '0|0|2|4' || {
  printf 'FINAL_FAIL_CLOSED_STATE_INVALID=%s\n' "$final_state" >&2
  exit 1
}

printf 'RESULT=RUNTIME_FLEET_CONNECTION_SCOPE_OK postgres_major=17 single_canary=compatible active_connections=2 duplicate_same_connection=blocked incomplete_credentials=blocked crossed_credentials=blocked terminal=preserved rls_grants=unchanged rollback=clean\n'
