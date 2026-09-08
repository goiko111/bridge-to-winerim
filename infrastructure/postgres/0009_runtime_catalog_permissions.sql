\set ON_ERROR_STOP on

BEGIN;

DO $runtime_catalog_permissions_preflight$
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
    RAISE EXCEPTION 'middleware_runtime must be a hardened NOLOGIN role';
  END IF;

  IF to_regclass('public.runtime_canary_connections') IS NULL THEN
    RAISE EXCEPTION 'runtime_canary_connections is required before migration 0009';
  END IF;

  FOREACH target_table IN ARRAY ARRAY[
    'provider_products',
    'agora_master_data',
    'product_mappings',
    'winerim_push_tracking'
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
$runtime_catalog_permissions_preflight$;

REVOKE ALL ON
  public.provider_products,
  public.agora_master_data,
  public.product_mappings,
  public.winerim_push_tracking
FROM middleware_runtime;

GRANT SELECT ON
  public.provider_products,
  public.agora_master_data,
  public.product_mappings,
  public.winerim_push_tracking
TO middleware_runtime;

GRANT INSERT (
  connection_id,
  provider_product_id,
  provider_product_name,
  winerim_wine_id,
  winerim_wine_name,
  match_method,
  match_score,
  match_reasons,
  status,
  format_type,
  agora_product_id,
  last_synced_at,
  last_sync_error
) ON public.product_mappings TO middleware_runtime;

GRANT UPDATE (
  provider_product_name,
  winerim_wine_id,
  winerim_wine_name,
  match_method,
  match_score,
  match_reasons,
  status,
  format_type,
  agora_product_id,
  last_synced_at,
  last_sync_error,
  updated_at
) ON public.product_mappings TO middleware_runtime;

GRANT INSERT (
  connection_id,
  winerim_wine_id,
  format,
  agora_product_id,
  agora_family_id,
  source,
  sync_status,
  last_error,
  pushed_at,
  verified_at
) ON public.winerim_push_tracking TO middleware_runtime;

GRANT UPDATE (
  agora_product_id,
  agora_family_id,
  source,
  sync_status,
  last_error,
  pushed_at,
  verified_at,
  updated_at
) ON public.winerim_push_tracking TO middleware_runtime;

DROP POLICY IF EXISTS middleware_runtime_canary_select_provider_products
  ON public.provider_products;
CREATE POLICY middleware_runtime_canary_select_provider_products
  ON public.provider_products
  FOR SELECT TO middleware_runtime
  USING (EXISTS (
    SELECT 1
    FROM public.runtime_canary_connections scope
    WHERE scope.connection_id = provider_products.connection_id
      AND scope.active = true
      AND scope.approved_at IS NOT NULL
      AND scope.approved_at <= now()
      AND scope.expires_at IS NOT NULL
      AND scope.expires_at > now()
  ));

DROP POLICY IF EXISTS middleware_runtime_canary_select_master
  ON public.agora_master_data;
CREATE POLICY middleware_runtime_canary_select_master
  ON public.agora_master_data
  FOR SELECT TO middleware_runtime
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

DROP POLICY IF EXISTS middleware_runtime_canary_insert_product_mappings
  ON public.product_mappings;
CREATE POLICY middleware_runtime_canary_insert_product_mappings
  ON public.product_mappings
  FOR INSERT TO middleware_runtime
  WITH CHECK (
    match_method = 'RUNTIME_CATALOG_PLAN'
    AND match_score = 1
    AND status = 'PENDING'
    AND format_type IN ('BOTTLE', 'GLASS', 'MAGNUM')
    AND winerim_wine_id IS NOT NULL
    AND agora_product_id = provider_product_id
    AND provider_product_id ~ '^[0-9]+$'
    AND match_reasons @> ARRAY['DB_PLAN_PREPARED']::text[]
    AND EXISTS (
      SELECT 1 FROM unnest(match_reasons) reason
      WHERE reason LIKE 'plan:%' AND length(reason) > 5
    )
    AND EXISTS (
      SELECT 1
      FROM public.winerim_wines wine
      WHERE wine.connection_id = product_mappings.connection_id
        AND wine.winerim_id = product_mappings.winerim_wine_id
    )
    AND EXISTS (
      SELECT 1
      FROM public.runtime_canary_connections scope
      WHERE scope.connection_id = product_mappings.connection_id
        AND scope.active = true
        AND scope.approved_at IS NOT NULL
        AND scope.approved_at <= now()
        AND scope.expires_at IS NOT NULL
        AND scope.expires_at > now()
    )
  );

DROP POLICY IF EXISTS middleware_runtime_canary_update_product_mappings
  ON public.product_mappings;
CREATE POLICY middleware_runtime_canary_update_product_mappings
  ON public.product_mappings
  FOR UPDATE TO middleware_runtime
  USING (
    status = 'PENDING'
    AND EXISTS (
      SELECT 1
      FROM public.runtime_canary_connections scope
      WHERE scope.connection_id = product_mappings.connection_id
        AND scope.active = true
        AND scope.approved_at IS NOT NULL
        AND scope.approved_at <= now()
        AND scope.expires_at IS NOT NULL
        AND scope.expires_at > now()
    )
  )
  WITH CHECK (
    match_method = 'RUNTIME_CATALOG_PLAN'
    AND match_score = 1
    AND status = 'PENDING'
    AND format_type IN ('BOTTLE', 'GLASS', 'MAGNUM')
    AND winerim_wine_id IS NOT NULL
    AND agora_product_id = provider_product_id
    AND provider_product_id ~ '^[0-9]+$'
    AND match_reasons @> ARRAY['DB_PLAN_PREPARED']::text[]
    AND EXISTS (
      SELECT 1 FROM unnest(match_reasons) reason
      WHERE reason LIKE 'plan:%' AND length(reason) > 5
    )
    AND EXISTS (
      SELECT 1
      FROM public.winerim_wines wine
      WHERE wine.connection_id = product_mappings.connection_id
        AND wine.winerim_id = product_mappings.winerim_wine_id
    )
    AND EXISTS (
      SELECT 1
      FROM public.runtime_canary_connections scope
      WHERE scope.connection_id = product_mappings.connection_id
        AND scope.active = true
        AND scope.approved_at IS NOT NULL
        AND scope.approved_at <= now()
        AND scope.expires_at IS NOT NULL
        AND scope.expires_at > now()
    )
  );

DROP POLICY IF EXISTS middleware_runtime_canary_select_tracking
  ON public.winerim_push_tracking;
CREATE POLICY middleware_runtime_canary_select_tracking
  ON public.winerim_push_tracking
  FOR SELECT TO middleware_runtime
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

DROP POLICY IF EXISTS middleware_runtime_canary_insert_tracking
  ON public.winerim_push_tracking;
CREATE POLICY middleware_runtime_canary_insert_tracking
  ON public.winerim_push_tracking
  FOR INSERT TO middleware_runtime
  WITH CHECK (
    source = 'WINERIM'
    AND sync_status = 'NOT_PUSHED'
    AND agora_product_id ~ '^[0-9]+$'
    AND EXISTS (
      SELECT 1
      FROM public.winerim_wines wine
      WHERE wine.connection_id = winerim_push_tracking.connection_id
        AND wine.winerim_id = winerim_push_tracking.winerim_wine_id
    )
    AND EXISTS (
      SELECT 1
      FROM public.runtime_canary_connections scope
      WHERE scope.connection_id = winerim_push_tracking.connection_id
        AND scope.active = true
        AND scope.approved_at IS NOT NULL
        AND scope.approved_at <= now()
        AND scope.expires_at IS NOT NULL
        AND scope.expires_at > now()
    )
  );

DROP POLICY IF EXISTS middleware_runtime_canary_update_tracking
  ON public.winerim_push_tracking;
CREATE POLICY middleware_runtime_canary_update_tracking
  ON public.winerim_push_tracking
  FOR UPDATE TO middleware_runtime
  USING (
    source = 'WINERIM'
    AND EXISTS (
      SELECT 1
      FROM public.runtime_canary_connections scope
      WHERE scope.connection_id = winerim_push_tracking.connection_id
        AND scope.active = true
        AND scope.approved_at IS NOT NULL
        AND scope.approved_at <= now()
        AND scope.expires_at IS NOT NULL
        AND scope.expires_at > now()
    )
  )
  WITH CHECK (
    source = 'WINERIM'
    AND sync_status IN ('NOT_PUSHED', 'PUSHED', 'VERIFIED')
    AND agora_product_id ~ '^[0-9]+$'
    AND EXISTS (
      SELECT 1
      FROM public.winerim_wines wine
      WHERE wine.connection_id = winerim_push_tracking.connection_id
        AND wine.winerim_id = winerim_push_tracking.winerim_wine_id
    )
    AND EXISTS (
      SELECT 1
      FROM public.runtime_canary_connections scope
      WHERE scope.connection_id = winerim_push_tracking.connection_id
        AND scope.active = true
        AND scope.approved_at IS NOT NULL
        AND scope.approved_at <= now()
        AND scope.expires_at IS NOT NULL
        AND scope.expires_at > now()
    )
  );

COMMIT;
