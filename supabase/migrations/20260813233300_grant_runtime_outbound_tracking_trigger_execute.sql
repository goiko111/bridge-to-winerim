DO $$
BEGIN
  IF to_regprocedure('public.enforce_runtime_full_outbound_tracking_scope()') IS NULL THEN
    RAISE EXCEPTION 'enforce_runtime_full_outbound_tracking_scope() is required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'middleware_runtime') THEN
    RAISE EXCEPTION 'middleware_runtime role is required';
  END IF;
END
$$;

GRANT EXECUTE ON FUNCTION public.enforce_runtime_full_outbound_tracking_scope()
  TO middleware_runtime;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'middleware_runtime_login') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.enforce_runtime_full_outbound_tracking_scope() TO middleware_runtime_login';
  END IF;
END
$$;
