
-- Set last_business_day_synced to 2026-04-13 so only 2026-04-14 gets synced
UPDATE public.pos_connections 
SET last_business_day_synced = '2026-04-13'
WHERE provider = 'agora' AND id = 'f1ce42a4-ffe2-44ea-bb3d-e22b306b1d8c';
