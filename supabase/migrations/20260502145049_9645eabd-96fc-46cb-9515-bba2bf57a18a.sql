UPDATE public.winerim_push_tracking
SET sync_status = 'NOT_PUSHED',
    task_id = NULL,
    last_error = NULL,
    updated_at = now()
WHERE sync_status = 'QUEUED'
  AND (task_id IS NULL OR task_id NOT IN (
    SELECT id FROM public.outbound_tasks WHERE status IN ('QUEUED','RUNNING')
  ));