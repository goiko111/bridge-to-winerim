
-- Add catalog fields to pos_connections
ALTER TABLE public.pos_connections
  ADD COLUMN IF NOT EXISTS catalog_endpoint text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS last_catalog_sync_at timestamptz DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS catalog_product_count integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS catalog_wine_candidate_count integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS catalog_sync_enabled boolean DEFAULT true;

-- Create provider_products table
CREATE TABLE public.provider_products (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  connection_id uuid NOT NULL REFERENCES public.pos_connections(id) ON DELETE CASCADE,
  provider_product_id text NOT NULL,
  name text NOT NULL,
  family text,
  vat_rate numeric DEFAULT 0,
  sale_format text,
  price numeric DEFAULT 0,
  is_wine_candidate boolean DEFAULT false,
  wine_score integer DEFAULT 0,
  wine_reasons text[] DEFAULT '{}',
  raw_payload jsonb,
  provider_updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(connection_id, provider_product_id)
);

-- Enable RLS
ALTER TABLE public.provider_products ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all select on provider_products" ON public.provider_products FOR SELECT USING (true);
CREATE POLICY "Allow all insert on provider_products" ON public.provider_products FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow all update on provider_products" ON public.provider_products FOR UPDATE USING (true);
CREATE POLICY "Allow all delete on provider_products" ON public.provider_products FOR DELETE USING (true);

-- Trigger for updated_at
CREATE TRIGGER update_provider_products_updated_at
  BEFORE UPDATE ON public.provider_products
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();
