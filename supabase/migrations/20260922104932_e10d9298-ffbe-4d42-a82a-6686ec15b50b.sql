ALTER TABLE public.catalog_review_decisions DROP CONSTRAINT IF EXISTS catalog_review_decisions_status_check;
ALTER TABLE public.catalog_review_decisions ADD CONSTRAINT catalog_review_decisions_status_check CHECK (status = ANY (ARRAY['DRAFT'::text,'READY_FOR_APPROVAL'::text,'NO_MATCH'::text,'NEEDS_CONFIRMATION'::text,'APPLIED'::text]));
ALTER TABLE public.catalog_review_decisions ADD COLUMN IF NOT EXISTS applied_at timestamptz;
ALTER TABLE public.catalog_review_decisions ADD COLUMN IF NOT EXISTS applied_by uuid;
ALTER TABLE public.catalog_review_decisions ADD COLUMN IF NOT EXISTS applied_mapping_id uuid;