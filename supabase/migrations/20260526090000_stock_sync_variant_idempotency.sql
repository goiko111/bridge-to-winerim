-- P0 safety migration: make Winerim stock sync idempotent per sales line and variant.
--
-- Deploy order:
-- 1) Apply this migration.
-- 2) Deploy edge functions that write variant/stock_id/idempotency_key.
--
-- Rollback order if needed:
-- 1) Deploy the previous edge functions first.
-- 2) Then run the rollback SQL documented in ROLLBACK_2026-05-26.md.

ALTER TABLE public.stock_sync_log
  ADD COLUMN IF NOT EXISTS variant TEXT,
  ADD COLUMN IF NOT EXISTS stock_id BIGINT,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE INDEX IF NOT EXISTS idx_stock_sync_log_variant
  ON public.stock_sync_log(connection_id, variant, status);

CREATE INDEX IF NOT EXISTS idx_stock_sync_log_stock_id
  ON public.stock_sync_log(connection_id, stock_id)
  WHERE stock_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_sync_log_line_variant_claim
  ON public.stock_sync_log(connection_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL
    AND status IN ('PENDING', 'SUCCESS');

CREATE OR REPLACE FUNCTION public.claim_outbound_tasks(
  p_connection_id UUID,
  p_task_types TEXT[],
  p_limit INTEGER DEFAULT 20
)
RETURNS SETOF public.outbound_tasks
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH picked AS (
    SELECT id
    FROM public.outbound_tasks
    WHERE connection_id = p_connection_id
      AND status = 'QUEUED'
      AND task_type = ANY(p_task_types)
      AND (next_retry_at IS NULL OR next_retry_at <= now())
    ORDER BY created_at
    FOR UPDATE SKIP LOCKED
    LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 20), 100))
  )
  UPDATE public.outbound_tasks t
  SET
    status = 'RUNNING',
    attempts = COALESCE(t.attempts, 0) + 1,
    updated_at = now()
  FROM picked
  WHERE t.id = picked.id
  RETURNING t.*;
END;
$$;
