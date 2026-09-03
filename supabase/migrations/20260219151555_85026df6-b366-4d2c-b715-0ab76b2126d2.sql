
-- Classification config per connection
CREATE TABLE public.classification_config (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  connection_id uuid NOT NULL REFERENCES public.pos_connections(id) ON DELETE CASCADE,
  wine_families_whitelist text[] NOT NULL DEFAULT '{}',
  non_wine_families_blacklist text[] NOT NULL DEFAULT '{}',
  wine_keywords_whitelist text[] NOT NULL DEFAULT '{}',
  non_wine_keywords_blacklist text[] NOT NULL DEFAULT '{}',
  format_whitelist text[] NOT NULL DEFAULT '{}',
  min_wine_price numeric NOT NULL DEFAULT 6,
  max_wine_price numeric NOT NULL DEFAULT 600,
  score_threshold_wine int NOT NULL DEFAULT 40,
  score_threshold_not_wine int NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE(connection_id)
);

ALTER TABLE public.classification_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all select on classification_config" ON public.classification_config FOR SELECT USING (true);
CREATE POLICY "Allow all insert on classification_config" ON public.classification_config FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow all update on classification_config" ON public.classification_config FOR UPDATE USING (true);
CREATE POLICY "Allow all delete on classification_config" ON public.classification_config FOR DELETE USING (true);

CREATE TRIGGER update_classification_config_updated_at
  BEFORE UPDATE ON public.classification_config
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Add classification fields to provider_products
ALTER TABLE public.provider_products
  ADD COLUMN IF NOT EXISTS classification_override text NOT NULL DEFAULT 'AUTO',
  ADD COLUMN IF NOT EXISTS last_score int DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_reasons text[] DEFAULT '{}';
