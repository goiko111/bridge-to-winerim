\set ON_ERROR_STOP on

BEGIN;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'middleware_runtime') THEN
    CREATE ROLE middleware_runtime NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'middleware_readonly') THEN
    CREATE ROLE middleware_readonly NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'middleware_api') THEN
    CREATE ROLE middleware_api NOLOGIN;
  END IF;
END
$roles$;

CREATE TABLE IF NOT EXISTS public.infrastructure_metadata (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.infrastructure_metadata (key, value)
VALUES ('environment', :'environment')
ON CONFLICT (key) DO UPDATE
SET value = EXCLUDED.value, updated_at = now();

CREATE TABLE IF NOT EXISTS public.runtime_idempotency (
  idempotency_key text PRIMARY KEY,
  message_id text NOT NULL,
  connection_id uuid NOT NULL REFERENCES public.pos_connections(id) ON DELETE CASCADE,
  job text NOT NULL,
  status text NOT NULL CHECK (status IN ('RUNNING', 'SUCCESS', 'RETRY', 'TERMINAL')),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  lease_expires_at timestamptz,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_runtime_idempotency_connection_status
  ON public.runtime_idempotency (connection_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS public.runtime_execution_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  message_id text NOT NULL,
  idempotency_key text NOT NULL,
  connection_id uuid NOT NULL REFERENCES public.pos_connections(id) ON DELETE CASCADE,
  job text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('SUCCESS', 'RETRY', 'TERMINAL', 'DUPLICATE', 'BLOCKED')),
  attempt integer NOT NULL CHECK (attempt >= 0),
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  error_class text,
  detail jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_runtime_execution_log_connection_created
  ON public.runtime_execution_log (connection_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runtime_execution_log_idempotency
  ON public.runtime_execution_log (idempotency_key, created_at DESC);

DO $policies$
DECLARE
  item record;
BEGIN
  FOR item IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
  LOOP
    EXECUTE format('DROP POLICY %I ON %I.%I', item.policyname, item.schemaname, item.tablename);
  END LOOP;

  FOR item IN
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', item.tablename);
    EXECUTE format(
      'CREATE POLICY middleware_runtime_all ON public.%I FOR ALL TO middleware_runtime USING (true) WITH CHECK (true)',
      item.tablename
    );
  END LOOP;
END
$policies$;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, authenticated, service_role;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, authenticated, service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, authenticated, service_role;

GRANT USAGE ON SCHEMA public TO middleware_runtime, middleware_readonly, middleware_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO middleware_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO middleware_runtime;
GRANT EXECUTE ON FUNCTION public.claim_outbound_tasks(uuid, text[], integer) TO middleware_runtime;
GRANT EXECUTE ON FUNCTION public.rescue_zombie_outbound_tasks() TO middleware_runtime;

GRANT SELECT ON
  public.infrastructure_metadata,
  public.runtime_idempotency,
  public.runtime_execution_log,
  public.sales_events,
  public.sales_line_items,
  public.stock_sync_log,
  public.outbound_tasks,
  public.product_mappings,
  public.provider_products,
  public.agora_master_data,
  public.winerim_push_tracking,
  public.winerim_wines
TO middleware_readonly;

GRANT SELECT ON
  public.infrastructure_metadata,
  public.pos_connections,
  public.connection_notification_contacts,
  public.integration_onboarding_requests,
  public.sales_line_items,
  public.stock_sync_log,
  public.outbound_tasks,
  public.agora_master_data,
  public.winerim_push_tracking
TO middleware_api;
GRANT INSERT ON public.integration_onboarding_requests TO middleware_api;

DO $readonly_policies$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'infrastructure_metadata', 'runtime_idempotency', 'runtime_execution_log',
    'sales_events', 'sales_line_items', 'stock_sync_log', 'outbound_tasks',
    'product_mappings', 'provider_products', 'agora_master_data',
    'winerim_push_tracking', 'winerim_wines'
  ]
  LOOP
    EXECUTE format(
      'CREATE POLICY middleware_readonly_select ON public.%I FOR SELECT TO middleware_readonly USING (true)',
      table_name
    );
  END LOOP;
END
$readonly_policies$;

DO $api_policies$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'infrastructure_metadata', 'pos_connections',
    'connection_notification_contacts', 'integration_onboarding_requests',
    'sales_line_items', 'stock_sync_log', 'outbound_tasks',
    'agora_master_data', 'winerim_push_tracking'
  ]
  LOOP
    EXECUTE format(
      'CREATE POLICY middleware_api_select ON public.%I FOR SELECT TO middleware_api USING (true)',
      table_name
    );
  END LOOP;
  CREATE POLICY middleware_api_insert_onboarding
    ON public.integration_onboarding_requests
    FOR INSERT TO middleware_api
    WITH CHECK (true);
END
$api_policies$;

ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO middleware_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO middleware_runtime;

COMMIT;
