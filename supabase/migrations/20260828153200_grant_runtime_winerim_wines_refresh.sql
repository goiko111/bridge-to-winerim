BEGIN;

DO $grant_guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'middleware_runtime') THEN
    RAISE EXCEPTION 'MIDDLEWARE_RUNTIME_ROLE_MISSING';
  END IF;
END
$grant_guard$;

GRANT INSERT, UPDATE ON TABLE public.winerim_wines TO middleware_runtime;

COMMIT;
