ALTER TABLE public.agora_master_data 
  ADD COLUMN IF NOT EXISTS sale_points_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS sale_centers_json jsonb NOT NULL DEFAULT '[]'::jsonb;