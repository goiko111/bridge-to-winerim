
-- 1) Provider Capabilities table
CREATE TABLE public.provider_capabilities (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  connection_id uuid NOT NULL REFERENCES public.pos_connections(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'AGORA',
  can_read_sales boolean NOT NULL DEFAULT true,
  can_read_catalog boolean NOT NULL DEFAULT false,
  can_write_products text NOT NULL DEFAULT 'UNKNOWN' CHECK (can_write_products IN ('UNKNOWN','YES','NO')),
  write_endpoint text,
  write_endpoints_json jsonb,
  last_checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(connection_id)
);
ALTER TABLE public.provider_capabilities ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all select on provider_capabilities" ON public.provider_capabilities FOR SELECT USING (true);
CREATE POLICY "Allow all insert on provider_capabilities" ON public.provider_capabilities FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow all update on provider_capabilities" ON public.provider_capabilities FOR UPDATE USING (true);
CREATE POLICY "Allow all delete on provider_capabilities" ON public.provider_capabilities FOR DELETE USING (true);

-- 2) Outbound Tasks table
CREATE TABLE public.outbound_tasks (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  connection_id uuid NOT NULL REFERENCES public.pos_connections(id) ON DELETE CASCADE,
  task_type text NOT NULL DEFAULT 'AGORA_UPSERT_PRODUCT',
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','RUNNING','SUCCESS','FAILED','BLOCKED')),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  last_error text,
  external_id text,
  blocked_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.outbound_tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all select on outbound_tasks" ON public.outbound_tasks FOR SELECT USING (true);
CREATE POLICY "Allow all insert on outbound_tasks" ON public.outbound_tasks FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow all update on outbound_tasks" ON public.outbound_tasks FOR UPDATE USING (true);
CREATE POLICY "Allow all delete on outbound_tasks" ON public.outbound_tasks FOR DELETE USING (true);

-- 3) Add outbound sync columns to pos_connections
ALTER TABLE public.pos_connections 
  ADD COLUMN IF NOT EXISTS default_wine_family_name text DEFAULT 'Vinos',
  ADD COLUMN IF NOT EXISTS default_vat_rate numeric DEFAULT 10,
  ADD COLUMN IF NOT EXISTS default_bottle_format_name text DEFAULT 'BOT',
  ADD COLUMN IF NOT EXISTS default_glass_format_name text DEFAULT 'COPA';

-- 4) Add sync_status columns to provider_products
ALTER TABLE public.provider_products
  ADD COLUMN IF NOT EXISTS sync_status text NOT NULL DEFAULT 'NOT_SYNCED' CHECK (sync_status IN ('NOT_SYNCED','SYNCED','BLOCKED','ERROR')),
  ADD COLUMN IF NOT EXISTS sync_error text,
  ADD COLUMN IF NOT EXISTS last_synced_at timestamptz,
  ADD COLUMN IF NOT EXISTS winerim_wine_id text;

-- Triggers for updated_at
CREATE TRIGGER update_provider_capabilities_updated_at
  BEFORE UPDATE ON public.provider_capabilities
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_outbound_tasks_updated_at
  BEFORE UPDATE ON public.outbound_tasks
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
