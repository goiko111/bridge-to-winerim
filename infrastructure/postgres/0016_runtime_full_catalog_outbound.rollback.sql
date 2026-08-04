\set ON_ERROR_STOP on

BEGIN;

DO $runtime_full_catalog_outbound_rollback_preflight$
DECLARE
  required_column text;
BEGIN
  IF current_user IN ('middleware_runtime', 'middleware_readonly', 'middleware_api', 'anon', 'authenticated', 'service_role')
    OR NOT EXISTS (
      SELECT 1
      FROM pg_roles owner_role
      WHERE owner_role.rolname = current_user
        AND (owner_role.rolsuper OR owner_role.rolbypassrls)
    )
  THEN
    RAISE EXCEPTION 'RUNTIME_FULL_CATALOG_ROLLBACK_PRIVILEGED_OWNER_REQUIRED';
  END IF;

  IF to_regclass('public.runtime_catalog_changes') IS NULL
    OR to_regprocedure('public.runtime_full_catalog_scope(uuid)') IS NULL
    OR to_regprocedure('public.validate_runtime_catalog_change_transition()') IS NULL
  THEN
    RAISE EXCEPTION 'RUNTIME_FULL_CATALOG_ROLLBACK_ARTIFACTS_REQUIRED';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_class table_class
    JOIN pg_namespace namespace ON namespace.oid = table_class.relnamespace
    JOIN pg_roles runtime_role ON runtime_role.rolname = 'middleware_runtime'
    WHERE namespace.nspname = 'public'
      AND table_class.relname = 'runtime_catalog_changes'
      AND table_class.relkind = 'r'
      AND table_class.relrowsecurity
      AND table_class.relforcerowsecurity
      AND table_class.relowner <> runtime_role.oid
  ) THEN
    RAISE EXCEPTION 'RUNTIME_FULL_CATALOG_ROLLBACK_TABLE_DRIFT';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger trigger_row
    WHERE trigger_row.tgrelid = 'public.runtime_catalog_changes'::regclass
      AND trigger_row.tgname = 'validate_runtime_catalog_change_transition'
      AND trigger_row.tgfoid = to_regprocedure('public.validate_runtime_catalog_change_transition()')
      AND trigger_row.tgtype = 23
      AND trigger_row.tgenabled IN ('O', 'A')
      AND NOT trigger_row.tgisinternal
  ) OR (
    SELECT count(*)
    FROM pg_trigger trigger_row
    WHERE trigger_row.tgrelid = 'public.runtime_catalog_changes'::regclass
      AND NOT trigger_row.tgisinternal
  ) <> 1 THEN
    RAISE EXCEPTION 'RUNTIME_FULL_CATALOG_ROLLBACK_TRIGGER_DRIFT';
  END IF;

  IF has_function_privilege('public', 'public.runtime_full_catalog_scope(uuid)', 'EXECUTE')
    OR has_function_privilege('public', 'public.validate_runtime_catalog_change_transition()', 'EXECUTE')
    OR position('full-lanes-v1' IN pg_get_functiondef('public.runtime_full_catalog_scope(uuid)'::regprocedure)) = 0
    OR position('RUNTIME_CATALOG_CHANGE_INITIAL_STATE_REJECTED' IN pg_get_functiondef('public.validate_runtime_catalog_change_transition()'::regprocedure)) = 0
  THEN
    RAISE EXCEPTION 'RUNTIME_FULL_CATALOG_ROLLBACK_FUNCTION_DRIFT';
  END IF;

  IF (
    SELECT count(*)
    FROM pg_policy policy
    WHERE policy.polrelid = 'public.runtime_catalog_changes'::regclass
      AND policy.polname IN (
        'middleware_runtime_full_catalog_changes',
        'middleware_readonly_catalog_changes'
      )
  ) <> 2 OR (
    SELECT count(*)
    FROM pg_policy policy
    WHERE policy.polrelid = 'public.runtime_catalog_changes'::regclass
  ) <> 2 THEN
    RAISE EXCEPTION 'RUNTIME_FULL_CATALOG_ROLLBACK_QUEUE_POLICY_DRIFT';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies policy
    WHERE policy.schemaname = 'public'
      AND policy.tablename = 'winerim_push_tracking'
      AND policy.policyname = 'middleware_runtime_canary_update_tracking'
      AND policy.cmd = 'UPDATE'
      AND policy.with_check LIKE '%NOT_PUSHED%'
      AND policy.with_check LIKE '%PUSHED%'
      AND policy.with_check NOT LIKE '%VERIFIED%'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_policies policy
    WHERE policy.schemaname = 'public'
      AND policy.tablename = 'winerim_push_tracking'
      AND policy.policyname = 'middleware_runtime_full_catalog_tracking_certified_insert'
      AND policy.cmd = 'INSERT'
      AND policy.with_check LIKE '%HIDDEN%'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_policies policy
    WHERE policy.schemaname = 'public'
      AND policy.tablename = 'winerim_push_tracking'
      AND policy.policyname = 'middleware_runtime_full_catalog_tracking_certified_update'
      AND policy.cmd = 'UPDATE'
      AND policy.with_check LIKE '%HIDDEN%'
  ) THEN
    RAISE EXCEPTION 'RUNTIME_FULL_CATALOG_ROLLBACK_TRACKING_POLICY_DRIFT';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_policy policy
    WHERE policy.polrelid = 'public.product_mappings'::regclass
      AND policy.polname IN (
        'middleware_runtime_canary_insert_product_mappings',
        'middleware_runtime_canary_update_product_mappings'
      )
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_policies policy
    WHERE policy.schemaname = 'public'
      AND policy.tablename = 'product_mappings'
      AND policy.policyname = 'middleware_runtime_full_catalog_mapping_exact_insert'
      AND policy.cmd = 'INSERT'
      AND policy.with_check LIKE '%RESCUE_EXACT_ID_WINE_VARIANT%'
      AND policy.with_check LIKE '%RESCUE_EXACT_ID_WINE_VARIANT_SALES_ONLY%'
      AND policy.with_check LIKE '%EXACT_PROVIDER_READBACK%'
      AND policy.with_check LIKE '%CONFIRMED%'
      AND policy.with_check NOT LIKE '%PENDING%'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_policies policy
    WHERE policy.schemaname = 'public'
      AND policy.tablename = 'product_mappings'
      AND policy.policyname = 'middleware_runtime_full_catalog_mapping_exact_update'
      AND policy.cmd = 'UPDATE'
      AND policy.with_check LIKE '%RESCUE_EXACT_ID_WINE_VARIANT%'
      AND policy.with_check LIKE '%RESCUE_EXACT_ID_WINE_VARIANT_SALES_ONLY%'
      AND policy.with_check LIKE '%EXACT_PROVIDER_READBACK%'
      AND policy.with_check LIKE '%CONFIRMED%'
      AND policy.with_check NOT LIKE '%PENDING%'
  ) THEN
    RAISE EXCEPTION 'RUNTIME_FULL_CATALOG_ROLLBACK_MAPPING_POLICY_DRIFT';
  END IF;

  IF (
    SELECT count(*)
    FROM pg_policy policy
    WHERE policy.polrelid = 'public.winerim_wines'::regclass
      AND policy.polname IN (
        'middleware_runtime_full_catalog_wines_select',
        'middleware_runtime_full_catalog_wines_insert',
        'middleware_runtime_full_catalog_wines_update'
      )
  ) <> 3 OR position(
    'runtime_full_catalog_scope'
    IN pg_get_functiondef('public.enforce_runtime_catalog_wine_refresh_scope()'::regprocedure)
  ) = 0 THEN
    RAISE EXCEPTION 'RUNTIME_FULL_CATALOG_ROLLBACK_WINE_POLICY_DRIFT';
  END IF;

  IF NOT has_table_privilege('middleware_runtime', 'public.winerim_wines', 'SELECT')
    OR has_table_privilege('middleware_runtime', 'public.winerim_wines', 'INSERT')
    OR has_table_privilege('middleware_runtime', 'public.winerim_wines', 'UPDATE')
    OR has_table_privilege('middleware_runtime', 'public.winerim_wines', 'DELETE')
  THEN
    RAISE EXCEPTION 'RUNTIME_FULL_CATALOG_ROLLBACK_WINE_ACL_DRIFT';
  END IF;

  FOREACH required_column IN ARRAY ARRAY[
    'connection_id', 'winerim_id', 'name', 'vintage', 'wine_type', 'is_active',
    'price', 'bottle_sale_price', 'bottle_purchase_price',
    'glass_sale_price', 'glass_cost_price', 'magnum_sale_price', 'magnum_purchase_price',
    'serve_by_glass', 'pricing_status', 'pricing_missing_reason', 'raw_payload'
  ] LOOP
    IF NOT has_column_privilege('middleware_runtime', 'public.winerim_wines', required_column, 'INSERT') THEN
      RAISE EXCEPTION 'RUNTIME_FULL_CATALOG_ROLLBACK_WINE_INSERT_ACL_DRIFT: %', required_column;
    END IF;
  END LOOP;

  FOREACH required_column IN ARRAY ARRAY[
    'name', 'vintage', 'wine_type', 'is_active',
    'price', 'bottle_sale_price', 'bottle_purchase_price',
    'glass_sale_price', 'glass_cost_price', 'magnum_sale_price', 'magnum_purchase_price',
    'serve_by_glass', 'pricing_status', 'pricing_missing_reason', 'raw_payload', 'updated_at'
  ] LOOP
    IF NOT has_column_privilege('middleware_runtime', 'public.winerim_wines', required_column, 'UPDATE') THEN
      RAISE EXCEPTION 'RUNTIME_FULL_CATALOG_ROLLBACK_WINE_UPDATE_ACL_DRIFT: %', required_column;
    END IF;
  END LOOP;
END
$runtime_full_catalog_outbound_rollback_preflight$;

DROP POLICY middleware_runtime_full_catalog_mapping_exact_insert
  ON public.product_mappings;
DROP POLICY middleware_runtime_full_catalog_mapping_exact_update
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

DROP POLICY middleware_runtime_full_catalog_tracking_certified_insert
  ON public.winerim_push_tracking;
DROP POLICY middleware_runtime_full_catalog_tracking_certified_update
  ON public.winerim_push_tracking;
DROP POLICY middleware_runtime_canary_update_tracking
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

DROP POLICY middleware_runtime_full_catalog_wines_select ON public.winerim_wines;
DROP POLICY middleware_runtime_full_catalog_wines_insert ON public.winerim_wines;
DROP POLICY middleware_runtime_full_catalog_wines_update ON public.winerim_wines;

REVOKE ALL ON public.winerim_wines FROM middleware_runtime;
GRANT SELECT ON public.winerim_wines TO middleware_runtime;
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
COMMENT ON FUNCTION public.enforce_runtime_catalog_wine_refresh_scope() IS
  'Rejects runtime refreshes outside the active connection, wine and format selected before canary activation.';

DROP TABLE public.runtime_catalog_changes;
DROP FUNCTION public.validate_runtime_catalog_change_transition();
DROP FUNCTION public.runtime_full_catalog_scope(uuid);

COMMIT;
