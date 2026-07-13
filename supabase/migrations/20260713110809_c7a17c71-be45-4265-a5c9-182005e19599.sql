ALTER TABLE public.sales_line_items
  ADD COLUMN IF NOT EXISTS provider_sold_at timestamp without time zone,
  ADD COLUMN IF NOT EXISTS provider_sold_at_source text;

CREATE INDEX IF NOT EXISTS idx_sales_line_items_connection_provider_sold_at
  ON public.sales_line_items(connection_id, provider_sold_at)
  WHERE provider_sold_at IS NOT NULL;