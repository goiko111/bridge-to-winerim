BEGIN;

DO $runtime_fleet_production_rollback_guard$
DECLARE
  environment_value text;
BEGIN
  SELECT value INTO environment_value
  FROM public.infrastructure_metadata
  WHERE key = 'environment';

  IF environment_value NOT IN ('staging', 'rescue-production') THEN
    RAISE EXCEPTION 'runtime fleet rollback target is not staging or rescue-production';
  END IF;

  IF to_regclass('public.runtime_canary_connections_one_active_per_connection_idx') IS NULL
    OR to_regclass('public.runtime_canary_connections_single_active_idx') IS NOT NULL
    OR to_regclass('public.runtime_connection_credentials_scope_idx') IS NULL
  THEN
    RAISE EXCEPTION 'runtime fleet production rollback source has drift';
  END IF;
END
$runtime_fleet_production_rollback_guard$;

DROP TABLE IF EXISTS public.agora_fleet_read_model;

DROP POLICY IF EXISTS middleware_fleet_reader_idempotency_select
  ON public.runtime_idempotency;
DROP POLICY IF EXISTS middleware_fleet_reader_outbound_select
  ON public.outbound_tasks;
DROP POLICY IF EXISTS middleware_fleet_reader_stock_select
  ON public.stock_sync_log;
DROP POLICY IF EXISTS middleware_fleet_reader_sales_select
  ON public.sales_line_items;
DROP POLICY IF EXISTS middleware_fleet_reader_master_select
  ON public.agora_master_data;
DROP POLICY IF EXISTS middleware_fleet_reader_tracking_select
  ON public.winerim_push_tracking;
DROP POLICY IF EXISTS middleware_fleet_reader_connection_select
  ON public.pos_connections;
DROP POLICY IF EXISTS middleware_fleet_reader_scope_select
  ON public.runtime_canary_connections;

DO $runtime_fleet_reader_rollback$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'middleware_fleet_reader') THEN
    REVOKE middleware_fleet_reader FROM middleware_runtime;
    REVOKE ALL ON
      public.runtime_canary_connections,
      public.pos_connections,
      public.winerim_push_tracking,
      public.agora_master_data,
      public.sales_line_items,
      public.stock_sync_log,
      public.outbound_tasks,
      public.runtime_idempotency
    FROM middleware_fleet_reader;
    REVOKE USAGE ON SCHEMA public FROM middleware_fleet_reader;
    DROP ROLE middleware_fleet_reader;
  END IF;
END
$runtime_fleet_reader_rollback$;

DROP INDEX public.runtime_connection_credentials_scope_idx;

COMMIT;
