ALTER TABLE public.winerim_wines
  ADD COLUMN IF NOT EXISTS glass_stock_id  bigint,
  ADD COLUMN IF NOT EXISTS bottle_stock_id bigint,
  ADD COLUMN IF NOT EXISTS magnum_stock_id bigint;