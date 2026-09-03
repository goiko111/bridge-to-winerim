
-- Cache of Winerim wine catalog
CREATE TABLE public.winerim_wines (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  connection_id UUID NOT NULL,
  winerim_id TEXT NOT NULL,
  name TEXT NOT NULL,
  sku TEXT,
  ean TEXT,
  vintage TEXT,
  winery TEXT,
  region TEXT,
  grape_variety TEXT,
  format TEXT,
  price NUMERIC,
  stock_quantity NUMERIC,
  raw_payload JSONB,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(connection_id, winerim_id)
);

ALTER TABLE public.winerim_wines ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all select on winerim_wines" ON public.winerim_wines FOR SELECT USING (true);
CREATE POLICY "Allow all insert on winerim_wines" ON public.winerim_wines FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow all update on winerim_wines" ON public.winerim_wines FOR UPDATE USING (true);
CREATE POLICY "Allow all delete on winerim_wines" ON public.winerim_wines FOR DELETE USING (true);

-- Product mapping table (POS product <-> Winerim wine)
CREATE TABLE public.product_mappings (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  connection_id UUID NOT NULL,
  provider_product_id TEXT NOT NULL,
  provider_product_name TEXT NOT NULL,
  winerim_wine_id TEXT,
  winerim_wine_name TEXT,
  match_method TEXT NOT NULL DEFAULT 'MANUAL', -- SKU, FUZZY, AI, MANUAL
  match_score NUMERIC DEFAULT 0,
  match_reasons TEXT[] DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'PENDING', -- PENDING, CONFIRMED, REJECTED, IGNORED
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(connection_id, provider_product_id)
);

ALTER TABLE public.product_mappings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all select on product_mappings" ON public.product_mappings FOR SELECT USING (true);
CREATE POLICY "Allow all insert on product_mappings" ON public.product_mappings FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow all update on product_mappings" ON public.product_mappings FOR UPDATE USING (true);
CREATE POLICY "Allow all delete on product_mappings" ON public.product_mappings FOR DELETE USING (true);

-- Trigger for updated_at
CREATE TRIGGER update_winerim_wines_updated_at
  BEFORE UPDATE ON public.winerim_wines
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_product_mappings_updated_at
  BEFORE UPDATE ON public.product_mappings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
