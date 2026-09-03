BEGIN;

LOCK TABLE public.runtime_canary_connections IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE public.runtime_canary_connections
  ADD COLUMN authorization_class text NOT NULL DEFAULT 'canary',
  ADD CONSTRAINT runtime_canary_connections_authorization_class_check
    CHECK (authorization_class IN ('canary', 'operational'));

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
      AND (
        (authorization_class = 'canary'
          AND expires_at <= approved_at + interval '2 hours')
        OR
        (authorization_class = 'operational'
          AND expires_at <= approved_at + interval '30 days')
      )
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
    NEW.authorization_class IS DISTINCT FROM OLD.authorization_class
    OR NEW.deployment_manifest_sha256 IS DISTINCT FROM OLD.deployment_manifest_sha256
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

COMMENT ON COLUMN public.runtime_canary_connections.authorization_class IS
  'Canary grants remain capped at two hours. Operational grants require E2E certification and remain capped at 30 days while each provider mutation still requires a 30-120 second writer lease.';

COMMIT;
