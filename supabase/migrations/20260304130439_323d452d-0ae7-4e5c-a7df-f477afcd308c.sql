
-- PRIORITY 1: Extend winerim_wines with POS-ready normalized fields
ALTER TABLE public.winerim_wines
  ADD COLUMN IF NOT EXISTS wine_type text,
  ADD COLUMN IF NOT EXISTS bottle_sale_price numeric,
  ADD COLUMN IF NOT EXISTS bottle_purchase_price numeric,
  ADD COLUMN IF NOT EXISTS glass_sale_price numeric,
  ADD COLUMN IF NOT EXISTS glass_cost_price numeric,
  ADD COLUMN IF NOT EXISTS magnum_sale_price numeric,
  ADD COLUMN IF NOT EXISTS magnum_purchase_price numeric,
  ADD COLUMN IF NOT EXISTS serve_by_glass boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

-- Add estimated_glasses_per_bottle to pos_connections
ALTER TABLE public.pos_connections
  ADD COLUMN IF NOT EXISTS estimated_glasses_per_bottle integer NOT NULL DEFAULT 5;
