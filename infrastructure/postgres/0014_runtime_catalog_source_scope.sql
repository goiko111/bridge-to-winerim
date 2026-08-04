\set ON_ERROR_STOP on

BEGIN;

DO $runtime_catalog_source_scope_preflight$
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

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'runtime_canary_connections'
      AND column_name = 'run_id'
  ) THEN
    RAISE EXCEPTION 'migration 0013 is required before migration 0014';
  END IF;

  FOREACH target_table IN ARRAY ARRAY[
    'runtime_canary_connections',
    'winerim_wines',
    'product_mappings'
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
$runtime_catalog_source_scope_preflight$;

CREATE TABLE public.runtime_catalog_source_scope (
  connection_id uuid NOT NULL,
  run_id text NOT NULL,
  winerim_wine_id text NOT NULL,
  format text NOT NULL,
  agora_product_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT runtime_catalog_source_scope_pkey
    PRIMARY KEY (connection_id, run_id),
  CONSTRAINT runtime_catalog_source_scope_run_id_key
    UNIQUE (run_id),
  CONSTRAINT runtime_catalog_source_scope_wine_id_format
    CHECK (winerim_wine_id ~ '^[1-9][0-9]{0,17}$'),
  CONSTRAINT runtime_catalog_source_scope_format_check
    CHECK (format IN ('BOTTLE', 'GLASS', 'MAGNUM')),
  CONSTRAINT runtime_catalog_source_scope_product_id_format
    CHECK (agora_product_id ~ '^[1-9][0-9]{0,17}$'),
  CONSTRAINT runtime_catalog_source_scope_run_fkey
    FOREIGN KEY (connection_id, run_id)
    REFERENCES public.runtime_canary_connections(connection_id, run_id)
    ON DELETE RESTRICT,
  CONSTRAINT runtime_catalog_source_scope_wine_fkey
    FOREIGN KEY (connection_id, winerim_wine_id)
    REFERENCES public.winerim_wines(connection_id, winerim_id)
    ON DELETE RESTRICT,
  CONSTRAINT runtime_catalog_source_scope_product_fkey
    FOREIGN KEY (connection_id, agora_product_id)
    REFERENCES public.product_mappings(connection_id, provider_product_id)
    ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION public.validate_runtime_catalog_source_scope()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
DECLARE
  canary_status text;
  canary_active boolean;
  mapped_wine_id text;
  mapped_format text;
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.connection_id IS DISTINCT FROM OLD.connection_id
    OR NEW.run_id IS DISTINCT FROM OLD.run_id
    OR NEW.winerim_wine_id IS DISTINCT FROM OLD.winerim_wine_id
    OR NEW.format IS DISTINCT FROM OLD.format
    OR NEW.agora_product_id IS DISTINCT FROM OLD.agora_product_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  ) THEN
    RAISE EXCEPTION 'RUNTIME_CATALOG_SOURCE_SCOPE_IMMUTABLE';
  END IF;

  SELECT scope.status, scope.active
  INTO canary_status, canary_active
  FROM public.runtime_canary_connections scope
  WHERE scope.connection_id = NEW.connection_id
    AND scope.run_id = NEW.run_id;

  IF canary_status IS DISTINCT FROM 'PREPARED' OR canary_active IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'RUNTIME_CATALOG_SOURCE_SCOPE_REQUIRES_PREPARED_RUN';
  END IF;

  SELECT mapping.winerim_wine_id, upper(mapping.format_type)
  INTO mapped_wine_id, mapped_format
  FROM public.product_mappings mapping
  WHERE mapping.connection_id = NEW.connection_id
    AND mapping.provider_product_id = NEW.agora_product_id;

  IF mapped_wine_id IS DISTINCT FROM NEW.winerim_wine_id
    OR mapped_format IS DISTINCT FROM NEW.format THEN
    RAISE EXCEPTION 'RUNTIME_CATALOG_SOURCE_TARGET_MISMATCH';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.validate_runtime_catalog_source_scope() FROM PUBLIC;

CREATE TRIGGER validate_runtime_catalog_source_scope
  BEFORE INSERT OR UPDATE ON public.runtime_catalog_source_scope
  FOR EACH ROW EXECUTE FUNCTION public.validate_runtime_catalog_source_scope();

CREATE OR REPLACE FUNCTION public.enforce_runtime_catalog_wine_refresh_scope()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
DECLARE
  target_format text;
BEGIN
  IF NOT pg_has_role(current_user, 'middleware_runtime', 'MEMBER') THEN
    RETURN NEW;
  END IF;

  SELECT target.format
  INTO target_format
  FROM public.runtime_catalog_source_scope target
  JOIN public.runtime_canary_connections scope
    ON scope.connection_id = target.connection_id
   AND scope.run_id = target.run_id
  WHERE target.connection_id = OLD.connection_id
    AND target.winerim_wine_id = OLD.winerim_id
    AND scope.status = 'ACTIVE'
    AND scope.active = true
    AND scope.approved_at <= now()
    AND scope.expires_at > now();

  IF target_format IS NULL THEN
    RAISE EXCEPTION 'RUNTIME_CATALOG_SOURCE_SCOPE_REJECTED';
  END IF;

  IF target_format <> 'BOTTLE' AND (
    NEW.price IS DISTINCT FROM OLD.price
    OR NEW.bottle_sale_price IS DISTINCT FROM OLD.bottle_sale_price
    OR NEW.bottle_purchase_price IS DISTINCT FROM OLD.bottle_purchase_price
  ) THEN
    RAISE EXCEPTION 'RUNTIME_CATALOG_SOURCE_FORMAT_SCOPE_REJECTED';
  END IF;

  IF target_format <> 'GLASS' AND (
    NEW.glass_sale_price IS DISTINCT FROM OLD.glass_sale_price
    OR NEW.glass_cost_price IS DISTINCT FROM OLD.glass_cost_price
    OR NEW.serve_by_glass IS DISTINCT FROM OLD.serve_by_glass
  ) THEN
    RAISE EXCEPTION 'RUNTIME_CATALOG_SOURCE_FORMAT_SCOPE_REJECTED';
  END IF;

  IF target_format <> 'MAGNUM' AND (
    NEW.magnum_sale_price IS DISTINCT FROM OLD.magnum_sale_price
    OR NEW.magnum_purchase_price IS DISTINCT FROM OLD.magnum_purchase_price
  ) THEN
    RAISE EXCEPTION 'RUNTIME_CATALOG_SOURCE_FORMAT_SCOPE_REJECTED';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.enforce_runtime_catalog_wine_refresh_scope() FROM PUBLIC;

CREATE TRIGGER enforce_runtime_catalog_wine_refresh_scope
  BEFORE UPDATE OF
    name,
    vintage,
    wine_type,
    is_active,
    price,
    bottle_sale_price,
    bottle_purchase_price,
    glass_sale_price,
    glass_cost_price,
    serve_by_glass,
    magnum_sale_price,
    magnum_purchase_price
  ON public.winerim_wines
  FOR EACH ROW EXECUTE FUNCTION public.enforce_runtime_catalog_wine_refresh_scope();

ALTER TABLE public.runtime_catalog_source_scope ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.runtime_catalog_source_scope
  FROM PUBLIC, anon, authenticated, service_role,
    middleware_api, middleware_readonly, middleware_runtime;
GRANT SELECT ON public.runtime_catalog_source_scope TO middleware_runtime;

CREATE POLICY middleware_runtime_catalog_source_scope_select
  ON public.runtime_catalog_source_scope
  FOR SELECT TO middleware_runtime
  USING (EXISTS (
    SELECT 1
    FROM public.runtime_canary_connections scope
    WHERE scope.connection_id = runtime_catalog_source_scope.connection_id
      AND scope.run_id = runtime_catalog_source_scope.run_id
      AND scope.status = 'ACTIVE'
      AND scope.active = true
      AND scope.approved_at <= now()
      AND scope.expires_at > now()
  ));

REVOKE UPDATE ON public.winerim_wines FROM middleware_runtime;
GRANT UPDATE (
  name,
  vintage,
  wine_type,
  is_active,
  price,
  bottle_sale_price,
  bottle_purchase_price,
  glass_sale_price,
  glass_cost_price,
  serve_by_glass,
  magnum_sale_price,
  magnum_purchase_price
) ON public.winerim_wines TO middleware_runtime;

CREATE POLICY middleware_runtime_catalog_source_update
  ON public.winerim_wines
  FOR UPDATE TO middleware_runtime
  USING (EXISTS (
    SELECT 1
    FROM public.runtime_catalog_source_scope target
    JOIN public.runtime_canary_connections scope
      ON scope.connection_id = target.connection_id
     AND scope.run_id = target.run_id
    WHERE target.connection_id = winerim_wines.connection_id
      AND target.winerim_wine_id = winerim_wines.winerim_id
      AND scope.status = 'ACTIVE'
      AND scope.active = true
      AND scope.approved_at <= now()
      AND scope.expires_at > now()
  ))
  WITH CHECK (EXISTS (
    SELECT 1
    FROM public.runtime_catalog_source_scope target
    JOIN public.runtime_canary_connections scope
      ON scope.connection_id = target.connection_id
     AND scope.run_id = target.run_id
    WHERE target.connection_id = winerim_wines.connection_id
      AND target.winerim_wine_id = winerim_wines.winerim_id
      AND scope.status = 'ACTIVE'
      AND scope.active = true
      AND scope.approved_at <= now()
      AND scope.expires_at > now()
  ));

COMMENT ON TABLE public.runtime_catalog_source_scope IS
  'Admin-owned immutable exact target for one catalog canary run. Runtime can read only the active run and cannot provision or change scope rows.';
COMMENT ON FUNCTION public.enforce_runtime_catalog_wine_refresh_scope() IS
  'Rejects runtime refreshes outside the active connection, wine and format selected before canary activation.';

COMMIT;
