\set ON_ERROR_STOP on

BEGIN;

DO $runtime_sales_column_privileges_preflight$
BEGIN
  IF to_regclass('public.sales_events') IS NULL THEN
    RAISE EXCEPTION 'public.sales_events is required before migration 0008';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'middleware_runtime'
      AND rolcanlogin = false
      AND rolsuper = false
      AND rolbypassrls = false
  ) THEN
    RAISE EXCEPTION 'middleware_runtime must be a hardened NOLOGIN role';
  END IF;
END
$runtime_sales_column_privileges_preflight$;

REVOKE UPDATE ON public.sales_events FROM middleware_runtime;
GRANT UPDATE (
  business_day,
  doc_type,
  total_amount,
  total_tax,
  total_net,
  line_count,
  raw_json
) ON public.sales_events TO middleware_runtime;

COMMIT;
