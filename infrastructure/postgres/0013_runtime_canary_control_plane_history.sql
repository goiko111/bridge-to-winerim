\set ON_ERROR_STOP on

BEGIN;

LOCK TABLE public.runtime_connection_credentials,
  public.runtime_canary_connections
  IN SHARE ROW EXCLUSIVE MODE;

DO $runtime_canary_control_plane_empty_upgrade$
BEGIN
  IF EXISTS (SELECT 1 FROM public.runtime_connection_credentials)
    OR EXISTS (SELECT 1 FROM public.runtime_canary_connections) THEN
    RAISE EXCEPTION 'runtime canary control-plane history upgrade requires empty control tables';
  END IF;
END;
$runtime_canary_control_plane_empty_upgrade$;

ALTER TABLE public.runtime_canary_connections
  ADD COLUMN run_id text NOT NULL,
  ADD COLUMN generation_mode text NOT NULL DEFAULT 'bootstrap',
  ADD COLUMN status text NOT NULL DEFAULT 'PREPARED',
  ADD COLUMN deployment_manifest_sha256 text,
  ADD COLUMN writer_fence_grant_sha256 text,
  ADD COLUMN credential_set_sha256 text,
  ADD COLUMN activated_at timestamptz,
  ADD COLUMN retired_at timestamptz;

ALTER TABLE public.runtime_canary_connections
  DROP CONSTRAINT runtime_canary_connections_pkey,
  ADD CONSTRAINT runtime_canary_connections_pkey PRIMARY KEY (connection_id, run_id),
  ADD CONSTRAINT runtime_canary_connections_run_id_key UNIQUE (run_id),
  ADD CONSTRAINT runtime_canary_connections_run_id_format
    CHECK (run_id ~ '^[a-z0-9][a-z0-9-]{2,31}$'),
  ADD CONSTRAINT runtime_canary_connections_generation_mode_check
    CHECK (generation_mode IN ('bootstrap', 'rotate')),
  ADD CONSTRAINT runtime_canary_connections_status_check
    CHECK (status IN ('PREPARED', 'ACTIVE', 'RETIRED', 'ABORTED')),
  ADD CONSTRAINT runtime_canary_connections_hashes_check CHECK (
    (deployment_manifest_sha256 IS NULL OR deployment_manifest_sha256 ~ '^[a-f0-9]{64}$')
    AND (writer_fence_grant_sha256 IS NULL OR writer_fence_grant_sha256 ~ '^[a-f0-9]{64}$')
    AND (credential_set_sha256 IS NULL OR credential_set_sha256 ~ '^[a-f0-9]{64}$')
  ),
  ADD CONSTRAINT runtime_canary_connections_lifecycle_check CHECK (
    (
      status = 'PREPARED'
      AND active = false
      AND approved_at IS NULL
      AND expires_at IS NULL
      AND deployment_manifest_sha256 IS NULL
      AND writer_fence_grant_sha256 IS NULL
      AND credential_set_sha256 IS NULL
      AND activated_at IS NULL
      AND retired_at IS NULL
    )
    OR (
      status = 'ACTIVE'
      AND active = true
      AND approved_at IS NOT NULL
      AND expires_at IS NOT NULL
      AND expires_at > approved_at
      AND expires_at <= approved_at + interval '2 hours'
      AND deployment_manifest_sha256 IS NOT NULL
      AND writer_fence_grant_sha256 IS NOT NULL
      AND credential_set_sha256 IS NOT NULL
      AND activated_at IS NOT NULL
      AND retired_at IS NULL
    )
    OR (
      status IN ('RETIRED', 'ABORTED')
      AND active = false
      AND approved_at IS NOT NULL
      AND expires_at IS NOT NULL
      AND deployment_manifest_sha256 IS NOT NULL
      AND writer_fence_grant_sha256 IS NOT NULL
      AND credential_set_sha256 IS NOT NULL
      AND activated_at IS NOT NULL
      AND retired_at IS NOT NULL
      AND retired_at >= activated_at
    )
  );

ALTER TABLE public.runtime_connection_credentials
  ADD COLUMN run_id text NOT NULL,
  ADD COLUMN attestation_sha256 text NOT NULL,
  ADD COLUMN activated_at timestamptz,
  ADD COLUMN retired_at timestamptz;

ALTER TABLE public.runtime_connection_credentials
  DROP CONSTRAINT runtime_connection_credentials_pkey,
  ADD CONSTRAINT runtime_connection_credentials_pkey
    PRIMARY KEY (connection_id, credential_kind, run_id),
  ADD CONSTRAINT runtime_connection_credentials_run_id_format
    CHECK (run_id ~ '^[a-z0-9][a-z0-9-]{2,31}$'),
  ADD CONSTRAINT runtime_connection_credentials_attestation_format
    CHECK (attestation_sha256 ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT runtime_connection_credentials_lifecycle_check CHECK (
    (
      active = false
      AND activated_at IS NULL
      AND retired_at IS NULL
    )
    OR (
      active = true
      AND activated_at IS NOT NULL
      AND retired_at IS NULL
    )
    OR (
      active = false
      AND activated_at IS NOT NULL
      AND retired_at IS NOT NULL
      AND retired_at >= activated_at
    )
  ),
  ADD CONSTRAINT runtime_connection_credentials_scope_fkey
    FOREIGN KEY (connection_id, run_id)
    REFERENCES public.runtime_canary_connections(connection_id, run_id)
    ON DELETE RESTRICT;

DROP INDEX IF EXISTS public.idx_runtime_connection_credentials_active;
CREATE UNIQUE INDEX idx_runtime_connection_credentials_active
  ON public.runtime_connection_credentials(connection_id, credential_kind)
  WHERE active = true;

CREATE OR REPLACE FUNCTION public.enforce_runtime_canary_scope_immutability()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF NEW.connection_id IS DISTINCT FROM OLD.connection_id
    OR NEW.run_id IS DISTINCT FROM OLD.run_id
    OR NEW.generation_mode IS DISTINCT FROM OLD.generation_mode
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'RUNTIME_CANARY_SCOPE_IDENTITY_IMMUTABLE';
  END IF;
  IF OLD.status <> 'PREPARED' AND (
    NEW.deployment_manifest_sha256 IS DISTINCT FROM OLD.deployment_manifest_sha256
    OR NEW.writer_fence_grant_sha256 IS DISTINCT FROM OLD.writer_fence_grant_sha256
    OR NEW.credential_set_sha256 IS DISTINCT FROM OLD.credential_set_sha256
    OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.activated_at IS DISTINCT FROM OLD.activated_at
  ) THEN
    RAISE EXCEPTION 'RUNTIME_CANARY_SCOPE_EVIDENCE_IMMUTABLE';
  END IF;
  IF OLD.status IN ('RETIRED', 'ABORTED') THEN
    RAISE EXCEPTION 'RUNTIME_CANARY_SCOPE_TERMINAL';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.enforce_runtime_canary_scope_immutability() FROM PUBLIC;
DROP TRIGGER IF EXISTS enforce_runtime_canary_scope_immutability
  ON public.runtime_canary_connections;
CREATE TRIGGER enforce_runtime_canary_scope_immutability
  BEFORE UPDATE ON public.runtime_canary_connections
  FOR EACH ROW EXECUTE FUNCTION public.enforce_runtime_canary_scope_immutability();

CREATE OR REPLACE FUNCTION public.enforce_runtime_credential_immutability()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF NEW.connection_id IS DISTINCT FROM OLD.connection_id
    OR NEW.provider IS DISTINCT FROM OLD.provider
    OR NEW.credential_kind IS DISTINCT FROM OLD.credential_kind
    OR NEW.run_id IS DISTINCT FROM OLD.run_id
    OR NEW.algorithm IS DISTINCT FROM OLD.algorithm
    OR NEW.key_version IS DISTINCT FROM OLD.key_version
    OR NEW.aad_version IS DISTINCT FROM OLD.aad_version
    OR NEW.ciphertext IS DISTINCT FROM OLD.ciphertext
    OR NEW.nonce IS DISTINCT FROM OLD.nonce
    OR NEW.attestation_sha256 IS DISTINCT FROM OLD.attestation_sha256
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'RUNTIME_CREDENTIAL_EVIDENCE_IMMUTABLE';
  END IF;
  IF OLD.retired_at IS NOT NULL OR (OLD.activated_at IS NOT NULL AND NEW.active = true AND OLD.active = false) THEN
    RAISE EXCEPTION 'RUNTIME_CREDENTIAL_REACTIVATION_REJECTED';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.enforce_runtime_credential_immutability() FROM PUBLIC;
DROP TRIGGER IF EXISTS enforce_runtime_credential_immutability
  ON public.runtime_connection_credentials;
CREATE TRIGGER enforce_runtime_credential_immutability
  BEFORE UPDATE ON public.runtime_connection_credentials
  FOR EACH ROW EXECUTE FUNCTION public.enforce_runtime_credential_immutability();

DROP POLICY IF EXISTS middleware_runtime_select_active
  ON public.runtime_connection_credentials;
CREATE POLICY middleware_runtime_select_active
  ON public.runtime_connection_credentials
  FOR SELECT TO middleware_runtime
  USING (
    active = true
    AND EXISTS (
      SELECT 1 FROM public.runtime_canary_connections scope
      WHERE scope.connection_id = runtime_connection_credentials.connection_id
        AND scope.run_id = runtime_connection_credentials.run_id
        AND scope.status = 'ACTIVE'
        AND scope.active = true
        AND scope.approved_at IS NOT NULL
        AND scope.approved_at <= now()
        AND scope.expires_at IS NOT NULL
        AND scope.expires_at > now()
    )
  );

COMMENT ON COLUMN public.runtime_connection_credentials.run_id IS
  'Immutable credential generation identity bound to one canary run.';
COMMENT ON COLUMN public.runtime_connection_credentials.attestation_sha256 IS
  'Immutable SHA-256 attestation of the encrypted credential row.';
COMMENT ON COLUMN public.runtime_canary_connections.run_id IS
  'Globally unique immutable canary run identity. Terminal runs cannot be replayed.';
COMMENT ON COLUMN public.runtime_canary_connections.generation_mode IS
  'Immutable bootstrap or rotate mode controlling prior operational-row gates.';

COMMIT;
