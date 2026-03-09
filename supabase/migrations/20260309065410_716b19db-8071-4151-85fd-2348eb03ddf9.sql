-- Add explicit restaurant_guid column to pos_connections
-- (api_hostname is already stored as base_url)
ALTER TABLE public.pos_connections 
  ADD COLUMN IF NOT EXISTS restaurant_guid text;

-- Backfill from provider_config JSON for existing Toast connections
UPDATE public.pos_connections
SET restaurant_guid = (provider_config->>'restaurant_guid')
WHERE provider = 'toast' 
  AND provider_config->>'restaurant_guid' IS NOT NULL
  AND (restaurant_guid IS NULL OR restaurant_guid = '');