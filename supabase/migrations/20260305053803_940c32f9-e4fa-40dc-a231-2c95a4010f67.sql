ALTER TABLE public.winerim_wines 
  ADD COLUMN IF NOT EXISTS pricing_status text NOT NULL DEFAULT 'MISSING',
  ADD COLUMN IF NOT EXISTS pricing_missing_reason text DEFAULT NULL;