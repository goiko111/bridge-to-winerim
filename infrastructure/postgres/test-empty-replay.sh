#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
MIGRATIONS_DIR="$REPO_ROOT/supabase/migrations"
MANIFEST="$SCRIPT_DIR/migration-manifest.tsv"
EXPECTED="$SCRIPT_DIR/expected-schema.txt"

for command_name in initdb pg_ctl createdb psql; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'BLOCKED: %s is not installed\n' "$command_name" >&2
    exit 2
  fi
done

TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/winerim-postgres-replay.XXXXXX")
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
PORT=$((55432 + ($$ % 1000)))
DB_NAME=winerim_schema_replay
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

PSQL=(psql -X -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT")

createdb -h "$SOCKET_DIR" -p "$PORT" "$DB_NAME"

BOOTSTRAP_SQL="$TMP_ROOT/bootstrap.sql"
"$SCRIPT_DIR/build-bootstrap.sh" "$BOOTSTRAP_SQL" >/dev/null
"${PSQL[@]}" -d "$DB_NAME" -v environment=staging -f "$BOOTSTRAP_SQL" >/dev/null

applied=$(awk -F '\t' 'NR > 1 && ($5 == "INCLUDE" || $5 == "INCLUDE_SECURITY_GATE" || $5 == "INCLUDE_WITH_REVIEW") { count++ } END { print count + 0 }' "$MANIFEST")

missing=0
while read -r object_type object_name _; do
  case "$object_type" in
    TABLE)
      present=$("${PSQL[@]}" -d "$DB_NAME" -Atc "SELECT (to_regclass('public.$object_name') IS NOT NULL)::int")
      ;;
    FUNCTION)
      present=$("${PSQL[@]}" -d "$DB_NAME" -Atc "SELECT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='$object_name')::int")
      ;;
    COLUMN)
      table_name=${object_name%%.*}
      column_name=${object_name#*.}
      present=$("${PSQL[@]}" -d "$DB_NAME" -Atc "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='$table_name' AND column_name='$column_name')::int")
      ;;
    INDEX)
      present=$("${PSQL[@]}" -d "$DB_NAME" -Atc "SELECT (to_regclass('public.$object_name') IS NOT NULL)::int")
      ;;
    TRIGGER)
      table_name=${object_name%%.*}
      trigger_name=${object_name#*.}
      present=$("${PSQL[@]}" -d "$DB_NAME" -Atc "SELECT EXISTS (SELECT 1 FROM pg_trigger trigger JOIN pg_class table_class ON table_class.oid=trigger.tgrelid JOIN pg_namespace n ON n.oid=table_class.relnamespace WHERE n.nspname='public' AND table_class.relname='$table_name' AND trigger.tgname='$trigger_name' AND NOT trigger.tgisinternal)::int")
      ;;
    FOREIGN_KEY_SET_NULL)
      present=$("${PSQL[@]}" -d "$DB_NAME" -Atc "SELECT EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public' AND c.conname='$object_name' AND c.contype='f' AND c.confdeltype='n')::int")
      ;;
    \#*|'')
      continue
      ;;
    *)
      printf 'BLOCKED: unknown expected object type %s\n' "$object_type" >&2
      exit 2
      ;;
  esac

  if [ "$present" != "1" ]; then
    printf 'MISSING: %s %s\n' "$object_type" "$object_name" >&2
    missing=$((missing + 1))
  fi
done < "$EXPECTED"

# Parse and execute the reusable catalog audit in an enforced read-only
# transaction. Output is suppressed here because the focused counts below are
# the replay gate; operators can run validate.sh to inspect the full matrix.
"${PSQL[@]}" -d "$DB_NAME" -f "$SCRIPT_DIR/validate-readonly.sql" >/dev/null

CANARY_CONNECTION_A=11111111-1111-4111-8111-111111111111
CANARY_CONNECTION_B=22222222-2222-4222-8222-222222222222
"${PSQL[@]}" -d "$DB_NAME" >/dev/null <<SQL
INSERT INTO public.pos_connections (id, location_name, provider, base_url, api_token, enabled)
VALUES
  ('$CANARY_CONNECTION_A', 'Canary scope A', 'agora', 'https://a.invalid', '', false),
  ('$CANARY_CONNECTION_B', 'Canary scope B', 'agora', 'https://b.invalid', '', false);

DO \$test_unapproved\$
DECLARE rejected boolean := false;
BEGIN
  BEGIN
    INSERT INTO public.runtime_canary_connections (
      connection_id, run_id, active, status, approved_at, expires_at, note
    ) VALUES (
      '$CANARY_CONNECTION_A', 'empty-unapproved', true, 'ACTIVE', NULL,
      now() + interval '1 hour', 'rescue-canary-run:empty-unapproved'
    );
  EXCEPTION WHEN check_violation THEN
    rejected := true;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'active unapproved canary scope was accepted'; END IF;
END
\$test_unapproved\$;

DO \$test_expired\$
DECLARE rejected boolean := false;
BEGIN
  BEGIN
    INSERT INTO public.runtime_canary_connections (
      connection_id, run_id, active, status, approved_at, expires_at, note,
      deployment_manifest_sha256, writer_fence_grant_sha256,
      credential_set_sha256, activated_at
    ) VALUES (
      '$CANARY_CONNECTION_A', 'empty-expired', true, 'ACTIVE',
      now() - interval '2 hours', now() - interval '1 hour',
      'rescue-canary-run:empty-expired', repeat('a',64), repeat('b',64),
      repeat('c',64), now() - interval '2 hours'
    );
  EXCEPTION WHEN check_violation THEN
    rejected := true;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'expired active canary scope was accepted'; END IF;
END
\$test_expired\$;

INSERT INTO public.runtime_canary_connections (
  connection_id, run_id, active, status, approved_at, expires_at, note,
  deployment_manifest_sha256, writer_fence_grant_sha256,
  credential_set_sha256, activated_at
) VALUES (
  '$CANARY_CONNECTION_A', 'empty-valid-a', true, 'ACTIVE', now(), now() + interval '1 hour',
  'rescue-canary-run:empty-valid-a', repeat('a',64), repeat('b',64), repeat('c',64), now()
);

DO \$test_single_active\$
DECLARE rejected boolean := false;
BEGIN
  BEGIN
    INSERT INTO public.runtime_canary_connections (
      connection_id, run_id, active, status, approved_at, expires_at, note,
      deployment_manifest_sha256, writer_fence_grant_sha256,
      credential_set_sha256, activated_at
    ) VALUES (
      '$CANARY_CONNECTION_B', 'empty-valid-b', true, 'ACTIVE', now(), now() + interval '1 hour',
      'rescue-canary-run:empty-valid-b', repeat('d',64), repeat('e',64), repeat('f',64), now()
    );
  EXCEPTION WHEN unique_violation THEN
    rejected := true;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'second active canary scope was accepted'; END IF;
END
\$test_single_active\$;
SQL

runtime_canary_valid_scope=$("${PSQL[@]}" -q -d "$DB_NAME" -Atc "SET ROLE middleware_runtime; SELECT ((SELECT count(*) FROM public.runtime_canary_connections) = 1 AND (SELECT count(*) FROM public.pos_connections) = 1)::int")

"${PSQL[@]}" -d "$DB_NAME" >/dev/null <<SQL
DELETE FROM public.runtime_canary_connections;
INSERT INTO public.runtime_canary_connections (
  connection_id, run_id, active, status, approved_at, expires_at, note
) VALUES
  ('$CANARY_CONNECTION_A', 'empty-prepared-a', false, 'PREPARED', NULL, NULL,
   'rescue-canary-run:empty-prepared-a'),
  ('$CANARY_CONNECTION_B', 'empty-prepared-b', false, 'PREPARED', NULL, NULL,
   'rescue-canary-run:empty-prepared-b');
SQL
runtime_canary_invalid_scope_hidden=$("${PSQL[@]}" -q -d "$DB_NAME" -Atc "SET ROLE middleware_runtime; SELECT ((SELECT count(*) FROM public.runtime_canary_connections) = 0 AND (SELECT count(*) FROM public.pos_connections) = 0)::int")

"${PSQL[@]}" -d "$DB_NAME" >/dev/null <<SQL
INSERT INTO public.winerim_wines (
  connection_id, winerim_id, name, wine_type, is_active,
  price, bottle_sale_price, bottle_purchase_price,
  glass_sale_price, glass_cost_price, serve_by_glass
) VALUES
  ('$CANARY_CONNECTION_A', '855797', 'Canary wine', 'tinto', true, 12, 12, 4, 3, 1, true),
  ('$CANARY_CONNECTION_B', '855798', 'Outside wine', 'blanco', true, 10, 10, 3, NULL, NULL, false);
INSERT INTO public.product_mappings (
  connection_id, provider_product_id, provider_product_name,
  winerim_wine_id, winerim_wine_name, status, format_type
) VALUES (
  '$CANARY_CONNECTION_A', '1055797', 'Canary wine',
  '855797', 'Canary wine', 'CONFIRMED', 'BOTTLE'
);
INSERT INTO public.runtime_catalog_source_scope (
  connection_id, run_id, winerim_wine_id, format, agora_product_id
) VALUES (
  '$CANARY_CONNECTION_A', 'empty-prepared-a', '855797', 'BOTTLE', '1055797'
);
SQL

catalog_source_prepared_hidden=$("${PSQL[@]}" -q -d "$DB_NAME" -Atc "SET ROLE middleware_runtime; SELECT (count(*) = 0)::int FROM public.runtime_catalog_source_scope")

"${PSQL[@]}" -d "$DB_NAME" >/dev/null <<SQL
UPDATE public.runtime_canary_connections
SET status = 'ACTIVE', active = true,
  approved_at = now(), expires_at = now() + interval '1 hour',
  deployment_manifest_sha256 = repeat('a', 64),
  writer_fence_grant_sha256 = repeat('b', 64),
  credential_set_sha256 = repeat('c', 64),
  activated_at = now()
WHERE connection_id = '$CANARY_CONNECTION_A'
  AND run_id = 'empty-prepared-a';
SQL

catalog_source_active_visible=$("${PSQL[@]}" -q -d "$DB_NAME" -Atc "SET ROLE middleware_runtime; SELECT (count(*) = 1)::int FROM public.runtime_catalog_source_scope")
catalog_source_exact_update=$("${PSQL[@]}" -q -d "$DB_NAME" -Atc "SET ROLE middleware_runtime; WITH changed AS (UPDATE public.winerim_wines SET name='Canary wine refreshed', price=13, bottle_sale_price=13, bottle_purchase_price=5 WHERE connection_id='$CANARY_CONNECTION_A' AND winerim_id='855797' RETURNING 1) SELECT (count(*) = 1)::int FROM changed")

"${PSQL[@]}" -q -d "$DB_NAME" >/dev/null <<SQL
SET ROLE middleware_runtime;
DO \$catalog_source_format_rejected\$
DECLARE
  rejected boolean := false;
BEGIN
  BEGIN
    UPDATE public.winerim_wines
    SET glass_sale_price = 4
    WHERE connection_id = '$CANARY_CONNECTION_A'
      AND winerim_id = '855797';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'RUNTIME_CATALOG_SOURCE_FORMAT_SCOPE_REJECTED' THEN
      rejected := true;
    ELSE
      RAISE;
    END IF;
  END;
  IF NOT rejected THEN
    RAISE EXCEPTION 'off-format runtime catalog refresh was accepted';
  END IF;
END
\$catalog_source_format_rejected\$;

DO \$catalog_source_wine_rejected\$
DECLARE
  affected integer;
BEGIN
  UPDATE public.winerim_wines
  SET name = 'Outside wine changed'
  WHERE connection_id = '$CANARY_CONNECTION_B'
    AND winerim_id = '855798';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 0 THEN
    RAISE EXCEPTION 'out-of-scope runtime catalog wine refresh was accepted';
  END IF;
END
\$catalog_source_wine_rejected\$;
RESET ROLE;
SQL

catalog_source_privileges=$("${PSQL[@]}" -q -d "$DB_NAME" -Atc "SELECT (has_table_privilege('middleware_runtime', 'public.runtime_catalog_source_scope', 'SELECT') AND NOT has_table_privilege('middleware_runtime', 'public.runtime_catalog_source_scope', 'INSERT,UPDATE,DELETE') AND has_column_privilege('middleware_runtime', 'public.winerim_wines', 'bottle_sale_price', 'UPDATE') AND has_column_privilege('middleware_runtime', 'public.winerim_wines', 'glass_sale_price', 'UPDATE') AND NOT has_column_privilege('middleware_runtime', 'public.winerim_wines', 'raw_payload', 'UPDATE') AND NOT has_table_privilege('middleware_api', 'public.runtime_catalog_source_scope', 'SELECT,INSERT,UPDATE,DELETE') AND NOT has_table_privilege('middleware_readonly', 'public.runtime_catalog_source_scope', 'SELECT,INSERT,UPDATE,DELETE'))::int")

for catalog_source_gate in \
  "$catalog_source_prepared_hidden" \
  "$catalog_source_active_visible" \
  "$catalog_source_exact_update" \
  "$catalog_source_privileges"
do
  test "$catalog_source_gate" = "1" || {
    printf 'RUNTIME_CATALOG_SOURCE_SCOPE_GATE_FAILED\n' >&2
    exit 1
  }
done

"${PSQL[@]}" -d "$DB_NAME" >/dev/null <<SQL
DELETE FROM public.runtime_catalog_source_scope;
DELETE FROM public.product_mappings
WHERE connection_id IN ('$CANARY_CONNECTION_A', '$CANARY_CONNECTION_B');
DELETE FROM public.winerim_wines
WHERE connection_id IN ('$CANARY_CONNECTION_A', '$CANARY_CONNECTION_B');
DELETE FROM public.runtime_canary_connections;
DELETE FROM public.pos_connections
WHERE id IN ('$CANARY_CONNECTION_A', '$CANARY_CONNECTION_B');
SQL

rls_missing=$("${PSQL[@]}" -d "$DB_NAME" -Atc "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND NOT c.relrowsecurity")
security_definer_public=$("${PSQL[@]}" -d "$DB_NAME" -Atc "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prosecdef AND EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE')")
table_count=$("${PSQL[@]}" -d "$DB_NAME" -Atc "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'")
function_count=$("${PSQL[@]}" -d "$DB_NAME" -Atc "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'")

printf 'INFO: replayed_migrations=%s\n' "$applied"
printf 'INFO: public_tables=%s\n' "$table_count"
printf 'INFO: public_functions=%s\n' "$function_count"
printf 'INFO: public_tables_without_rls=%s\n' "$rls_missing"
printf 'INFO: security_definer_functions_executable_by_public=%s\n' "$security_definer_public"

public_policies=$("${PSQL[@]}" -d "$DB_NAME" -Atc "SELECT count(*) FROM pg_policies WHERE schemaname='public' AND ('public'=ANY(roles) OR 'anon'=ANY(roles) OR 'authenticated'=ANY(roles) OR 'service_role'=ANY(roles))")
platform_role_table_privileges=$("${PSQL[@]}" -d "$DB_NAME" -Atc "SELECT count(*) FROM information_schema.role_table_grants WHERE table_schema='public' AND grantee IN ('anon','authenticated','service_role')")
platform_role_function_privileges=$("${PSQL[@]}" -d "$DB_NAME" -Atc "SELECT count(*) FROM information_schema.routine_privileges WHERE specific_schema='public' AND grantee IN ('anon','authenticated','service_role')")
runtime_lock_table=$("${PSQL[@]}" -d "$DB_NAME" -Atc "SELECT (NOT has_table_privilege('middleware_runtime', 'public.agora_dispatch_locks', 'SELECT,INSERT,UPDATE,DELETE'))::int")
runtime_lock_functions=$("${PSQL[@]}" -d "$DB_NAME" -Atc "SELECT (NOT has_function_privilege('middleware_runtime', 'public.acquire_agora_dispatch_lock(uuid,text,text,integer)', 'EXECUTE') AND NOT has_function_privilege('middleware_runtime', 'public.release_agora_dispatch_lock(uuid,text,text)', 'EXECUTE'))::int")
runtime_vault_privileges=$("${PSQL[@]}" -d "$DB_NAME" -Atc "SELECT (has_table_privilege('middleware_runtime', 'public.runtime_connection_credentials', 'SELECT') AND NOT has_table_privilege('middleware_runtime', 'public.runtime_connection_credentials', 'INSERT,UPDATE,DELETE') AND NOT has_table_privilege('middleware_api', 'public.runtime_connection_credentials', 'SELECT,INSERT,UPDATE,DELETE') AND NOT has_table_privilege('middleware_readonly', 'public.runtime_connection_credentials', 'SELECT,INSERT,UPDATE,DELETE'))::int")
runtime_canary_scope=$("${PSQL[@]}" -d "$DB_NAME" -Atc "SELECT (has_table_privilege('middleware_runtime', 'public.runtime_canary_connections', 'SELECT') AND NOT has_table_privilege('middleware_runtime', 'public.runtime_canary_connections', 'INSERT,UPDATE,DELETE') AND has_table_privilege('middleware_runtime', 'public.product_mappings', 'SELECT') AND has_table_privilege('middleware_runtime', 'public.winerim_wines', 'SELECT') AND has_table_privilege('middleware_runtime', 'public.sales_events', 'SELECT,INSERT') AND NOT has_table_privilege('middleware_runtime', 'public.sales_events', 'UPDATE,DELETE') AND has_column_privilege('middleware_runtime', 'public.sales_events', 'business_day', 'UPDATE') AND has_column_privilege('middleware_runtime', 'public.sales_events', 'doc_type', 'UPDATE') AND has_column_privilege('middleware_runtime', 'public.sales_events', 'total_amount', 'UPDATE') AND has_column_privilege('middleware_runtime', 'public.sales_events', 'total_tax', 'UPDATE') AND has_column_privilege('middleware_runtime', 'public.sales_events', 'total_net', 'UPDATE') AND has_column_privilege('middleware_runtime', 'public.sales_events', 'line_count', 'UPDATE') AND has_column_privilege('middleware_runtime', 'public.sales_events', 'raw_json', 'UPDATE') AND NOT has_column_privilege('middleware_runtime', 'public.sales_events', 'connection_id', 'UPDATE') AND NOT has_column_privilege('middleware_runtime', 'public.sales_events', 'provider_doc_id', 'UPDATE') AND NOT has_column_privilege('middleware_runtime', 'public.sales_events', 'created_at', 'UPDATE') AND has_table_privilege('middleware_runtime', 'public.sales_line_items', 'SELECT,INSERT,DELETE') AND NOT has_table_privilege('middleware_runtime', 'public.sales_line_items', 'UPDATE') AND has_table_privilege('middleware_runtime', 'public.stock_sync_log', 'SELECT,INSERT') AND NOT has_table_privilege('middleware_runtime', 'public.stock_sync_log', 'UPDATE,DELETE') AND (SELECT count(*) = 0 FROM public.runtime_canary_connections))::int")
api_minimum_privileges=$("${PSQL[@]}" -d "$DB_NAME" -Atc "SELECT (has_table_privilege('middleware_api', 'public.infrastructure_metadata', 'SELECT') AND has_table_privilege('middleware_api', 'public.pos_connections', 'SELECT') AND has_table_privilege('middleware_api', 'public.integration_onboarding_requests', 'SELECT,INSERT') AND NOT has_table_privilege('middleware_api', 'public.stock_sync_log', 'INSERT,UPDATE,DELETE') AND NOT has_table_privilege('middleware_api', 'public.outbound_tasks', 'INSERT,UPDATE,DELETE'))::int")
legacy_lock_functions=$("${PSQL[@]}" -d "$DB_NAME" -Atc "SELECT (has_function_privilege('service_role', 'public.acquire_agora_dispatch_lock(uuid,text,text,integer)', 'EXECUTE') OR has_function_privilege('service_role', 'public.release_agora_dispatch_lock(uuid,text,text)', 'EXECUTE'))::int")
platform_helpers=$("${PSQL[@]}" -d "$DB_NAME" -Atc "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('invoke_connection_health_monitor','invoke_connection_health_monitor_secure')")
legacy_contact_columns=$("${PSQL[@]}" -d "$DB_NAME" -Atc "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='connection_notification_contacts' AND column_name IN ('label','channel','target','notify_client','notify_recovery','min_severity','alert_types')")
secure_contact_columns=$("${PSQL[@]}" -d "$DB_NAME" -Atc "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='connection_notification_contacts' AND column_name IN ('contact_type','display_name','email','phone')")

if [ "$missing" -gt 0 ] || [ "$rls_missing" -gt 0 ] || [ "$security_definer_public" -gt 0 ] || [ "$public_policies" -gt 0 ] || [ "$platform_role_table_privileges" -gt 0 ] || [ "$platform_role_function_privileges" -gt 0 ] || [ "$runtime_lock_table" != "1" ] || [ "$runtime_lock_functions" != "1" ] || [ "$runtime_vault_privileges" != "1" ] || [ "$runtime_canary_scope" != "1" ] || [ "$runtime_canary_valid_scope" != "1" ] || [ "$runtime_canary_invalid_scope_hidden" != "1" ] || [ "$api_minimum_privileges" != "1" ] || [ "$legacy_lock_functions" != "0" ] || [ "$platform_helpers" -gt 0 ] || [ "$legacy_contact_columns" -gt 0 ] || [ "$secure_contact_columns" != "4" ]; then
  printf 'RESULT=EMPTY_REPLAY_FAILED missing=%s rls_missing=%s public_security_definer=%s public_policies=%s platform_role_table_privileges=%s platform_role_function_privileges=%s runtime_lock_table=%s runtime_lock_functions=%s runtime_vault_privileges=%s runtime_canary_scope=%s runtime_canary_valid_scope=%s runtime_canary_invalid_scope_hidden=%s api_minimum_privileges=%s legacy_lock_functions=%s platform_helpers=%s legacy_contact_columns=%s secure_contact_columns=%s\n' "$missing" "$rls_missing" "$security_definer_public" "$public_policies" "$platform_role_table_privileges" "$platform_role_function_privileges" "$runtime_lock_table" "$runtime_lock_functions" "$runtime_vault_privileges" "$runtime_canary_scope" "$runtime_canary_valid_scope" "$runtime_canary_invalid_scope_hidden" "$api_minimum_privileges" "$legacy_lock_functions" "$platform_helpers" "$legacy_contact_columns" "$secure_contact_columns" >&2
  exit 1
fi

printf 'INFO: public_or_legacy_role_policies=%s\n' "$public_policies"
printf 'INFO: platform_role_table_privileges=%s\n' "$platform_role_table_privileges"
printf 'INFO: platform_role_function_privileges=%s\n' "$platform_role_function_privileges"
printf 'INFO: runtime_cannot_manage_lock_table=%s\n' "$runtime_lock_table"
printf 'INFO: runtime_cannot_execute_lock_functions=%s\n' "$runtime_lock_functions"
printf 'INFO: runtime_vault_minimum_privileges=%s\n' "$runtime_vault_privileges"
printf 'INFO: runtime_canary_scope_minimum_privileges=%s\n' "$runtime_canary_scope"
printf 'INFO: runtime_canary_valid_scope_visible=%s\n' "$runtime_canary_valid_scope"
printf 'INFO: runtime_canary_invalid_scope_hidden=%s\n' "$runtime_canary_invalid_scope_hidden"
printf 'INFO: api_minimum_privileges=%s\n' "$api_minimum_privileges"
printf 'INFO: legacy_lock_function_privileges=%s\n' "$legacy_lock_functions"
printf 'INFO: excluded_platform_health_helpers=%s\n' "$platform_helpers"
printf 'INFO: legacy_contact_columns=%s\n' "$legacy_contact_columns"
printf 'INFO: secure_contact_columns=%s\n' "$secure_contact_columns"
printf 'RESULT=EMPTY_REPLAY_HARDENED_OK\n'
