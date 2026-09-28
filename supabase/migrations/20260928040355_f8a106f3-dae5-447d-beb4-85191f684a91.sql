ALTER TABLE public.agora_reversal_audit
  ADD COLUMN identity_scope text CHECK (identity_scope IN ('SALE','DETAIL')),
  ADD COLUMN endpoint_granularity text CHECK (endpoint_granularity IN ('SALE','DETAIL')),
  ADD COLUMN endpoint_reverts_history boolean,
  ADD COLUMN endpoint_reverts_stock boolean,
  ADD COLUMN endpoint_partial_qty boolean,
  ADD CONSTRAINT agora_reversal_audit_verified_requires_reviewer
    CHECK (workflow_status NOT IN ('VERIFIED','READY_TO_REVERSE','REVERSED') OR (verified_by IS NOT NULL AND verified_at IS NOT NULL));

CREATE OR REPLACE FUNCTION public.guard_agora_reversal_audit() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.workflow_status IN ('VERIFIED','READY_TO_REVERSE','REVERSED') AND (NEW.verified_by IS NULL OR NEW.verified_at IS NULL) THEN
    RAISE EXCEPTION 'audit %: % requires verified_by and verified_at', NEW.id, NEW.workflow_status; END IF;
  IF NEW.eligible_for_reversal OR NEW.workflow_status IN ('READY_TO_REVERSE','REVERSED') THEN
    IF NEW.evidence_classification NOT IN ('CONFIRMED_DUPLICATE_STOCK','CONFIRMED_DUPLICATE_HISTORY') THEN RAISE EXCEPTION 'audit %: evidence % not reversible', NEW.id, NEW.evidence_classification; END IF;
    IF NEW.reverse_qty <= 0 THEN RAISE EXCEPTION 'audit %: reverse_qty must be > 0', NEW.id; END IF;
    IF coalesce(NEW.candidate_sale_id,'') = '' THEN RAISE EXCEPTION 'audit %: missing candidate saleId', NEW.id; END IF;
    IF NEW.identity_scope IS NULL OR (NEW.identity_scope = 'DETAIL' AND coalesce(NEW.candidate_detail_ids,'') = '') THEN RAISE EXCEPTION 'audit %: missing exact candidate identity', NEW.id; END IF;
    IF cardinality(NEW.blockers) > 0 THEN RAISE EXCEPTION 'audit %: blocked by %', NEW.id, NEW.blockers; END IF;
    IF NEW.workflow_status NOT IN ('VERIFIED','READY_TO_REVERSE','REVERSED') THEN RAISE EXCEPTION 'audit %: must be manually VERIFIED first', NEW.id; END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.guard_agora_reversal_queue() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE a public.agora_reversal_audit;
BEGIN
  IF NEW.audit_case_id IS NULL THEN RAISE EXCEPTION 'queue rows must be promoted from agora_reversal_audit'; END IF;
  SELECT * INTO a FROM public.agora_reversal_audit WHERE id = NEW.audit_case_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'audit case % not found', NEW.audit_case_id; END IF;
  IF a.eligible_for_reversal IS NOT TRUE THEN RAISE EXCEPTION 'audit case % not eligible_for_reversal', a.id; END IF;
  IF a.evidence_classification NOT IN ('CONFIRMED_DUPLICATE_STOCK','CONFIRMED_DUPLICATE_HISTORY') THEN RAISE EXCEPTION 'audit case %: evidence % not reversible', a.id, a.evidence_classification; END IF;
  IF a.workflow_status NOT IN ('VERIFIED','READY_TO_REVERSE','REVERSED') OR a.verified_by IS NULL OR a.verified_at IS NULL THEN RAISE EXCEPTION 'audit case % not manually verified', a.id; END IF;
  IF 'ENDPOINT_GRANULARITY_UNKNOWN' = ANY(a.blockers) OR a.endpoint_granularity IS NULL THEN RAISE EXCEPTION 'audit case %: endpoint granularity unknown, stays in audit', a.id; END IF;
  IF cardinality(a.blockers) > 0 THEN RAISE EXCEPTION 'audit case %: blocked by %', a.id, a.blockers; END IF;
  IF a.reverse_qty <= 0 OR NEW.reverse_qty <= 0 OR NEW.reverse_qty <> a.reverse_qty THEN RAISE EXCEPTION 'audit case %: invalid reverse_qty', a.id; END IF;
  IF a.identity_scope IS DISTINCT FROM a.endpoint_granularity THEN RAISE EXCEPTION 'audit case %: identity % incompatible with endpoint %', a.id, a.identity_scope, a.endpoint_granularity; END IF;
  IF a.identity_scope = 'DETAIL' AND (coalesce(a.candidate_detail_ids,'') = '' OR coalesce(NEW.sale_detail_id,'') = '') THEN RAISE EXCEPTION 'audit case %: missing detail identity', a.id; END IF;
  IF coalesce(NEW.sale_id,'') = '' OR NEW.sale_id <> a.candidate_sale_id THEN RAISE EXCEPTION 'audit case %: sale identity mismatch', a.id; END IF;
  IF a.endpoint_reverts_history IS NOT TRUE THEN RAISE EXCEPTION 'audit case %: endpoint does not revert history', a.id; END IF;
  IF a.evidence_classification = 'CONFIRMED_DUPLICATE_STOCK' AND a.endpoint_reverts_stock IS NOT TRUE THEN RAISE EXCEPTION 'audit case %: endpoint does not revert stock', a.id; END IF;
  IF a.reverse_qty < coalesce(a.history_units_excess, a.reverse_qty) AND a.endpoint_partial_qty IS NOT TRUE THEN RAISE EXCEPTION 'audit case %: partial reversal unsupported', a.id; END IF;
  RETURN NEW;
END $$;