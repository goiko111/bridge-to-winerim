\set ON_ERROR_STOP on

BEGIN TRANSACTION READ ONLY;

SELECT
  current_database() AS database_name,
  current_user AS database_user,
  current_setting('server_version_num')::integer AS server_version_num,
  current_setting('transaction_read_only') AS transaction_read_only;

WITH expected(name) AS (
  VALUES
    ('agora_master_data'),
    ('agora_dispatch_locks'),
    ('classification_config'),
    ('connection_alerts'),
    ('connection_health_checks'),
    ('connection_notification_contacts'),
    ('integration_onboarding_requests'),
    ('infrastructure_metadata'),
    ('middleware_incident_email_attempts'),
    ('middleware_incident_events'),
    ('middleware_incidents'),
    ('outbound_tasks'),
    ('pos_connections'),
    ('product_mappings'),
    ('provider_capabilities'),
    ('provider_credentials'),
    ('provider_products'),
    ('runtime_connection_credentials'),
    ('runtime_canary_connections'),
    ('runtime_catalog_source_scope'),
    ('runtime_execution_log'),
    ('runtime_idempotency'),
    ('sales_events'),
    ('sales_line_items'),
    ('stock_sync_log'),
    ('user_roles'),
    ('webhook_events'),
    ('wine_family_rules'),
    ('wine_type_family_mappings'),
    ('winerim_push_tracking'),
    ('winerim_wines')
)
SELECT
  expected.name,
  to_regclass(format('public.%I', expected.name)) IS NOT NULL AS present
FROM expected
ORDER BY expected.name;

WITH expected(name) AS (
  VALUES
    ('acquire_agora_dispatch_lock'),
    ('claim_outbound_tasks'),
    ('enforce_runtime_canary_connection_window'),
    ('enforce_runtime_catalog_wine_refresh_scope'),
    ('has_role'),
    ('release_agora_dispatch_lock'),
    ('rescue_zombie_outbound_tasks'),
    ('runtime_bind_sales_claim_identity'),
    ('update_updated_at_column'),
    ('validate_runtime_catalog_source_scope')
)
SELECT
  expected.name,
  EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = expected.name
  ) AS present
FROM expected
ORDER BY expected.name;

WITH expected(table_name, column_name) AS (
  VALUES
    ('runtime_idempotency', 'payload_sha256'),
    ('runtime_idempotency', 'lease_token'),
    ('runtime_idempotency', 'sales_claim_identity'),
    ('sales_line_items', 'provider_sold_at'),
    ('sales_line_items', 'provider_sold_at_source')
)
SELECT
  expected.table_name,
  expected.column_name,
  columns.data_type,
  columns.is_nullable,
  columns.column_name IS NOT NULL AS present
FROM expected
LEFT JOIN information_schema.columns columns
  ON columns.table_schema = 'public'
 AND columns.table_name = expected.table_name
 AND columns.column_name = expected.column_name
ORDER BY expected.table_name, expected.column_name;

SELECT
  to_regclass('public.idx_sales_line_items_connection_provider_sold_at') IS NOT NULL
    AS provider_sold_at_index_present;

SELECT
  to_regclass('public.runtime_canary_connections_one_active_per_connection_idx') IS NOT NULL
    AS runtime_canary_index_present,
  to_regclass('public.uq_runtime_sales_claim_identity') IS NOT NULL
    AS runtime_sales_claim_identity_index_present,
  EXISTS (
    SELECT 1
    FROM pg_trigger trigger
    JOIN pg_class table_class ON table_class.oid = trigger.tgrelid
    JOIN pg_namespace namespace ON namespace.oid = table_class.relnamespace
    WHERE namespace.nspname = 'public'
      AND table_class.relname = 'runtime_canary_connections'
      AND trigger.tgname = 'enforce_runtime_canary_connection_window'
      AND NOT trigger.tgisinternal
  ) AS runtime_canary_trigger_present,
  EXISTS (
    SELECT 1
    FROM pg_trigger trigger
    JOIN pg_class table_class ON table_class.oid = trigger.tgrelid
    JOIN pg_namespace namespace ON namespace.oid = table_class.relnamespace
    WHERE namespace.nspname = 'public'
      AND table_class.relname = 'runtime_idempotency'
      AND trigger.tgname = 'runtime_bind_sales_claim_identity'
      AND NOT trigger.tgisinternal
      AND trigger.tgenabled IN ('O', 'A')
  ) AS runtime_sales_claim_identity_trigger_present;

SELECT
  c.conname,
  c.contype = 'f' AS is_foreign_key,
  c.confdeltype = 'n' AS on_delete_set_null
FROM pg_constraint c
JOIN pg_namespace n ON n.oid = c.connamespace
WHERE n.nspname = 'public'
  AND c.conname = 'stock_sync_log_sales_line_item_id_fkey';

SELECT
  c.relname AS table_name,
  c.relrowsecurity AS rls_enabled,
  count(pol.polname) AS policy_count
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_policy pol ON pol.polrelid = c.oid
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
GROUP BY c.relname, c.relrowsecurity
ORDER BY c.relname;

SELECT
  n.nspname AS schema_name,
  p.proname AS function_name,
  p.prosecdef AS security_definer,
  EXISTS (
    SELECT 1
    FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
    WHERE acl.grantee = 0
      AND acl.privilege_type = 'EXECUTE'
  ) AS public_can_execute
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'acquire_agora_dispatch_lock',
    'claim_outbound_tasks',
    'has_role',
    'release_agora_dispatch_lock',
    'rescue_zombie_outbound_tasks',
    'runtime_bind_sales_claim_identity',
    'schedule_next_catalog_batch',
    'schedule_next_queue_batch',
    'update_updated_at_column'
  )
ORDER BY p.proname;

SELECT
  NOT has_table_privilege(
    'middleware_runtime',
    'public.agora_dispatch_locks',
    'SELECT,INSERT,UPDATE,DELETE'
  ) AS runtime_cannot_manage_dispatch_locks,
  NOT has_function_privilege(
    'middleware_runtime',
    'public.acquire_agora_dispatch_lock(uuid,text,text,integer)',
    'EXECUTE'
  ) AS runtime_cannot_acquire_dispatch_lock,
  NOT has_function_privilege(
    'middleware_runtime',
    'public.release_agora_dispatch_lock(uuid,text,text)',
    'EXECUTE'
  ) AS runtime_cannot_release_dispatch_lock;

SELECT
  has_table_privilege(
    'middleware_runtime',
    'public.runtime_connection_credentials',
    'SELECT'
  ) AS runtime_can_read_encrypted_credentials,
  NOT has_table_privilege(
    'middleware_runtime',
    'public.runtime_connection_credentials',
    'INSERT,UPDATE,DELETE'
  ) AS runtime_cannot_write_encrypted_credentials,
  NOT has_table_privilege(
    'middleware_api',
    'public.runtime_connection_credentials',
    'SELECT,INSERT,UPDATE,DELETE'
  ) AS api_cannot_access_encrypted_credentials;

SELECT
  extname,
  extversion,
  n.nspname AS extension_schema
FROM pg_extension e
JOIN pg_namespace n ON n.oid = e.extnamespace
WHERE extname IN ('pg_cron', 'pg_net', 'pgcrypto')
ORDER BY extname;

SELECT
  rolname,
  rolcanlogin,
  rolsuper,
  rolbypassrls
FROM pg_roles
WHERE rolname IN (
  'anon',
  'authenticated',
  'service_role',
  'middleware_api',
  'middleware_migrator',
  'middleware_readonly',
  'middleware_runtime'
)
ORDER BY rolname;

ROLLBACK;
