BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'middleware_runtime') THEN
    RAISE EXCEPTION 'middleware_runtime role is required';
  END IF;
END
$$;

-- The runtime catalog adapter owns a RUNNING -> SUCCESS transition inside the
-- existing connection-scoped RLS policy. INSERT/SELECT were already granted;
-- UPDATE was omitted, leaving a remotely verified Agora write unreceipted.
GRANT UPDATE ON TABLE public.runtime_idempotency TO middleware_runtime;

COMMIT;
