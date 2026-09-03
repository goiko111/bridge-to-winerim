ALTER TABLE public.stock_sync_log
  DROP CONSTRAINT IF EXISTS stock_sync_log_sales_line_item_id_fkey;

ALTER TABLE public.stock_sync_log
  ADD CONSTRAINT stock_sync_log_sales_line_item_id_fkey
  FOREIGN KEY (sales_line_item_id)
  REFERENCES public.sales_line_items(id)
  ON DELETE SET NULL;

COMMENT ON COLUMN public.stock_sync_log.sales_line_item_id IS
  'Optional source line reference. Set to NULL when an Agora snapshot refresh replaces the line; the durable idempotency claim remains.';