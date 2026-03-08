
ALTER TABLE public.provider_capabilities
  ADD COLUMN IF NOT EXISTS webhook_supported boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS readiness_status text NOT NULL DEFAULT 'NOT_CONNECTED',
  ADD COLUMN IF NOT EXISTS last_verified_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS write_mode text NOT NULL DEFAULT 'NONE';
