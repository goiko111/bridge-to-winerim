
CREATE TABLE public.winerim_push_tracking (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  connection_id UUID NOT NULL REFERENCES public.pos_connections(id) ON DELETE CASCADE,
  winerim_wine_id TEXT NOT NULL,
  format TEXT NOT NULL DEFAULT 'BOTTLE',
  agora_product_id TEXT,
  agora_family_id TEXT,
  source TEXT NOT NULL DEFAULT 'WINERIM',
  sync_status TEXT NOT NULL DEFAULT 'NOT_PUSHED',
  last_error TEXT,
  task_id UUID,
  pushed_at TIMESTAMP WITH TIME ZONE,
  verified_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE (connection_id, winerim_wine_id, format)
);

ALTER TABLE public.winerim_push_tracking ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all select on winerim_push_tracking" ON public.winerim_push_tracking FOR SELECT TO public USING (true);
CREATE POLICY "Allow all insert on winerim_push_tracking" ON public.winerim_push_tracking FOR INSERT TO public WITH CHECK (true);
CREATE POLICY "Allow all update on winerim_push_tracking" ON public.winerim_push_tracking FOR UPDATE TO public USING (true);
CREATE POLICY "Allow all delete on winerim_push_tracking" ON public.winerim_push_tracking FOR DELETE TO public USING (true);
