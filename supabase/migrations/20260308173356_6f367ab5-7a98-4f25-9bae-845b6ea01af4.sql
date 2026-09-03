
-- Add unique constraint on sales_events for idempotent upserts
ALTER TABLE public.sales_events 
ADD CONSTRAINT sales_events_connection_provider_doc_unique 
UNIQUE (connection_id, provider_doc_id);

-- Add unique constraint on sales_line_items for idempotent upserts
ALTER TABLE public.sales_line_items 
ADD CONSTRAINT sales_line_items_event_provider_product_unique 
UNIQUE (sales_event_id, provider_product_id);
