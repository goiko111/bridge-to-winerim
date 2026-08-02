\set ON_ERROR_STOP on

BEGIN;

DO $rollback_guard$
DECLARE
  environment_value text;
  credential_rows bigint;
  scope_rows bigint;
BEGIN
  SELECT value INTO environment_value
  FROM public.infrastructure_metadata
  WHERE key = 'environment';
  IF environment_value IS DISTINCT FROM 'staging' THEN
    RAISE EXCEPTION 'rollback target is not staging';
  END IF;
  SELECT count(*) INTO credential_rows FROM public.runtime_connection_credentials;
  SELECT count(*) INTO scope_rows FROM public.runtime_canary_connections;
  IF credential_rows <> 0 OR scope_rows <> 0 THEN
    RAISE EXCEPTION 'runtime upgrade rollback requires empty canary and credential tables';
  END IF;
END
$rollback_guard$;

DO $drop_runtime_policies$
DECLARE item record;
BEGIN
  FOR item IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND policyname LIKE 'middleware_runtime%'
  LOOP
    EXECUTE format('DROP POLICY %I ON %I.%I', item.policyname, item.schemaname, item.tablename);
  END LOOP;
END
$drop_runtime_policies$;

DROP TABLE public.runtime_canary_connections;
DROP FUNCTION public.enforce_runtime_canary_connection_window();
DROP TABLE public.runtime_connection_credentials;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM middleware_runtime;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM middleware_runtime;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM middleware_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO middleware_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO middleware_runtime;
GRANT EXECUTE ON FUNCTION public.claim_outbound_tasks(uuid, text[], integer) TO middleware_runtime;
GRANT EXECUTE ON FUNCTION public.rescue_zombie_outbound_tasks() TO middleware_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO middleware_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO middleware_runtime;

DO $restore_runtime_policies$
DECLARE item record;
BEGIN
  FOR item IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
  LOOP
    EXECUTE format(
      'CREATE POLICY middleware_runtime_all ON public.%I FOR ALL TO middleware_runtime USING (true) WITH CHECK (true)',
      item.relname
    );
  END LOOP;
END
$restore_runtime_policies$;

COMMIT;
