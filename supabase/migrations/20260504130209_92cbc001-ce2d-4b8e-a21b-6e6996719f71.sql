CREATE OR REPLACE FUNCTION public.rescue_zombie_outbound_tasks()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rescued_count integer;
BEGIN
  WITH updated AS (
    UPDATE public.outbound_tasks
    SET status = 'QUEUED',
        last_error = COALESCE(last_error, '') || ' | RESCUED: was stuck in RUNNING > 15min',
        updated_at = now()
    WHERE status = 'RUNNING'
      AND updated_at < now() - interval '15 minutes'
    RETURNING id
  )
  SELECT COUNT(*) INTO rescued_count FROM updated;
  RETURN rescued_count;
END;
$$;