\set ON_ERROR_STOP on

BEGIN;

DO $rollback_guard$
DECLARE
  environment_value text;
BEGIN
  SELECT value INTO environment_value
  FROM public.infrastructure_metadata
  WHERE key = 'environment';
  IF environment_value IS DISTINCT FROM 'staging' THEN
    RAISE EXCEPTION 'fleet scope rollback target is not staging';
  END IF;
  IF EXISTS (SELECT 1 FROM public.runtime_connection_credentials)
    OR EXISTS (SELECT 1 FROM public.runtime_canary_connections) THEN
    RAISE EXCEPTION 'fleet scope rollback requires empty control tables';
  END IF;
END
$rollback_guard$;

DROP TRIGGER IF EXISTS validate_runtime_fleet_credential_transition
  ON public.runtime_connection_credentials;
DROP TRIGGER IF EXISTS validate_runtime_fleet_scope_transition
  ON public.runtime_canary_connections;
DROP FUNCTION IF EXISTS public.validate_runtime_fleet_credential_transition();
DROP FUNCTION IF EXISTS public.validate_runtime_fleet_scope_transition();
DROP FUNCTION IF EXISTS public.assert_runtime_fleet_connection_scope_generation(uuid, text);

DROP INDEX IF EXISTS public.runtime_connection_credentials_scope_idx;
DROP INDEX IF EXISTS public.runtime_canary_connections_one_active_per_connection_idx;
CREATE UNIQUE INDEX runtime_canary_connections_single_active_idx
  ON public.runtime_canary_connections(active)
  WHERE active = true;

COMMENT ON TABLE public.runtime_canary_connections IS
  'Admin-owned, approved and expiring single-connection allowlist for the staging runtime canary. Zero active rows is fail-closed; at most one valid active row is allowed.';

COMMIT;
