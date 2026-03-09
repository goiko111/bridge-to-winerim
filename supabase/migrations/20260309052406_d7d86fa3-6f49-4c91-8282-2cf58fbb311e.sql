-- Add explicit Toast credential columns to provider_credentials
ALTER TABLE public.provider_credentials
  ADD COLUMN IF NOT EXISTS toast_client_id TEXT,
  ADD COLUMN IF NOT EXISTS toast_client_secret TEXT,
  ADD COLUMN IF NOT EXISTS toast_access_token TEXT,
  ADD COLUMN IF NOT EXISTS toast_refresh_token TEXT,
  ADD COLUMN IF NOT EXISTS toast_expires_at TIMESTAMPTZ;

-- Migrate existing Toast connections (merchant_id → toast_client_id, refresh_token_enc → toast_client_secret, access_token_enc → toast_access_token, expires_at → toast_expires_at)
-- We identify Toast connections by joining with pos_connections where provider = 'toast'
UPDATE public.provider_credentials pc
SET 
  toast_client_id = pc.merchant_id,
  toast_client_secret = pc.refresh_token_enc,
  toast_access_token = CASE WHEN pc.access_token_enc <> 'pending' THEN pc.access_token_enc ELSE NULL END,
  toast_expires_at = pc.expires_at
FROM public.pos_connections conn
WHERE conn.id = pc.connection_id
  AND conn.provider = 'toast'
  AND pc.toast_client_id IS NULL;