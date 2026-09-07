CREATE TABLE public.winerim_wine_formats (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  connection_id uuid NOT NULL,
  winerim_id text NOT NULL,
  format_key text NOT NULL,
  source_variant text,
  sale_price numeric,
  cost_price numeric,
  stock_id bigint,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (connection_id, winerim_id, format_key)
);

CREATE INDEX idx_winerim_wine_formats_conn_format ON public.winerim_wine_formats (connection_id, format_key);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.winerim_wine_formats TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.winerim_wine_formats TO anon;
GRANT ALL ON public.winerim_wine_formats TO service_role;

ALTER TABLE public.winerim_wine_formats ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all select on winerim_wine_formats" ON public.winerim_wine_formats FOR SELECT USING (true);
CREATE POLICY "Allow all insert on winerim_wine_formats" ON public.winerim_wine_formats FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow all update on winerim_wine_formats" ON public.winerim_wine_formats FOR UPDATE USING (true);
CREATE POLICY "Allow all delete on winerim_wine_formats" ON public.winerim_wine_formats FOR DELETE USING (true);

CREATE TRIGGER update_winerim_wine_formats_updated_at
BEFORE UPDATE ON public.winerim_wine_formats
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();