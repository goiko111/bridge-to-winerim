UPDATE outbound_tasks
SET status='SUCCESS',
    last_error='Resolved: client confirmed WINERIM families are the final categories - no migration needed',
    updated_at=now()
WHERE connection_id='c9b23830-a00b-4786-a50b-43fe526c4d3c'
  AND task_type='AGORA_MIGRATE_FAMILY'
  AND status IN ('FAILED','QUEUED');