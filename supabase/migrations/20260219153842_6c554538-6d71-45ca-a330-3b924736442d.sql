
-- Table to log every stock sync attempt
CREATE TABLE public.stock_sync_log (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  connection_id UUID NOT NULL,
  sales_event_id UUID REFERENCES public.sales_events(id) ON DELETE CASCADE,
  sales_line_item_id UUID REFERENCES public.sales_line_items(id) ON DELETE CASCADE,
  provider_product_id TEXT,
  winerim_product_id TEXT,
  product_name TEXT NOT NULL,
  quantity NUMERIC NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'PENDING', -- PENDING, SUCCESS, FAILED, SKIPPED
  error_message TEXT,
  winerim_response JSONB,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  synced_at TIMESTAMP WITH TIME ZONE
);

ALTER TABLE public.stock_sync_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all select on stock_sync_log" ON public.stock_sync_log FOR SELECT USING (true);
CREATE POLICY "Allow all insert on stock_sync_log" ON public.stock_sync_log FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow all update on stock_sync_log" ON public.stock_sync_log FOR UPDATE USING (true);
CREATE POLICY "Allow all delete on stock_sync_log" ON public.stock_sync_log FOR DELETE USING (true);

-- Index for quick lookups
CREATE INDEX idx_stock_sync_log_connection ON public.stock_sync_log(connection_id, status);
CREATE INDEX idx_stock_sync_log_event ON public.stock_sync_log(sales_event_id);
