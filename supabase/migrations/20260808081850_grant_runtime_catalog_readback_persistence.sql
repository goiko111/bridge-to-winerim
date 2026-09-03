BEGIN;

DO $grant_guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'middleware_runtime') THEN
    RAISE EXCEPTION 'MIDDLEWARE_RUNTIME_ROLE_MISSING';
  END IF;
END
$grant_guard$;

GRANT INSERT, UPDATE ON TABLE public.product_mappings TO middleware_runtime;
GRANT INSERT, UPDATE ON TABLE public.winerim_push_tracking TO middleware_runtime;
GRANT INSERT, UPDATE ON TABLE public.provider_products TO middleware_runtime;
GRANT UPDATE ON TABLE public.agora_master_data TO middleware_runtime;

DROP POLICY IF EXISTS middleware_runtime_full_catalog_provider_shadow_insert
  ON public.provider_products;
CREATE POLICY middleware_runtime_full_catalog_provider_shadow_insert
  ON public.provider_products
  FOR INSERT
  TO middleware_runtime
  WITH CHECK (
    public.runtime_full_catalog_scope(connection_id)
    AND provider_product_id ~ '^[0-9]+$'
    AND sale_format IN ('BOTTLE', 'GLASS', 'MAGNUM')
    AND is_wine_candidate IS TRUE
    AND sync_status = 'SYNCED'
    AND sync_error IS NULL
    AND last_synced_at IS NOT NULL
    AND winerim_wine_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.product_mappings mapping
      WHERE mapping.connection_id = provider_products.connection_id
        AND mapping.provider_product_id = provider_products.provider_product_id
        AND mapping.winerim_wine_id = provider_products.winerim_wine_id
        AND upper(mapping.format_type) = upper(provider_products.sale_format)
        AND mapping.status = 'CONFIRMED'
        AND mapping.match_method IN (
          'RESCUE_EXACT_ID_WINE_VARIANT',
          'RESCUE_EXACT_ID_WINE_VARIANT_SALES_ONLY'
        )
    )
  );

DROP POLICY IF EXISTS middleware_runtime_full_catalog_provider_shadow_update
  ON public.provider_products;
CREATE POLICY middleware_runtime_full_catalog_provider_shadow_update
  ON public.provider_products
  FOR UPDATE
  TO middleware_runtime
  USING (
    public.runtime_full_catalog_scope(connection_id)
    AND provider_product_id ~ '^[0-9]+$'
  )
  WITH CHECK (
    public.runtime_full_catalog_scope(connection_id)
    AND provider_product_id ~ '^[0-9]+$'
    AND sale_format IN ('BOTTLE', 'GLASS', 'MAGNUM')
    AND is_wine_candidate IS TRUE
    AND sync_status = 'SYNCED'
    AND sync_error IS NULL
    AND last_synced_at IS NOT NULL
    AND winerim_wine_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.product_mappings mapping
      WHERE mapping.connection_id = provider_products.connection_id
        AND mapping.provider_product_id = provider_products.provider_product_id
        AND mapping.winerim_wine_id = provider_products.winerim_wine_id
        AND upper(mapping.format_type) = upper(provider_products.sale_format)
        AND mapping.status = 'CONFIRMED'
        AND mapping.match_method IN (
          'RESCUE_EXACT_ID_WINE_VARIANT',
          'RESCUE_EXACT_ID_WINE_VARIANT_SALES_ONLY'
        )
    )
  );

DROP POLICY IF EXISTS middleware_runtime_full_catalog_master_shadow_update
  ON public.agora_master_data;
CREATE POLICY middleware_runtime_full_catalog_master_shadow_update
  ON public.agora_master_data
  FOR UPDATE
  TO middleware_runtime
  USING (public.runtime_full_catalog_scope(connection_id))
  WITH CHECK (public.runtime_full_catalog_scope(connection_id));

COMMIT;
