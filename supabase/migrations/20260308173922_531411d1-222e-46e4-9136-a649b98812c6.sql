
-- Add unique constraint on provider_products for idempotent catalog upserts
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'provider_products_connection_provider_id_unique'
  ) THEN
    ALTER TABLE public.provider_products
    ADD CONSTRAINT provider_products_connection_provider_id_unique
    UNIQUE (connection_id, provider_product_id);
  END IF;
END $$;
