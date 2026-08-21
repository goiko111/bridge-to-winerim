CREATE TABLE IF NOT EXISTS public.agora_sales_variant_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES public.pos_connections(id) ON DELETE CASCADE,
  provider_product_id text NOT NULL,
  sale_format_id text NOT NULL,
  provider_product_name text NOT NULL,
  provider_sale_format_name text NOT NULL,
  winerim_wine_id text NOT NULL,
  format_type text NOT NULL CHECK (format_type IN ('BOTTLE','GLASS','MAGNUM','OTHER')),
  match_method text NOT NULL,
  status text NOT NULL DEFAULT 'CONFIRMED' CHECK (status IN ('CONFIRMED','BLOCKED','REJECTED')),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(connection_id, provider_product_id, sale_format_id)
);
GRANT ALL ON public.agora_sales_variant_mappings TO service_role;
ALTER TABLE public.agora_sales_variant_mappings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.agora_sales_variant_mappings FROM anon, authenticated;
CREATE INDEX IF NOT EXISTS idx_agora_sales_variant_mappings_lookup ON public.agora_sales_variant_mappings(connection_id, provider_product_id, sale_format_id) WHERE status='CONFIRMED';
CREATE TRIGGER update_agora_sales_variant_mappings_updated_at BEFORE UPDATE ON public.agora_sales_variant_mappings FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();