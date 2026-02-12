
-- Sales events (one per Invoice/document)
CREATE TABLE public.sales_events (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  connection_id UUID NOT NULL REFERENCES public.pos_connections(id) ON DELETE CASCADE,
  provider_doc_id TEXT NOT NULL,
  business_day DATE NOT NULL,
  doc_type TEXT NOT NULL DEFAULT 'BasicInvoice',
  total_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_tax NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_net NUMERIC(12,2) NOT NULL DEFAULT 0,
  line_count INTEGER NOT NULL DEFAULT 0,
  raw_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(connection_id, provider_doc_id)
);

ALTER TABLE public.sales_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all select on sales_events" ON public.sales_events FOR SELECT USING (true);
CREATE POLICY "Allow all insert on sales_events" ON public.sales_events FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow all update on sales_events" ON public.sales_events FOR UPDATE USING (true);
CREATE POLICY "Allow all delete on sales_events" ON public.sales_events FOR DELETE USING (true);

-- Sales line items (one per Line inside InvoiceItems)
CREATE TABLE public.sales_line_items (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  sales_event_id UUID NOT NULL REFERENCES public.sales_events(id) ON DELETE CASCADE,
  connection_id UUID NOT NULL REFERENCES public.pos_connections(id) ON DELETE CASCADE,
  provider_product_id TEXT,
  name TEXT NOT NULL,
  format TEXT,
  family TEXT,
  quantity NUMERIC(10,3) NOT NULL DEFAULT 0,
  unit_price NUMERIC(10,2) NOT NULL DEFAULT 0,
  total_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  vat_rate NUMERIC(5,2) NOT NULL DEFAULT 0,
  is_wine_candidate BOOLEAN NOT NULL DEFAULT false,
  winerim_product_id TEXT,
  mapped BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.sales_line_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all select on sales_line_items" ON public.sales_line_items FOR SELECT USING (true);
CREATE POLICY "Allow all insert on sales_line_items" ON public.sales_line_items FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow all update on sales_line_items" ON public.sales_line_items FOR UPDATE USING (true);
CREATE POLICY "Allow all delete on sales_line_items" ON public.sales_line_items FOR DELETE USING (true);

-- Wine family rules (configurable per connection)
CREATE TABLE public.wine_family_rules (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  connection_id UUID NOT NULL REFERENCES public.pos_connections(id) ON DELETE CASCADE,
  family_name TEXT NOT NULL,
  is_wine BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(connection_id, family_name)
);

ALTER TABLE public.wine_family_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all select on wine_family_rules" ON public.wine_family_rules FOR SELECT USING (true);
CREATE POLICY "Allow all insert on wine_family_rules" ON public.wine_family_rules FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow all update on wine_family_rules" ON public.wine_family_rules FOR UPDATE USING (true);
CREATE POLICY "Allow all delete on wine_family_rules" ON public.wine_family_rules FOR DELETE USING (true);

-- Add last_business_day_synced to pos_connections
ALTER TABLE public.pos_connections
  ADD COLUMN IF NOT EXISTS last_business_day_synced DATE;

-- Indexes
CREATE INDEX idx_sales_events_connection_day ON public.sales_events(connection_id, business_day);
CREATE INDEX idx_sales_line_items_event ON public.sales_line_items(sales_event_id);
CREATE INDEX idx_sales_line_items_family ON public.sales_line_items(family);
CREATE INDEX idx_wine_family_rules_conn ON public.wine_family_rules(connection_id);
