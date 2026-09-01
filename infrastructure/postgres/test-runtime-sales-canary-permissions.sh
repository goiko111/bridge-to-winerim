#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
for command_name in initdb pg_ctl createdb psql; do
  command -v "$command_name" >/dev/null 2>&1 || {
    printf 'BLOCKED: %s is not installed\n' "$command_name" >&2
    exit 2
  }
done

TMP_ROOT=$(mktemp -d /tmp/winerim-runtime-sales-canary.XXXXXX)
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
SERVER_LOG="$TMP_ROOT/postgres.log"
PORT=$((58432 + ($$ % 500)))
DB_NAME=winerim_runtime_sales_canary_test
LOGIN_ROLE=middleware_runtime_canary_test_login
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
if ! pg_ctl -D "$DATA_DIR" -l "$SERVER_LOG" -o "-h '' -k '$SOCKET_DIR' -p $PORT" -w start >/dev/null; then
  sed -n '1,80p' "$SERVER_LOG" >&2 || true
  exit 1
fi
SERVER_STARTED=1
createdb -h "$SOCKET_DIR" -p "$PORT" "$DB_NAME"

ADMIN_PSQL=(psql -X -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -d "$DB_NAME")
LOGIN_PSQL=(psql -X -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -d "$DB_NAME" -U "$LOGIN_ROLE")

BOOTSTRAP_SQL="$TMP_ROOT/bootstrap.sql"
"$SCRIPT_DIR/build-bootstrap.sh" "$BOOTSTRAP_SQL" >/dev/null
"${ADMIN_PSQL[@]}" -v environment=runtime-sales-canary-test -f "$BOOTSTRAP_SQL" >/dev/null
for migration_pass in 1 2; do
  "${ADMIN_PSQL[@]}" -f "$SCRIPT_DIR/0007_runtime_sales_canary_permissions.sql" >/dev/null
  "${ADMIN_PSQL[@]}" -f "$SCRIPT_DIR/0008_runtime_sales_column_privileges.sql" >/dev/null
  "${ADMIN_PSQL[@]}" -f "$SCRIPT_DIR/0009_runtime_catalog_permissions.sql" >/dev/null
done

"${ADMIN_PSQL[@]}" >/dev/null <<SQL
CREATE ROLE $LOGIN_ROLE
  LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  IN ROLE middleware_runtime;

INSERT INTO public.pos_connections (id, location_name, provider, base_url, api_token, enabled)
VALUES
  ('11111111-1111-4111-8111-111111111111', 'Runtime canary A', 'agora', 'https://a.invalid', '', false),
  ('22222222-2222-4222-8222-222222222222', 'Outside canary B', 'agora', 'https://b.invalid', '', false);

INSERT INTO public.winerim_wines (id, connection_id, winerim_id, name, format)
VALUES
  ('11111111-aaaa-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111', 'wine-a', 'Wine A', 'BOTTLE'),
  ('22222222-bbbb-4222-8222-222222222222', '22222222-2222-4222-8222-222222222222', 'wine-b', 'Wine B', 'BOTTLE');

INSERT INTO public.product_mappings (
  id, connection_id, provider_product_id, provider_product_name,
  winerim_wine_id, winerim_wine_name, status
) VALUES
  ('11111111-aaaa-4111-9111-111111111111', '11111111-1111-4111-8111-111111111111', 'product-a', 'Product A', 'wine-a', 'Wine A', 'CONFIRMED'),
  ('22222222-bbbb-4222-9222-222222222222', '22222222-2222-4222-8222-222222222222', 'product-b', 'Product B', 'wine-b', 'Wine B', 'CONFIRMED');

INSERT INTO public.provider_products (
  connection_id, provider_product_id, name, family, sale_format,
  is_wine_candidate, sync_status, winerim_wine_id
) VALUES
  ('11111111-1111-4111-8111-111111111111', 'product-a', 'Product A', 'Wine', 'BOTTLE', true, 'SYNCED', 'wine-a'),
  ('22222222-2222-4222-8222-222222222222', 'product-b', 'Product B', 'Wine', 'BOTTLE', true, 'SYNCED', 'wine-b');

INSERT INTO public.agora_master_data (connection_id, families_json, products_summary_json)
VALUES
  ('11111111-1111-4111-8111-111111111111', '[{"Id":"10","Name":"Wine"}]', '[{"Id":"product-a"}]'),
  ('22222222-2222-4222-8222-222222222222', '[{"Id":"20","Name":"Wine"}]', '[{"Id":"product-b"}]');

INSERT INTO public.winerim_push_tracking (
  connection_id, winerim_wine_id, format, agora_product_id,
  agora_family_id, source, sync_status
) VALUES
  ('11111111-1111-4111-8111-111111111111', 'wine-existing-a', 'BOTTLE', '500001', '10', 'WINERIM', 'VERIFIED'),
  ('22222222-2222-4222-8222-222222222222', 'wine-existing-b', 'BOTTLE', '500002', '20', 'WINERIM', 'VERIFIED');

INSERT INTO public.sales_events (
  id, connection_id, provider_doc_id, business_day, doc_type, line_count
) VALUES
  ('11111111-aaaa-4111-a111-111111111111', '11111111-1111-4111-8111-111111111111', 'doc-a', current_date, 'BasicInvoice', 1),
  ('22222222-bbbb-4222-a222-222222222222', '22222222-2222-4222-8222-222222222222', 'doc-b', current_date, 'BasicInvoice', 1);

INSERT INTO public.sales_line_items (
  id, sales_event_id, connection_id, provider_product_id, name,
  quantity, unit_price, total_amount, is_wine_candidate, winerim_product_id, mapped
) VALUES
  ('11111111-aaaa-4111-b111-111111111111', '11111111-aaaa-4111-a111-111111111111', '11111111-1111-4111-8111-111111111111', 'product-a', 'Product A', 1, 10, 10, true, 'wine-a', true),
  ('22222222-bbbb-4222-b222-222222222222', '22222222-bbbb-4222-a222-222222222222', '22222222-2222-4222-8222-222222222222', 'product-b', 'Product B', 1, 20, 20, true, 'wine-b', true);

INSERT INTO public.stock_sync_log (
  id, connection_id, sales_event_id, sales_line_item_id, provider_product_id,
  winerim_product_id, product_name, quantity, status, idempotency_key
) VALUES
  ('11111111-aaaa-4111-c111-111111111111', '11111111-1111-4111-8111-111111111111', '11111111-aaaa-4111-a111-111111111111', '11111111-aaaa-4111-b111-111111111111', 'product-a', 'wine-a', 'Product A', 1, 'SUCCESS', 'existing-a'),
  ('22222222-bbbb-4222-c222-222222222222', '22222222-2222-4222-8222-222222222222', '22222222-bbbb-4222-a222-222222222222', '22222222-bbbb-4222-b222-222222222222', 'product-b', 'wine-b', 'Product B', 1, 'SUCCESS', 'existing-b');

INSERT INTO public.runtime_canary_connections (
  connection_id, run_id, active, status, approved_at, expires_at, note,
  deployment_manifest_sha256, writer_fence_grant_sha256,
  credential_set_sha256, activated_at
) VALUES (
  '11111111-1111-4111-8111-111111111111', 'permission-test-a', true, 'ACTIVE',
  now(), now() + interval '15 minutes', 'rescue-canary-run:permission-test-a',
  repeat('a',64), repeat('b',64), repeat('c',64), now()
);
SQL

role_attributes=$("${ADMIN_PSQL[@]}" -Atc "
  SELECT rolcanlogin::int || '|' || rolinherit::int || '|' || rolsuper::int || '|' || rolbypassrls::int
  FROM pg_roles WHERE rolname = '$LOGIN_ROLE'
")
test "$role_attributes" = "1|1|0|0" || {
  printf 'LOGIN_ROLE_ATTRIBUTES_INVALID=%s\n' "$role_attributes" >&2
  exit 1
}

login_identity=$("${LOGIN_PSQL[@]}" -Atc "SELECT session_user || '|' || current_user")
test "$login_identity" = "$LOGIN_ROLE|$LOGIN_ROLE" || {
  printf 'LOGIN_ROLE_CONNECTION_INVALID=%s\n' "$login_identity" >&2
  exit 1
}

visible_counts=$("${LOGIN_PSQL[@]}" -Atc "
  SELECT
    (SELECT count(*) FROM public.runtime_canary_connections) || '|' ||
    (SELECT count(*) FROM public.pos_connections) || '|' ||
    (SELECT count(*) FROM public.product_mappings) || '|' ||
    (SELECT count(*) FROM public.winerim_wines) || '|' ||
    (SELECT count(*) FROM public.sales_events) || '|' ||
    (SELECT count(*) FROM public.sales_line_items) || '|' ||
    (SELECT count(*) FROM public.stock_sync_log) || '|' ||
    (SELECT count(*) FROM public.provider_products) || '|' ||
    (SELECT count(*) FROM public.agora_master_data) || '|' ||
    (SELECT count(*) FROM public.winerim_push_tracking)
")
test "$visible_counts" = "1|1|1|1|1|1|1|1|1|1" || {
  printf 'CANARY_VISIBLE_COUNTS_INVALID=%s\n' "$visible_counts" >&2
  exit 1
}

"${LOGIN_PSQL[@]}" >/dev/null <<'SQL'
INSERT INTO public.product_mappings (
  connection_id, provider_product_id, provider_product_name,
  winerim_wine_id, winerim_wine_name, match_method, match_score,
  match_reasons, status, format_type, agora_product_id,
  last_synced_at, last_sync_error
)
SELECT
  '11111111-1111-4111-8111-111111111111', '500001', 'B Runtime plan',
  winerim_id, name, 'RUNTIME_CATALOG_PLAN', 1,
  ARRAY['DB_PLAN_PREPARED', 'plan:test-v1'], 'PENDING', 'BOTTLE', '500001', NULL, NULL
FROM public.winerim_wines
WHERE connection_id = '11111111-1111-4111-8111-111111111111'
  AND winerim_id = 'wine-a'
ON CONFLICT (connection_id, provider_product_id) DO UPDATE SET
  provider_product_name = EXCLUDED.provider_product_name,
  winerim_wine_id = EXCLUDED.winerim_wine_id,
  winerim_wine_name = EXCLUDED.winerim_wine_name,
  match_method = EXCLUDED.match_method,
  match_score = EXCLUDED.match_score,
  match_reasons = EXCLUDED.match_reasons,
  status = 'PENDING',
  format_type = EXCLUDED.format_type,
  agora_product_id = EXCLUDED.agora_product_id,
  last_synced_at = NULL,
  last_sync_error = NULL,
  updated_at = now()
WHERE product_mappings.status = 'PENDING';

INSERT INTO public.product_mappings (
  connection_id, provider_product_id, provider_product_name,
  winerim_wine_id, winerim_wine_name, match_method, match_score,
  match_reasons, status, format_type, agora_product_id,
  last_synced_at, last_sync_error
)
SELECT
  '11111111-1111-4111-8111-111111111111', '500001', 'B Runtime plan updated',
  winerim_id, name, 'RUNTIME_CATALOG_PLAN', 1,
  ARRAY['DB_PLAN_PREPARED', 'plan:test-v2'], 'PENDING', 'BOTTLE', '500001', NULL, NULL
FROM public.winerim_wines
WHERE connection_id = '11111111-1111-4111-8111-111111111111'
  AND winerim_id = 'wine-a'
ON CONFLICT (connection_id, provider_product_id) DO UPDATE SET
  provider_product_name = EXCLUDED.provider_product_name,
  winerim_wine_id = EXCLUDED.winerim_wine_id,
  winerim_wine_name = EXCLUDED.winerim_wine_name,
  match_method = EXCLUDED.match_method,
  match_score = EXCLUDED.match_score,
  match_reasons = EXCLUDED.match_reasons,
  status = 'PENDING',
  format_type = EXCLUDED.format_type,
  agora_product_id = EXCLUDED.agora_product_id,
  last_synced_at = NULL,
  last_sync_error = NULL,
  updated_at = now()
WHERE product_mappings.status = 'PENDING';

INSERT INTO public.winerim_push_tracking (
  connection_id, winerim_wine_id, format, agora_product_id,
  agora_family_id, source, sync_status, last_error, pushed_at, verified_at
) VALUES (
  '11111111-1111-4111-8111-111111111111', 'wine-a', 'BOTTLE',
  '500001', '10', 'WINERIM', 'NOT_PUSHED', NULL, NULL, NULL
)
ON CONFLICT (connection_id, winerim_wine_id, format) DO UPDATE SET
  agora_product_id = EXCLUDED.agora_product_id,
  agora_family_id = EXCLUDED.agora_family_id,
  source = 'WINERIM',
  sync_status = CASE
    WHEN winerim_push_tracking.sync_status IN ('PUSHED', 'VERIFIED')
      THEN winerim_push_tracking.sync_status
    ELSE 'NOT_PUSHED'
  END,
  last_error = CASE
    WHEN winerim_push_tracking.sync_status IN ('PUSHED', 'VERIFIED')
      THEN winerim_push_tracking.last_error
    ELSE NULL
  END,
  pushed_at = CASE
    WHEN winerim_push_tracking.sync_status IN ('PUSHED', 'VERIFIED')
      THEN winerim_push_tracking.pushed_at
    ELSE NULL
  END,
  verified_at = CASE
    WHEN winerim_push_tracking.sync_status = 'VERIFIED'
      THEN winerim_push_tracking.verified_at
    ELSE NULL
  END,
  updated_at = now();
SQL

catalog_write_readback=$("${LOGIN_PSQL[@]}" -Atc "
  SELECT
    (SELECT count(*) FROM public.product_mappings WHERE provider_product_id='500001' AND provider_product_name='B Runtime plan updated' AND status='PENDING' AND match_method='RUNTIME_CATALOG_PLAN' AND match_reasons @> ARRAY['DB_PLAN_PREPARED','plan:test-v2']::text[]) || '|' ||
    (SELECT count(*) FROM public.winerim_push_tracking WHERE winerim_wine_id='wine-a' AND format='BOTTLE' AND sync_status='NOT_PUSHED')
")
test "$catalog_write_readback" = "1|1" || {
  printf 'CANARY_CATALOG_WRITE_READBACK_INVALID=%s\n' "$catalog_write_readback" >&2
  exit 1
}

"${LOGIN_PSQL[@]}" >/dev/null <<'SQL'
INSERT INTO public.stock_sync_log (
  connection_id, sales_event_id, sales_line_item_id, provider_product_id,
  winerim_product_id, product_name, quantity, status, idempotency_key
) VALUES (
  '11111111-1111-4111-8111-111111111111',
  '11111111-aaaa-4111-a111-111111111111',
  '11111111-aaaa-4111-b111-111111111111',
  'product-a', 'wine-a', 'Runtime receipt A', 1, 'SUCCESS', 'runtime-a'
);
SQL

receipt_readback=$("${LOGIN_PSQL[@]}" -Atc "
  SELECT count(*) FROM public.stock_sync_log
  WHERE connection_id = '11111111-1111-4111-8111-111111111111'
    AND idempotency_key = 'runtime-a'
")
test "$receipt_readback" = "1" || {
  printf 'CANARY_RECEIPT_READBACK_INVALID=%s\n' "$receipt_readback" >&2
  exit 1
}

"${LOGIN_PSQL[@]}" >/dev/null <<'SQL'
INSERT INTO public.sales_events (
  connection_id, provider_doc_id, business_day, doc_type, line_count, total_amount
) VALUES (
  '11111111-1111-4111-8111-111111111111', 'doc-runtime', current_date,
  'BasicInvoice', 1, 12
)
ON CONFLICT (connection_id, provider_doc_id) DO UPDATE
SET total_amount = EXCLUDED.total_amount, line_count = EXCLUDED.line_count;

INSERT INTO public.sales_line_items (
  id, sales_event_id, connection_id, provider_product_id, name,
  quantity, unit_price, total_amount, is_wine_candidate, winerim_product_id, mapped
)
SELECT
  '11111111-aaaa-4111-b333-111111111111', id,
  '11111111-1111-4111-8111-111111111111', 'product-a', 'Runtime line A',
  1, 12, 12, true, 'wine-a', true
FROM public.sales_events
WHERE connection_id = '11111111-1111-4111-8111-111111111111'
  AND provider_doc_id = 'doc-runtime';

DELETE FROM public.sales_line_items
WHERE id = '11111111-aaaa-4111-b333-111111111111';

UPDATE public.pos_connections
SET last_sync_at = now(), last_business_day_synced = current_date
WHERE id = '11111111-1111-4111-8111-111111111111';
SQL

persistence_readback=$("${LOGIN_PSQL[@]}" -Atc "
  SELECT
    (SELECT count(*) FROM public.sales_events WHERE provider_doc_id='doc-runtime') || '|' ||
    (SELECT count(*) FROM public.sales_line_items WHERE id='11111111-aaaa-4111-b333-111111111111') || '|' ||
    (SELECT count(*) FROM public.pos_connections WHERE last_sync_at IS NOT NULL AND last_business_day_synced=current_date)
")
test "$persistence_readback" = "1|0|1" || {
  printf 'CANARY_PERSISTENCE_READBACK_INVALID=%s\n' "$persistence_readback" >&2
  exit 1
}

expect_login_failure() {
  label=$1
  pattern=$2
  sql=$3
  output="$TMP_ROOT/$label.out"
  if "${LOGIN_PSQL[@]}" -c "$sql" >"$output" 2>&1; then
    printf '%s_UNEXPECTEDLY_SUCCEEDED\n' "$label" >&2
    exit 1
  fi
  grep -Eiq "$pattern" "$output" || {
    printf '%s_FAILED_WITH_UNEXPECTED_ERROR\n' "$label" >&2
    sed -n '1,12p' "$output" >&2
    exit 1
  }
}

expect_login_failure CROSS_CONNECTION_INSERT \
  'row-level security|permission denied' \
  "INSERT INTO public.stock_sync_log (connection_id, product_name, quantity, status, idempotency_key) VALUES ('22222222-2222-4222-8222-222222222222', 'Outside receipt', 1, 'SUCCESS', 'runtime-b')"

expect_login_failure CROSS_EVENT_REFERENCE_INSERT \
  'row-level security|permission denied' \
  "INSERT INTO public.stock_sync_log (connection_id, sales_event_id, product_name, quantity, status, idempotency_key) VALUES ('11111111-1111-4111-8111-111111111111', '22222222-bbbb-4222-a222-222222222222', 'Cross event', 1, 'SUCCESS', 'runtime-cross-event')"

expect_login_failure EMPTY_IDEMPOTENCY_INSERT \
  'row-level security|permission denied' \
  "INSERT INTO public.stock_sync_log (connection_id, product_name, quantity, status, idempotency_key) VALUES ('11111111-1111-4111-8111-111111111111', 'No idempotency', 1, 'SUCCESS', '')"

expect_login_failure STOCK_RECEIPT_UPDATE \
  'permission denied' \
  "UPDATE public.stock_sync_log SET quantity = 2 WHERE idempotency_key = 'runtime-a'"

expect_login_failure STOCK_RECEIPT_DELETE \
  'permission denied' \
  "DELETE FROM public.stock_sync_log WHERE idempotency_key = 'runtime-a'"

expect_login_failure CROSS_CONNECTION_MAPPING_INSERT \
  'row-level security|permission denied' \
  "INSERT INTO public.product_mappings (connection_id, provider_product_id, provider_product_name, winerim_wine_id, winerim_wine_name, match_method, match_score, status, format_type, agora_product_id) VALUES ('22222222-2222-4222-8222-222222222222', '500002', 'Forbidden', 'wine-b', 'Wine B', 'RUNTIME_CATALOG_PLAN', 1, 'PENDING', 'BOTTLE', '500002')"

expect_login_failure CROSS_CONNECTION_TRACKING_INSERT \
  'row-level security|permission denied' \
  "INSERT INTO public.winerim_push_tracking (connection_id, winerim_wine_id, format, agora_product_id, source, sync_status) VALUES ('22222222-2222-4222-8222-222222222222', 'wine-b', 'BOTTLE', '500002', 'WINERIM', 'NOT_PUSHED')"

expect_login_failure INVALID_MAPPING_STATE_INSERT \
  'row-level security|permission denied' \
  "INSERT INTO public.product_mappings (connection_id, provider_product_id, provider_product_name, winerim_wine_id, winerim_wine_name, match_method, match_score, match_reasons, status, format_type, agora_product_id) VALUES ('11111111-1111-4111-8111-111111111111', '500003', 'Forbidden', 'wine-a', 'Wine A', 'MANUAL', 1, ARRAY['DB_PLAN_PREPARED','plan:invalid'], 'CONFIRMED', 'BOTTLE', '500003')"

expect_login_failure PROVIDER_PRODUCT_INSERT \
  'permission denied' \
  "INSERT INTO public.provider_products (connection_id, provider_product_id, name) VALUES ('11111111-1111-4111-8111-111111111111', 'forbidden', 'Forbidden')"

expect_login_failure MASTER_UPDATE \
  'permission denied' \
  "UPDATE public.agora_master_data SET families_json='[]'::jsonb WHERE connection_id='11111111-1111-4111-8111-111111111111'"

expect_login_failure MAPPING_DELETE \
  'permission denied' \
  "DELETE FROM public.product_mappings WHERE provider_product_id='500001'"

expect_login_failure TRACKING_TASK_UPDATE \
  'permission denied' \
  "UPDATE public.winerim_push_tracking SET task_id='11111111-aaaa-4111-a111-111111111111' WHERE winerim_wine_id='wine-a'"

expect_login_failure CONNECTION_ENABLE_UPDATE \
  'permission denied' \
  "UPDATE public.pos_connections SET enabled=true WHERE id='11111111-1111-4111-8111-111111111111'"

expect_login_failure CROSS_CONNECTION_EVENT_INSERT \
  'row-level security|permission denied' \
  "INSERT INTO public.sales_events (connection_id, provider_doc_id, business_day, doc_type, line_count) VALUES ('22222222-2222-4222-8222-222222222222', 'forbidden-doc', current_date, 'BasicInvoice', 0)"

cross_connection_catalog_visible=$("${LOGIN_PSQL[@]}" -Atc "
  SELECT
    (SELECT count(*) FROM public.provider_products WHERE connection_id='22222222-2222-4222-8222-222222222222') || '|' ||
    (SELECT count(*) FROM public.agora_master_data WHERE connection_id='22222222-2222-4222-8222-222222222222') || '|' ||
    (SELECT count(*) FROM public.product_mappings WHERE connection_id='22222222-2222-4222-8222-222222222222') || '|' ||
    (SELECT count(*) FROM public.winerim_push_tracking WHERE connection_id='22222222-2222-4222-8222-222222222222')
")
test "$cross_connection_catalog_visible" = "0|0|0|0" || {
  printf 'CROSS_CONNECTION_CATALOG_VISIBLE=%s\n' "$cross_connection_catalog_visible" >&2
  exit 1
}

platform_privileges=$("${ADMIN_PSQL[@]}" -Atc "
  SELECT count(*)
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public'
    AND table_name IN ('pos_connections','product_mappings','provider_products','agora_master_data','winerim_push_tracking','winerim_wines','sales_events','sales_line_items','stock_sync_log')
    AND grantee IN ('PUBLIC','anon','authenticated','service_role')
")
test "$platform_privileges" = "0" || {
  printf 'PLATFORM_ROLE_PRIVILEGES_PRESENT=%s\n' "$platform_privileges" >&2
  exit 1
}

runtime_privileges=$("${ADMIN_PSQL[@]}" -Atc "
  SELECT
    has_table_privilege('middleware_runtime', 'public.product_mappings', 'SELECT')::int || '|' ||
    has_table_privilege('middleware_runtime', 'public.winerim_wines', 'SELECT')::int || '|' ||
    has_table_privilege('middleware_runtime', 'public.sales_events', 'SELECT,INSERT')::int || '|' ||
    (NOT has_table_privilege('middleware_runtime', 'public.sales_events', 'UPDATE'))::int || '|' ||
    (has_column_privilege('middleware_runtime', 'public.sales_events', 'business_day', 'UPDATE') AND has_column_privilege('middleware_runtime', 'public.sales_events', 'doc_type', 'UPDATE') AND has_column_privilege('middleware_runtime', 'public.sales_events', 'total_amount', 'UPDATE') AND has_column_privilege('middleware_runtime', 'public.sales_events', 'total_tax', 'UPDATE') AND has_column_privilege('middleware_runtime', 'public.sales_events', 'total_net', 'UPDATE') AND has_column_privilege('middleware_runtime', 'public.sales_events', 'line_count', 'UPDATE') AND has_column_privilege('middleware_runtime', 'public.sales_events', 'raw_json', 'UPDATE'))::int || '|' ||
    (NOT has_column_privilege('middleware_runtime', 'public.sales_events', 'provider_doc_id', 'UPDATE'))::int || '|' ||
    has_table_privilege('middleware_runtime', 'public.sales_events', 'DELETE')::int || '|' ||
    has_table_privilege('middleware_runtime', 'public.sales_line_items', 'SELECT,INSERT,DELETE')::int || '|' ||
    has_table_privilege('middleware_runtime', 'public.sales_line_items', 'UPDATE')::int || '|' ||
    has_table_privilege('middleware_runtime', 'public.stock_sync_log', 'SELECT,INSERT')::int || '|' ||
    has_table_privilege('middleware_runtime', 'public.stock_sync_log', 'UPDATE,DELETE')::int || '|' ||
    has_column_privilege('middleware_runtime', 'public.pos_connections', 'last_sync_at', 'UPDATE')::int || '|' ||
    has_column_privilege('middleware_runtime', 'public.pos_connections', 'enabled', 'UPDATE')::int || '|' ||
    has_table_privilege('middleware_runtime', 'public.provider_products', 'SELECT')::int || '|' ||
    has_table_privilege('middleware_runtime', 'public.provider_products', 'INSERT,UPDATE,DELETE')::int || '|' ||
    has_table_privilege('middleware_runtime', 'public.agora_master_data', 'SELECT')::int || '|' ||
    has_table_privilege('middleware_runtime', 'public.agora_master_data', 'INSERT,UPDATE,DELETE')::int || '|' ||
    has_table_privilege('middleware_runtime', 'public.product_mappings', 'INSERT,UPDATE,DELETE')::int || '|' ||
    has_column_privilege('middleware_runtime', 'public.product_mappings', 'provider_product_name', 'INSERT')::int || '|' ||
    has_column_privilege('middleware_runtime', 'public.product_mappings', 'status', 'UPDATE')::int || '|' ||
    has_column_privilege('middleware_runtime', 'public.product_mappings', 'id', 'UPDATE')::int || '|' ||
    has_table_privilege('middleware_runtime', 'public.winerim_push_tracking', 'SELECT')::int || '|' ||
    has_table_privilege('middleware_runtime', 'public.winerim_push_tracking', 'INSERT,UPDATE,DELETE')::int || '|' ||
    has_column_privilege('middleware_runtime', 'public.winerim_push_tracking', 'agora_product_id', 'INSERT')::int || '|' ||
    has_column_privilege('middleware_runtime', 'public.winerim_push_tracking', 'sync_status', 'UPDATE')::int || '|' ||
    has_column_privilege('middleware_runtime', 'public.winerim_push_tracking', 'task_id', 'UPDATE')::int
")
test "$runtime_privileges" = "1|1|1|1|1|1|0|1|0|1|0|1|0|1|0|1|0|0|1|1|0|1|0|1|1|0" || {
  printf 'RUNTIME_PRIVILEGES_INVALID=%s\n' "$runtime_privileges" >&2
  exit 1
}

"${ADMIN_PSQL[@]}" -c "
  DELETE FROM public.runtime_canary_connections
  WHERE connection_id = '11111111-1111-4111-8111-111111111111';
  INSERT INTO public.runtime_canary_connections (
    connection_id, run_id, active, status, approved_at, expires_at, note,
    deployment_manifest_sha256, writer_fence_grant_sha256,
    credential_set_sha256, activated_at
  ) VALUES (
    '11111111-1111-4111-8111-111111111111', 'permission-test-expiry', true, 'ACTIVE',
    now(), now() + interval '100 milliseconds', 'rescue-canary-run:permission-test-expiry',
    repeat('d',64), repeat('e',64), repeat('f',64), now()
  );
  SELECT pg_sleep(0.2);
" >/dev/null

expired_counts=$("${LOGIN_PSQL[@]}" -Atc "
  SELECT
    (SELECT count(*) FROM public.runtime_canary_connections) || '|' ||
    (SELECT count(*) FROM public.product_mappings) || '|' ||
    (SELECT count(*) FROM public.winerim_wines) || '|' ||
    (SELECT count(*) FROM public.sales_events) || '|' ||
    (SELECT count(*) FROM public.sales_line_items) || '|' ||
    (SELECT count(*) FROM public.stock_sync_log) || '|' ||
    (SELECT count(*) FROM public.provider_products) || '|' ||
    (SELECT count(*) FROM public.agora_master_data) || '|' ||
    (SELECT count(*) FROM public.winerim_push_tracking)
")
test "$expired_counts" = "0|0|0|0|0|0|0|0|0" || {
  printf 'EXPIRED_SCOPE_NOT_FAIL_CLOSED=%s\n' "$expired_counts" >&2
  exit 1
}

expect_login_failure EXPIRED_SCOPE_INSERT \
  'row-level security|permission denied' \
  "INSERT INTO public.stock_sync_log (connection_id, product_name, quantity, status, idempotency_key) VALUES ('11111111-1111-4111-8111-111111111111', 'Expired receipt', 1, 'SUCCESS', 'runtime-expired')"

printf 'INFO: login_role=%s attributes=%s\n' "$LOGIN_ROLE" "$role_attributes"
printf 'INFO: visible_counts=%s catalog_write_readback=%s cross_connection_catalog_visible=%s receipt_readback=%s persistence_readback=%s expired_counts=%s\n' \
  "$visible_counts" "$catalog_write_readback" "$cross_connection_catalog_visible" "$receipt_readback" "$persistence_readback" "$expired_counts"
printf 'INFO: runtime_privileges=%s platform_role_privileges=%s\n' \
  "$runtime_privileges" "$platform_privileges"
printf 'RESULT=RUNTIME_SALES_CANARY_PERMISSIONS_OK\n'
