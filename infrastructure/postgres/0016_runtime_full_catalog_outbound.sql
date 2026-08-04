\set ON_ERROR_STOP on

BEGIN;

CREATE OR REPLACE FUNCTION public.runtime_full_catalog_scope(target_connection_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.runtime_canary_connections scope
    JOIN public.pos_connections connection ON connection.id = scope.connection_id
    WHERE scope.connection_id = target_connection_id
      AND scope.status = 'ACTIVE'
      AND scope.active = true
      AND scope.approved_at <= now()
      AND scope.expires_at > now()
      AND connection.enabled = true
      AND connection.provider = 'agora'
      AND connection.catalog_sync_enabled = true
      AND upper(connection.sync_mode) = 'BIDIRECTIONAL'
      AND upper(connection.write_mode) = 'XML_IMPORT'
      AND connection.provider_config ->> 'runtime_fleet_profile' = 'full-lanes-v1'
      AND connection.provider_config -> 'runtime_fleet_job_allowlist' =
        '["sales.auto-sync","sales.sync-intraday","catalog.fetch-winerim","catalog.sync-master","outbound.process"]'::jsonb
      AND connection.provider_config -> 'runtime_sales_job_allowlist' =
        '["sales.auto-sync","sales.sync-intraday"]'::jsonb
      AND connection.provider_config ->> 'intraday_sales_sync_enabled' = 'true'
      AND connection.provider_config ->> 'open_tickets_sync_enabled' = 'false'
      AND connection.provider_config ->> 'open_tickets_stock_sync_enabled' = 'false'
      AND connection.provider_config ->> 'runtime_catalog_enabled' = 'true'
      AND connection.provider_config ->> 'runtime_stock_enabled' = 'true'
      AND connection.provider_config ->> 'runtime_outbound_enabled' = 'true'
      AND connection.provider_config ->> 'runtime_maintenance_enabled' = 'false'
  )
$function$;

REVOKE ALL ON FUNCTION public.runtime_full_catalog_scope(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.runtime_full_catalog_scope(uuid) TO middleware_runtime;

DO $runtime_full_catalog_scope_owner$
BEGIN
  IF current_user IN ('middleware_runtime', 'middleware_readonly', 'middleware_api', 'anon', 'authenticated', 'service_role')
    OR NOT EXISTS (
      SELECT 1
      FROM pg_roles owner_role
      WHERE owner_role.rolname = current_user
        AND (owner_role.rolsuper OR owner_role.rolbypassrls)
    )
  THEN
    RAISE EXCEPTION 'RUNTIME_FULL_CATALOG_SCOPE_PRIVILEGED_OWNER_REQUIRED';
  END IF;
END;
$runtime_full_catalog_scope_owner$;

CREATE TABLE public.runtime_catalog_changes (
  connection_id uuid NOT NULL REFERENCES public.pos_connections(id) ON DELETE RESTRICT,
  winerim_wine_id text NOT NULL,
  format text NOT NULL,
  source_fingerprint text NOT NULL,
  source_message_id text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING',
  attempt integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  completed_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT runtime_catalog_changes_pkey PRIMARY KEY (connection_id, winerim_wine_id, format),
  CONSTRAINT runtime_catalog_changes_wine_fkey FOREIGN KEY (connection_id, winerim_wine_id)
    REFERENCES public.winerim_wines(connection_id, winerim_id) ON DELETE RESTRICT,
  CONSTRAINT runtime_catalog_changes_format_check CHECK (format IN ('BOTTLE', 'GLASS', 'MAGNUM')),
  CONSTRAINT runtime_catalog_changes_fingerprint_check CHECK (source_fingerprint ~ '^[a-f0-9]{64}$'),
  CONSTRAINT runtime_catalog_changes_status_check CHECK (status IN ('PENDING', 'RUNNING', 'SUCCESS', 'BLOCKED')),
  CONSTRAINT runtime_catalog_changes_attempt_check CHECK (attempt BETWEEN 0 AND 20),
  CONSTRAINT runtime_catalog_changes_lifecycle_check CHECK (
    (status = 'PENDING' AND claimed_at IS NULL AND completed_at IS NULL)
    OR (status = 'RUNNING' AND claimed_at IS NOT NULL AND completed_at IS NULL)
    OR (status IN ('SUCCESS', 'BLOCKED') AND claimed_at IS NOT NULL AND completed_at IS NOT NULL)
  )
);

CREATE INDEX runtime_catalog_changes_pending_idx
  ON public.runtime_catalog_changes(connection_id, available_at, updated_at)
  WHERE status = 'PENDING';

ALTER TABLE public.runtime_catalog_changes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.runtime_catalog_changes FROM PUBLIC, anon, authenticated, service_role,
  middleware_api, middleware_readonly, middleware_runtime;
GRANT SELECT, INSERT, UPDATE ON public.runtime_catalog_changes TO middleware_runtime;
GRANT SELECT ON public.runtime_catalog_changes TO middleware_readonly;

CREATE POLICY middleware_runtime_full_catalog_changes
  ON public.runtime_catalog_changes FOR ALL TO middleware_runtime
  USING (public.runtime_full_catalog_scope(connection_id))
  WITH CHECK (public.runtime_full_catalog_scope(connection_id));

CREATE POLICY middleware_readonly_catalog_changes
  ON public.runtime_catalog_changes FOR SELECT TO middleware_readonly
  USING (true);

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

  IF TG_OP = 'UPDATE' AND (
    NEW.connection_id IS DISTINCT FROM OLD.connection_id
    OR NEW.winerim_id IS DISTINCT FROM OLD.winerim_id
    OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  ) THEN
    RAISE EXCEPTION 'RUNTIME_CATALOG_WINE_IDENTITY_IMMUTABLE';
  END IF;

  IF public.runtime_full_catalog_scope(NEW.connection_id) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    RAISE EXCEPTION 'RUNTIME_CATALOG_SOURCE_INSERT_SCOPE_REJECTED';
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

REVOKE ALL ON public.winerim_wines FROM middleware_runtime;
GRANT SELECT ON public.winerim_wines TO middleware_runtime;
GRANT INSERT (
  connection_id, winerim_id, name, vintage, wine_type, is_active,
  price, bottle_sale_price, bottle_purchase_price,
  glass_sale_price, glass_cost_price, magnum_sale_price, magnum_purchase_price,
  serve_by_glass, pricing_status, pricing_missing_reason, raw_payload
) ON public.winerim_wines TO middleware_runtime;
GRANT UPDATE (
  name, vintage, wine_type, is_active,
  price, bottle_sale_price, bottle_purchase_price,
  glass_sale_price, glass_cost_price, magnum_sale_price, magnum_purchase_price,
  serve_by_glass, pricing_status, pricing_missing_reason, raw_payload, updated_at
) ON public.winerim_wines TO middleware_runtime;

CREATE POLICY middleware_runtime_full_catalog_wines_select
  ON public.winerim_wines FOR SELECT TO middleware_runtime
  USING (public.runtime_full_catalog_scope(connection_id));
CREATE POLICY middleware_runtime_full_catalog_wines_insert
  ON public.winerim_wines FOR INSERT TO middleware_runtime
  WITH CHECK (public.runtime_full_catalog_scope(connection_id));
CREATE POLICY middleware_runtime_full_catalog_wines_update
  ON public.winerim_wines FOR UPDATE TO middleware_runtime
  USING (public.runtime_full_catalog_scope(connection_id))
  WITH CHECK (public.runtime_full_catalog_scope(connection_id));

COMMENT ON TABLE public.runtime_catalog_changes IS
  'Differential per-variant catalog queue. A full fleet refresh updates this table; one-product Agora mutations consume it with exact readback.';
COMMENT ON FUNCTION public.runtime_full_catalog_scope(uuid) IS
  'Fail-closed full-lanes fleet policy gate shared by catalog source and pending-change RLS.';

COMMIT;
