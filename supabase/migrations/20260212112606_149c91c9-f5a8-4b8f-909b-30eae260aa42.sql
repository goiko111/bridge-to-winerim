
-- Table to store per-location POS integration configs
CREATE TABLE public.pos_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_name TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'agora',
  base_url TEXT NOT NULL,
  api_token TEXT NOT NULL,
  sync_mode TEXT NOT NULL DEFAULT 'PULL_ONLY',
  sync_frequency_minutes INTEGER NOT NULL DEFAULT 15,
  backfill_days INTEGER NOT NULL DEFAULT 30,
  enabled BOOLEAN NOT NULL DEFAULT false,
  last_sync_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.pos_connections ENABLE ROW LEVEL SECURITY;

-- For now, allow all authenticated users (we'll refine with org-based access later)
CREATE POLICY "Authenticated users can view connections"
  ON public.pos_connections FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can insert connections"
  ON public.pos_connections FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated users can update connections"
  ON public.pos_connections FOR UPDATE TO authenticated USING (true);

CREATE POLICY "Authenticated users can delete connections"
  ON public.pos_connections FOR DELETE TO authenticated USING (true);

-- Timestamp trigger
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER update_pos_connections_updated_at
  BEFORE UPDATE ON public.pos_connections
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();
