\set ON_ERROR_STOP on

BEGIN;

CREATE TABLE IF NOT EXISTS public.runtime_canary_connections (
  connection_id uuid PRIMARY KEY REFERENCES public.pos_connections(id) ON DELETE CASCADE,
  active boolean NOT NULL DEFAULT false,
  approved_at timestamptz,
  expires_at timestamptz,
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at IS NULL OR approved_at IS NULL OR expires_at > approved_at)
);

ALTER TABLE public.runtime_canary_connections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.runtime_canary_connections
  FROM PUBLIC, authenticated, service_role, middleware_api, middleware_readonly, middleware_runtime;
GRANT SELECT ON public.runtime_canary_connections TO middleware_runtime;

DROP POLICY IF EXISTS middleware_runtime_canary_select_scope
  ON public.runtime_canary_connections;
CREATE POLICY middleware_runtime_canary_select_scope
  ON public.runtime_canary_connections
  FOR SELECT TO middleware_runtime
  USING (active = true AND (expires_at IS NULL OR expires_at > now()));

DROP POLICY IF EXISTS middleware_runtime_canary_select_connections
  ON public.pos_connections;
CREATE POLICY middleware_runtime_canary_select_connections
  ON public.pos_connections
  FOR SELECT TO middleware_runtime
  USING (EXISTS (
    SELECT 1 FROM public.runtime_canary_connections scope
    WHERE scope.connection_id = pos_connections.id
  ));

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
    )
  );

DROP POLICY IF EXISTS middleware_runtime_canary_select_idempotency
  ON public.runtime_idempotency;
DROP POLICY IF EXISTS middleware_runtime_canary_insert_idempotency
  ON public.runtime_idempotency;
DROP POLICY IF EXISTS middleware_runtime_canary_update_idempotency
  ON public.runtime_idempotency;
CREATE POLICY middleware_runtime_canary_select_idempotency
  ON public.runtime_idempotency FOR SELECT TO middleware_runtime
  USING (EXISTS (
    SELECT 1 FROM public.runtime_canary_connections scope
    WHERE scope.connection_id = runtime_idempotency.connection_id
  ));
CREATE POLICY middleware_runtime_canary_insert_idempotency
  ON public.runtime_idempotency FOR INSERT TO middleware_runtime
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.runtime_canary_connections scope
    WHERE scope.connection_id = runtime_idempotency.connection_id
  ));
CREATE POLICY middleware_runtime_canary_update_idempotency
  ON public.runtime_idempotency FOR UPDATE TO middleware_runtime
  USING (EXISTS (
    SELECT 1 FROM public.runtime_canary_connections scope
    WHERE scope.connection_id = runtime_idempotency.connection_id
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.runtime_canary_connections scope
    WHERE scope.connection_id = runtime_idempotency.connection_id
  ));

DROP POLICY IF EXISTS middleware_runtime_canary_select_execution_log
  ON public.runtime_execution_log;
DROP POLICY IF EXISTS middleware_runtime_canary_insert_execution_log
  ON public.runtime_execution_log;
CREATE POLICY middleware_runtime_canary_select_execution_log
  ON public.runtime_execution_log FOR SELECT TO middleware_runtime
  USING (EXISTS (
    SELECT 1 FROM public.runtime_canary_connections scope
    WHERE scope.connection_id = runtime_execution_log.connection_id
  ));
CREATE POLICY middleware_runtime_canary_insert_execution_log
  ON public.runtime_execution_log FOR INSERT TO middleware_runtime
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.runtime_canary_connections scope
    WHERE scope.connection_id = runtime_execution_log.connection_id
  ));

DROP POLICY IF EXISTS middleware_runtime_canary_select_stock_log
  ON public.stock_sync_log;
DROP POLICY IF EXISTS middleware_runtime_canary_insert_stock_log
  ON public.stock_sync_log;
REVOKE ALL ON public.stock_sync_log FROM middleware_runtime;

COMMENT ON TABLE public.runtime_canary_connections IS
  'Admin-owned, expiring allowlist for the single staging runtime canary. Runtime can read active scope but cannot create or alter it.';

COMMIT;
