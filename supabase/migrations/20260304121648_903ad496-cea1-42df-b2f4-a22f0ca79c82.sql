
ALTER TABLE public.pos_connections 
  ADD COLUMN IF NOT EXISTS auto_push_on_create boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_push_on_update boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_push_bottle boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS auto_push_glass boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS require_manual_review_before_push boolean NOT NULL DEFAULT true;
