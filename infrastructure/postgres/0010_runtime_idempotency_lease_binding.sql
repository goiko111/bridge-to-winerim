\set ON_ERROR_STOP on

BEGIN;

DO $runtime_idempotency_binding_preflight$
BEGIN
  IF to_regclass('public.runtime_idempotency') IS NULL THEN
    RAISE EXCEPTION 'public.runtime_idempotency is required before migration 0010';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'middleware_runtime'
      AND rolcanlogin = false
      AND rolsuper = false
      AND rolbypassrls = false
  ) THEN
    RAISE EXCEPTION 'middleware_runtime must be a hardened NOLOGIN role';
  END IF;
END
$runtime_idempotency_binding_preflight$;

ALTER TABLE public.runtime_idempotency
  ADD COLUMN IF NOT EXISTS payload_sha256 text,
  ADD COLUMN IF NOT EXISTS lease_token uuid;

ALTER TABLE public.runtime_idempotency
  DROP CONSTRAINT IF EXISTS runtime_idempotency_payload_sha256_format;
ALTER TABLE public.runtime_idempotency
  ADD CONSTRAINT runtime_idempotency_payload_sha256_format
  CHECK (payload_sha256 IS NULL OR payload_sha256 ~ '^[a-f0-9]{64}$');

COMMENT ON COLUMN public.runtime_idempotency.payload_sha256 IS
  'Canonical payload digest. NULL is legacy and must never be acquired by the current runtime.';
COMMENT ON COLUMN public.runtime_idempotency.lease_token IS
  'Per-attempt ownership token. Completion/retry/terminal writes must match it exactly.';

COMMIT;
