
-- Provider credentials: encrypted OAuth tokens per merchant/connection
CREATE TABLE public.provider_credentials (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  connection_id UUID NOT NULL REFERENCES public.pos_connections(id) ON DELETE CASCADE,
  merchant_id TEXT NOT NULL,
  access_token_enc TEXT NOT NULL,
  refresh_token_enc TEXT,
  expires_at TIMESTAMP WITH TIME ZONE,
  scopes TEXT[] NOT NULL DEFAULT '{}',
  oauth_state TEXT,
  oauth_state_expires_at TIMESTAMP WITH TIME ZONE,
  status TEXT NOT NULL DEFAULT 'PENDING',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(connection_id)
);

-- RLS policies
ALTER TABLE public.provider_credentials ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all select on provider_credentials" ON public.provider_credentials FOR SELECT USING (true);
CREATE POLICY "Allow all insert on provider_credentials" ON public.provider_credentials FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow all update on provider_credentials" ON public.provider_credentials FOR UPDATE USING (true);
CREATE POLICY "Allow all delete on provider_credentials" ON public.provider_credentials FOR DELETE USING (true);

-- Updated_at trigger
CREATE TRIGGER update_provider_credentials_updated_at
  BEFORE UPDATE ON public.provider_credentials
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Webhook events log for dedup and async processing
CREATE TABLE public.webhook_events (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  connection_id UUID REFERENCES public.pos_connections(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'CLOVER',
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'PENDING',
  processed_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(provider, event_id)
);

ALTER TABLE public.webhook_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all select on webhook_events" ON public.webhook_events FOR SELECT USING (true);
CREATE POLICY "Allow all insert on webhook_events" ON public.webhook_events FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow all update on webhook_events" ON public.webhook_events FOR UPDATE USING (true);
CREATE POLICY "Allow all delete on webhook_events" ON public.webhook_events FOR DELETE USING (true);
