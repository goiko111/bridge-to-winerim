\set ON_ERROR_STOP on

BEGIN;

DO $runtime_full_catalog_outbound_preflight$
DECLARE
  target_table text;
  rls_enabled boolean;
  runtime_owns_table boolean;
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

  IF NOT EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname = 'middleware_runtime'
      AND rolcanlogin = false
      AND rolsuper = false
      AND rolbypassrls = false
  ) THEN
    RAISE EXCEPTION 'RUNTIME_FULL_CATALOG_MIDDLEWARE_ROLE_NOT_HARDENED';
  END IF;

  IF to_regclass('public.runtime_catalog_changes') IS NOT NULL
    OR to_regprocedure('public.runtime_full_catalog_scope(uuid)') IS NOT NULL
  THEN
    RAISE EXCEPTION 'RUNTIME_FULL_CATALOG_OUTBOUND_ALREADY_APPLIED';
  END IF;

  FOREACH target_table IN ARRAY ARRAY[
    'pos_connections',
    'runtime_canary_connections',
    'runtime_catalog_source_scope',
    'winerim_wines',
    'product_mappings',
    'winerim_push_tracking'
  ]
  LOOP
    SELECT
      table_class.relrowsecurity,
      table_class.relowner = runtime_role.oid
    INTO rls_enabled, runtime_owns_table
    FROM pg_class table_class
    JOIN pg_namespace namespace ON namespace.oid = table_class.relnamespace
    JOIN pg_roles runtime_role ON runtime_role.rolname = 'middleware_runtime'
    WHERE namespace.nspname = 'public'
      AND table_class.relname = target_table
      AND table_class.relkind = 'r';

    IF rls_enabled IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'RUNTIME_FULL_CATALOG_DEPENDENCY_RLS_REQUIRED: public.%', target_table;
    END IF;

    IF runtime_owns_table IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'RUNTIME_FULL_CATALOG_DEPENDENCY_RUNTIME_OWNER_REJECTED: public.%', target_table;
    END IF;
  END LOOP;

  IF to_regprocedure('public.enforce_runtime_catalog_wine_refresh_scope()') IS NULL
    OR to_regprocedure('public.validate_runtime_catalog_source_scope()') IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM pg_trigger trigger_row
      JOIN pg_class table_class ON table_class.oid = trigger_row.tgrelid
      JOIN pg_namespace namespace ON namespace.oid = table_class.relnamespace
      WHERE namespace.nspname = 'public'
        AND table_class.relname = 'winerim_wines'
        AND trigger_row.tgname = 'enforce_runtime_catalog_wine_refresh_scope'
        AND trigger_row.tgfoid = to_regprocedure('public.enforce_runtime_catalog_wine_refresh_scope()')
        AND trigger_row.tgtype = 19
        AND trigger_row.tgenabled IN ('O', 'A')
        AND NOT trigger_row.tgisinternal
    )
    OR NOT EXISTS (
      SELECT 1
      FROM pg_trigger trigger_row
      JOIN pg_class table_class ON table_class.oid = trigger_row.tgrelid
      JOIN pg_namespace namespace ON namespace.oid = table_class.relnamespace
      WHERE namespace.nspname = 'public'
        AND table_class.relname = 'runtime_catalog_source_scope'
        AND trigger_row.tgname = 'validate_runtime_catalog_source_scope'
        AND trigger_row.tgfoid = to_regprocedure('public.validate_runtime_catalog_source_scope()')
        AND trigger_row.tgtype = 23
        AND trigger_row.tgenabled IN ('O', 'A')
        AND NOT trigger_row.tgisinternal
    )
  THEN
    RAISE EXCEPTION 'RUNTIME_FULL_CATALOG_MIGRATION_0014_REQUIRED';
  END IF;

  IF NOT has_table_privilege('middleware_runtime', 'public.runtime_catalog_source_scope', 'SELECT')
    OR has_table_privilege('middleware_runtime', 'public.runtime_catalog_source_scope', 'INSERT')
    OR has_table_privilege('middleware_runtime', 'public.runtime_catalog_source_scope', 'UPDATE')
    OR has_function_privilege('public', 'public.enforce_runtime_catalog_wine_refresh_scope()', 'EXECUTE')
    OR has_function_privilege('public', 'public.validate_runtime_catalog_source_scope()', 'EXECUTE')
  THEN
    RAISE EXCEPTION 'RUNTIME_FULL_CATALOG_MIGRATION_0014_ACL_REQUIRED';
  END IF;
END
$runtime_full_catalog_outbound_preflight$;

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
  lease_expires_at timestamptz,
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
  CONSTRAINT runtime_catalog_changes_error_check CHECK (
    last_error IS NULL OR last_error ~ '^[A-Z][A-Z0-9_]{0,79}$'
  ),
  CONSTRAINT runtime_catalog_changes_lifecycle_check CHECK (
    (status = 'PENDING' AND claimed_at IS NULL AND lease_expires_at IS NULL AND completed_at IS NULL)
    OR (
      status = 'RUNNING'
      AND attempt BETWEEN 1 AND 20
      AND claimed_at IS NOT NULL
      AND lease_expires_at = claimed_at + interval '120 seconds'
      AND completed_at IS NULL
      AND last_error IS NULL
    )
    OR (
      status = 'SUCCESS'
      AND attempt BETWEEN 1 AND 20
      AND claimed_at IS NOT NULL
      AND lease_expires_at IS NULL
      AND completed_at >= claimed_at
      AND last_error IS NULL
    )
    OR (
      status = 'BLOCKED'
      AND attempt BETWEEN 1 AND 20
      AND claimed_at IS NOT NULL
      AND lease_expires_at IS NULL
      AND completed_at >= claimed_at
      AND last_error IS NOT NULL
    )
  )
);

CREATE OR REPLACE FUNCTION public.validate_runtime_catalog_change_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'PENDING'
      OR NEW.attempt <> 0
      OR NEW.claimed_at IS NOT NULL
      OR NEW.lease_expires_at IS NOT NULL
      OR NEW.completed_at IS NOT NULL
      OR NEW.last_error IS NOT NULL
    THEN
      RAISE EXCEPTION 'RUNTIME_CATALOG_CHANGE_INITIAL_STATE_REJECTED';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.connection_id IS DISTINCT FROM OLD.connection_id
    OR NEW.winerim_wine_id IS DISTINCT FROM OLD.winerim_wine_id
    OR NEW.format IS DISTINCT FROM OLD.format
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'RUNTIME_CATALOG_CHANGE_IDENTITY_IMMUTABLE';
  END IF;

  IF NEW.status = 'PENDING' THEN
    IF NEW.claimed_at IS NOT NULL
      OR NEW.lease_expires_at IS NOT NULL
      OR NEW.completed_at IS NOT NULL
      OR (
        NEW.source_fingerprint IS DISTINCT FROM OLD.source_fingerprint
        AND NEW.attempt <> 0
      )
      OR (
        NEW.source_fingerprint IS NOT DISTINCT FROM OLD.source_fingerprint
        AND NEW.attempt <> OLD.attempt
      )
      OR (
        OLD.status IN ('SUCCESS', 'BLOCKED')
        AND NEW.source_fingerprint IS NOT DISTINCT FROM OLD.source_fingerprint
      )
    THEN
      RAISE EXCEPTION 'RUNTIME_CATALOG_CHANGE_PENDING_TRANSITION_REJECTED';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status = 'RUNNING' THEN
    IF NEW.source_fingerprint IS DISTINCT FROM OLD.source_fingerprint
      OR NEW.attempt <> OLD.attempt + 1
      OR NEW.attempt > 20
      OR NEW.claimed_at IS DISTINCT FROM transaction_timestamp()
      OR NEW.lease_expires_at IS DISTINCT FROM NEW.claimed_at + interval '120 seconds'
      OR NEW.completed_at IS NOT NULL
      OR NEW.last_error IS NOT NULL
      OR NOT (
        (OLD.status = 'PENDING' AND OLD.available_at <= transaction_timestamp())
        OR (
          OLD.status = 'RUNNING'
          AND OLD.lease_expires_at <= transaction_timestamp()
        )
      )
    THEN
      RAISE EXCEPTION 'RUNTIME_CATALOG_CHANGE_CLAIM_TRANSITION_REJECTED';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status = 'SUCCESS' THEN
    IF OLD.status = 'SUCCESS' THEN
      IF NEW.source_fingerprint IS DISTINCT FROM OLD.source_fingerprint
        OR NEW.attempt <> OLD.attempt
        OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at
        OR NEW.lease_expires_at IS NOT NULL
        OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
        OR NEW.last_error IS NOT NULL
      THEN
        RAISE EXCEPTION 'RUNTIME_CATALOG_CHANGE_SUCCESS_REFRESH_REJECTED';
      END IF;
      RETURN NEW;
    END IF;

    IF OLD.status <> 'RUNNING'
      OR NEW.source_fingerprint IS DISTINCT FROM OLD.source_fingerprint
      OR NEW.attempt <> OLD.attempt
      OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at
      OR NEW.lease_expires_at IS NOT NULL
      OR NEW.completed_at IS DISTINCT FROM transaction_timestamp()
      OR NEW.last_error IS NOT NULL
    THEN
      RAISE EXCEPTION 'RUNTIME_CATALOG_CHANGE_SUCCESS_TRANSITION_REJECTED';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status = 'BLOCKED' THEN
    IF OLD.status = 'PENDING' THEN
      IF OLD.attempt <> 20
        OR OLD.available_at > transaction_timestamp()
        OR NEW.source_fingerprint IS DISTINCT FROM OLD.source_fingerprint
        OR NEW.attempt <> OLD.attempt
        OR NEW.claimed_at IS DISTINCT FROM transaction_timestamp()
        OR NEW.lease_expires_at IS NOT NULL
        OR NEW.completed_at IS DISTINCT FROM transaction_timestamp()
        OR NEW.last_error <> 'CATALOG_CHANGE_ATTEMPTS_EXHAUSTED'
      THEN
        RAISE EXCEPTION 'RUNTIME_CATALOG_CHANGE_EXHAUSTION_REJECTED';
      END IF;
      RETURN NEW;
    END IF;

    IF OLD.status <> 'RUNNING'
      OR NEW.source_fingerprint IS DISTINCT FROM OLD.source_fingerprint
      OR NEW.attempt <> OLD.attempt
      OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at
      OR NEW.lease_expires_at IS NOT NULL
      OR NEW.completed_at IS DISTINCT FROM transaction_timestamp()
      OR NEW.last_error IS NULL
    THEN
      RAISE EXCEPTION 'RUNTIME_CATALOG_CHANGE_BLOCKED_TRANSITION_REJECTED';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'RUNTIME_CATALOG_CHANGE_STATUS_REJECTED';
END;
$function$;

REVOKE ALL ON FUNCTION public.validate_runtime_catalog_change_transition() FROM PUBLIC;

CREATE TRIGGER validate_runtime_catalog_change_transition
  BEFORE INSERT OR UPDATE ON public.runtime_catalog_changes
  FOR EACH ROW EXECUTE FUNCTION public.validate_runtime_catalog_change_transition();

CREATE INDEX runtime_catalog_changes_pending_idx
  ON public.runtime_catalog_changes(connection_id, available_at, updated_at)
  WHERE status = 'PENDING';

CREATE INDEX runtime_catalog_changes_running_lease_idx
  ON public.runtime_catalog_changes(connection_id, lease_expires_at, updated_at)
  WHERE status = 'RUNNING';

ALTER TABLE public.runtime_catalog_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.runtime_catalog_changes FORCE ROW LEVEL SECURITY;
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

DROP POLICY middleware_runtime_canary_insert_product_mappings
  ON public.product_mappings;
DROP POLICY middleware_runtime_canary_update_product_mappings
  ON public.product_mappings;

CREATE POLICY middleware_runtime_full_catalog_mapping_exact_insert
  ON public.product_mappings FOR INSERT TO middleware_runtime
  WITH CHECK (
    public.runtime_full_catalog_scope(connection_id)
    AND status = 'CONFIRMED'
    AND match_method IN (
      'RESCUE_EXACT_ID_WINE_VARIANT',
      'RESCUE_EXACT_ID_WINE_VARIANT_SALES_ONLY'
    )
    AND match_score = 1
    AND cardinality(match_reasons) = 2
    AND match_reasons @> ARRAY['EXACT_PROVIDER_READBACK']::text[]
    AND (
      SELECT count(*)
      FROM unnest(match_reasons) reason
      WHERE reason LIKE 'plan:%' AND length(reason) > 5
    ) = 1
    AND format_type IN ('BOTTLE', 'GLASS', 'MAGNUM')
    AND winerim_wine_id IS NOT NULL
    AND agora_product_id = provider_product_id
    AND provider_product_id ~ '^[0-9]+$'
    AND last_synced_at IS NOT NULL
    AND last_sync_error IS NULL
    AND EXISTS (
      SELECT 1
      FROM public.winerim_wines wine
      WHERE wine.connection_id = product_mappings.connection_id
        AND wine.winerim_id = product_mappings.winerim_wine_id
    )
  );

CREATE POLICY middleware_runtime_full_catalog_mapping_exact_update
  ON public.product_mappings FOR UPDATE TO middleware_runtime
  USING (
    public.runtime_full_catalog_scope(connection_id)
    AND status IN ('PENDING', 'CONFIRMED')
  )
  WITH CHECK (
    public.runtime_full_catalog_scope(connection_id)
    AND status = 'CONFIRMED'
    AND match_method IN (
      'RESCUE_EXACT_ID_WINE_VARIANT',
      'RESCUE_EXACT_ID_WINE_VARIANT_SALES_ONLY'
    )
    AND match_score = 1
    AND cardinality(match_reasons) = 2
    AND match_reasons @> ARRAY['EXACT_PROVIDER_READBACK']::text[]
    AND (
      SELECT count(*)
      FROM unnest(match_reasons) reason
      WHERE reason LIKE 'plan:%' AND length(reason) > 5
    ) = 1
    AND format_type IN ('BOTTLE', 'GLASS', 'MAGNUM')
    AND winerim_wine_id IS NOT NULL
    AND agora_product_id = provider_product_id
    AND provider_product_id ~ '^[0-9]+$'
    AND last_synced_at IS NOT NULL
    AND last_sync_error IS NULL
    AND EXISTS (
      SELECT 1
      FROM public.winerim_wines wine
      WHERE wine.connection_id = product_mappings.connection_id
        AND wine.winerim_id = product_mappings.winerim_wine_id
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
        AND scope.status = 'ACTIVE'
        AND scope.active = true
        AND scope.approved_at <= now()
        AND scope.expires_at > now()
    )
  )
  WITH CHECK (
    source = 'WINERIM'
    AND agora_product_id ~ '^[0-9]+$'
    AND sync_status IN ('NOT_PUSHED', 'PUSHED')
  );

CREATE POLICY middleware_runtime_full_catalog_tracking_certified_insert
  ON public.winerim_push_tracking FOR INSERT TO middleware_runtime
  WITH CHECK (
    public.runtime_full_catalog_scope(connection_id)
    AND source = 'WINERIM'
    AND sync_status IN ('VERIFIED', 'HIDDEN')
    AND agora_product_id ~ '^[0-9]+$'
    AND format IN ('BOTTLE', 'GLASS', 'MAGNUM')
    AND last_error IS NULL
    AND pushed_at IS NOT NULL
    AND verified_at IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.product_mappings mapping
      WHERE mapping.connection_id = winerim_push_tracking.connection_id
        AND mapping.provider_product_id = winerim_push_tracking.agora_product_id
        AND mapping.winerim_wine_id = winerim_push_tracking.winerim_wine_id
        AND upper(mapping.format_type) = upper(winerim_push_tracking.format)
        AND mapping.status = 'CONFIRMED'
        AND mapping.match_method IN (
          'RESCUE_EXACT_ID_WINE_VARIANT',
          'RESCUE_EXACT_ID_WINE_VARIANT_SALES_ONLY'
        )
        AND mapping.match_score = 1
        AND cardinality(mapping.match_reasons) = 2
        AND mapping.match_reasons @> ARRAY['EXACT_PROVIDER_READBACK']::text[]
        AND (
          SELECT count(*)
          FROM unnest(mapping.match_reasons) reason
          WHERE reason LIKE 'plan:%' AND length(reason) > 5
        ) = 1
    )
  );

CREATE POLICY middleware_runtime_full_catalog_tracking_certified_update
  ON public.winerim_push_tracking FOR UPDATE TO middleware_runtime
  USING (
    public.runtime_full_catalog_scope(connection_id)
    AND source = 'WINERIM'
  )
  WITH CHECK (
    public.runtime_full_catalog_scope(connection_id)
    AND source = 'WINERIM'
    AND sync_status IN ('VERIFIED', 'HIDDEN')
    AND agora_product_id ~ '^[0-9]+$'
    AND format IN ('BOTTLE', 'GLASS', 'MAGNUM')
    AND last_error IS NULL
    AND pushed_at IS NOT NULL
    AND verified_at IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.product_mappings mapping
      WHERE mapping.connection_id = winerim_push_tracking.connection_id
        AND mapping.provider_product_id = winerim_push_tracking.agora_product_id
        AND mapping.winerim_wine_id = winerim_push_tracking.winerim_wine_id
        AND upper(mapping.format_type) = upper(winerim_push_tracking.format)
        AND mapping.status = 'CONFIRMED'
        AND mapping.match_method IN (
          'RESCUE_EXACT_ID_WINE_VARIANT',
          'RESCUE_EXACT_ID_WINE_VARIANT_SALES_ONLY'
        )
        AND mapping.match_score = 1
        AND cardinality(mapping.match_reasons) = 2
        AND mapping.match_reasons @> ARRAY['EXACT_PROVIDER_READBACK']::text[]
        AND (
          SELECT count(*)
          FROM unnest(mapping.match_reasons) reason
          WHERE reason LIKE 'plan:%' AND length(reason) > 5
        ) = 1
    )
  );

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
