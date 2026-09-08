\set ON_ERROR_STOP on

BEGIN;

-- The first bootstrap revision granted the runtime role broad access so the
-- schema could be replayed. The staging canary needs only the stock lane and
-- must not inherit control-plane or cross-connection mutation privileges.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM middleware_runtime;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM middleware_runtime;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM middleware_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM middleware_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM middleware_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM middleware_runtime;

DO $drop_broad_runtime_policies$
DECLARE
  item record;
BEGIN
  FOR item IN
    SELECT schemaname, tablename
    FROM pg_policies
    WHERE schemaname = 'public'
      AND policyname = 'middleware_runtime_all'
  LOOP
    EXECUTE format(
      'DROP POLICY middleware_runtime_all ON %I.%I',
      item.schemaname,
      item.tablename
    );
  END LOOP;
END
$drop_broad_runtime_policies$;

GRANT USAGE ON SCHEMA public TO middleware_runtime;
GRANT SELECT ON
  public.infrastructure_metadata,
  public.pos_connections,
  public.runtime_connection_credentials,
  public.runtime_idempotency,
  public.runtime_execution_log
TO middleware_runtime;
GRANT INSERT, UPDATE ON public.runtime_idempotency TO middleware_runtime;
GRANT INSERT ON public.runtime_execution_log TO middleware_runtime;
GRANT USAGE, SELECT ON SEQUENCE public.runtime_execution_log_id_seq TO middleware_runtime;

CREATE POLICY middleware_runtime_canary_select_metadata
  ON public.infrastructure_metadata
  FOR SELECT TO middleware_runtime USING (true);
CREATE POLICY middleware_runtime_canary_select_connections
  ON public.pos_connections
  FOR SELECT TO middleware_runtime USING (true);
CREATE POLICY middleware_runtime_canary_select_idempotency
  ON public.runtime_idempotency
  FOR SELECT TO middleware_runtime USING (true);
CREATE POLICY middleware_runtime_canary_insert_idempotency
  ON public.runtime_idempotency
  FOR INSERT TO middleware_runtime WITH CHECK (true);
CREATE POLICY middleware_runtime_canary_update_idempotency
  ON public.runtime_idempotency
  FOR UPDATE TO middleware_runtime USING (true) WITH CHECK (true);
CREATE POLICY middleware_runtime_canary_select_execution_log
  ON public.runtime_execution_log
  FOR SELECT TO middleware_runtime USING (true);
CREATE POLICY middleware_runtime_canary_insert_execution_log
  ON public.runtime_execution_log
  FOR INSERT TO middleware_runtime WITH CHECK (true);
COMMIT;
