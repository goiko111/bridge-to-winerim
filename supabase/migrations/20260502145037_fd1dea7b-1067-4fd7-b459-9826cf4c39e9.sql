UPDATE public.outbound_tasks
SET status = 'FAILED',
    last_error = 'Legacy task_type AGORA_UPSERT_PRODUCT — superseded by AGORA_XML_UPSERT_PRODUCT. Auto-push will re-queue if still needed.',
    updated_at = now()
WHERE status = 'QUEUED'
  AND task_type = 'AGORA_UPSERT_PRODUCT';