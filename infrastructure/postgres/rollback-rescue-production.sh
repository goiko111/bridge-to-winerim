#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/postgres-client-tools.sh"
DATABASE_URL=${RESCUE_PRODUCTION_DATABASE_URL:-}
RUNTIME_DATABASE_URL=${RESCUE_PRODUCTION_RUNTIME_DATABASE_URL:-}
ARTIFACT_DIR=${RESCUE_PRODUCTION_ROLLBACK_ARTIFACT_DIR:-}
APPLY=0
CONFIRM_PROJECT_REF=''
CONFIRM_PLAN_SHA=''
CONFIRM_ACTION=''

while [ "$#" -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --confirm-project-ref) CONFIRM_PROJECT_REF=${2:-}; shift 2 ;;
    --confirm-plan-sha) CONFIRM_PLAN_SHA=${2:-}; shift 2 ;;
    --confirm-action) CONFIRM_ACTION=${2:-}; shift 2 ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done

command -v node >/dev/null 2>&1 || { printf 'BLOCKED_MISSING_COMMAND=node\n' >&2; exit 2; }
if command -v sha256sum >/dev/null 2>&1; then SHA256=(sha256sum); else SHA256=(shasum -a 256); fi
test -n "$DATABASE_URL" || { printf 'RESCUE_PRODUCTION_DATABASE_URL_REQUIRED\n' >&2; exit 2; }
configure_postgres_tools "$DATABASE_URL"
test -n "$ARTIFACT_DIR" && test -d "$ARTIFACT_DIR" || { printf 'RESCUE_PRODUCTION_ROLLBACK_ARTIFACT_DIR_REQUIRED\n' >&2; exit 2; }
case "$ARTIFACT_DIR" in /*) ;; *) printf 'ABSOLUTE_ROLLBACK_ARTIFACT_DIR_REQUIRED\n' >&2; exit 2 ;; esac

target_json=$(node "$SCRIPT_DIR/rescue-production-target.mjs")
project_ref=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).projectRef)' "$target_json")
target_mode=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).mode)' "$target_json")
manifest="$ARTIFACT_DIR/manifest.txt"
manifest_digest="$ARTIFACT_DIR/manifest.txt.sha256"
dump="$ARTIFACT_DIR/public.dump"
toc="$ARTIFACT_DIR/public.toc"
roles="$ARTIFACT_DIR/roles.tsv"
memberships="$ARTIFACT_DIR/memberships.tsv"
inventory="$ARTIFACT_DIR/public-tables.tsv"
prerequisites="$ARTIFACT_DIR/restore-prerequisites.sql"
for required_file in "$manifest" "$manifest_digest" "$dump" "$toc" "$roles" "$memberships" "$inventory" "$prerequisites"; do
  test -f "$required_file" || { printf 'ROLLBACK_ARTIFACT_INCOMPLETE\n' >&2; exit 3; }
done

(cd "$ARTIFACT_DIR" && "${SHA256[@]}" -c "$(basename "$manifest_digest")" >/dev/null) || {
  printf 'ROLLBACK_MANIFEST_DIGEST_REJECTED\n' >&2; exit 3;
}
manifest_value() { awk -F= -v key="$1" '$1 == key {print substr($0, index($0, "=") + 1)}' "$manifest"; }
test "$(manifest_value project_ref)" = "$project_ref" || { printf 'ROLLBACK_PROJECT_REF_MISMATCH\n' >&2; exit 3; }

verify_artifact_digest() {
  local file=$1
  local key=$2
  test "$("${SHA256[@]}" "$file" | awk '{print $1}')" = "$(manifest_value "$key")" || {
    printf 'ROLLBACK_ARTIFACT_DIGEST_REJECTED file=%s\n' "$(basename "$file")" >&2
    exit 3
  }
}
verify_artifact_digest "$dump" dump_sha256
verify_artifact_digest "$toc" toc_sha256
verify_artifact_digest "$roles" roles_sha256
verify_artifact_digest "$memberships" memberships_sha256
verify_artifact_digest "$inventory" inventory_sha256
verify_artifact_digest "$prerequisites" restore_prerequisites_sha256

phase=$(manifest_value phase)
case "$phase" in
  pre-canary)
    pre_canary_schema_version=$(manifest_value schema_version)
    case "$pre_canary_schema_version" in 3|5) ;; *) printf 'ROLLBACK_PRE_CANARY_SCHEMA_VERSION_REJECTED\n' >&2; exit 3 ;; esac
    test "$(manifest_value observed_environment)" = rescue-production || { printf 'ROLLBACK_PRE_CANARY_ENVIRONMENT_REJECTED\n' >&2; exit 3; }
    test "$(manifest_value public_table_count)" = 30 || { printf 'ROLLBACK_PRE_CANARY_TABLES_REJECTED\n' >&2; exit 3; }
    if [ "$target_mode" != local-disposable ]; then
      test "$(manifest_value backup_storage)" = encrypted-disk-image || { printf 'ROLLBACK_PRE_CANARY_STORAGE_REJECTED\n' >&2; exit 3; }
    fi
    test -n "$RUNTIME_DATABASE_URL" || { printf 'RESCUE_PRODUCTION_RUNTIME_DATABASE_URL_REQUIRED\n' >&2; exit 3; }
    if [ "$pre_canary_schema_version" = 5 ]; then
      hydration_plan_artifact="$ARTIFACT_DIR/hydration-plan.json"
      test -f "$hydration_plan_artifact" && test ! -L "$hydration_plan_artifact" || {
        printf 'ROLLBACK_HYDRATION_PLAN_ARTIFACT_REJECTED\n' >&2
        exit 3
      }
      verify_artifact_digest "$hydration_plan_artifact" hydration_plan_sha256
      hydration_connection_id=$(manifest_value hydration_connection_id)
      hydration_wines=$(manifest_value hydration_winerim_wines)
      hydration_products=$(manifest_value hydration_provider_products)
      hydration_mappings=$(manifest_value hydration_product_mappings)
      hydration_master=$(manifest_value hydration_master_rows)
      hydration_digest=$(manifest_value hydration_digest)
      if [[ ! "$hydration_connection_id" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$ ]]; then
        printf 'ROLLBACK_HYDRATION_CONNECTION_ID_REJECTED\n' >&2
        exit 3
      fi
      for hydration_count in "$hydration_wines" "$hydration_products" "$hydration_mappings" "$hydration_master"; do
        case "$hydration_count" in ''|*[!0-9]*) printf 'ROLLBACK_HYDRATION_COUNTS_REJECTED\n' >&2; exit 3 ;; esac
        [ "$hydration_count" -gt 0 ] || { printf 'ROLLBACK_HYDRATION_COUNTS_REJECTED\n' >&2; exit 3; }
      done
      test "$hydration_master" = 1 || { printf 'ROLLBACK_HYDRATION_MASTER_COUNT_REJECTED\n' >&2; exit 3; }
      [[ "$hydration_digest" =~ ^[0-9a-f]{64}$ ]] || { printf 'ROLLBACK_HYDRATION_DIGEST_REJECTED\n' >&2; exit 3; }
      if ! node - "$hydration_plan_artifact" "$hydration_connection_id" "$hydration_wines" "$hydration_products" "$hydration_mappings" "$hydration_digest" <<'NODE'
const { readFileSync } = require("node:fs");
const [path, connectionId, wines, products, mappings, digest] = process.argv.slice(2);
const plan = JSON.parse(readFileSync(path, "utf8"));
if (plan?.schemaVersion !== 2 || plan?.kind !== "disabled-connection-hydration"
  || plan.connectionId !== connectionId || plan.hydrationDigest !== digest
  || plan?.counts?.currentWinerimWines !== Number(wines)
  || plan?.counts?.currentAgoraProducts !== Number(products)
  || plan?.counts?.acceptedMappings !== Number(mappings)) process.exit(1);
NODE
      then
        printf 'ROLLBACK_HYDRATION_PLAN_CONTRACT_REJECTED\n' >&2
        exit 3
      fi
      expected_inventory=$(awk -v wines="$hydration_wines" -v products="$hydration_products" -v mappings="$hydration_mappings" -v master="$hydration_master" 'BEGIN {OFS="\t"} $0=="infrastructure_metadata" {print $0,1; next} $0=="pos_connections" {print $0,31; next} $0=="winerim_wines" {print $0,wines; next} $0=="provider_products" {print $0,products; next} $0=="product_mappings" {print $0,mappings; next} $0=="agora_master_data" {print $0,master; next} {print $0,0}' "$SCRIPT_DIR/expected-tables-runtime-postupgrade.txt")
    else
      expected_inventory=$(awk 'BEGIN {OFS="\t"} $0=="infrastructure_metadata" {print $0,1; next} $0=="pos_connections" {print $0,31; next} {print $0,0}' "$SCRIPT_DIR/expected-tables-runtime-postupgrade.txt")
    fi
    if ! diff -u <(printf '%s\n' "$expected_inventory") "$inventory" >&2; then
      printf 'ROLLBACK_PRE_CANARY_NOT_INERT\n' >&2
      exit 3
    fi
    confirm_action_expected=ROLLBACK_RESCUE_PRODUCTION_TO_PRE_CANARY
    ;;
  pre-bootstrap)
    test "$(manifest_value observed_environment)" = absent || { printf 'ROLLBACK_PRESTATE_REJECTED\n' >&2; exit 3; }
    test "$(manifest_value public_table_count)" = 0 || { printf 'ROLLBACK_PRESTATE_TABLES_REJECTED\n' >&2; exit 3; }
    test ! -s "$roles" || { printf 'ROLLBACK_PRESTATE_ROLES_REJECTED\n' >&2; exit 3; }
    confirm_action_expected=ROLLBACK_UNUSED_RESCUE_PRODUCTION
    ;;
  *) printf 'ROLLBACK_PHASE_REJECTED\n' >&2; exit 3 ;;
esac

query() {
  PGOPTIONS="${PGOPTIONS:+$PGOPTIONS }-c default_transaction_read_only=on -c statement_timeout=15000 -c lock_timeout=1000" \
    "$PSQL_CMD" "$DATABASE_URL" -XAtq -v ON_ERROR_STOP=1 -c "$1"
}
actual_tables=$(query "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' ORDER BY c.relname")
if [ -n "$actual_tables" ] && ! diff -u <(printf '%s\n' "$actual_tables") "$SCRIPT_DIR/expected-tables-runtime-postupgrade.txt" >/dev/null; then
  printf 'ROLLBACK_UNKNOWN_TABLE_INVENTORY_REJECTED\n' >&2
  exit 3
fi
sentinel=$(query "SELECT CASE WHEN to_regclass('public.infrastructure_metadata') IS NULL THEN 'absent' ELSE (SELECT coalesce(value,'missing-row') FROM public.infrastructure_metadata WHERE key='environment') END")
test "$sentinel" = rescue-production || { printf 'ROLLBACK_ENVIRONMENT_REJECTED\n' >&2; exit 3; }
connections=$(query 'SELECT count(*) FROM public.pos_connections')
test "$connections" = 31 || { printf 'ROLLBACK_CONNECTION_COUNT_REJECTED actual=%s\n' "$connections" >&2; exit 3; }

if [ "$phase" = pre-bootstrap ]; then
  unsafe=$(query "SELECT count(*) FROM public.pos_connections WHERE enabled OR catalog_sync_enabled OR sync_mode <> 'PULL_ONLY' OR write_mode <> 'NONE' OR backfill_days <> 0 OR last_sync_at IS NOT NULL OR last_catalog_sync_at IS NOT NULL OR last_business_day_synced IS NOT NULL OR circuit_breaker_paused_until IS NOT NULL OR consecutive_failures <> 0 OR base_url <> 'https://redacted.invalid' OR api_token <> '' OR winerim_api_token IS NOT NULL")
  non_seed_rows=$(query "SELECT coalesce(sum((xpath('/row/count/text()', query_to_xml(format('SELECT count(*) AS count FROM public.%I', c.relname), false, true, '')))[1]::text::bigint), 0) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relname NOT IN ('infrastructure_metadata','pos_connections')")
  test "$unsafe" = 0 && test "$non_seed_rows" = 0 || {
    printf 'ROLLBACK_LIVE_OR_UNKNOWN_DATA_REJECTED connections=%s unsafe=%s non_seed_rows=%s\n' "$connections" "$unsafe" "$non_seed_rows" >&2
    exit 3
  }
  rollback_scope='empty-bootstrap'
else
  enabled_count=$(query "SELECT count(*) FROM public.pos_connections WHERE enabled")
  active_scope_count=$(query "SELECT count(*) FROM public.runtime_canary_connections WHERE active")
  test "$enabled_count" -le 1 && test "$active_scope_count" -le 1 || {
    printf 'ROLLBACK_MULTIPLE_ACTIVE_CONNECTIONS_REJECTED enabled=%s scopes=%s\n' "$enabled_count" "$active_scope_count" >&2
    exit 3
  }
  if [ "$enabled_count" = 0 ] && [ "$active_scope_count" = 0 ]; then
    inert_control_plane=$(query "SELECT count(*) FROM public.pos_connections WHERE enabled OR catalog_sync_enabled OR sync_mode<>'PULL_ONLY' OR write_mode<>'NONE' OR backfill_days<>0")
    operational_rows=$(query "SELECT (SELECT count(*) FROM public.runtime_canary_connections) + (SELECT count(*) FROM public.runtime_connection_credentials) + (SELECT count(*) FROM public.runtime_idempotency) + (SELECT count(*) FROM public.runtime_execution_log) + (SELECT count(*) FROM public.sales_events) + (SELECT count(*) FROM public.sales_line_items) + (SELECT count(*) FROM public.stock_sync_log) + (SELECT count(*) FROM public.outbound_tasks)")
    hydration_connection_count=$(query "SELECT count(DISTINCT connection_id) FROM (SELECT connection_id FROM public.winerim_wines UNION ALL SELECT connection_id FROM public.provider_products UNION ALL SELECT connection_id FROM public.product_mappings UNION ALL SELECT connection_id FROM public.agora_master_data UNION ALL SELECT connection_id FROM public.winerim_push_tracking) hydrated")
    test "$hydration_connection_count" -le 1 || {
      printf 'ROLLBACK_MULTI_CONNECTION_HYDRATION_REJECTED connections=%s\n' "$hydration_connection_count" >&2
      exit 3
    }
    disallowed_hydration_rows=$(query "SELECT coalesce(sum((xpath('/row/count/text()', query_to_xml(format('SELECT count(*) AS count FROM public.%I', c.relname), false, true, '')))[1]::text::bigint),0) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relname NOT IN ('infrastructure_metadata','pos_connections','winerim_wines','provider_products','product_mappings','agora_master_data','winerim_push_tracking')")
    login_roles=$(query "SELECT count(*) FROM pg_roles WHERE rolname IN ('middleware_api_login','middleware_readonly_login','middleware_runtime_login') AND rolcanlogin")
    test "$inert_control_plane" = 0 && test "$operational_rows" = 0 && test "$disallowed_hydration_rows" = 0 && test "$login_roles" = 3 || {
      printf 'ROLLBACK_HYDRATION_STATE_REJECTED control_plane=%s operational_rows=%s disallowed_rows=%s login_roles=%s\n' "$inert_control_plane" "$operational_rows" "$disallowed_hydration_rows" "$login_roles" >&2
      exit 3
    }
    if [ "$hydration_connection_count" = 0 ]; then
      rollback_scope='pre-hydration-inert'
    else
      candidate_id=$(query "SELECT connection_id::text FROM (SELECT connection_id FROM public.winerim_wines UNION ALL SELECT connection_id FROM public.provider_products UNION ALL SELECT connection_id FROM public.product_mappings UNION ALL SELECT connection_id FROM public.agora_master_data UNION ALL SELECT connection_id FROM public.winerim_push_tracking) hydrated LIMIT 1")
      rollback_scope="hydration-only:$candidate_id"
    fi
  else
    candidate_id=$(query "SELECT coalesce((SELECT connection_id::text FROM public.runtime_canary_connections WHERE active), (SELECT id::text FROM public.pos_connections WHERE enabled), '00000000-0000-0000-0000-000000000000')")
    identity_mismatch=$(query "SELECT CASE WHEN (SELECT count(*) FROM public.pos_connections WHERE enabled)=1 AND (SELECT count(*) FROM public.runtime_canary_connections WHERE active)=1 AND (SELECT id FROM public.pos_connections WHERE enabled)<>(SELECT connection_id FROM public.runtime_canary_connections WHERE active) THEN 1 ELSE 0 END")
    noncandidate_control_plane=$(query "SELECT count(*) FROM public.pos_connections WHERE id<>'$candidate_id'::uuid AND (enabled OR catalog_sync_enabled OR write_mode<>'NONE')")
    active_credentials=$(query "SELECT count(*) FROM public.runtime_connection_credentials WHERE active")
    credential_shape=$(query "SELECT coalesce(string_agg(credential_kind, ',' ORDER BY credential_kind),'') FROM public.runtime_connection_credentials WHERE active AND connection_id='$candidate_id'::uuid")
    unscoped_connection_rows=$(query "SELECT coalesce(sum((xpath('/row/count/text()', query_to_xml(format('SELECT count(*) AS count FROM public.%I WHERE connection_id <> %L::uuid', c.relname, '$candidate_id'), false, true, '')))[1]::text::bigint),0) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN information_schema.columns col ON col.table_schema='public' AND col.table_name=c.relname AND col.column_name='connection_id' WHERE n.nspname='public' AND c.relkind='r' AND c.relname<>'pos_connections'")
    unscoped_tables_without_connection=$(query "SELECT coalesce(sum((xpath('/row/count/text()', query_to_xml(format('SELECT count(*) AS count FROM public.%I', c.relname), false, true, '')))[1]::text::bigint),0) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relname NOT IN ('infrastructure_metadata','pos_connections') AND NOT EXISTS (SELECT 1 FROM information_schema.columns col WHERE col.table_schema='public' AND col.table_name=c.relname AND col.column_name='connection_id')")
    outbound_debt=$(query "SELECT count(*) FROM public.outbound_tasks")
    login_roles=$(query "SELECT count(*) FROM pg_roles WHERE rolname IN ('middleware_api_login','middleware_readonly_login','middleware_runtime_login') AND rolcanlogin")
    test "$identity_mismatch" = 0 && test "$noncandidate_control_plane" = 0 && test "$unscoped_connection_rows" = 0 && test "$unscoped_tables_without_connection" = 0 && test "$outbound_debt" = 0 && test "$login_roles" = 3 || {
      printf 'ROLLBACK_CANARY_SCOPE_REJECTED identity_mismatch=%s noncandidate_control=%s unscoped_rows=%s unscoped_tables=%s outbound_debt=%s login_roles=%s\n' "$identity_mismatch" "$noncandidate_control_plane" "$unscoped_connection_rows" "$unscoped_tables_without_connection" "$outbound_debt" "$login_roles" >&2
      exit 3
    }
    if [ "$active_credentials" -gt 0 ]; then
      test "$active_credentials" = 2 && test "$credential_shape" = agora,winerim || {
        printf 'ROLLBACK_CANARY_CREDENTIAL_SCOPE_REJECTED active=%s kinds=%s\n' "$active_credentials" "$credential_shape" >&2
        exit 3
      }
    fi
    rollback_scope="prepared-canary:$candidate_id"
  fi
fi

state_counts=$(query "SELECT coalesce(string_agg(format('%s=%s', c.relname, (xpath('/row/count/text()', query_to_xml(format('SELECT count(*) AS count FROM public.%I', c.relname), false, true, '')))[1]::text::bigint), ',' ORDER BY c.relname), '') FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'")
candidate_binding=${candidate_id:-none}
state_fingerprint=$(
  {
    printf 'project_ref=%s\nphase=%s\nscope=%s\nconnection=%s\ncounts=%s\n' \
      "$project_ref" "$phase" "$rollback_scope" "$candidate_binding" "$state_counts"
    printf '%s\n' "$actual_tables"
    while IFS= read -r table_name; do
      [[ "$table_name" =~ ^[a-z_][a-z0-9_]*$ ]] || {
        printf 'ROLLBACK_STATE_TABLE_IDENTIFIER_REJECTED\n' >&2
        exit 3
      }
      printf 'table=%s\n' "$table_name"
      query "SELECT to_jsonb(state_row)::text FROM public.\"$table_name\" state_row ORDER BY to_jsonb(state_row)::text"
    done <<<"$actual_tables"
    query "SELECT to_jsonb(role_state)::text FROM (SELECT rolname, rolcanlogin, rolinherit, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname LIKE 'middleware_%' ORDER BY rolname) role_state"
    query "SELECT to_jsonb(membership_state)::text FROM (SELECT granted.rolname AS granted_role, member.rolname AS member_role, membership.admin_option FROM pg_auth_members membership JOIN pg_roles granted ON granted.oid=membership.roleid JOIN pg_roles member ON member.oid=membership.member WHERE granted.rolname LIKE 'middleware_%' OR member.rolname LIKE 'middleware_%' ORDER BY granted.rolname, member.rolname) membership_state"
  } | "${SHA256[@]}" | awk '{print $1}'
)

dependency_binding=$(
  for dependency in \
    "$SCRIPT_DIR/postgres-client-tools.sh" \
    "$SCRIPT_DIR/rescue-production-target.mjs" \
    "$SCRIPT_DIR/expected-tables-runtime-postupgrade.txt" \
    "$SCRIPT_DIR/verify-encrypted-backup-root.mjs" \
    "$SCRIPT_DIR/backup-rescue-production.sh" \
    "$SCRIPT_DIR/verify-rescue-production.sh" \
    "$SCRIPT_DIR/verify-rescue-production-pre-canary.sh" \
    "$SCRIPT_DIR/rollback-rescue-production.sh"; do
    test -f "$dependency" || { printf 'ROLLBACK_DEPENDENCY_MISSING=%s\n' "$(basename "$dependency")" >&2; exit 3; }
    printf '%s\t%s\n' "$(basename "$dependency")" "$("${SHA256[@]}" "$dependency" | awk '{print $1}')"
  done | "${SHA256[@]}" | awk '{print $1}'
)

plan_sha=$(
  {
    printf 'rollback_plan_schema=2\nproject_ref=%s\nphase=%s\nscope=%s\nconnection=%s\ncounts=%s\nstate_fingerprint_sha256=%s\ndependencies_sha256=%s\n' \
      "$project_ref" "$phase" "$rollback_scope" "$candidate_binding" "$state_counts" "$state_fingerprint" "$dependency_binding"
    cat "$manifest" "$manifest_digest" "$dump" "$inventory" "$prerequisites"
  } | "${SHA256[@]}" | awk '{print $1}'
)
printf 'RESCUE_PRODUCTION_ROLLBACK_PLAN_OK project_ref=%s phase=%s scope=%s connection=%s counts_sha256=%s state_fingerprint_sha256=%s dependencies_sha256=%s plan_sha256=%s\n' \
  "$project_ref" "$phase" "$rollback_scope" "$candidate_binding" \
  "$(printf '%s' "$state_counts" | "${SHA256[@]}" | awk '{print $1}')" \
  "$state_fingerprint" "$dependency_binding" "$plan_sha"
if [ "$APPLY" -ne 1 ]; then printf 'RESULT=PLAN_ONLY\n'; exit 0; fi

test "$CONFIRM_PROJECT_REF" = "$project_ref" || { printf 'CONFIRM_PROJECT_REF_REJECTED\n' >&2; exit 4; }
test "$CONFIRM_PLAN_SHA" = "$plan_sha" || { printf 'CONFIRM_PLAN_SHA_REJECTED\n' >&2; exit 4; }
test "$CONFIRM_ACTION" = "$confirm_action_expected" || { printf 'CONFIRM_ACTION_REJECTED\n' >&2; exit 4; }

"$SCRIPT_DIR/backup-rescue-production.sh" pre-rollback
"$PSQL_CMD" "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -c 'DROP SCHEMA public CASCADE' >/dev/null

if [ "$phase" = pre-canary ]; then
  "$PSQL_CMD" "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$prerequisites" >/dev/null
  "$PG_RESTORE_CMD" --exit-on-error --no-owner --dbname "$DATABASE_URL" "$dump" >/dev/null
  if [ "$pre_canary_schema_version" = 5 ]; then
    RESCUE_PRODUCTION_EXPECTED_LOGIN_ROLES=3 \
      RESCUE_PRODUCTION_HYDRATION_CONNECTION_ID="$hydration_connection_id" \
      RESCUE_PRODUCTION_HYDRATION_PLAN_FILE="$hydration_plan_artifact" \
      RESCUE_PRODUCTION_EXPECTED_HYDRATION_WINERIM_WINES="$hydration_wines" \
      RESCUE_PRODUCTION_EXPECTED_HYDRATION_PROVIDER_PRODUCTS="$hydration_products" \
      RESCUE_PRODUCTION_EXPECTED_HYDRATION_PRODUCT_MAPPINGS="$hydration_mappings" \
      RESCUE_PRODUCTION_EXPECTED_HYDRATION_MASTER_ROWS="$hydration_master" \
      "$SCRIPT_DIR/verify-rescue-production.sh" >/dev/null
    RESCUE_PRODUCTION_HYDRATION_CONNECTION_ID="$hydration_connection_id" \
      RESCUE_PRODUCTION_HYDRATION_PLAN_FILE="$hydration_plan_artifact" \
      RESCUE_PRODUCTION_EXPECTED_HYDRATION_WINERIM_WINES="$hydration_wines" \
      RESCUE_PRODUCTION_EXPECTED_HYDRATION_PROVIDER_PRODUCTS="$hydration_products" \
      RESCUE_PRODUCTION_EXPECTED_HYDRATION_PRODUCT_MAPPINGS="$hydration_mappings" \
      RESCUE_PRODUCTION_EXPECTED_HYDRATION_MASTER_ROWS="$hydration_master" \
      "$SCRIPT_DIR/backup-rescue-production.sh" post-canary-rollback
  else
    RESCUE_PRODUCTION_EXPECTED_LOGIN_ROLES=3 "$SCRIPT_DIR/verify-rescue-production.sh" >/dev/null
    "$SCRIPT_DIR/backup-rescue-production.sh" post-canary-rollback
  fi
  printf 'RESULT=RESCUE_PRODUCTION_ROLLED_BACK_TO_PRE_CANARY project_ref=%s connections=31 unsafe=0 runtime_rows=0\n' "$project_ref"
  exit 0
fi

"$PG_RESTORE_CMD" --exit-on-error --no-owner --dbname "$DATABASE_URL" "$dump" >/dev/null
"$PSQL_CMD" "$DATABASE_URL" -X -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
DO $cleanup_roles$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['middleware_api', 'middleware_readonly', 'middleware_runtime']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('DROP OWNED BY %I', role_name);
      EXECUTE format('DROP ROLE %I', role_name);
    END IF;
  END LOOP;
END
$cleanup_roles$;
SQL

post_tables=$(query "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'")
post_roles=$(query "SELECT count(*) FROM pg_roles WHERE rolname LIKE 'middleware_%'")
post_metadata=$(query "SELECT (to_regclass('public.infrastructure_metadata') IS NOT NULL)::int")
test "$post_tables" = 0 && test "$post_roles" = 0 && test "$post_metadata" = 0 || {
  printf 'ROLLBACK_POSTVERIFY_FAILED tables=%s roles=%s metadata=%s\n' "$post_tables" "$post_roles" "$post_metadata" >&2
  exit 6
}
"$SCRIPT_DIR/backup-rescue-production.sh" post-rollback
printf 'RESULT=RESCUE_PRODUCTION_ROLLED_BACK_TO_EMPTY project_ref=%s tables=0 middleware_roles=0\n' "$project_ref"
