BEGIN;

LOCK TABLE public.runtime_connection_credentials IN SHARE MODE;

DO $runtime_fleet_production_prerequisite$
DECLARE
  environment_value text;
BEGIN
  SELECT value INTO environment_value
  FROM public.infrastructure_metadata
  WHERE key = 'environment';

  IF environment_value NOT IN ('staging', 'rescue-production') THEN
    RAISE EXCEPTION 'runtime fleet prerequisite target is not staging or rescue-production';
  END IF;

  IF to_regclass('public.runtime_canary_connections_one_active_per_connection_idx') IS NULL
    OR to_regclass('public.runtime_canary_connections_single_active_idx') IS NOT NULL
  THEN
    RAISE EXCEPTION 'runtime fleet per-connection scope contract is missing';
  END IF;

  IF to_regclass('public.runtime_connection_credentials_scope_idx') IS NOT NULL
    OR to_regclass('public.agora_fleet_read_model') IS NOT NULL
    OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'middleware_fleet_reader')
  THEN
    RAISE EXCEPTION 'runtime fleet production prerequisite has drift';
  END IF;

  IF (
    SELECT count(*)
    FROM pg_proc procedure
    JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname = 'public'
      AND procedure.proname IN (
        'assert_runtime_fleet_connection_scope_generation',
        'validate_runtime_fleet_scope_transition',
        'validate_runtime_fleet_credential_transition'
      )
  ) <> 3 OR (
    SELECT count(*)
    FROM pg_trigger trigger
    WHERE NOT trigger.tgisinternal
      AND trigger.tgname IN (
        'validate_runtime_fleet_scope_transition',
        'validate_runtime_fleet_credential_transition'
      )
  ) <> 2 THEN
    RAISE EXCEPTION 'runtime fleet production scope validators have drift';
  END IF;

  IF EXISTS (
    SELECT scope.connection_id, scope.run_id
    FROM public.runtime_canary_connections scope
    LEFT JOIN public.runtime_connection_credentials credentials
      ON credentials.connection_id = scope.connection_id
     AND credentials.run_id = scope.run_id
     AND credentials.active
    WHERE scope.active
      AND scope.status = 'ACTIVE'
      AND scope.approved_at IS NOT NULL
      AND scope.approved_at <= statement_timestamp()
      AND scope.expires_at IS NOT NULL
      AND scope.expires_at > statement_timestamp()
      AND scope.activated_at IS NOT NULL
      AND scope.retired_at IS NULL
    GROUP BY scope.connection_id, scope.run_id, scope.activated_at
    HAVING count(credentials.*) <> 2
      OR count(DISTINCT credentials.credential_kind) <> 2
      OR count(DISTINCT credentials.key_version) <> 1
      OR bool_or(credentials.provider IS DISTINCT FROM 'agora')
      OR bool_or(credentials.credential_kind NOT IN ('agora', 'winerim'))
      OR bool_or(credentials.activated_at IS DISTINCT FROM scope.activated_at)
      OR bool_or(credentials.retired_at IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'runtime fleet production active credentials are invalid';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.runtime_connection_credentials credentials
    WHERE credentials.active
      AND credentials.retired_at IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.runtime_canary_connections scope
        WHERE scope.connection_id = credentials.connection_id
          AND scope.run_id = credentials.run_id
          AND scope.status = 'ACTIVE'
          AND scope.active
      )
  ) THEN
    RAISE EXCEPTION 'runtime fleet production has orphan active credentials';
  END IF;
END
$runtime_fleet_production_prerequisite$;

CREATE INDEX runtime_connection_credentials_scope_idx
  ON public.runtime_connection_credentials(connection_id, run_id);

COMMENT ON INDEX public.runtime_connection_credentials_scope_idx IS
  'Supports exact connection and run generation lookups for the fleet read model.';

COMMIT;
