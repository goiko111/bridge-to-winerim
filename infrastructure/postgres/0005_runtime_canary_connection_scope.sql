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
  CONSTRAINT runtime_canary_connections_active_window_check CHECK (
    active = false
    OR (
      approved_at IS NOT NULL
      AND expires_at IS NOT NULL
      AND expires_at > approved_at
    )
  )
);

ALTER TABLE public.runtime_canary_connections
  DROP CONSTRAINT IF EXISTS runtime_canary_connections_active_window_check;
ALTER TABLE public.runtime_canary_connections
  ADD CONSTRAINT runtime_canary_connections_active_window_check CHECK (
    active = false
    OR (
      approved_at IS NOT NULL
      AND expires_at IS NOT NULL
      AND expires_at > approved_at
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS runtime_canary_connections_single_active_idx
  ON public.runtime_canary_connections ((active))
  WHERE active = true;

CREATE OR REPLACE FUNCTION public.enforce_runtime_canary_connection_window()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF NEW.active = true AND (
    NEW.approved_at IS NULL
    OR NEW.approved_at > statement_timestamp()
    OR NEW.expires_at IS NULL
    OR NEW.expires_at <= statement_timestamp()
  ) THEN
    RAISE EXCEPTION 'runtime canary scope must be approved and unexpired'
      USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.enforce_runtime_canary_connection_window() FROM PUBLIC;

DROP TRIGGER IF EXISTS enforce_runtime_canary_connection_window
  ON public.runtime_canary_connections;
CREATE TRIGGER enforce_runtime_canary_connection_window
  BEFORE INSERT OR UPDATE ON public.runtime_canary_connections
  FOR EACH ROW EXECUTE FUNCTION public.enforce_runtime_canary_connection_window();

ALTER TABLE public.runtime_canary_connections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.runtime_canary_connections
  FROM PUBLIC, authenticated, service_role, middleware_api, middleware_readonly, middleware_runtime;
GRANT SELECT ON public.runtime_canary_connections TO middleware_runtime;

DROP POLICY IF EXISTS middleware_runtime_canary_select_scope
  ON public.runtime_canary_connections;
CREATE POLICY middleware_runtime_canary_select_scope
  ON public.runtime_canary_connections
  FOR SELECT TO middleware_runtime
  USING (
    active = true
    AND approved_at IS NOT NULL
    AND approved_at <= now()
    AND expires_at IS NOT NULL
    AND expires_at > now()
  );

DROP POLICY IF EXISTS middleware_runtime_canary_select_connections
  ON public.pos_connections;
CREATE POLICY middleware_runtime_canary_select_connections
  ON public.pos_connections
  FOR SELECT TO middleware_runtime
  USING (EXISTS (
    SELECT 1 FROM public.runtime_canary_connections scope
    WHERE scope.connection_id = pos_connections.id
      AND scope.active = true
      AND scope.approved_at IS NOT NULL
      AND scope.approved_at <= now()
      AND scope.expires_at IS NOT NULL
      AND scope.expires_at > now()
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
        AND scope.active = true
        AND scope.approved_at IS NOT NULL
        AND scope.approved_at <= now()
        AND scope.expires_at IS NOT NULL
        AND scope.expires_at > now()
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
      AND scope.active = true
      AND scope.approved_at IS NOT NULL
      AND scope.approved_at <= now()
      AND scope.expires_at IS NOT NULL
      AND scope.expires_at > now()
  ));
CREATE POLICY middleware_runtime_canary_insert_idempotency
  ON public.runtime_idempotency FOR INSERT TO middleware_runtime
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.runtime_canary_connections scope
    WHERE scope.connection_id = runtime_idempotency.connection_id
      AND scope.active = true
      AND scope.approved_at IS NOT NULL
      AND scope.approved_at <= now()
      AND scope.expires_at IS NOT NULL
      AND scope.expires_at > now()
  ));
CREATE POLICY middleware_runtime_canary_update_idempotency
  ON public.runtime_idempotency FOR UPDATE TO middleware_runtime
  USING (EXISTS (
    SELECT 1 FROM public.runtime_canary_connections scope
    WHERE scope.connection_id = runtime_idempotency.connection_id
      AND scope.active = true
      AND scope.approved_at IS NOT NULL
      AND scope.approved_at <= now()
      AND scope.expires_at IS NOT NULL
      AND scope.expires_at > now()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.runtime_canary_connections scope
    WHERE scope.connection_id = runtime_idempotency.connection_id
      AND scope.active = true
      AND scope.approved_at IS NOT NULL
      AND scope.approved_at <= now()
      AND scope.expires_at IS NOT NULL
      AND scope.expires_at > now()
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
      AND scope.active = true
      AND scope.approved_at IS NOT NULL
      AND scope.approved_at <= now()
      AND scope.expires_at IS NOT NULL
      AND scope.expires_at > now()
  ));
CREATE POLICY middleware_runtime_canary_insert_execution_log
  ON public.runtime_execution_log FOR INSERT TO middleware_runtime
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.runtime_canary_connections scope
    WHERE scope.connection_id = runtime_execution_log.connection_id
      AND scope.active = true
      AND scope.approved_at IS NOT NULL
      AND scope.approved_at <= now()
      AND scope.expires_at IS NOT NULL
      AND scope.expires_at > now()
  ));

DROP POLICY IF EXISTS middleware_runtime_canary_select_stock_log
  ON public.stock_sync_log;
DROP POLICY IF EXISTS middleware_runtime_canary_insert_stock_log
  ON public.stock_sync_log;
REVOKE ALL ON public.stock_sync_log FROM middleware_runtime;

COMMENT ON TABLE public.runtime_canary_connections IS
  'Admin-owned, approved and expiring single-connection allowlist for the staging runtime canary. Zero active rows is fail-closed; at most one valid active row is allowed.';

COMMIT;
