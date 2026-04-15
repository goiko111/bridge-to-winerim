
-- Set Sa Pedrera and Sa Vida to re-sync from a couple days back
UPDATE public.pos_connections 
SET last_business_day_synced = '2026-04-11'
WHERE id = 'e2f6ce27-0e94-444f-9d64-09ba425a2b83';

UPDATE public.pos_connections 
SET last_business_day_synced = '2026-04-13'
WHERE id = 'e5b988f1-8471-4336-a1f7-a5c1626deab1';
