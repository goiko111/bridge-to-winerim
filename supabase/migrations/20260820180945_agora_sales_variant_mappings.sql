BEGIN;

DO $role_guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'middleware_runtime') THEN
    RAISE EXCEPTION 'MIDDLEWARE_RUNTIME_ROLE_MISSING';
  END IF;
  IF to_regprocedure('public.runtime_full_catalog_scope(uuid)') IS NULL THEN
    RAISE EXCEPTION 'RUNTIME_FULL_CATALOG_SCOPE_FUNCTION_MISSING';
  END IF;
END
$role_guard$;

CREATE TABLE public.agora_sales_variant_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES public.pos_connections(id) ON DELETE CASCADE,
  provider_product_id text NOT NULL,
  sale_format_id text NOT NULL,
  provider_product_name text NOT NULL,
  provider_sale_format_name text NOT NULL,
  winerim_wine_id text NOT NULL,
  format_type text NOT NULL,
  match_method text NOT NULL,
  status text NOT NULL DEFAULT 'CONFIRMED',
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agora_sales_variant_mappings_numeric_ids CHECK (
    provider_product_id ~ '^[0-9]+$'
    AND sale_format_id ~ '^[0-9]+$'
  ),
  CONSTRAINT agora_sales_variant_mappings_format CHECK (
    format_type IN ('BOTTLE', 'GLASS', 'MAGNUM')
  ),
  CONSTRAINT agora_sales_variant_mappings_method CHECK (
    match_method IN ('AGORA_NATIVE_EXACT_ID_WINE_VARIANT', 'AGORA_NATIVE_EXACT_ID_WINE_VARIANT_SALES_ONLY')
  ),
  CONSTRAINT agora_sales_variant_mappings_status CHECK (status IN ('CONFIRMED', 'REJECTED')),
  CONSTRAINT agora_sales_variant_mappings_identity UNIQUE (
    connection_id,
    provider_product_id,
    sale_format_id
  )
);

CREATE INDEX agora_sales_variant_mappings_sale_format_lookup
  ON public.agora_sales_variant_mappings (connection_id, sale_format_id)
  WHERE status = 'CONFIRMED';

ALTER TABLE public.agora_sales_variant_mappings ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE ON TABLE public.agora_sales_variant_mappings TO middleware_runtime;

CREATE POLICY middleware_runtime_agora_sales_variant_select
  ON public.agora_sales_variant_mappings
  FOR SELECT
  TO middleware_runtime
  USING (public.runtime_full_catalog_scope(connection_id));

CREATE POLICY middleware_runtime_agora_sales_variant_insert
  ON public.agora_sales_variant_mappings
  FOR INSERT
  TO middleware_runtime
  WITH CHECK (
    public.runtime_full_catalog_scope(connection_id)
    AND status = 'CONFIRMED'
    AND EXISTS (
      SELECT 1
      FROM public.winerim_wines wine
      WHERE wine.connection_id = agora_sales_variant_mappings.connection_id
        AND wine.winerim_id = agora_sales_variant_mappings.winerim_wine_id
    )
  );

CREATE POLICY middleware_runtime_agora_sales_variant_update
  ON public.agora_sales_variant_mappings
  FOR UPDATE
  TO middleware_runtime
  USING (public.runtime_full_catalog_scope(connection_id))
  WITH CHECK (
    public.runtime_full_catalog_scope(connection_id)
    AND status IN ('CONFIRMED', 'REJECTED')
    AND EXISTS (
      SELECT 1
      FROM public.winerim_wines wine
      WHERE wine.connection_id = agora_sales_variant_mappings.connection_id
        AND wine.winerim_id = agora_sales_variant_mappings.winerim_wine_id
    )
  );

CREATE TRIGGER update_agora_sales_variant_mappings_updated_at
  BEFORE UPDATE ON public.agora_sales_variant_mappings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

COMMENT ON TABLE public.agora_sales_variant_mappings IS
  'Exact Agora native ProductId + SaleFormatId identities. Flat product_mappings must not represent this pair because SaleFormatId may collide with another ProductId.';

COMMIT;
