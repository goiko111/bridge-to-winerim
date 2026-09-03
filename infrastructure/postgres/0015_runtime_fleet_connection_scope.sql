\set ON_ERROR_STOP on

BEGIN;

LOCK TABLE public.runtime_connection_credentials,
  public.runtime_canary_connections
  IN SHARE ROW EXCLUSIVE MODE;

DO $runtime_fleet_connection_scope_preflight$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.runtime_canary_connections scope
    WHERE scope.active
      AND (
        scope.status <> 'ACTIVE'
        OR scope.approved_at IS NULL
        OR scope.approved_at > statement_timestamp()
        OR scope.expires_at IS NULL
        OR scope.expires_at <= statement_timestamp()
        OR scope.activated_at IS NULL
        OR scope.retired_at IS NOT NULL
      )
  ) THEN
    RAISE EXCEPTION 'RUNTIME_FLEET_SCOPE_PREFLIGHT_INVALID_ACTIVE_SCOPE';
  END IF;

  IF EXISTS (
    SELECT scope.connection_id, scope.run_id
    FROM public.runtime_canary_connections scope
    LEFT JOIN public.runtime_connection_credentials credentials
      ON credentials.connection_id = scope.connection_id
     AND credentials.run_id = scope.run_id
     AND credentials.active
    WHERE scope.active
    GROUP BY scope.connection_id, scope.run_id, scope.activated_at
    HAVING count(credentials.*) <> 2
      OR count(DISTINCT credentials.credential_kind) <> 2
      OR count(DISTINCT credentials.key_version) <> 1
      OR bool_or(credentials.provider IS DISTINCT FROM 'agora')
      OR bool_or(credentials.credential_kind NOT IN ('agora', 'winerim'))
      OR bool_or(credentials.activated_at IS DISTINCT FROM scope.activated_at)
      OR bool_or(credentials.retired_at IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'RUNTIME_FLEET_SCOPE_PREFLIGHT_INCOMPLETE_CREDENTIALS';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.runtime_connection_credentials credentials
    WHERE credentials.active
      AND NOT EXISTS (
        SELECT 1
        FROM public.runtime_canary_connections scope
        WHERE scope.connection_id = credentials.connection_id
          AND scope.run_id = credentials.run_id
          AND scope.status = 'ACTIVE'
          AND scope.active
      )
  ) THEN
    RAISE EXCEPTION 'RUNTIME_FLEET_SCOPE_PREFLIGHT_ORPHAN_ACTIVE_CREDENTIAL';
  END IF;
END;
$runtime_fleet_connection_scope_preflight$;

CREATE UNIQUE INDEX IF NOT EXISTS runtime_canary_connections_one_active_per_connection_idx
  ON public.runtime_canary_connections(connection_id)
  WHERE active = true;

CREATE INDEX IF NOT EXISTS runtime_connection_credentials_scope_idx
  ON public.runtime_connection_credentials(connection_id, run_id);

DROP INDEX IF EXISTS public.runtime_canary_connections_single_active_idx;

CREATE OR REPLACE FUNCTION public.assert_runtime_fleet_connection_scope_generation(
  checked_connection_id uuid,
  checked_run_id text
)
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
DECLARE
  active_scope_count integer;
  exact_active_credential_count integer;
  connection_active_credential_count integer;
  active_credential_kind_count integer;
  active_credential_key_version_count integer;
  active_scope_activated_at timestamptz;
BEGIN
  IF checked_connection_id IS NULL OR checked_run_id IS NULL THEN
    RAISE EXCEPTION 'RUNTIME_FLEET_SCOPE_IDENTITY_REQUIRED'
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*), min(scope.activated_at)
  INTO active_scope_count, active_scope_activated_at
  FROM public.runtime_canary_connections scope
  WHERE scope.connection_id = checked_connection_id
    AND scope.run_id = checked_run_id
    AND scope.active;

  SELECT
    count(*) FILTER (WHERE credentials.run_id = checked_run_id),
    count(*),
    count(DISTINCT credentials.credential_kind)
      FILTER (WHERE credentials.run_id = checked_run_id),
    count(DISTINCT credentials.key_version)
      FILTER (WHERE credentials.run_id = checked_run_id)
  INTO
    exact_active_credential_count,
    connection_active_credential_count,
    active_credential_kind_count,
    active_credential_key_version_count
  FROM public.runtime_connection_credentials credentials
  WHERE credentials.connection_id = checked_connection_id
    AND credentials.active;

  IF active_scope_count = 1 THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.runtime_canary_connections scope
      WHERE scope.connection_id = checked_connection_id
        AND scope.run_id = checked_run_id
        AND scope.status = 'ACTIVE'
        AND scope.active
        AND scope.approved_at IS NOT NULL
        AND scope.approved_at <= statement_timestamp()
        AND scope.expires_at IS NOT NULL
        AND scope.expires_at > statement_timestamp()
        AND scope.deployment_manifest_sha256 IS NOT NULL
        AND scope.writer_fence_grant_sha256 IS NOT NULL
        AND scope.credential_set_sha256 IS NOT NULL
        AND scope.activated_at IS NOT NULL
        AND scope.retired_at IS NULL
    ) THEN
      RAISE EXCEPTION 'RUNTIME_FLEET_SCOPE_ACTIVE_EVIDENCE_INVALID'
        USING ERRCODE = '23514';
    END IF;

    IF exact_active_credential_count <> 2
      OR connection_active_credential_count <> 2
      OR active_credential_kind_count <> 2
      OR active_credential_key_version_count <> 1
      OR EXISTS (
        SELECT 1
        FROM public.runtime_connection_credentials credentials
        WHERE credentials.connection_id = checked_connection_id
          AND credentials.run_id = checked_run_id
          AND credentials.active
          AND (
            credentials.provider <> 'agora'
            OR credentials.credential_kind NOT IN ('agora', 'winerim')
            OR credentials.activated_at IS DISTINCT FROM active_scope_activated_at
            OR credentials.retired_at IS NOT NULL
          )
      )
    THEN
      RAISE EXCEPTION 'RUNTIME_FLEET_SCOPE_CREDENTIALS_INVALID'
        USING ERRCODE = '23514';
    END IF;
  ELSIF exact_active_credential_count > 0 THEN
    RAISE EXCEPTION 'RUNTIME_FLEET_SCOPE_ACTIVE_CREDENTIAL_WITHOUT_SCOPE'
      USING ERRCODE = '23514';
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.assert_runtime_fleet_connection_scope_generation(uuid, text)
  FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.validate_runtime_fleet_scope_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM public.assert_runtime_fleet_connection_scope_generation(
      OLD.connection_id,
      OLD.run_id
    );
  END IF;
  IF TG_OP <> 'DELETE' AND (
    TG_OP = 'INSERT'
    OR NEW.connection_id IS DISTINCT FROM OLD.connection_id
    OR NEW.run_id IS DISTINCT FROM OLD.run_id
    OR NEW.active IS DISTINCT FROM OLD.active
    OR NEW.status IS DISTINCT FROM OLD.status
    OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.deployment_manifest_sha256 IS DISTINCT FROM OLD.deployment_manifest_sha256
    OR NEW.writer_fence_grant_sha256 IS DISTINCT FROM OLD.writer_fence_grant_sha256
    OR NEW.credential_set_sha256 IS DISTINCT FROM OLD.credential_set_sha256
    OR NEW.activated_at IS DISTINCT FROM OLD.activated_at
    OR NEW.retired_at IS DISTINCT FROM OLD.retired_at
  ) THEN
    PERFORM public.assert_runtime_fleet_connection_scope_generation(
      NEW.connection_id,
      NEW.run_id
    );
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.validate_runtime_fleet_scope_transition() FROM PUBLIC;

DROP TRIGGER IF EXISTS validate_runtime_fleet_scope_transition
  ON public.runtime_canary_connections;
CREATE CONSTRAINT TRIGGER validate_runtime_fleet_scope_transition
  AFTER INSERT OR UPDATE OR DELETE ON public.runtime_canary_connections
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_runtime_fleet_scope_transition();

CREATE OR REPLACE FUNCTION public.validate_runtime_fleet_credential_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM public.assert_runtime_fleet_connection_scope_generation(
      OLD.connection_id,
      OLD.run_id
    );
  END IF;
  IF TG_OP <> 'DELETE' AND (
    TG_OP = 'INSERT'
    OR NEW.connection_id IS DISTINCT FROM OLD.connection_id
    OR NEW.run_id IS DISTINCT FROM OLD.run_id
    OR NEW.active IS DISTINCT FROM OLD.active
    OR NEW.activated_at IS DISTINCT FROM OLD.activated_at
    OR NEW.retired_at IS DISTINCT FROM OLD.retired_at
  ) THEN
    PERFORM public.assert_runtime_fleet_connection_scope_generation(
      NEW.connection_id,
      NEW.run_id
    );
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.validate_runtime_fleet_credential_transition() FROM PUBLIC;

DROP TRIGGER IF EXISTS validate_runtime_fleet_credential_transition
  ON public.runtime_connection_credentials;
CREATE CONSTRAINT TRIGGER validate_runtime_fleet_credential_transition
  AFTER INSERT OR UPDATE OR DELETE ON public.runtime_connection_credentials
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_runtime_fleet_credential_transition();

COMMENT ON INDEX public.runtime_canary_connections_one_active_per_connection_idx IS
  'Allows concurrent fleet scopes while enforcing at most one active generation per connection.';
COMMENT ON INDEX public.runtime_connection_credentials_scope_idx IS
  'Supports the exact connection and run generation foreign key and fleet-scope validation lookups.';
COMMENT ON TABLE public.runtime_canary_connections IS
  'Admin-owned, approved and expiring runtime scope history. Zero active rows is fail-closed; at most one active generation is allowed per connection, while distinct connections may run concurrently.';
COMMENT ON FUNCTION public.assert_runtime_fleet_connection_scope_generation(uuid, text) IS
  'Deferred fail-closed invariant: each active connection generation has exactly one Agora and one Winerim credential from the same run and key version.';

COMMIT;
