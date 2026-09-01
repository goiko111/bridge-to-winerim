-- Middleware incident control for external POS/API outages.
-- Incidents are visible to authenticated operators; recipient/contact data and
-- full email attempts stay service-role only.

CREATE TABLE IF NOT EXISTS public.middleware_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES public.pos_connections(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'agora',
  incident_type text NOT NULL CHECK (incident_type IN (
    'AGORA_PUBLIC_ROUTER_404',
    'AGORA_API_UNREACHABLE',
    'AGORA_API_UNHEALTHY'
  )),
  severity text NOT NULL DEFAULT 'error' CHECK (severity IN ('warning', 'error', 'critical')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN (
    'open',
    'awaiting_external',
    'monitoring_recovery',
    'recovering',
    'resolved'
  )),
  dedupe_key text NOT NULL,
  title text NOT NULL,
  summary text NOT NULL,
  diagnosis jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_detected_at timestamptz NOT NULL DEFAULT now(),
  last_detected_at timestamptz NOT NULL DEFAULT now(),
  last_probe_at timestamptz,
  resolved_at timestamptz,
  first_notified_at timestamptz,
  last_notification_sent_at timestamptz,
  last_email_attempt_at timestamptz,
  next_followup_at timestamptz,
  followup_count integer NOT NULL DEFAULT 0,
  email_status text NOT NULL DEFAULT 'pending' CHECK (email_status IN (
    'pending',
    'sent',
    'failed',
    'skipped_no_provider',
    'skipped_no_recipients'
  )),
  email_message_id text,
  email_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.middleware_incidents ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON public.middleware_incidents TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.middleware_incidents TO service_role;

DROP POLICY IF EXISTS "Authenticated users can view middleware incidents"
  ON public.middleware_incidents;
CREATE POLICY "Authenticated users can view middleware incidents"
  ON public.middleware_incidents
  FOR SELECT
  TO authenticated
  USING (true);

CREATE UNIQUE INDEX IF NOT EXISTS idx_middleware_incidents_open_dedupe
  ON public.middleware_incidents(connection_id, dedupe_key)
  WHERE status <> 'resolved';

CREATE INDEX IF NOT EXISTS idx_middleware_incidents_status_last_detected
  ON public.middleware_incidents(status, last_detected_at DESC);

CREATE INDEX IF NOT EXISTS idx_middleware_incidents_connection
  ON public.middleware_incidents(connection_id, last_detected_at DESC);

DROP TRIGGER IF EXISTS update_middleware_incidents_updated_at
  ON public.middleware_incidents;
CREATE TRIGGER update_middleware_incidents_updated_at
  BEFORE UPDATE ON public.middleware_incidents
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE IF NOT EXISTS public.middleware_incident_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL REFERENCES public.middleware_incidents(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES public.pos_connections(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN (
    'detected',
    'email_sent',
    'email_failed',
    'email_skipped',
    'followup_sent',
    'probe_ok',
    'reconnected',
    'resolved',
    'note'
  )),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.middleware_incident_events ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.middleware_incident_events TO service_role;

CREATE INDEX IF NOT EXISTS idx_middleware_incident_events_incident
  ON public.middleware_incident_events(incident_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_middleware_incident_events_connection
  ON public.middleware_incident_events(connection_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.middleware_incident_email_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL REFERENCES public.middleware_incidents(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES public.pos_connections(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'resend',
  from_email text NOT NULL,
  to_emails text[] NOT NULL DEFAULT '{}',
  cc_emails text[] NOT NULL DEFAULT '{}',
  subject text NOT NULL,
  body_preview text,
  status text NOT NULL CHECK (status IN (
    'pending',
    'sent',
    'failed',
    'skipped_no_provider',
    'skipped_no_recipients'
  )),
  provider_message_id text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.middleware_incident_email_attempts ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.middleware_incident_email_attempts TO service_role;

CREATE INDEX IF NOT EXISTS idx_middleware_incident_email_attempts_incident
  ON public.middleware_incident_email_attempts(incident_id, created_at DESC);

COMMENT ON TABLE public.middleware_incidents IS
  'Controlled operational incidents opened by middleware health checks. Deduplicates outage emails and tracks recovery/follow-up.';

COMMENT ON TABLE public.middleware_incident_email_attempts IS
  'Service-role-only audit trail of operational emails generated for middleware incidents.';
