
CREATE TABLE public.wine_type_family_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id UUID NOT NULL REFERENCES public.pos_connections(id) ON DELETE CASCADE,
  mapping_key TEXT NOT NULL,
  agora_family_id TEXT,
  agora_family_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(connection_id, mapping_key)
);

ALTER TABLE public.wine_type_family_mappings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all select on wine_type_family_mappings" ON public.wine_type_family_mappings FOR SELECT USING (true);
CREATE POLICY "Allow all insert on wine_type_family_mappings" ON public.wine_type_family_mappings FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow all update on wine_type_family_mappings" ON public.wine_type_family_mappings FOR UPDATE USING (true);
CREATE POLICY "Allow all delete on wine_type_family_mappings" ON public.wine_type_family_mappings FOR DELETE USING (true);
