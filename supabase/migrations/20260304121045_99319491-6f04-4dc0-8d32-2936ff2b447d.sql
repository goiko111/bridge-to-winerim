
-- 1) Create agora_master_data table for caching master data from /api/export-master/
CREATE TABLE public.agora_master_data (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES public.pos_connections(id) ON DELETE CASCADE,
  families_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  vats_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  price_lists_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  preparation_types_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  preparation_orders_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  warehouses_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  products_summary_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  raw_xml_preview text,
  fetched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(connection_id)
);

ALTER TABLE public.agora_master_data ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all select on agora_master_data" ON public.agora_master_data FOR SELECT USING (true);
CREATE POLICY "Allow all insert on agora_master_data" ON public.agora_master_data FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow all update on agora_master_data" ON public.agora_master_data FOR UPDATE USING (true);
CREATE POLICY "Allow all delete on agora_master_data" ON public.agora_master_data FOR DELETE USING (true);

-- 2) Add write config columns to pos_connections
ALTER TABLE public.pos_connections
  ADD COLUMN IF NOT EXISTS write_mode text NOT NULL DEFAULT 'NONE',
  ADD COLUMN IF NOT EXISTS default_family_id text,
  ADD COLUMN IF NOT EXISTS default_vat_id text,
  ADD COLUMN IF NOT EXISTS default_preparation_type_id text,
  ADD COLUMN IF NOT EXISTS default_preparation_order_id text,
  ADD COLUMN IF NOT EXISTS default_warehouse_id text,
  ADD COLUMN IF NOT EXISTS auto_create_families boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS write_bottle boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS write_glass boolean NOT NULL DEFAULT false;

-- 3) Add format_type and agora_product_id to product_mappings for bottle/glass tracking
ALTER TABLE public.product_mappings
  ADD COLUMN IF NOT EXISTS format_type text NOT NULL DEFAULT 'BOTTLE',
  ADD COLUMN IF NOT EXISTS agora_product_id text,
  ADD COLUMN IF NOT EXISTS last_synced_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_sync_error text;

-- 4) Add updated_at trigger to agora_master_data
CREATE TRIGGER update_agora_master_data_updated_at
  BEFORE UPDATE ON public.agora_master_data
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();
