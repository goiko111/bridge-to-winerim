\set ON_ERROR_STOP on

BEGIN;

DROP VIEW IF EXISTS public.integration_certification_latest;
DROP TABLE IF EXISTS public.integration_certification_snapshots;
DROP TABLE IF EXISTS public.integration_monitoring_policies;

COMMIT;
