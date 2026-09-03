BEGIN;

CREATE TABLE public.integration_monitoring_policies (
  connection_id uuid PRIMARY KEY REFERENCES public.pos_connections(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  timezone text NOT NULL DEFAULT 'Europe/Madrid',
  weekly_schedule jsonb,
  offline_grace_minutes integer NOT NULL DEFAULT 30 CHECK (offline_grace_minutes BETWEEN 0 AND 180),
  p0_after_minutes integer NOT NULL DEFAULT 20 CHECK (p0_after_minutes BETWEEN 10 AND 240),
  healthy_cycles_required integer NOT NULL DEFAULT 2 CHECK (healthy_cycles_required BETWEEN 2 AND 6),
  max_cycle_age_minutes integer NOT NULL DEFAULT 12 CHECK (max_cycle_age_minutes BETWEEN 5 AND 30),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT integration_monitoring_policies_schedule_object
    CHECK (weekly_schedule IS NULL OR jsonb_typeof(weekly_schedule) = 'object')
);

COMMENT ON COLUMN public.integration_monitoring_policies.weekly_schedule IS
  'Null means fail-safe 24x7 monitoring. Explicit keys mon..sun contain [{start:HH:MM,end:HH:MM}] windows in timezone.';

CREATE TRIGGER update_integration_monitoring_policies_updated_at
  BEFORE UPDATE ON public.integration_monitoring_policies
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.integration_certification_snapshots (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  connection_id uuid NOT NULL REFERENCES public.pos_connections(id) ON DELETE CASCADE,
  state text NOT NULL CHECK (state IN ('ONLINE_OK', 'OFFLINE_EXPECTED', 'CATCHUP_PENDING', 'DEGRADED', 'P0')),
  service_window_state text NOT NULL CHECK (service_window_state IN ('ACTIVE', 'INACTIVE', 'UNCONFIGURED')),
  healthy_cycle_streak integer NOT NULL DEFAULT 0 CHECK (healthy_cycle_streak BETWEEN 0 AND 6),
  writer_ok boolean NOT NULL,
  connectivity_ok boolean NOT NULL,
  catalog_ok boolean NOT NULL,
  sales_ok boolean NOT NULL,
  stock_ok boolean NOT NULL,
  queue_ok boolean NOT NULL,
  cursor_ok boolean NOT NULL,
  reasons text[] NOT NULL DEFAULT '{}',
  evidence jsonb NOT NULL DEFAULT '{}',
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, observed_at)
);

CREATE INDEX integration_certification_snapshots_connection_time_idx
  ON public.integration_certification_snapshots(connection_id, observed_at DESC);
CREATE INDEX integration_certification_snapshots_state_time_idx
  ON public.integration_certification_snapshots(state, observed_at DESC);

CREATE VIEW public.integration_certification_latest
WITH (security_invoker = true) AS
SELECT DISTINCT ON (snapshot.connection_id) snapshot.*
FROM public.integration_certification_snapshots snapshot
ORDER BY snapshot.connection_id, snapshot.observed_at DESC, snapshot.id DESC;

ALTER TABLE public.integration_monitoring_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integration_certification_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY middleware_runtime_monitoring_policy_select
  ON public.integration_monitoring_policies FOR SELECT TO middleware_runtime
  USING (EXISTS (
    SELECT 1 FROM public.runtime_canary_connections scope
    WHERE scope.connection_id = integration_monitoring_policies.connection_id
      AND scope.status = 'ACTIVE' AND scope.active = true
      AND scope.approved_at <= now() AND scope.expires_at > now()
  ));
CREATE POLICY middleware_runtime_certification_snapshot_select
  ON public.integration_certification_snapshots FOR SELECT TO middleware_runtime
  USING (EXISTS (
    SELECT 1 FROM public.runtime_canary_connections scope
    WHERE scope.connection_id = integration_certification_snapshots.connection_id
      AND scope.status = 'ACTIVE' AND scope.active = true
      AND scope.approved_at <= now() AND scope.expires_at > now()
  ));
CREATE POLICY middleware_runtime_certification_snapshot_insert
  ON public.integration_certification_snapshots FOR INSERT TO middleware_runtime
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.runtime_canary_connections scope
    WHERE scope.connection_id = integration_certification_snapshots.connection_id
      AND scope.status = 'ACTIVE' AND scope.active = true
      AND scope.approved_at <= now() AND scope.expires_at > now()
  ));

REVOKE ALL ON public.integration_monitoring_policies FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.integration_certification_snapshots FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.integration_certification_latest FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.integration_monitoring_policies TO middleware_runtime, middleware_api, middleware_readonly;
GRANT SELECT, INSERT ON public.integration_certification_snapshots TO middleware_runtime;
GRANT SELECT ON public.integration_certification_snapshots TO middleware_api, middleware_readonly;
GRANT USAGE, SELECT ON SEQUENCE public.integration_certification_snapshots_id_seq TO middleware_runtime;
GRANT SELECT ON public.integration_certification_latest TO middleware_runtime, middleware_api, middleware_readonly;

COMMIT;
