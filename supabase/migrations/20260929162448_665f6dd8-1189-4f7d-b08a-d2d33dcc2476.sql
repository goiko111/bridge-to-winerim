CREATE TABLE public.winerim_cancel_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES public.pos_connections(id) ON DELETE CASCADE,
  correlation_id text NOT NULL UNIQUE,
  payload jsonb NOT NULL,
  eligibility jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'PENDING_APPROVAL' CHECK (status IN ('PENDING_APPROVAL','APPROVED','EXECUTING','DONE','NEEDS_READBACK','MANUAL','FAILED','REJECTED')),
  requested_by uuid NOT NULL,
  approved_by uuid,
  approved_at timestamptz,
  executed_at timestamptz,
  response jsonb,
  readback jsonb,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (approved_by IS NULL OR approved_by <> requested_by)
);
GRANT SELECT ON public.winerim_cancel_requests TO authenticated;
GRANT ALL ON public.winerim_cancel_requests TO service_role;
ALTER TABLE public.winerim_cancel_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Platform admins read cancel requests" ON public.winerim_cancel_requests FOR SELECT TO authenticated USING (public.is_platform_admin());
CREATE TRIGGER winerim_cancel_requests_updated_at BEFORE UPDATE ON public.winerim_cancel_requests FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();