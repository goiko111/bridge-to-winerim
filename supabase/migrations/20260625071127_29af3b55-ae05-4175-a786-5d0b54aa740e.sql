-- Persistent connection health monitoring and email alert state.
CREATE TABLE IF NOT EXISTS public.connection_health_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES public.pos_connections(id) ON DELETE CASCADE,
  provider text NOT NULL,
  location_name text NOT NULL,
  check_type text NOT NULL DEFAULT 'reachability',
  status text NOT NULL CHECK (status IN ('OK','WARN','DOWN','AUTH_ERROR','ERROR','PAUSED','STALE')),
  severity text NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warning','error','critical')),
  http_status integer,
  latency_ms integer,
  error_class text,
  error_message text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  checked_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.connection_health_checks TO anon, authenticated, service_role;

ALTER TABLE public.connection_health_checks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all select on connection_health_checks"
  ON public.connection_health_checks FOR SELECT USING (true);
CREATE POLICY "Allow all insert on connection_health_checks"
  ON public.connection_health_checks FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow all update on connection_health_checks"
  ON public.connection_health_checks FOR UPDATE USING (true);
CREATE POLICY "Allow all delete on connection_health_checks"
  ON public.connection_health_checks FOR DELETE USING (true);

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
  severity text NOT NULL CHECK (severity IN ('info','warning','error','critical')),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','ACKED','RESOLVED')),
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

GRANT SELECT, INSERT, UPDATE, DELETE ON public.connection_alerts TO anon, authenticated, service_role;

ALTER TABLE public.connection_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all select on connection_alerts"
  ON public.connection_alerts FOR SELECT USING (true);
CREATE POLICY "Allow all insert on connection_alerts"
  ON public.connection_alerts FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow all update on connection_alerts"
  ON public.connection_alerts FOR UPDATE USING (true);
CREATE POLICY "Allow all delete on connection_alerts"
  ON public.connection_alerts FOR DELETE USING (true);

CREATE UNIQUE INDEX IF NOT EXISTS idx_connection_alerts_open_key
  ON public.connection_alerts(connection_id, alert_key)
  WHERE status IN ('OPEN','ACKED');
CREATE INDEX IF NOT EXISTS idx_connection_alerts_status_seen
  ON public.connection_alerts(status, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_connection_alerts_connection_status
  ON public.connection_alerts(connection_id, status);

CREATE TRIGGER update_connection_alerts_updated_at
  BEFORE UPDATE ON public.connection_alerts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE IF NOT EXISTS public.connection_notification_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES public.pos_connections(id) ON DELETE CASCADE,
  label text NOT NULL DEFAULT 'Client',
  channel text NOT NULL DEFAULT 'email' CHECK (channel IN ('email')),
  target text NOT NULL,
  notify_client boolean NOT NULL DEFAULT true,
  notify_recovery boolean NOT NULL DEFAULT true,
  min_severity text NOT NULL DEFAULT 'warning' CHECK (min_severity IN ('info','warning','error','critical')),
  alert_types text[] NOT NULL DEFAULT '{}'::text[],
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(connection_id, channel, target)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.connection_notification_contacts TO anon, authenticated, service_role;

ALTER TABLE public.connection_notification_contacts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all select on connection_notification_contacts"
  ON public.connection_notification_contacts FOR SELECT USING (true);
CREATE POLICY "Allow all insert on connection_notification_contacts"
  ON public.connection_notification_contacts FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow all update on connection_notification_contacts"
  ON public.connection_notification_contacts FOR UPDATE USING (true);
CREATE POLICY "Allow all delete on connection_notification_contacts"
  ON public.connection_notification_contacts FOR DELETE USING (true);

CREATE INDEX IF NOT EXISTS idx_connection_notification_contacts_connection
  ON public.connection_notification_contacts(connection_id, enabled);

CREATE TRIGGER update_connection_notification_contacts_updated_at
  BEFORE UPDATE ON public.connection_notification_contacts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE FUNCTION public.invoke_connection_health_monitor(
  fn_url text,
  service_key text,
  notify_clients boolean DEFAULT true
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM net.http_post(
    url := fn_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || service_key
    ),
    body := jsonb_build_object(
      'provider', 'agora',
      'sendEmails', true,
      'notifyClients', notify_clients
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.invoke_connection_health_monitor(text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.invoke_connection_health_monitor(text, text, boolean) TO service_role;