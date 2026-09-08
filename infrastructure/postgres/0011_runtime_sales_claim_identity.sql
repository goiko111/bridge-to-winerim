\set ON_ERROR_STOP on

BEGIN;

DO $runtime_sales_claim_identity_preflight$
BEGIN
  IF to_regclass('public.runtime_idempotency') IS NULL THEN
    RAISE EXCEPTION 'public.runtime_idempotency is required before migration 0011';
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
$runtime_sales_claim_identity_preflight$;

LOCK TABLE public.runtime_idempotency IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE public.runtime_idempotency
  ADD COLUMN IF NOT EXISTS sales_claim_identity text;

UPDATE public.runtime_idempotency
SET sales_claim_identity = jsonb_build_array(
  connection_id::text,
  btrim(result ->> 'lifecycleId'),
  btrim(result ->> 'winerimWineId'),
  upper(btrim(result ->> 'variant'))
)::text
WHERE job = 'sales.claim'
  AND NULLIF(btrim(result ->> 'lifecycleId'), '') IS NOT NULL
  AND NULLIF(btrim(result ->> 'winerimWineId'), '') IS NOT NULL
  AND upper(btrim(result ->> 'variant')) IN ('BOTTLE', 'GLASS', 'MAGNUM');

DO $runtime_sales_claim_identity_duplicates$
DECLARE
  duplicate_identity text;
BEGIN
  SELECT sales_claim_identity
  INTO duplicate_identity
  FROM public.runtime_idempotency
  WHERE job = 'sales.claim'
    AND sales_claim_identity IS NOT NULL
  GROUP BY sales_claim_identity
  HAVING count(*) > 1
  ORDER BY sales_claim_identity
  LIMIT 1;

  IF duplicate_identity IS NOT NULL THEN
    RAISE EXCEPTION 'RUNTIME_SALES_CLAIM_DUPLICATE_RECONCILIATION_REQUIRED identity=%', duplicate_identity;
  END IF;
END
$runtime_sales_claim_identity_duplicates$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_runtime_sales_claim_identity
  ON public.runtime_idempotency (sales_claim_identity)
  WHERE job = 'sales.claim' AND sales_claim_identity IS NOT NULL;

ALTER TABLE public.runtime_idempotency
  DROP CONSTRAINT IF EXISTS runtime_idempotency_sales_claim_identity_scope;
ALTER TABLE public.runtime_idempotency
  ADD CONSTRAINT runtime_idempotency_sales_claim_identity_scope
  CHECK (job = 'sales.claim' OR sales_claim_identity IS NULL);

CREATE OR REPLACE FUNCTION public.runtime_bind_sales_claim_identity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $runtime_bind_sales_claim_identity$
DECLARE
  derived_identity text;
BEGIN
  IF NEW.job <> 'sales.claim' THEN
    NEW.sales_claim_identity := NULL;
    RETURN NEW;
  END IF;

  IF NULLIF(btrim(NEW.result ->> 'lifecycleId'), '') IS NULL
    OR NULLIF(btrim(NEW.result ->> 'winerimWineId'), '') IS NULL
    OR upper(btrim(NEW.result ->> 'variant')) NOT IN ('BOTTLE', 'GLASS', 'MAGNUM') THEN
    NEW.sales_claim_identity := NULL;
    RETURN NEW;
  END IF;

  derived_identity := jsonb_build_array(
    NEW.connection_id::text,
    btrim(NEW.result ->> 'lifecycleId'),
    btrim(NEW.result ->> 'winerimWineId'),
    upper(btrim(NEW.result ->> 'variant'))
  )::text;

  IF TG_OP = 'UPDATE'
    AND OLD.sales_claim_identity IS NOT NULL
    AND OLD.sales_claim_identity <> derived_identity THEN
    RAISE EXCEPTION 'RUNTIME_SALES_CLAIM_IDENTITY_IMMUTABLE';
  END IF;

  NEW.sales_claim_identity := derived_identity;
  RETURN NEW;
END
$runtime_bind_sales_claim_identity$;

REVOKE ALL ON FUNCTION public.runtime_bind_sales_claim_identity() FROM PUBLIC;

DROP TRIGGER IF EXISTS runtime_bind_sales_claim_identity
  ON public.runtime_idempotency;
CREATE TRIGGER runtime_bind_sales_claim_identity
  BEFORE INSERT OR UPDATE OF connection_id, job, result
  ON public.runtime_idempotency
  FOR EACH ROW
  EXECUTE FUNCTION public.runtime_bind_sales_claim_identity();

COMMENT ON COLUMN public.runtime_idempotency.sales_claim_identity IS
  'Version-independent sales claim identity. Duplicate v1/v2 rows are rejected; ambiguous legacy rows remain NULL and fail closed in runtime reconciliation.';

COMMIT;
