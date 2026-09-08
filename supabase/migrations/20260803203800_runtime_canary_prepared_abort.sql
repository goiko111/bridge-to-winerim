BEGIN;

LOCK TABLE public.runtime_connection_credentials,
  public.runtime_canary_connections
  IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE public.runtime_canary_connections
  DROP CONSTRAINT runtime_canary_connections_lifecycle_check,
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
      status = 'RETIRED'
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
    OR (
      status = 'ABORTED'
      AND active = false
      AND retired_at IS NOT NULL
      AND (
        (
          approved_at IS NULL
          AND expires_at IS NULL
          AND deployment_manifest_sha256 IS NULL
          AND writer_fence_grant_sha256 IS NULL
          AND credential_set_sha256 IS NULL
          AND activated_at IS NULL
        )
        OR (
          approved_at IS NOT NULL
          AND expires_at IS NOT NULL
          AND deployment_manifest_sha256 IS NOT NULL
          AND writer_fence_grant_sha256 IS NOT NULL
          AND credential_set_sha256 IS NOT NULL
          AND activated_at IS NOT NULL
          AND retired_at >= activated_at
        )
      )
    )
  );

ALTER TABLE public.runtime_connection_credentials
  DROP CONSTRAINT runtime_connection_credentials_lifecycle_check,
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
      AND retired_at IS NOT NULL
      AND (
        activated_at IS NULL
        OR retired_at >= activated_at
      )
    )
  );

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
  IF OLD.status IN ('RETIRED', 'ABORTED') THEN
    RAISE EXCEPTION 'RUNTIME_CANARY_SCOPE_TERMINAL';
  END IF;
  IF NOT (
    (OLD.status = 'PREPARED' AND NEW.status IN ('PREPARED', 'ACTIVE', 'ABORTED'))
    OR (OLD.status = 'ACTIVE' AND NEW.status IN ('ACTIVE', 'RETIRED', 'ABORTED'))
  ) THEN
    RAISE EXCEPTION 'RUNTIME_CANARY_SCOPE_TRANSITION_REJECTED';
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
  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.enforce_runtime_canary_scope_immutability() FROM PUBLIC;

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
  IF OLD.retired_at IS NOT NULL THEN
    RAISE EXCEPTION 'RUNTIME_CREDENTIAL_TERMINAL';
  END IF;
  IF OLD.activated_at IS NOT NULL
    AND NEW.activated_at IS DISTINCT FROM OLD.activated_at THEN
    RAISE EXCEPTION 'RUNTIME_CREDENTIAL_ACTIVATION_IMMUTABLE';
  END IF;
  IF OLD.activated_at IS NULL AND NEW.activated_at IS NOT NULL
    AND (NEW.active IS DISTINCT FROM true OR NEW.retired_at IS NOT NULL) THEN
    RAISE EXCEPTION 'RUNTIME_CREDENTIAL_ACTIVATION_TRANSITION_REJECTED';
  END IF;
  IF OLD.activated_at IS NULL AND NEW.retired_at IS NOT NULL
    AND (NEW.active IS DISTINCT FROM false OR NEW.activated_at IS NOT NULL) THEN
    RAISE EXCEPTION 'RUNTIME_CREDENTIAL_ABORT_TRANSITION_REJECTED';
  END IF;
  IF OLD.activated_at IS NOT NULL AND NEW.active = true AND OLD.active = false THEN
    RAISE EXCEPTION 'RUNTIME_CREDENTIAL_REACTIVATION_REJECTED';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.enforce_runtime_credential_immutability() FROM PUBLIC;

COMMENT ON CONSTRAINT runtime_canary_connections_lifecycle_check
  ON public.runtime_canary_connections IS
  'Allows append-only PREPARED to ABORTED closure without activation while retaining the activated terminal lifecycle.';
COMMENT ON CONSTRAINT runtime_connection_credentials_lifecycle_check
  ON public.runtime_connection_credentials IS
  'Allows inactive prepared credentials to be retired without ever becoming active.';

COMMIT;
