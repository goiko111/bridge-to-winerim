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
    RAISE EXCEPTION 'control-plane history rollback target is not staging';
  END IF;
  IF EXISTS (SELECT 1 FROM public.runtime_connection_credentials)
    OR EXISTS (SELECT 1 FROM public.runtime_canary_connections) THEN
    RAISE EXCEPTION 'control-plane history rollback requires empty control tables';
  END IF;
END
$rollback_guard$;

DROP TRIGGER IF EXISTS enforce_runtime_credential_immutability
  ON public.runtime_connection_credentials;
DROP FUNCTION IF EXISTS public.enforce_runtime_credential_immutability();
DROP TRIGGER IF EXISTS enforce_runtime_canary_scope_immutability
  ON public.runtime_canary_connections;
DROP FUNCTION IF EXISTS public.enforce_runtime_canary_scope_immutability();

DROP POLICY IF EXISTS middleware_runtime_select_active
  ON public.runtime_connection_credentials;

DROP INDEX IF EXISTS public.idx_runtime_connection_credentials_active;

ALTER TABLE public.runtime_connection_credentials
  DROP CONSTRAINT runtime_connection_credentials_scope_fkey,
  DROP CONSTRAINT runtime_connection_credentials_pkey,
  DROP CONSTRAINT runtime_connection_credentials_run_id_format,
  DROP CONSTRAINT runtime_connection_credentials_attestation_format,
  DROP CONSTRAINT runtime_connection_credentials_lifecycle_check,
  DROP COLUMN run_id,
  DROP COLUMN attestation_sha256,
  DROP COLUMN activated_at,
  DROP COLUMN retired_at,
  ADD CONSTRAINT runtime_connection_credentials_pkey
    PRIMARY KEY (connection_id, credential_kind);

ALTER TABLE public.runtime_canary_connections
  DROP CONSTRAINT runtime_canary_connections_pkey,
  DROP CONSTRAINT runtime_canary_connections_run_id_key,
  DROP CONSTRAINT runtime_canary_connections_run_id_format,
  DROP CONSTRAINT runtime_canary_connections_generation_mode_check,
  DROP CONSTRAINT runtime_canary_connections_status_check,
  DROP CONSTRAINT runtime_canary_connections_hashes_check,
  DROP CONSTRAINT runtime_canary_connections_lifecycle_check,
  DROP COLUMN run_id,
  DROP COLUMN generation_mode,
  DROP COLUMN status,
  DROP COLUMN deployment_manifest_sha256,
  DROP COLUMN writer_fence_grant_sha256,
  DROP COLUMN credential_set_sha256,
  DROP COLUMN activated_at,
  DROP COLUMN retired_at,
  ADD CONSTRAINT runtime_canary_connections_pkey PRIMARY KEY (connection_id);

CREATE POLICY middleware_runtime_select_active
  ON public.runtime_connection_credentials
  FOR SELECT TO middleware_runtime
  USING (
    active = true
    AND EXISTS (
      SELECT 1 FROM public.runtime_canary_connections scope
      WHERE scope.connection_id = runtime_connection_credentials.connection_id
        AND scope.active = true
        AND scope.approved_at IS NOT NULL
        AND scope.approved_at <= now()
        AND scope.expires_at IS NOT NULL
        AND scope.expires_at > now()
    )
  );

CREATE INDEX idx_runtime_connection_credentials_active
  ON public.runtime_connection_credentials(connection_id, credential_kind)
  WHERE active = true;

COMMIT;
