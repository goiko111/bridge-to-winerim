
-- Delete orphaned line items and sales events with empty provider_doc_id
DELETE FROM public.sales_line_items 
WHERE sales_event_id IN (
  SELECT id FROM public.sales_events WHERE provider_doc_id = ''
);

DELETE FROM public.sales_events WHERE provider_doc_id = '';

-- Reset last_business_day_synced so auto-sync re-fetches all days
UPDATE public.pos_connections 
SET last_business_day_synced = NULL 
WHERE provider = 'agora';
