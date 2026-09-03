BEGIN;

DO $fleet_reader_preflight$
DECLARE
  source_table text;
  rls_enabled boolean;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname = 'middleware_runtime'
      AND rolcanlogin = false
      AND rolsuper = false
      AND rolbypassrls = false
  ) THEN
    RAISE EXCEPTION
      'middleware_runtime must exist as a NOLOGIN, NOSUPERUSER, NOBYPASSRLS role';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'middleware_fleet_reader') THEN
    RAISE EXCEPTION 'middleware_fleet_reader already exists; reconcile before applying';
  END IF;

  IF to_regclass('public.runtime_canary_connections_one_active_per_connection_idx') IS NULL
    OR to_regclass('public.runtime_canary_connections_single_active_idx') IS NOT NULL
  THEN
    RAISE EXCEPTION
      'runtime fleet connection scope must allow one active generation per connection';
  END IF;

  FOREACH source_table IN ARRAY ARRAY[
    'runtime_canary_connections',
    'pos_connections',
    'winerim_push_tracking',
    'agora_master_data',
    'sales_line_items',
    'stock_sync_log',
    'outbound_tasks',
    'runtime_idempotency'
  ]
  LOOP
    SELECT table_class.relrowsecurity
    INTO rls_enabled
    FROM pg_class table_class
    JOIN pg_namespace namespace ON namespace.oid = table_class.relnamespace
    WHERE namespace.nspname = 'public'
      AND table_class.relname = source_table
      AND table_class.relkind = 'r';

    IF rls_enabled IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'public.% must exist with RLS enabled', source_table;
    END IF;
  END LOOP;
END
$fleet_reader_preflight$;

CREATE ROLE middleware_fleet_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
GRANT middleware_fleet_reader TO middleware_runtime;
GRANT USAGE ON SCHEMA public TO middleware_fleet_reader;
GRANT SELECT ON
  public.runtime_canary_connections,
  public.pos_connections,
  public.winerim_push_tracking,
  public.agora_master_data,
  public.sales_line_items,
  public.stock_sync_log,
  public.outbound_tasks,
  public.runtime_idempotency
TO middleware_fleet_reader;

CREATE POLICY middleware_fleet_reader_scope_select
  ON public.runtime_canary_connections
  FOR SELECT TO middleware_fleet_reader
  USING (
    active = true
    AND approved_at IS NOT NULL
    AND approved_at <= now()
    AND expires_at IS NOT NULL
    AND expires_at > now()
  );

CREATE POLICY middleware_fleet_reader_connection_select
  ON public.pos_connections
  FOR SELECT TO middleware_fleet_reader
  USING (EXISTS (
    SELECT 1
    FROM public.runtime_canary_connections scope
    WHERE scope.connection_id = pos_connections.id
      AND scope.active = true
      AND scope.approved_at IS NOT NULL
      AND scope.approved_at <= now()
      AND scope.expires_at IS NOT NULL
      AND scope.expires_at > now()
  ));

CREATE POLICY middleware_fleet_reader_tracking_select
  ON public.winerim_push_tracking
  FOR SELECT TO middleware_fleet_reader
  USING (EXISTS (
    SELECT 1
    FROM public.runtime_canary_connections scope
    WHERE scope.connection_id = winerim_push_tracking.connection_id
      AND scope.active = true
      AND scope.approved_at IS NOT NULL
      AND scope.approved_at <= now()
      AND scope.expires_at IS NOT NULL
      AND scope.expires_at > now()
  ));

CREATE POLICY middleware_fleet_reader_master_select
  ON public.agora_master_data
  FOR SELECT TO middleware_fleet_reader
  USING (EXISTS (
    SELECT 1
    FROM public.runtime_canary_connections scope
    WHERE scope.connection_id = agora_master_data.connection_id
      AND scope.active = true
      AND scope.approved_at IS NOT NULL
      AND scope.approved_at <= now()
      AND scope.expires_at IS NOT NULL
      AND scope.expires_at > now()
  ));

CREATE POLICY middleware_fleet_reader_sales_select
  ON public.sales_line_items
  FOR SELECT TO middleware_fleet_reader
  USING (EXISTS (
    SELECT 1
    FROM public.runtime_canary_connections scope
    WHERE scope.connection_id = sales_line_items.connection_id
      AND scope.active = true
      AND scope.approved_at IS NOT NULL
      AND scope.approved_at <= now()
      AND scope.expires_at IS NOT NULL
      AND scope.expires_at > now()
  ));

CREATE POLICY middleware_fleet_reader_stock_select
  ON public.stock_sync_log
  FOR SELECT TO middleware_fleet_reader
  USING (EXISTS (
    SELECT 1
    FROM public.runtime_canary_connections scope
    WHERE scope.connection_id = stock_sync_log.connection_id
      AND scope.active = true
      AND scope.approved_at IS NOT NULL
      AND scope.approved_at <= now()
      AND scope.expires_at IS NOT NULL
      AND scope.expires_at > now()
  ));

CREATE POLICY middleware_fleet_reader_outbound_select
  ON public.outbound_tasks
  FOR SELECT TO middleware_fleet_reader
  USING (EXISTS (
    SELECT 1
    FROM public.runtime_canary_connections scope
    WHERE scope.connection_id = outbound_tasks.connection_id
      AND scope.active = true
      AND scope.approved_at IS NOT NULL
      AND scope.approved_at <= now()
      AND scope.expires_at IS NOT NULL
      AND scope.expires_at > now()
  ));

CREATE POLICY middleware_fleet_reader_idempotency_select
  ON public.runtime_idempotency
  FOR SELECT TO middleware_fleet_reader
  USING (EXISTS (
    SELECT 1
    FROM public.runtime_canary_connections scope
    WHERE scope.connection_id = runtime_idempotency.connection_id
      AND scope.active = true
      AND scope.approved_at IS NOT NULL
      AND scope.approved_at <= now()
      AND scope.expires_at IS NOT NULL
      AND scope.expires_at > now()
  ));

CREATE TABLE public.agora_fleet_read_model (
  connection_id uuid PRIMARY KEY REFERENCES public.pos_connections(id) ON DELETE CASCADE,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  source_hash text NOT NULL CHECK (source_hash ~ '^[a-f0-9]{64}$'),
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.agora_fleet_read_model IS
  'Derived, non-secret Agora fleet status. Refreshed outside UI requests; renderers must not query TPVs or operational ledgers directly.';

CREATE INDEX agora_fleet_read_model_observed_at_idx
  ON public.agora_fleet_read_model(observed_at DESC, connection_id);

ALTER TABLE public.agora_fleet_read_model ENABLE ROW LEVEL SECURITY;

CREATE POLICY middleware_fleet_read_model_select
  ON public.agora_fleet_read_model
  FOR SELECT TO middleware_runtime, middleware_api, middleware_readonly
  USING (true);

CREATE POLICY middleware_runtime_fleet_read_model_insert
  ON public.agora_fleet_read_model
  FOR INSERT TO middleware_runtime
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.pos_connections connection
    WHERE connection.id = agora_fleet_read_model.connection_id
      AND connection.provider = 'agora'
  ));

CREATE POLICY middleware_runtime_fleet_read_model_update
  ON public.agora_fleet_read_model
  FOR UPDATE TO middleware_runtime
  USING (EXISTS (
    SELECT 1 FROM public.pos_connections connection
    WHERE connection.id = agora_fleet_read_model.connection_id
      AND connection.provider = 'agora'
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.pos_connections connection
    WHERE connection.id = agora_fleet_read_model.connection_id
      AND connection.provider = 'agora'
  ));

REVOKE ALL ON public.agora_fleet_read_model FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.agora_fleet_read_model TO middleware_runtime, middleware_api, middleware_readonly;
GRANT INSERT, UPDATE ON public.agora_fleet_read_model TO middleware_runtime;

COMMIT;
