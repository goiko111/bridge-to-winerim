CREATE TABLE public.integration_specifics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES public.pos_connections(id) ON DELETE CASCADE,
  category text NOT NULL DEFAULT 'OTROS',
  title text NOT NULL,
  detail text NOT NULL DEFAULT '',
  impact text NOT NULL DEFAULT 'INFO',
  status text NOT NULL DEFAULT 'OPEN',
  reported_by text,
  reported_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT integration_specifics_category_check CHECK (category IN ('CATALOGO','COMANDAS','VENTAS','STOCK','PRECIOS','OTROS')),
  CONSTRAINT integration_specifics_impact_check CHECK (impact IN ('INFO','IMPORTANTE','BLOQUEANTE')),
  CONSTRAINT integration_specifics_status_check CHECK (status IN ('OPEN','ACCEPTED','RESOLVED'))
);

CREATE INDEX integration_specifics_connection_idx ON public.integration_specifics (connection_id, status);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.integration_specifics TO authenticated;
GRANT ALL ON public.integration_specifics TO service_role;

ALTER TABLE public.integration_specifics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "specifics_select" ON public.integration_specifics FOR SELECT TO authenticated
  USING (public.is_platform_admin() OR public.can_access_connection(connection_id));
CREATE POLICY "specifics_insert" ON public.integration_specifics FOR INSERT TO authenticated
  WITH CHECK (public.is_platform_admin() OR public.can_access_connection(connection_id));
CREATE POLICY "specifics_update" ON public.integration_specifics FOR UPDATE TO authenticated
  USING (public.is_platform_admin() OR public.can_access_connection(connection_id))
  WITH CHECK (public.is_platform_admin() OR public.can_access_connection(connection_id));
CREATE POLICY "specifics_delete" ON public.integration_specifics FOR DELETE TO authenticated
  USING (public.is_platform_admin() OR public.can_access_connection(connection_id));

CREATE TRIGGER update_integration_specifics_updated_at
  BEFORE UPDATE ON public.integration_specifics
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();