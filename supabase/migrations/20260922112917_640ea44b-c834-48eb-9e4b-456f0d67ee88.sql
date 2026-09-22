ALTER TABLE public.catalog_review_decisions
  ADD COLUMN IF NOT EXISTS force_ready boolean NOT NULL DEFAULT false;

UPDATE public.catalog_review_decisions
  SET force_ready = false
  WHERE force_ready IS NULL;
