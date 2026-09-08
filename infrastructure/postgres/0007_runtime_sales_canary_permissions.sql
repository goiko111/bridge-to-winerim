\set ON_ERROR_STOP on

BEGIN;

DO $runtime_sales_canary_preflight$
DECLARE
  target_table text;
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

  IF to_regclass('public.runtime_canary_connections') IS NULL THEN
    RAISE EXCEPTION 'runtime_canary_connections is required before migration 0007';
  END IF;

  FOREACH target_table IN ARRAY ARRAY[
    'product_mappings',
    'winerim_wines',
    'sales_events',
    'sales_line_items',
    'stock_sync_log'
  ]
  LOOP
    SELECT table_class.relrowsecurity
    INTO rls_enabled
    FROM pg_class table_class
    JOIN pg_namespace namespace ON namespace.oid = table_class.relnamespace
    WHERE namespace.nspname = 'public'
      AND table_class.relname = target_table
      AND table_class.relkind = 'r';

    IF rls_enabled IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'public.% must exist with RLS enabled', target_table;
    END IF;
  END LOOP;
END
$runtime_sales_canary_preflight$;

REVOKE ALL ON
  public.product_mappings,
  public.winerim_wines,
  public.sales_events,
  public.sales_line_items,
  public.stock_sync_log
FROM PUBLIC, anon, authenticated, service_role, middleware_runtime;

GRANT SELECT ON
  public.product_mappings,
  public.winerim_wines,
  public.stock_sync_log
TO middleware_runtime;

GRANT SELECT, INSERT, UPDATE ON public.sales_events TO middleware_runtime;
GRANT SELECT, INSERT, DELETE ON public.sales_line_items TO middleware_runtime;
GRANT INSERT ON public.stock_sync_log TO middleware_runtime;
GRANT UPDATE (last_business_day_synced, last_sync_at)
  ON public.pos_connections TO middleware_runtime;

DROP POLICY IF EXISTS middleware_runtime_canary_select_product_mappings
  ON public.product_mappings;
CREATE POLICY middleware_runtime_canary_select_product_mappings
  ON public.product_mappings
  FOR SELECT TO middleware_runtime
  USING (EXISTS (
    SELECT 1
    FROM public.runtime_canary_connections scope
    WHERE scope.connection_id = product_mappings.connection_id
      AND scope.active = true
      AND scope.approved_at IS NOT NULL
      AND scope.approved_at <= now()
      AND scope.expires_at IS NOT NULL
      AND scope.expires_at > now()
  ));

DROP POLICY IF EXISTS middleware_runtime_canary_select_winerim_wines
  ON public.winerim_wines;
CREATE POLICY middleware_runtime_canary_select_winerim_wines
  ON public.winerim_wines
  FOR SELECT TO middleware_runtime
  USING (EXISTS (
    SELECT 1
    FROM public.runtime_canary_connections scope
    WHERE scope.connection_id = winerim_wines.connection_id
      AND scope.active = true
      AND scope.approved_at IS NOT NULL
      AND scope.approved_at <= now()
      AND scope.expires_at IS NOT NULL
      AND scope.expires_at > now()
  ));

DROP POLICY IF EXISTS middleware_runtime_canary_select_sales_events
  ON public.sales_events;
CREATE POLICY middleware_runtime_canary_select_sales_events
  ON public.sales_events
  FOR SELECT TO middleware_runtime
  USING (EXISTS (
    SELECT 1
    FROM public.runtime_canary_connections scope
    WHERE scope.connection_id = sales_events.connection_id
      AND scope.active = true
      AND scope.approved_at IS NOT NULL
      AND scope.approved_at <= now()
      AND scope.expires_at IS NOT NULL
      AND scope.expires_at > now()
  ));

DROP POLICY IF EXISTS middleware_runtime_canary_insert_sales_events
  ON public.sales_events;
CREATE POLICY middleware_runtime_canary_insert_sales_events
  ON public.sales_events
  FOR INSERT TO middleware_runtime
  WITH CHECK (EXISTS (
    SELECT 1
    FROM public.runtime_canary_connections scope
    WHERE scope.connection_id = sales_events.connection_id
      AND scope.active = true
      AND scope.approved_at IS NOT NULL
      AND scope.approved_at <= now()
      AND scope.expires_at IS NOT NULL
      AND scope.expires_at > now()
  ));

DROP POLICY IF EXISTS middleware_runtime_canary_update_sales_events
  ON public.sales_events;
CREATE POLICY middleware_runtime_canary_update_sales_events
  ON public.sales_events
  FOR UPDATE TO middleware_runtime
  USING (EXISTS (
    SELECT 1
    FROM public.runtime_canary_connections scope
    WHERE scope.connection_id = sales_events.connection_id
      AND scope.active = true
      AND scope.approved_at IS NOT NULL
      AND scope.approved_at <= now()
      AND scope.expires_at IS NOT NULL
      AND scope.expires_at > now()
  ))
  WITH CHECK (EXISTS (
    SELECT 1
    FROM public.runtime_canary_connections scope
    WHERE scope.connection_id = sales_events.connection_id
      AND scope.active = true
      AND scope.approved_at IS NOT NULL
      AND scope.approved_at <= now()
      AND scope.expires_at IS NOT NULL
      AND scope.expires_at > now()
  ));

DROP POLICY IF EXISTS middleware_runtime_canary_select_sales_line_items
  ON public.sales_line_items;
CREATE POLICY middleware_runtime_canary_select_sales_line_items
  ON public.sales_line_items
  FOR SELECT TO middleware_runtime
  USING (
    EXISTS (
      SELECT 1
      FROM public.runtime_canary_connections scope
      WHERE scope.connection_id = sales_line_items.connection_id
        AND scope.active = true
        AND scope.approved_at IS NOT NULL
        AND scope.approved_at <= now()
        AND scope.expires_at IS NOT NULL
        AND scope.expires_at > now()
    )
    AND EXISTS (
      SELECT 1
      FROM public.sales_events event
      WHERE event.id = sales_line_items.sales_event_id
        AND event.connection_id = sales_line_items.connection_id
    )
  );

DROP POLICY IF EXISTS middleware_runtime_canary_insert_sales_line_items
  ON public.sales_line_items;
CREATE POLICY middleware_runtime_canary_insert_sales_line_items
  ON public.sales_line_items
  FOR INSERT TO middleware_runtime
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.runtime_canary_connections scope
      WHERE scope.connection_id = sales_line_items.connection_id
        AND scope.active = true
        AND scope.approved_at IS NOT NULL
        AND scope.approved_at <= now()
        AND scope.expires_at IS NOT NULL
        AND scope.expires_at > now()
    )
    AND EXISTS (
      SELECT 1
      FROM public.sales_events event
      WHERE event.id = sales_line_items.sales_event_id
        AND event.connection_id = sales_line_items.connection_id
    )
  );

DROP POLICY IF EXISTS middleware_runtime_canary_delete_sales_line_items
  ON public.sales_line_items;
CREATE POLICY middleware_runtime_canary_delete_sales_line_items
  ON public.sales_line_items
  FOR DELETE TO middleware_runtime
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

DROP POLICY IF EXISTS middleware_runtime_canary_update_sales_cursor
  ON public.pos_connections;
CREATE POLICY middleware_runtime_canary_update_sales_cursor
  ON public.pos_connections
  FOR UPDATE TO middleware_runtime
  USING (EXISTS (
    SELECT 1
    FROM public.runtime_canary_connections scope
    WHERE scope.connection_id = pos_connections.id
      AND scope.active = true
      AND scope.approved_at IS NOT NULL
      AND scope.approved_at <= now()
      AND scope.expires_at IS NOT NULL
      AND scope.expires_at > now()
  ))
  WITH CHECK (EXISTS (
    SELECT 1
    FROM public.runtime_canary_connections scope
    WHERE scope.connection_id = pos_connections.id
      AND scope.active = true
      AND scope.approved_at IS NOT NULL
      AND scope.approved_at <= now()
      AND scope.expires_at IS NOT NULL
      AND scope.expires_at > now()
  ));

DROP POLICY IF EXISTS middleware_runtime_canary_select_stock_log
  ON public.stock_sync_log;
DROP POLICY IF EXISTS middleware_runtime_canary_insert_stock_log
  ON public.stock_sync_log;

CREATE POLICY middleware_runtime_canary_select_stock_log
  ON public.stock_sync_log
  FOR SELECT TO middleware_runtime
  USING (
    EXISTS (
      SELECT 1
      FROM public.runtime_canary_connections scope
      WHERE scope.connection_id = stock_sync_log.connection_id
        AND scope.active = true
        AND scope.approved_at IS NOT NULL
        AND scope.approved_at <= now()
        AND scope.expires_at IS NOT NULL
        AND scope.expires_at > now()
    )
    AND (
      stock_sync_log.sales_event_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM public.sales_events event
        WHERE event.id = stock_sync_log.sales_event_id
          AND event.connection_id = stock_sync_log.connection_id
      )
    )
    AND (
      stock_sync_log.sales_line_item_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM public.sales_line_items line
        WHERE line.id = stock_sync_log.sales_line_item_id
          AND line.connection_id = stock_sync_log.connection_id
          AND (
            stock_sync_log.sales_event_id IS NULL
            OR line.sales_event_id = stock_sync_log.sales_event_id
          )
      )
    )
  );

CREATE POLICY middleware_runtime_canary_insert_stock_log
  ON public.stock_sync_log
  FOR INSERT TO middleware_runtime
  WITH CHECK (
    stock_sync_log.idempotency_key IS NOT NULL
    AND btrim(stock_sync_log.idempotency_key) <> ''
    AND EXISTS (
      SELECT 1
      FROM public.runtime_canary_connections scope
      WHERE scope.connection_id = stock_sync_log.connection_id
        AND scope.active = true
        AND scope.approved_at IS NOT NULL
        AND scope.approved_at <= now()
        AND scope.expires_at IS NOT NULL
        AND scope.expires_at > now()
    )
    AND (
      stock_sync_log.sales_event_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM public.sales_events event
        WHERE event.id = stock_sync_log.sales_event_id
          AND event.connection_id = stock_sync_log.connection_id
      )
    )
    AND (
      stock_sync_log.sales_line_item_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM public.sales_line_items line
        WHERE line.id = stock_sync_log.sales_line_item_id
          AND line.connection_id = stock_sync_log.connection_id
          AND (
            stock_sync_log.sales_event_id IS NULL
            OR line.sales_event_id = stock_sync_log.sales_event_id
          )
      )
    )
  );

COMMIT;
