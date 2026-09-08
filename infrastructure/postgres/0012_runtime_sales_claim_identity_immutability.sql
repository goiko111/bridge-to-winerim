\set ON_ERROR_STOP on

BEGIN;

DO $runtime_sales_claim_identity_immutability_preflight$
BEGIN
  IF to_regclass('public.runtime_idempotency') IS NULL THEN
    RAISE EXCEPTION 'public.runtime_idempotency is required before migration 0012';
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
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'runtime_idempotency'
      AND column_name = 'sales_claim_identity'
  ) THEN
    RAISE EXCEPTION 'migration 0011 must be applied before migration 0012';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_index index_contract
    JOIN pg_class index_class ON index_class.oid = index_contract.indexrelid
    JOIN pg_class table_class ON table_class.oid = index_contract.indrelid
    JOIN pg_attribute identity_column
      ON identity_column.attrelid = table_class.oid
      AND identity_column.attname = 'sales_claim_identity'
      AND identity_column.attnum > 0
      AND NOT identity_column.attisdropped
    WHERE table_class.oid = 'public.runtime_idempotency'::regclass
      AND index_class.relname = 'uq_runtime_sales_claim_identity'
      AND index_contract.indisunique
      AND index_contract.indisvalid
      AND index_contract.indisready
      AND index_contract.indnkeyatts = 1
      AND index_contract.indnatts = 1
      AND index_contract.indkey::text = identity_column.attnum::text
      AND pg_get_expr(index_contract.indpred, index_contract.indrelid)
        = '((job = ''sales.claim''::text) AND (sales_claim_identity IS NOT NULL))'
  ) THEN
    RAISE EXCEPTION 'migration 0011 unique sales claim index contract is required before migration 0012';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint constraint_contract
    WHERE constraint_contract.conrelid = 'public.runtime_idempotency'::regclass
      AND constraint_contract.conname = 'runtime_idempotency_sales_claim_identity_scope'
      AND constraint_contract.contype = 'c'
      AND constraint_contract.convalidated
      AND pg_get_constraintdef(constraint_contract.oid)
        = 'CHECK (((job = ''sales.claim''::text) OR (sales_claim_identity IS NULL)))'
  ) THEN
    RAISE EXCEPTION 'migration 0011 sales claim scope constraint is required before migration 0012';
  END IF;
END
$runtime_sales_claim_identity_immutability_preflight$;

LOCK TABLE public.runtime_idempotency IN SHARE ROW EXCLUSIVE MODE;

CREATE OR REPLACE FUNCTION public.runtime_bind_sales_claim_identity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $runtime_bind_sales_claim_identity$
DECLARE
  derived_identity text;
BEGIN
  IF TG_OP = 'UPDATE'
    AND NEW.sales_claim_identity IS DISTINCT FROM OLD.sales_claim_identity THEN
    RAISE EXCEPTION 'RUNTIME_SALES_CLAIM_IDENTITY_IMMUTABLE';
  END IF;

  IF NEW.job <> 'sales.claim' THEN
    IF TG_OP = 'UPDATE' AND OLD.sales_claim_identity IS NOT NULL THEN
      RAISE EXCEPTION 'RUNTIME_SALES_CLAIM_IDENTITY_IMMUTABLE';
    END IF;
    NEW.sales_claim_identity := NULL;
    RETURN NEW;
  END IF;

  IF NULLIF(btrim(NEW.result ->> 'lifecycleId'), '') IS NULL
    OR NULLIF(btrim(NEW.result ->> 'winerimWineId'), '') IS NULL
    OR upper(btrim(NEW.result ->> 'variant')) NOT IN ('BOTTLE', 'GLASS', 'MAGNUM') THEN
    IF TG_OP = 'UPDATE' AND OLD.sales_claim_identity IS NOT NULL THEN
      RAISE EXCEPTION 'RUNTIME_SALES_CLAIM_IDENTITY_IMMUTABLE';
    END IF;
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
    AND OLD.sales_claim_identity IS DISTINCT FROM derived_identity THEN
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
  BEFORE INSERT OR UPDATE OF connection_id, job, result, sales_claim_identity
  ON public.runtime_idempotency
  FOR EACH ROW
  EXECUTE FUNCTION public.runtime_bind_sales_claim_identity();

REVOKE UPDATE ON public.runtime_idempotency FROM middleware_runtime;
GRANT UPDATE (
  message_id,
  status,
  attempt,
  lease_expires_at,
  payload_sha256,
  lease_token,
  result,
  updated_at
) ON public.runtime_idempotency TO middleware_runtime;

COMMENT ON COLUMN public.runtime_idempotency.sales_claim_identity IS
  'Derived immutable sales claim identity. Runtime writes cannot clear or directly replace it; duplicate v1/v2 rows are rejected.';

COMMIT;
