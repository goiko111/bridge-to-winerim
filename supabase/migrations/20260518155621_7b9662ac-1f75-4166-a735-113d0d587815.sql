UPDATE public.outbound_tasks
SET status='BLOCKED',
    blocked_reason='Runaway loop: 11k+ attempts with TypeError: unexpected end of file. Force-blocked.',
    next_retry_at=NULL,
    updated_at=now()
WHERE id='4b2e7c20-ce5e-4c04-9b3d-b775baab835c';