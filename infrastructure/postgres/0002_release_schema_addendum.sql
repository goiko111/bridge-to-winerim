\set ON_ERROR_STOP on

BEGIN;

CREATE TABLE IF NOT EXISTS public.connection_health_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES public.pos_connections(id) ON DELETE CASCADE,
  provider text NOT NULL,
  location_name text NOT NULL,
  check_type text NOT NULL DEFAULT 'reachability',
  status text NOT NULL CHECK (status IN ('OK', 'WARN', 'DOWN', 'AUTH_ERROR', 'ERROR', 'PAUSED', 'STALE')),
  severity text NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'error', 'critical')),
  http_status integer,
  latency_ms integer,
  error_class text,
  error_message text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  checked_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_connection_health_checks_connection_time
  ON public.connection_health_checks(connection_id, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_connection_health_checks_status_time
  ON public.connection_health_checks(status, checked_at DESC);

CREATE TABLE IF NOT EXISTS public.connection_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES public.pos_connections(id) ON DELETE CASCADE,
  provider text NOT NULL,
  alert_key text NOT NULL,
  alert_type text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('info', 'warning', 'error', 'critical')),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'ACKED', 'RESOLVED')),
  title text NOT NULL,
  message text NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  occurrences integer NOT NULL DEFAULT 1,
  consecutive_failures integer NOT NULL DEFAULT 1,
  last_check_id uuid REFERENCES public.connection_health_checks(id) ON DELETE SET NULL,
  last_error_class text,
  last_error_message text,
  notify_internal boolean NOT NULL DEFAULT true,
  notify_client boolean NOT NULL DEFAULT false,
  internal_notified_at timestamptz,
  client_notified_at timestamptz,
  recovery_notified_at timestamptz,
  last_notification_error text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_connection_alerts_open_key
  ON public.connection_alerts(connection_id, alert_key)
  WHERE status IN ('OPEN', 'ACKED');
CREATE INDEX IF NOT EXISTS idx_connection_alerts_status_seen
  ON public.connection_alerts(status, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_connection_alerts_connection_status
  ON public.connection_alerts(connection_id, status);

DROP TRIGGER IF EXISTS update_connection_alerts_updated_at
  ON public.connection_alerts;
CREATE TRIGGER update_connection_alerts_updated_at
  BEFORE UPDATE ON public.connection_alerts
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.connection_health_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.connection_alerts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS middleware_runtime_all ON public.connection_health_checks;
DROP POLICY IF EXISTS middleware_runtime_all ON public.connection_alerts;
CREATE POLICY middleware_runtime_all
  ON public.connection_health_checks
  FOR ALL TO middleware_runtime
  USING (true) WITH CHECK (true);
CREATE POLICY middleware_runtime_all
  ON public.connection_alerts
  FOR ALL TO middleware_runtime
  USING (true) WITH CHECK (true);

REVOKE ALL ON public.connection_health_checks FROM PUBLIC, authenticated, service_role;
REVOKE ALL ON public.connection_alerts FROM PUBLIC, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.connection_health_checks, public.connection_alerts
  TO middleware_runtime;

ALTER TABLE public.sales_line_items
  ADD COLUMN IF NOT EXISTS provider_sold_at timestamp without time zone,
  ADD COLUMN IF NOT EXISTS provider_sold_at_source text;

CREATE INDEX IF NOT EXISTS idx_sales_line_items_connection_provider_sold_at
  ON public.sales_line_items(connection_id, provider_sold_at)
  WHERE provider_sold_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.agora_dispatch_locks (
  connection_id uuid NOT NULL REFERENCES public.pos_connections(id) ON DELETE CASCADE,
  job text NOT NULL CHECK (job IN ('catalog', 'sales-stock', 'outbound-queue', 'activation')),
  lock_token text NOT NULL,
  locked_until timestamptz NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id)
);

ALTER TABLE public.agora_dispatch_locks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS middleware_runtime_all ON public.agora_dispatch_locks;
CREATE POLICY middleware_runtime_all
  ON public.agora_dispatch_locks
  FOR ALL TO middleware_runtime
  USING (true) WITH CHECK (true);

REVOKE ALL ON public.agora_dispatch_locks FROM PUBLIC, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.agora_dispatch_locks
  TO middleware_runtime;

CREATE OR REPLACE FUNCTION public.acquire_agora_dispatch_lock(
  p_connection_id uuid,
  p_job text,
  p_lock_token text,
  p_ttl_seconds integer DEFAULT 540
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  acquired_token text;
BEGIN
  IF p_job NOT IN ('catalog', 'sales-stock', 'outbound-queue', 'activation') THEN
    RAISE EXCEPTION 'Unsupported Agora lock job: %', p_job;
  END IF;

  INSERT INTO public.agora_dispatch_locks (
    connection_id, job, lock_token, locked_until, acquired_at
  )
  VALUES (
    p_connection_id,
    p_job,
    p_lock_token,
    now() + make_interval(secs => greatest(30, least(p_ttl_seconds, 1800))),
    now()
  )
  ON CONFLICT (connection_id) DO UPDATE
  SET
    job = EXCLUDED.job,
    lock_token = EXCLUDED.lock_token,
    locked_until = EXCLUDED.locked_until,
    acquired_at = now()
  WHERE public.agora_dispatch_locks.locked_until <= now()
     OR public.agora_dispatch_locks.lock_token = EXCLUDED.lock_token
  RETURNING lock_token INTO acquired_token;

  RETURN coalesce(acquired_token = p_lock_token, false);
END;
$$;

CREATE OR REPLACE FUNCTION public.release_agora_dispatch_lock(
  p_connection_id uuid,
  p_job text,
  p_lock_token text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  removed_count integer;
BEGIN
  IF p_job NOT IN ('catalog', 'sales-stock', 'outbound-queue', 'activation') THEN
    RETURN false;
  END IF;

  DELETE FROM public.agora_dispatch_locks
  WHERE connection_id = p_connection_id
    AND lock_token = p_lock_token;
  GET DIAGNOSTICS removed_count = ROW_COUNT;
  RETURN removed_count > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.acquire_agora_dispatch_lock(uuid, text, text, integer)
  FROM PUBLIC, authenticated, service_role;
REVOKE ALL ON FUNCTION public.release_agora_dispatch_lock(uuid, text, text)
  FROM PUBLIC, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.acquire_agora_dispatch_lock(uuid, text, text, integer)
  TO middleware_runtime;
GRANT EXECUTE ON FUNCTION public.release_agora_dispatch_lock(uuid, text, text)
  TO middleware_runtime;

ALTER TABLE public.stock_sync_log
  DROP CONSTRAINT IF EXISTS stock_sync_log_sales_line_item_id_fkey;
ALTER TABLE public.stock_sync_log
  ADD CONSTRAINT stock_sync_log_sales_line_item_id_fkey
  FOREIGN KEY (sales_line_item_id)
  REFERENCES public.sales_line_items(id)
  ON DELETE SET NULL;

COMMENT ON COLUMN public.stock_sync_log.sales_line_item_id IS
  'Optional source line reference. Set to NULL when an Agora snapshot refresh replaces the line; the durable idempotency claim remains.';

COMMIT;
